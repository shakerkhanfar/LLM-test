import prisma from "../lib/prisma";
import { Router } from "express";
import { Readable } from "stream";
import { RunStatus } from "@prisma/client";
import { updateAgentModel, fetchConversation } from "../services/hamsaApi";
import { runEvaluationCheck } from "../services/evaluationRunner";
import { AuthRequest } from "../middleware/auth";
import { assertProjectAccess, assertRunAccess, canAccess } from "../lib/ownership";
import { evalRateLimit } from "../middleware/rateLimiter";

const router = Router();

const VALID_STATUSES = new Set<string>(Object.values(RunStatus));
// Only allow external callers to set these statuses (not e.g. EVALUATING or COMPLETE)
const CLIENT_SETTABLE_STATUSES = new Set<string>(["PENDING", "RUNNING", "AWAITING_DATA", "FAILED"]);

// List runs for a project (most recent 200, with pagination via ?skip=)
router.get("/project/:projectId", async (req: AuthRequest, res) => {
  const project = await assertProjectAccess(req.params.projectId, req, res);
  if (!project) return;

  const skip = parseInt(req.query.skip as string) || 0;
  const take = Math.min(parseInt(req.query.take as string) || 100, 200);

  const runs = await prisma.run.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { createdAt: "desc" },
    skip,
    take,
    include: {
      evalResults: { include: { criterion: true } },
      _count: { select: { wordLabels: true } },
    },
  });
  res.json(runs);
});

// Get single run with full details
router.get("/:id", async (req: AuthRequest, res) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: {
        project: { include: { criteria: true } },
        evalResults: { include: { criterion: true } },
        wordLabels: { orderBy: { wordIndex: "asc" } },
      },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });
    const projectUserId = (run.project as any)?.userId as string | null;
    if (!await canAccess(projectUserId, req)) {
      return res.status(403).json({ error: "Access denied" });
    }
    res.json(run);
  } catch {
    res.status(500).json({ error: "Failed to fetch run" });
  }
});

// Fetch a fresh recording URL from Hamsa for a run whose CloudFront signed URL may have expired.
// Calls fetchConversation() and extracts the mediaUrl from the response.
//
// Fallback chain: if the project's stored hamsaApiKey returns 403/401 (revoked
// or wrong key), retry with the server-wide HAMSA_API_KEY from env. This keeps
// recordings playable when a project's key goes stale, without forcing the
// user to first re-enter the key from the UI.
router.get("/:id/recording-url", async (req: AuthRequest, res) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      select: { conversationId: true, project: { select: { userId: true, hamsaApiKey: true } } },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!await canAccess((run.project as any)?.userId ?? null, req)) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (!run.conversationId) return res.status(404).json({ error: "No conversationId on this run" });

    const projectKey = (run.project as any)?.hamsaApiKey as string | null;
    const envKey     = process.env.HAMSA_API_KEY || "";
    if (!projectKey && !envKey) {
      return res.status(400).json({ error: "No Hamsa API key configured (project or env)" });
    }

    // Build the candidate-key list: project key first, env key as fallback.
    // Dedupe so we don't double-try the same key.
    const keys = [projectKey, envKey].filter((k): k is string => !!k);
    const uniqKeys = [...new Set(keys)];

    let conv: any = null;
    let lastErr: Error | null = null;
    let usedFallback = false;
    for (let i = 0; i < uniqKeys.length; i++) {
      try {
        conv = await fetchConversation(run.conversationId, uniqKeys[i]);
        usedFallback = i > 0;
        break;
      } catch (err) {
        lastErr = err as Error;
        // Only fall through to next key on auth failures; surface other errors immediately.
        if (!/(^|\s)40[13](\s|$|—)/.test(lastErr.message)) break;
      }
    }
    if (!conv) {
      console.error("[Runs] GET /:id/recording-url error:", lastErr?.message);
      // In dev, return the upstream Hamsa message so the user can see why
      // (e.g. "Invalid API key!"). Strip it in prod to avoid info leakage.
      const detail = process.env.NODE_ENV === "production" ? undefined : lastErr?.message;
      return res.status(502).json({ error: "Failed to fetch recording URL", detail });
    }

    const url = conv?.mediaUrl || conv?.data?.conversationRecording || conv?.data?.recordingUrl || null;
    if (!url) return res.status(404).json({ error: "No recording URL found in Hamsa response" });

    res.json({ url, usedFallbackKey: usedFallback });
  } catch (err) {
    console.error("[Runs] GET /:id/recording-url error:", (err as Error).message);
    res.status(500).json({ error: "Failed to fetch recording URL", detail: (err as Error).message });
  }
});

