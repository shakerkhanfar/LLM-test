import { PrismaClient } from "@prisma/client";
import { evaluateRun } from "./evaluator";
import { fetchCallLog } from "./hamsaApi";

const prisma = new PrismaClient();

let useQueue = false;
let queueModule: any = null;

/**
 * Try to initialize BullMQ. If Redis isn't available, fall back to inline execution.
 */
export async function initQueue() {
  try {
    // Test Redis connection first
    const IORedis = (await import("ioredis")).default;
    const testConn = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      connectTimeout: 2000,
      retryStrategy: () => null, // Don't retry
    });
    testConn.on("error", () => {}); // Suppress error events
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
 */
export async function runEvaluationCheck(runId: string) {
  if (useQueue) {
    await queueModule.queueEvaluationCheck(runId);
    return;
  }

  // Inline execution
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) return;

  const hasData = run.callLog != null || run.transcript != null;
  if (!hasData) return;

  if (run.status !== "EVALUATING" && run.status !== "COMPLETE") {
    await prisma.run.update({
      where: { id: runId },
      data: { status: "EVALUATING" },
    });
  }

  try {
    const result = await evaluateRun(runId);
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
 * Queue or run call log fetch.
 */
export async function runCallLogFetch(runId: string, callId: string, apiKey?: string) {
  if (useQueue) {
    await queueModule.queueCallLogFetch(runId, callId);
    return;
  }

  // Inline execution
  try {
    const logData = await fetchCallLog(callId, apiKey);
    await prisma.run.update({
      where: { id: runId },
      data: { callLog: logData as any },
    });
    console.log(`[Eval] Call log fetched for run ${runId}`);
    await runEvaluationCheck(runId);
  } catch (err) {
    console.error(`[Eval] Failed to fetch call log for run ${runId}: ${err}`);
  }
}
