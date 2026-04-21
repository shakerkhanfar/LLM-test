import prisma from "../lib/prisma";
import { PrismaClient } from "@prisma/client";
import { evaluateRun } from "./evaluator";
import { fetchCallLog } from "./hamsaApi";


let useQueue = false;
let queueModule: any = null;

// Per-run in-process lock: prevents concurrent evaluations of the same run
const evaluatingRuns = new Set<string>();

/**
 * Try to initialize BullMQ. If Redis isn't available, fall back to inline execution.
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
    queueModule.startWorker();
    useQueue = true;
    console.log("[Eval] Using BullMQ queue for evaluations");
  } catch {
    useQueue = false;
    console.log("[Eval] Redis not available — evaluations will run inline");
  }
}

/**
 * Queue or run evaluation check for a run.
 * Includes an in-process lock to prevent duplicate concurrent evaluations.
 */
export async function runEvaluationCheck(runId: string) {
  if (useQueue) {
    try {
      await queueModule.queueEvaluationCheck(runId);
      return;
    } catch (err) {
      // Redis dropped post-startup — fall through to inline execution
      console.warn(`[Eval] BullMQ queue failed, falling back to inline: ${err}`);
      useQueue = false;
    }
  }

  // Inline execution with concurrency guard
  if (evaluatingRuns.has(runId)) {
    console.log(`[Eval] Run ${runId} is already being evaluated — skipping duplicate`);
    return;
  }

  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) return;

  // webhookData (the full conv object) is also sufficient — transcript may be inside it
  const hasData = run.callLog != null || run.transcript != null || run.webhookData != null;
  if (!hasData) return;

  // Double-check status in DB to guard against race conditions across processes
  if (run.status === "EVALUATING" || run.status === "COMPLETE") {
    console.log(`[Eval] Run ${runId} already in status ${run.status} — skipping`);
    return;
  }

  // Atomic status update: only proceed if we successfully transition to EVALUATING
  // The WHERE clause prevents two concurrent calls from both proceeding
  const updated = await prisma.run.updateMany({
    where: { id: runId, status: { notIn: ["EVALUATING", "COMPLETE"] } },
    data: { status: "EVALUATING" },
  });
  if (updated.count === 0) {
    console.log(`[Eval] Run ${runId} was claimed by another process — skipping`);
    return;
  }

  evaluatingRuns.add(runId);
  try {
    const result = await evaluateRun(runId);
    console.log(`[Eval] Run ${runId} complete. Score: ${result.overallScore}`);
  } catch (err) {
    console.error(`[Eval] Run ${runId} failed: ${err}`);
    await prisma.run.update({
      where: { id: runId },
      data: { status: "FAILED", errorLog: (err as Error).message },
    });
  } finally {
    evaluatingRuns.delete(runId);
  }
}

/**
 * Fetch call log for a run, with retry, then trigger evaluation.
 */
export async function runCallLogFetch(runId: string, callId: string, apiKey?: string) {
  if (useQueue) {
    try {
      await queueModule.queueCallLogFetch(runId, callId);
      return;
    } catch (err) {
      console.warn(`[Eval] BullMQ queue failed for log fetch, falling back to inline: ${err}`);
      useQueue = false;
    }
  }

  // Inline execution with retry (Hamsa API may not have logs ready immediately)
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
        // Still trigger evaluation with whatever data we have (transcript may be enough)
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
