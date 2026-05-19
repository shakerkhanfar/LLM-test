import prisma from "../lib/prisma";
import { evaluateRun } from "./evaluator";
import { fetchCallLog } from "./hamsaApi";
import { setQueueHealth } from "../app";

let useQueue = false;
let queueModule: any = null;

/**
 * Try to initialise BullMQ. If Redis isn't available, fall back to inline
 * execution. Queue health is exposed to the /api/health endpoint so
 * operators know when the queue has failed.
 */
export async function initQueue() {
  try {
    const IORedis = (await import("ioredis")).default;
    const testConn = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      connectTimeout: 2000,
      retryStrategy: () => null,
    });
    testConn.on("error", () => {});
    await testConn.connect();
    await testConn.ping();
    await testConn.quit();

    queueModule = await import("../jobs/evaluationQueue");
    await queueModule.recoverStuckRuns();
    queueModule.startWorker();
    useQueue = true;
    setQueueHealth(true);
    console.log("[Eval] Using BullMQ queue for evaluations");
  } catch {
    useQueue = false;
    setQueueHealth(false);
    console.warn("[Eval] Redis not available — evaluations will run inline (no persistence)");
    // Recover any runs left in PENDING/AWAITING_DATA/EVALUATING from a previous crash.
    // Run in background so startup is not blocked.
    recoverInlineRuns().catch((err) =>
      console.error("[Eval] Inline recovery sweep failed:", err)
    );
  }
}

/**
 * Sweep runs that have data but never reached COMPLETE — happens when the
 * process restarts mid-evaluation in inline (no-Redis) mode.
 */
async function recoverInlineRuns() {
  // Reset stuck EVALUATING → PENDING so the claim guard below can re-claim them.
  await prisma.run.updateMany({
    where: { status: "EVALUATING" },
    data: { status: "PENDING" },
  });

  const stuck = await prisma.run.findMany({
    where: {
      status: { in: ["PENDING", "AWAITING_DATA"] },
      OR: [
        { callLog: { not: "DbNull" } },
        { transcript: { not: "DbNull" } },
        { webhookData: { not: "DbNull" } },
      ],
    },
    select: { id: true },
  });

  if (stuck.length === 0) return;
  console.log(`[Eval] Inline sweep: recovering ${stuck.length} stuck run(s)`);

  // Process up to 3 concurrently to avoid hammering the LLM API.
  const CONCURRENCY = 3;
  for (let i = 0; i < stuck.length; i += CONCURRENCY) {
    const batch = stuck.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(({ id }) =>
        runEvaluationCheck(id).catch((err) =>
          console.error(`[Eval] Inline sweep failed for run ${id}:`, err)
        )
      )
    );
  }
  console.log("[Eval] Inline sweep complete");
}

/**
 * Queue or run an evaluation check for a run.
 *
 * Concurrency safety: the DB-level atomic updateMany with
 * `status: { notIn: ["EVALUATING", "COMPLETE"] }` is the authoritative
 * guard against duplicate evaluations. It works correctly across multiple
 * processes and pods. There is NO in-process lock here — that pattern gives
 * false safety in multi-process deployments.
 */
export async function runEvaluationCheck(runId: string) {
  if (useQueue) {
    try {
      await queueModule.queueEvaluationCheck(runId);
      return;
    } catch (err) {
      // Redis dropped post-startup — surface in health check and fall through to inline
      console.error(`[Eval] BullMQ queue failed — falling back to inline execution: ${err}`);
      useQueue = false;
      setQueueHealth(false);
    }
  }

  // ── Inline execution ─────────────────────────────────────────────
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) return;

  const hasData = run.callLog != null || run.transcript != null || run.webhookData != null;
  if (!hasData) return;

  // Atomic claim — only one caller wins; others see count === 0 and skip.
  // PENDING_REVIEW runs must not be claimed here — they wait for human review.
  const claimed = await prisma.run.updateMany({
    where: { id: runId, status: { notIn: ["EVALUATING", "COMPLETE", "PENDING_REVIEW"] } },
    data: { status: "EVALUATING" },
  });
  if (claimed.count === 0) {
    console.log(`[Eval] Run ${runId} already claimed or complete — skipping`);
    return;
  }

  const EVAL_TIMEOUT_MS = 5 * 60 * 1000;
  try {
    const result = await Promise.race([
      evaluateRun(runId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Evaluation timed out after 5 minutes")), EVAL_TIMEOUT_MS)
      ),
    ]);
    console.log(`[Eval] Run ${runId} complete. Score: ${result.overallScore}`);
  } catch (err) {
    console.error(`[Eval] Run ${runId} failed: ${err}`);
    await prisma.run.update({
      where: { id: runId },
      data: { status: "FAILED", errorLog: (err as Error).message },
    });
  }
}

/**
 * Fetch call log for a run with retry, then trigger evaluation.
 */
export async function runCallLogFetch(runId: string, callId: string, apiKey?: string) {
  if (useQueue) {
    try {
      await queueModule.queueCallLogFetch(runId, callId);
      return;
    } catch (err) {
      console.error(`[Eval] BullMQ queue failed for log fetch — falling back to inline: ${err}`);
      useQueue = false;
      setQueueHealth(false);
    }
  }

  const maxRetries = 3;
  const retryDelayMs = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const logData = await fetchCallLog(callId, apiKey);
      const hasData = Array.isArray(logData) ? logData.length > 0 : logData != null;
      if (!hasData && attempt < maxRetries) {
        console.log(`[Eval] Call log empty for run ${runId}, retry ${attempt}/${maxRetries}...`);
        await delay(retryDelayMs * attempt);
        continue;
      }
      await prisma.run.update({
        where: { id: runId },
        data: { callLog: logData as any },
      });
      console.log(`[Eval] Call log fetched for run ${runId} (attempt ${attempt})`);
      await runEvaluationCheck(runId);
      return;
    } catch (err) {
      if (attempt < maxRetries) {
        console.log(`[Eval] Call log fetch failed for run ${runId}, retry ${attempt}/${maxRetries}: ${err}`);
        await delay(retryDelayMs * attempt);
      } else {
        console.error(`[Eval] Failed to fetch call log for run ${runId} after ${maxRetries} attempts: ${err}`);
        try {
          await runEvaluationCheck(runId);
        } catch (evalErr) {
          console.error(`[Eval] Evaluation also failed for run ${runId}: ${evalErr}`);
        }
      }
    }
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
