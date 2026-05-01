import prisma from "../lib/prisma";
import { Router, Request, Response } from "express";
import { runCallLogFetch, runEvaluationCheck } from "../services/evaluationRunner";
import { fetchConversation } from "../services/hamsaApi";
import crypto from "crypto";

const router = Router();

/**
 * Verify HMAC-SHA256 signature on incoming webhook payloads.
 * If the project has a webhookSecret configured, the sender MUST include
 * an `X-Hamsa-Signature` header: `sha256=<hex(HMAC-SHA256(secret, rawBody))>`.
 *
 * Projects without a webhookSecret are accepted but logged as a warning —
 * this keeps backward compatibility while encouraging migration to signed webhooks.
 */
async function verifyWebhookSignature(
  req: Request & { rawBody?: Buffer },
  projectId: string | null,
  res: Response
): Promise<boolean> {
  const project = projectId
    ? await prisma.project.findUnique({ where: { id: projectId }, select: { webhookSecret: true } })
    : null;

  const secret = project?.webhookSecret;
  const signature = req.headers["x-hamsa-signature"] as string | undefined;

  if (!secret) {
    // No secret configured — accept but warn operators
    if (signature) {
      console.warn(`[Webhook] Received signature header but project ${projectId} has no webhookSecret configured`);
    } else {
      console.warn(`[Webhook] Project ${projectId} has no webhookSecret — webhook is unauthenticated`);
    }
    return true;
  }

  if (!signature) {
    console.error(`[Webhook] Rejected: project ${projectId} requires signature but none provided`);
    res.status(401).json({ error: "Missing webhook signature" });
    return false;
  }

  // Signature format: "sha256=<hex>"
  const [algo, receivedHex] = signature.split("=", 2);
  if (algo !== "sha256" || !receivedHex) {
    res.status(401).json({ error: "Invalid signature format. Expected: sha256=<hex>" });
    return false;
  }

  // Use raw body bytes for HMAC so JSON serialisation differences don't break verification
  const bodyBytes = (req as any).rawBody || Buffer.from(JSON.stringify(req.body));
  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(bodyBytes)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  const expectedBuf = Buffer.from(expectedHex, "hex");
  const receivedBuf = Buffer.from(receivedHex, "hex");
  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    console.error(`[Webhook] Rejected: invalid signature for project ${projectId}`);
    res.status(401).json({ error: "Invalid webhook signature" });
    return false;
  }

  return true;
}

/**
 * Project-specific webhook endpoint for WEBHOOK projects.
 * URL: POST /api/webhooks/hamsa/:projectId
 * Each WEBHOOK project gets a unique URL that routes directly to it.
 */
