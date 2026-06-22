import prisma from "../lib/prisma";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { evaluateRun } from "../services/evaluator";
import { fetchCallLog } from "../services/hamsaApi";

// BullMQ requires maxRetriesPerRequest: null on its own dedicated connection.
// Do NOT share this with the general-purpose redis client in lib/redis.ts.
const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});
connection.on("error", (err) => {
  console.warn("[BullMQ] Redis connection error:", err.message);
});

export const evaluationQueue = new Queue("evaluation", { connection });

/**
 * Queue a check: if both callLog and transcript are present, run evaluation.
 * If not, wait — the other data source will trigger another check.
 */
export async function queueEvaluationCheck(runId: string) {
  await evaluationQueue.add("check-and-evaluate", { runId }, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  });
}

/**
 * Queue fetching the call log from Hamsa API.
 */
export async function queueCallLogFetch(runId: string, callId: string) {
  await evaluationQueue.add("fetch-call-log", { runId, callId }, {
    attempts: 5,
    backoff: { type: "exponential", delay: 3000 },
  });
}

// ─── Startup recovery ─────────────────────────────────────────────
// Only reset runs that have been EVALUATING for more than 10 minutes — this
// prevents a rolling-deploy pod from resetting runs actively being processed
// by a worker on another pod that just started up.
export async function recoverStuckRuns() {
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);
  const stuck = await prisma.run.updateMany({
    where: { status: "EVALUATING", updatedAt: { lte: staleThreshold } },
    data: { status: "PENDING" },
  });
  if (stuck.count > 0) {
    console.log(`[Worker] Recovered ${stuck.count} stuck EVALUATING run(s) → PENDING`);
  }
}

// ─── Worker ────────────────────────────────────────────────────────

export function startWorker() {
  const worker = new Worker(
    "evaluation",
    async (job) => {
      console.log(`[Worker] Processing job ${job.name} — ${job.id}`);

      if (job.name === "fetch-call-log") {
        const { runId, callId } = job.data;
        try {
          const logData = await fetchCallLog(callId);
          await prisma.run.update({
            where: { id: runId },
            data: { callLog: logData as any },
          });
          console.log(`[Worker] Call log fetched for run ${runId}`);
          // Now check if we can evaluate
          await queueEvaluationCheck(runId);
        } catch (err) {
          console.error(`[Worker] Failed to fetch call log: ${err}`);
          throw err; // BullMQ will retry
        }
        return;
      }

      if (job.name === "check-and-evaluate") {
        const { runId } = job.data;
        const run = await prisma.run.findUnique({ where: { id: runId } });

        if (!run) {
          console.log(`[Worker] Run ${runId} not found, skipping`);
          return;
        }

        // Project-level AI evaluation switch. When off, keep the ingested run + its data
        // but skip evaluation (mark COMPLETE). Mirrors the gate in runEvaluationCheck so the
        // toggle holds even for jobs enqueued via the fetch-call-log → check-and-evaluate path.
        const proj = await prisma.project.findUnique({
          where: { id: run.projectId },
          select: { evaluationEnabled: true },
        });
        if (proj?.evaluationEnabled === false) {
          // Mark ingested runs COMPLETE (no eval), but never disturb a run that's done,
          // awaiting human review, actively evaluating, or a live call in progress.
          const PROTECTED = ["COMPLETE", "PENDING_REVIEW", "EVALUATING", "RUNNING"];
          if (!PROTECTED.includes(run.status)) {
            await prisma.run.update({ where: { id: runId }, data: { status: "COMPLETE" } });
          }
          console.log(`[Worker] AI evaluation disabled for run ${runId}'s project — stored without evaluation`);
          return;
        }

        // Check if we have both data sources
        const hasCallLog = run.callLog != null;
        const hasTranscript = run.transcript != null;

        if (!hasCallLog && !hasTranscript) {
          console.log(`[Worker] Run ${runId} has no data yet, skipping`);
          return;
        }

        // Atomically claim this run for evaluation — only proceeds if status is
        // still PENDING/AWAITING_DATA/FAILED. If another worker already claimed it
        // (status became EVALUATING or COMPLETE), count === 0 and we skip.
        const claimed = await prisma.run.updateMany({
          where: { id: runId, status: { notIn: ["EVALUATING", "COMPLETE", "PENDING_REVIEW"] } },
          data: { status: "EVALUATING" },
        });
        if (claimed.count === 0) {
          console.log(`[Worker] Run ${runId} already claimed or complete, skipping`);
          return;
        }

        try {
          const result = await evaluateRun(runId);
          console.log(
            `[Worker] Evaluation complete for run ${runId}. Score: ${result.overallScore}`
          );
        } catch (err) {
          console.error(`[Worker] Evaluation failed for run ${runId}: ${err}`);
          await prisma.run.update({
            where: { id: runId },
            data: {
              status: "FAILED",
              errorLog: (err as Error).message,
            },
          });
        }
        return;
      }
    },
    { connection, concurrency: 2 }
  );

  worker.on("failed", (job, err) => {
    console.error(`[Worker] Job ${job?.name} failed: ${err.message}`);
  });

  worker.on("completed", (job) => {
    console.log(`[Worker] Job ${job.name} completed`);
  });

  console.log("[Worker] Evaluation worker started");
  return worker;
}