// Stream the recording through our backend so the browser receives a correct
// Content-Type header. CloudFront often serves OGG files as application/octet-stream,
// which Chrome refuses to play. We force audio/ogg here.
// Passes Range headers through so audio seeking (partial content) works correctly.
router.get("/:id/recording-stream", async (req: AuthRequest, res) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      select: { conversationId: true, webhookData: true, project: { select: { userId: true, hamsaApiKey: true } } },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!await canAccess((run.project as any)?.userId ?? null, req)) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Helper: fetch the recording URL from Hamsa API using available keys.
    const fetchFreshUrl = async (): Promise<string | null> => {
      if (!run.conversationId) return null;
      const projectKey = (run.project as any)?.hamsaApiKey as string | null;
      const envKey = process.env.HAMSA_API_KEY || "";
      const keys = [...new Set([projectKey, envKey].filter((k): k is string => !!k))];
      for (const key of keys) {
        try {
          const conv = await fetchConversation(run.conversationId, key);
          const url = conv?.mediaUrl || conv?.data?.conversationRecording || conv?.data?.recordingUrl || null;
          if (url) return url;
        } catch { /* try next key */ }
      }
      return null;
    };

    // Resolve URL from stored webhook data first (fast path, no Hamsa call).
    const wd = run.webhookData as any;
    let recordingUrl: string | null =
      wd?.data?.conversationRecording || wd?.mediaUrl || wd?.data?.recordingUrl ||
      wd?.data?.recording_url || wd?.caller_info?.recording_url || wd?.recordingUrl || null;

    // Fall through to Hamsa API if nothing in webhook data.
    if (!recordingUrl) recordingUrl = await fetchFreshUrl();
    if (!recordingUrl) return res.status(404).json({ error: "No recording URL found" });

    // Forward Range header for seek support (partial content / audio scrubbing).
    const upstreamHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (compatible; hamsa-eval-proxy/1.0)",
    };
    if (req.headers.range) upstreamHeaders["Range"] = req.headers.range;

    // 30 s timeout — prevents a hung CloudFront connection from tying up a server slot.
    let upstream = await fetch(recordingUrl, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(30_000),
    });

    // CloudFront signed URLs expire. If we get 403/401, fetch a fresh URL from Hamsa
    // and retry once before giving up.
    if (upstream.status === 403 || upstream.status === 401) {
      const freshUrl = await fetchFreshUrl();
      if (freshUrl && freshUrl !== recordingUrl) {
        recordingUrl = freshUrl;
        upstream = await fetch(recordingUrl, {
          headers: upstreamHeaders,
          signal: AbortSignal.timeout(30_000),
        });
      }
    }

    // Surface upstream errors cleanly rather than piping error XML as audio.
    if (!upstream.ok && upstream.status !== 206) {
      const status = upstream.status >= 500 ? 502 : upstream.status === 404 ? 404 : 502;
      return res.status(status).json({ error: `Upstream returned ${upstream.status}` });
    }

    // Determine the correct audio Content-Type based on file extension.
    const isOgg = /\.ogg(\?|$)/i.test(recordingUrl);
    const isMp3 = /\.mp3(\?|$)/i.test(recordingUrl);
    const isWav = /\.wav(\?|$)/i.test(recordingUrl);
    const serverType = upstream.headers.get("content-type") || "";
    const contentType =
      isOgg ? "audio/ogg" :
      isMp3 ? "audio/mpeg" :
      isWav ? "audio/wav" :
      serverType.startsWith("audio/") ? serverType : "audio/ogg";

    res.status(upstream.status === 206 ? 206 : 200);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");

    for (const h of ["content-length", "content-range"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    if (!upstream.body) return res.end();

    const readable = Readable.fromWeb(upstream.body as any);

    // If the client disconnects mid-stream, destroy the upstream to free the
    // CloudFront connection and stop wasting bandwidth.
    res.on("close", () => readable.destroy());

    readable.on("error", (e) => {
      console.error("[Runs] recording-stream pipe error:", e.message);
      // Headers already sent — can only close the connection.
      res.end();
    });

    readable.pipe(res);
  } catch (err) {
    console.error("[Runs] GET /:id/recording-stream error:", (err as Error).message);
    if (!res.headersSent) res.status(500).json({ error: "Failed to stream recording" });
  }
});