router.post("/hamsa/:projectId", async (req, res) => {
  try {
  const { projectId } = req.params;
  const payload = req.body;

  // Verify HMAC signature before doing any DB work
  if (!await verifyWebhookSignature(req, projectId, res)) return;

  console.log(`[Webhook] Received event for project ${projectId}: ${payload.event_type}`);

  if (!payload.event_type) {
    console.warn(`[Webhook] Received payload with no event_type`);
  }
  if (payload.event_type !== "call_end") {
    return res.json({ ok: true, message: "Ignored non-call_end event" });
  }

  const callId = payload.caller_info?.call_id;
  if (!callId) {
    return res.status(400).json({ error: "Missing call_id in webhook" });
  }

  // Verify project exists and is a WEBHOOK project
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, projectType: true, hamsaApiKey: true, agentSummary: true, webhookSecret: true },
  });

  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }
  if (project.projectType !== "WEBHOOK") {
    return res.status(400).json({ error: "Project is not a webhook project" });
  }

  // Check for duplicate by callId
  const existingByCallId = await prisma.run.findFirst({
    where: { projectId, hamsaCallId: callId },
  });
  if (existingByCallId) {
    console.log(`[Webhook] Duplicate call_id=${callId} for project ${projectId} — ignoring`);
    return res.json({ ok: true, runId: existingByCallId.id, message: "Already processed" });
  }

  const transcript = payload.data?.transcription || null;
  const conversationId = payload.data?.conversationId ?? payload.conversationId ?? payload.caller_info?.conversationId ?? null;

  // Check for duplicate by conversationId
  if (conversationId) {
    const existingByConv = await prisma.run.findFirst({
      where: { projectId, conversationId },
    });
    if (existingByConv) {
      console.log(`[Webhook] Duplicate conversationId=${conversationId} — already processed as run ${existingByConv.id}`);
      return res.json({ ok: true, message: "Duplicate conversation — already processed" });
    }
  }

  // Guard against no transcript
  if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
    console.warn(`[Webhook] Call ${callId} has no transcript — creating run as FAILED`);
    await prisma.run.create({
      data: {
        projectId,
        source: "WEBHOOK",
        hamsaCallId: callId,
        conversationId,
        status: "FAILED",
        errorLog: "Webhook contained no transcript data",
        webhookData: payload as any,
        callDate: new Date(),
        startedAt: new Date(),
      },
    }).catch(() => {});
    return res.json({ ok: true, message: "No transcript — run marked as FAILED" });
  }

  const rawStartMs = payload.data?.callStartedAt || (payload.caller_info?.call_start_time ? payload.caller_info.call_start_time * 1000 : null);
  const startMs = (typeof rawStartMs === "number" && !isNaN(rawStartMs)) ? rawStartMs : null;
  const endMs = (typeof payload.data?.callEndedAt === "number" && !isNaN(payload.data.callEndedAt)) ? payload.data.callEndedAt : null;
  const callDuration = (startMs && endMs) ? Math.round((endMs - startMs) / 1000) : null;
  const callDate = startMs ? new Date(startMs) : new Date();
  const outcomeResult = payload.data?.outcomeResult ?? null;
  const callOutcome = outcomeResult?.call_outcome ?? null;

  let newRun;
  try {
    newRun = await prisma.run.create({
      data: {
        projectId,
        source: "WEBHOOK",
        hamsaCallId: callId,
        conversationId,
        modelUsed: payload.data?.model || payload.caller_info?.model || null,
        callDate,
        callDuration,
        callStatus: "COMPLETED",
        callOutcome,
        outcomeResult: outcomeResult as any,
        transcript: transcript as any,
        webhookData: payload as any,
        status: "AWAITING_DATA",
        startedAt: callDate,
      },
    });
  } catch (createErr: any) {
    if (createErr?.code === "P2002") {
      console.log(`[Webhook] Duplicate call_id=${callId} — already processed`);
      return res.json({ ok: true, message: "Duplicate call — already processed" });
    }
    throw createErr;
  }

  console.log(`[Webhook] Created run ${newRun.id} for project ${projectId} (callId=${callId})`);

  // Fire-and-forget: evaluate in background
  hydrateWebhookRun(newRun.id, callId, project.hamsaApiKey || undefined)
    .catch(err => console.error(`[Webhook] Uncaught hydration error for run ${newRun.id}:`, err));

  return res.json({ ok: true, runId: newRun.id, autoCreated: true });

  } catch (err) {
    console.error(`[Webhook] Error in project webhook handler:`, err);
    return res.status(500).json({ error: "Internal webhook error" });
  }
});

/**
 * Generic webhook endpoint (backward-compatible for LIVE projects).
 * URL: POST /api/webhooks/hamsa
 * Matches by callId or agentId to find an existing LIVE run.
 */
