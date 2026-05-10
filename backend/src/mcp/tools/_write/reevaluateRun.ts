/**
 * reevaluate_run — re-runs evaluation against EXISTING local data for one run.
 * Use after the eval prompt or criteria have changed and you want to re-score
 * existing transcripts without re-fetching them from Hamsa.
 *
 * Cost note: each invocation triggers Layer 2/3/4 LLM evaluation, costing
 * roughly $0.10-0.30 per run (model-dependent). The `confirm` gate exists
 * to prevent accidental cost explosions from a buggy agent loop.
 *
 * Idempotency: re-running on a still-PENDING run is a no-op (the existing
 * eval will pick up). On COMPLETE/FAILED runs we delete prior eval results
 * and reset to PENDING. The actual eval then runs asynchronously — the agent
 * gets back a status of "queued" and can poll via get_run_breakdown later.
 */
import { z } from "zod";
import prisma from "../../../lib/prisma";
import { runEvaluationCheck } from "../../../services/evaluationRunner";
import { McpToolError, type McpToolDefinition } from "../../registry";
import { reasonField, confirmField, auditMcpWrite, dryRunResult, assertWriteScope } from "./_helpers";

const inputSchema = {
  runId: z.string().min(1)
    .describe("Run id to re-evaluate (from list_runs / get_top_*_issues / get_node_performance)"),
  reason: reasonField,
  confirm: confirmField.optional()
    .describe("Set to `true` to actually queue the re-evaluation. Omit for a dry-run."),
};

export const reevaluateRunTool: McpToolDefinition<typeof inputSchema> = {
  name: "reevaluate_run",
  title: "Re-run evaluation on a single run",
  description:
    "Triggers a fresh evaluation pass on a run, using the EXISTING transcript and call log. " +
    "Useful after eval prompts or criteria have changed. Costs roughly $0.10-0.30 per run. " +
    "Pass `confirm: true` to enqueue. Use `rehydrate_run` instead if the underlying call data " +
    "in Hamsa has changed since the last evaluation.",
  scope: "read_write",
  inputSchema,
  handler: async (ctx, input) => {
    assertWriteScope(ctx);

    const run = await prisma.run.findUnique({
      where: { id: input.runId },
      select: { id: true, projectId: true, status: true, callDate: true, callOutcome: true },
    });
    if (!run || run.projectId !== ctx.projectId) {
      throw new McpToolError("Run not found");
    }

    if (run.status === "EVALUATING" || run.status === "RUNNING") {
      throw new McpToolError(
        `Run is currently ${run.status} — wait for it to finish before re-evaluating.`,
      );
    }

    if (input.confirm !== true) {
      return dryRunResult({
        runId: run.id,
        currentStatus: run.status,
        callDate: run.callDate,
        callOutcome: run.callOutcome,
        // Order-of-magnitude estimate. Actual cost depends on transcript
        // length and model — see the run's evalCost field after completion.
        estimatedCostUsdOrderOfMagnitude: 0.2,
      });
    }

    // Same pattern as the existing /runs/:id/evaluate endpoint.
    await prisma.$transaction([
      prisma.evalResult.deleteMany({ where: { runId: run.id } }),
      prisma.run.update({
        where: { id: run.id },
        data: { status: "PENDING", overallScore: null, evalCost: null, errorLog: null },
      }),
    ]);

    // Trigger eval async — failures here are logged but don't fail the call,
    // because the run is already in PENDING state and BullMQ recovery will
    // eventually pick it up.
    runEvaluationCheck(run.id).catch((err) =>
      console.error(`[Mcp.reevaluate_run] eval trigger failed for ${run.id}:`, (err as Error).message),
    );

    await auditMcpWrite(ctx, "mcp.write.reevaluate_run", run.id, {
      reason: input.reason,
      previousStatus: run.status,
    });

    return {
      applied: true,
      runId: run.id,
      newStatus: "PENDING",
      message: "Re-evaluation queued. Poll get_run_breakdown for results.",
    };
  },
};
