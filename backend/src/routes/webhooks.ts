import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { runEvaluationCheck, runCallLogFetch } from "../services/evaluationRunner";

const router = Router();
const prisma = new PrismaClient();

/**
 * Receive Hamsa webhook (call_end event).
 * Matches the callId to a Run, stores transcript + webhook data,
 * then triggers call log fetch and evaluation.
 */
router.post("/hamsa", async (req, res) => {
  const payload = req.body;

  console.log(`[Webhook] Received event: ${payload.event_type}`);

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
    console.log(`[Webhook] No matching run for callId=${callId}, storing as orphan`);
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
      status: "AWAITING_DATA",
    },
  });

  console.log(`[Webhook] Stored transcript for run ${run.id} (callId=${callId})`);

  // Fetch call log from Hamsa API
  const apiKey = (run as any).project?.hamsaApiKey || undefined;
  await runCallLogFetch(run.id, callId, apiKey);

  // Also trigger evaluation check (in case call log already exists)
  await runEvaluationCheck(run.id);

  res.json({ ok: true, runId: run.id });
});

export default router;