router.post("/hamsa", async (req, res) => {
  try {
  const payload = req.body;

  // Generic endpoint has no projectId — verify against a global fallback secret if configured
  if (!await verifyWebhookSignature(req, null, res)) return;

  console.log(`[Webhook] Received event (generic): ${payload.event_type}`);

  if (payload.event_type !== "call_end") {
    return res.json({ ok: true, message: "Ignored non-call_end event" });
  }

  const callId = payload.caller_info?.call_id;
  if (!callId) {
    return res.status(400).json({ error: "Missing call_id in webhook" });
  }

  // Find the run by hamsaCallId
  let run = await prisma.run.findFirst({
    where: { hamsaCallId: callId },
    include: { project: true },
  });

  // If no run found, try to match by agent_id to the most recent RUNNING run
  if (!run) {
    const agentId = payload.caller_info?.agent_id;
    if (agentId) {
      run = await prisma.run.findFirst({
        where: {
          project: { agentId },
          status: { in: ["RUNNING", "AWAITING_DATA", "PENDING"] },
        },
        orderBy: { createdAt: "desc" },
        include: { project: true },
      });
    }
  }

  if (!run) {
    console.log(`[Webhook] No matching run for callId=${callId}`);
    return res.json({ ok: true, message: "No matching run found" });
  }

  // Store transcript and webhook data
  const transcript = payload.data?.transcription || null;
  await prisma.run.update({
    where: { id: run.id },
    data: {
      hamsaCallId: callId,
      transcript,
      webhookData: payload,
      status: transcript ? "AWAITING_DATA" : run.status,
    },
  });

  console.log(`[Webhook] Stored transcript for run ${run.id} (callId=${callId})`);

  const apiKey = (run as any).project?.hamsaApiKey || undefined;
  try {
    await runCallLogFetch(run.id, callId, apiKey);
  } catch (err) {
    console.error(`[Webhook] runCallLogFetch failed for run ${run.id}: ${err}`);
  }

  res.json({ ok: true, runId: run.id });

  } catch (err) {
    console.error(`[Webhook] Error in generic webhook handler:`, err);
    return res.status(500).json({ error: "Internal webhook error" });
  }
});

/**
 * Hydrate a webhook-created run in the background.
 * Fetches call logs from Hamsa (via conversationId), then evaluates.
 */
async function hydrateWebhookRun(
  runId: string,
  callId: string,
  apiKey: string | undefined
) {
  try {
    // Wait briefly for agentSummary if it hasn't been generated yet
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: {
        conversationId: true,
        project: { select: { agentSummary: true, hamsaApiKey: true } },
      },
    });
    if (!run?.project?.agentSummary) {
      console.log(`[Webhook] Waiting 5s for agentSummary before evaluating run ${runId}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Fetch call logs from Hamsa using the conversationId from the webhook payload.
    // The conversation object contains conv.logs (execution logs: node movements,
    // tool calls, variable extractions) which are used by DETERMINISTIC, STRUCTURAL,
    // LATENCY, and FLOW_PROGRESSION evaluators.
    const key = apiKey || run?.project?.hamsaApiKey || undefined;
    const convId = run?.conversationId;
    if (convId && key) {
      try {
        // Retry up to 3 times with delays — Hamsa may not have processed
        // the conversation logs immediately at call_end time
        let convLogs: any[] | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const conv = await fetchConversation(convId, key);
          convLogs = Array.isArray(conv?.logs) && conv.logs.length > 0 ? conv.logs : null;
          if (convLogs) break;
          if (attempt < 2) {
            console.log(`[Webhook] No logs yet for ${convId} (attempt ${attempt + 1}/3) — retrying in 5s`);
            await new Promise(r => setTimeout(r, 5000));
          }
        }
        if (convLogs) {
          await prisma.run.update({
            where: { id: runId },
            data: { callLog: convLogs as any },
          });
          console.log(`[Webhook] Fetched ${convLogs.length} log entries for run ${runId} (conv=${convId})`);
        } else {
          console.log(`[Webhook] No logs available for ${convId} after 3 attempts — evaluating with transcript only`);
        }
      } catch (logErr) {
        console.warn(`[Webhook] Failed to fetch conversation logs for ${convId}: ${(logErr as Error).message}`);
        // Non-fatal — evaluation will proceed with transcript only
      }
    } else {
      console.log(`[Webhook] No conversationId or API key — evaluating with transcript only for run ${runId}`);
    }

    await runEvaluationCheck(runId);
    console.log(`[Webhook] Evaluated run ${runId} (callId=${callId})`);
  } catch (err) {
    console.error(`[Webhook] Failed to evaluate run ${runId}: ${(err as Error).message}`);
    await prisma.run.update({
      where: { id: runId },
      data: { status: "FAILED", errorLog: (err as Error).message },
    }).catch(() => {});
  }
}

export default router;