// Create a new run
router.post("/", async (req: AuthRequest, res) => {
  const { projectId, modelUsed } = req.body;
  if (!projectId) return res.status(400).json({ error: "projectId is required" });

  try {
    const project = await assertProjectAccess(projectId, req, res);
    if (!project) return;

    const run = await prisma.run.create({
      data: {
        projectId,
        modelUsed: modelUsed || null,
        status: "PENDING",
        startedAt: new Date(),
      },
    });

    res.status(201).json(run);
  } catch {
    res.status(500).json({ error: "Failed to create run" });
  }
});

// Switch agent model via Hamsa API (explicit action)
router.post("/:id/switch-model", async (req: AuthRequest, res) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!await canAccess((run.project as any).userId ?? null, req)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const result = await updateAgentModel(
      run.project.agentId,
      run.modelUsed || "openai/gpt-4.1",
      undefined,
      run.project.hamsaApiKey || undefined
    );
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({
      error: "Failed to update agent model",
      detail: (err as Error).message,
    });
  }
});

// Rehydrate a run — re-fetch fresh call log AND conversation/transcript from Hamsa,
// then trigger re-evaluation. Works even if data already exists (overwrites stale data).
router.post("/:id/rehydrate", evalRateLimit, async (req: AuthRequest, res) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!await canAccess((run.project as any).userId ?? null, req)) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Need at least one ID to fetch data from Hamsa.
    // The logs endpoint (/v1/agent-analytics/logs?jobId=...) requires a UUID —
    // conversationId is preferred; hamsaCallId is used as a fallback but may not
    // be a valid UUID for all call types.
    if (!run.hamsaCallId && !run.conversationId) {
      return res.status(400).json({ error: "No hamsaCallId or conversationId on this run — cannot rehydrate" });
    }

    // Atomic guard: refuse if evaluation is already in progress.
    // We immediately transition to PENDING to "claim" the run; if another process
    // already owns it (EVALUATING), updateMany returns count=0 and we bail out.
    const claimed = await prisma.run.updateMany({
      where: { id: run.id, status: { notIn: ["EVALUATING"] } },
      data: { status: "PENDING" },
    });
    if (claimed.count === 0) {
      return res.status(409).json({ error: "Evaluation already in progress — try again once it completes" });
    }

    const apiKey = run.project.hamsaApiKey || undefined;
    const { fetchCallLog, fetchConversation, extractTranscriptFromConversation } = await import("../services/hamsaApi");

    let logEvents = 0;
    let transcriptTurns = 0;
    const warnings: string[] = [];

    // 1. Re-fetch call log — REQUIRED for node mapping in layered evaluation.
    //    Hamsa's logs endpoint requires a UUID jobId. conversationId is always a
    //    UUID; hamsaCallId may be a short non-UUID identifier for some call types.
    //    If this fails, abort rather than evaluating with stale logs.
    const logJobId = run.conversationId || run.hamsaCallId!;
    let freshCallLog: any;
    try {
      freshCallLog = await fetchCallLog(logJobId, apiKey);
      logEvents = Array.isArray(freshCallLog) ? freshCallLog.length : 0;
      console.log(`[Rehydrate] Fetched ${logEvents} log events for run ${run.id} (jobId: ${logJobId})`);
    } catch (err) {
      // Release the claimed PENDING back to FAILED so the run is clearly errored,
      // not stuck in PENDING forever.
      await prisma.run.update({ where: { id: run.id }, data: { status: "FAILED", errorLog: `Rehydrate: call log fetch failed: ${(err as Error).message}` } });
      return res.status(502).json({ error: `Call log fetch failed: ${(err as Error).message}` });
    }

    // 2. Re-fetch conversation (transcript + metadata) — optional but strongly preferred.
    //    Failure here is non-fatal: transcript may be embedded in the call log.
    let freshWebhookData: any = undefined;
    let freshTranscript: any[] | undefined = undefined;
    const convId = run.conversationId || run.hamsaCallId!;
    try {
      const conv = await fetchConversation(convId, apiKey);
      freshWebhookData = conv;
      const extracted = extractTranscriptFromConversation(conv);
      if (extracted && extracted.length > 0) {
        freshTranscript = extracted;
        transcriptTurns = extracted.length;
      }
      console.log(`[Rehydrate] Fetched conversation for run ${run.id} (${transcriptTurns} transcript turns)`);
    } catch (err) {
      const msg = `Conversation fetch failed (will rely on call log for transcript): ${(err as Error).message}`;
      warnings.push(msg);
      console.warn(`[Rehydrate] ${msg}`);
    }

    // 3. Atomically persist fresh data and reset to PENDING.
    const updatePayload: Record<string, any> = {
      callLog: freshCallLog,
      status: "PENDING",
    };
    if (freshWebhookData !== undefined) updatePayload.webhookData = freshWebhookData;
    if (freshTranscript !== undefined) updatePayload.transcript = freshTranscript;

    await prisma.run.update({ where: { id: run.id }, data: updatePayload });

    // 4. Trigger re-evaluation with fresh data
    const { runEvaluationCheck } = await import("../services/evaluationRunner");
    await runEvaluationCheck(run.id);

    res.json({
      ok: true,
      callLogFetched: true,
      conversationFetched: freshWebhookData !== undefined,
      logEvents,
      transcriptTurns,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Fetch call log from Hamsa API for a run
router.post("/:id/fetch-logs", async (req: AuthRequest, res) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!await canAccess((run.project as any).userId ?? null, req)) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (!run.hamsaCallId) return res.status(400).json({ error: "No call ID on this run" });

    const { fetchCallLog } = await import("../services/hamsaApi");
    const logs = await fetchCallLog(run.hamsaCallId, run.project.hamsaApiKey || undefined);
    await prisma.run.update({
      where: { id: run.id },
      data: { callLog: logs as any },
    });
    res.json({ ok: true, events: Array.isArray(logs) ? logs.length : 0 });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Manually attach call log to a run (for local testing without API)
router.post("/:id/call-log", async (req: AuthRequest, res) => {
  const { callLog } = req.body;
  if (callLog === undefined) return res.status(400).json({ error: "callLog is required" });
  if (!Array.isArray(callLog)) return res.status(400).json({ error: "callLog must be an array" });

  try {
    const access = await assertRunAccess(req.params.id, req, res);
    if (!access) return;

    const run = await prisma.run.update({
      where: { id: access.id },
      data: { callLog },
    });
    await runEvaluationCheck(run.id);
    res.json(run);
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Run not found" });
    res.status(500).json({ error: "Failed to attach call log" });
  }
});

// Manually attach transcript/webhook data to a run (for local testing)
router.post("/:id/transcript", async (req: AuthRequest, res) => {
  const { transcript, webhookData } = req.body;

  try {
    const access = await assertRunAccess(req.params.id, req, res);
    if (!access) return;

    const run = await prisma.run.update({
      where: { id: access.id },
      data: { transcript, webhookData },
    });
    await runEvaluationCheck(run.id);
    res.json(run);
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Run not found" });
    res.status(500).json({ error: "Failed to attach transcript" });
  }
});

// Manually trigger evaluation (force re-run even if status is COMPLETE)
router.post("/:id/evaluate", evalRateLimit, async (req: AuthRequest, res) => {
  try {
    const access = await assertRunAccess(req.params.id, req, res);
    if (!access) return;

    // Atomic reset: prevents interrupting an in-progress evaluation.
    const updated = await prisma.run.updateMany({
      where: { id: access.id, status: { notIn: ["EVALUATING"] } },
      data: { status: "PENDING" },
    });

    if (updated.count === 0) {
      return res.status(409).json({ error: "Evaluation already in progress" });
    }

    await runEvaluationCheck(access.id);
    res.json({ ok: true, message: "Evaluation queued" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Set the hamsa call ID or status (after starting call via SDK)
router.patch("/:id", async (req: AuthRequest, res) => {
  const { hamsaCallId, status } = req.body;

  if (status !== undefined) {
    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: `Invalid status: ${status}` });
    }
    if (!CLIENT_SETTABLE_STATUSES.has(status)) {
      return res.status(400).json({ error: `Status '${status}' cannot be set via this endpoint` });
    }
  }

  try {
    const access = await assertRunAccess(req.params.id, req, res);
    if (!access) return;

    const data: any = {};
    if (hamsaCallId !== undefined) data.hamsaCallId = hamsaCallId;
    if (status !== undefined) data.status = status;

    const run = await prisma.run.update({
      where: { id: access.id },
      data,
    });
    res.json(run);
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Run not found" });
    res.status(500).json({ error: "Failed to update run" });
  }
});

// Delete a run
router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const access = await assertRunAccess(req.params.id, req, res);
    if (!access) return;

    await prisma.run.delete({ where: { id: access.id } });
    res.json({ ok: true });
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Run not found" });
    res.status(500).json({ error: "Failed to delete run" });
  }
});

// Compare multiple runs — max 20, must all belong to the same project
router.post("/compare", async (req: AuthRequest, res) => {
  const { runIds } = req.body;
  if (!Array.isArray(runIds) || runIds.length === 0) {
    return res.status(400).json({ error: "runIds must be a non-empty array" });
  }
  if (runIds.length > 20) {
    return res.status(400).json({ error: "Cannot compare more than 20 runs at once" });
  }
  if (runIds.some((id: unknown) => typeof id !== "string" || !id.trim())) {
    return res.status(400).json({ error: "Each runId must be a non-empty string" });
  }

  try {
    const runs = await prisma.run.findMany({
      where: { id: { in: runIds } },
      include: {
        evalResults: { include: { criterion: true } },
        _count: { select: { wordLabels: true } },
        project: { select: { userId: true } },
      },
    });

    // If none of the requested IDs exist, return 404 rather than an empty 200
    if (runs.length === 0) {
      return res.status(404).json({ error: "No runs found for the provided IDs" });
    }

    // Verify all runs belong to the same project
    const projectIds = new Set(runs.map((r) => r.projectId));
    if (projectIds.size > 1) {
      return res.status(400).json({ error: "All runs must belong to the same project" });
    }

    // Verify the user owns the project (runs.length > 0 is guaranteed above)
    const projectUserId = (runs[0].project as any)?.userId as string | null;
    if (!await canAccess(projectUserId, req)) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Return only the runs the caller explicitly requested (IDs not found are silently absent)
    res.json(runs);
  } catch {
    res.status(500).json({ error: "Failed to compare runs" });
  }
});

export default router;
