/**
 * rehydrate_run — re-fetches fresh transcript + call log from Hamsa, then
 * triggers evaluation. Use this when the data IN HAMSA has changed (e.g. a
 * transcript was edited, agent recorded fresh outcomes) — `reevaluate_run`
 * only re-scores existing local data and won't pick up Hamsa-side changes.
 *
 * Cost: Hamsa API call + LLM eval = roughly $0.20-0.40 per run.
 *
 * Race with BullMQ: the run is set to PENDING here, then the Hamsa fetch
 * runs (slow, ~2s). If BullMQ picks up the PENDING run during that window
 * it would evaluate stale data; our subsequent fetch would then overwrite
 * and re-trigger. End result: at most one wasted eval, no corruption.
 * This matches the behaviour of the single-run rehydrate HTTP endpoint.
 */
import { z } from "zod";
import prisma from "../../../lib/prisma";
import { McpToolError, type McpToolDefinition } from "../../registry";
import { reasonField, confirmField, auditMcpWrite, dryRunResult, assertWriteScope } from "./_helpers";

const inputSchema = {
  runId: z.string().min(1)
    .describe("Run id to rehydrate (from list_runs / get_top_*_issues / get_node_performance)"),
  reason: reasonField,
  confirm: confirmField.optional(),
};

export const rehydrateRunTool: McpToolDefinition<typeof inputSchema> = {
  name: "rehydrate_run",
  title: "Re-fetch from Hamsa then re-evaluate",
  description:
    "Re-fetches the transcript and call log from Hamsa for one run, overwrites local data, " +
    "then triggers evaluation. Use when Hamsa-side data has been updated since the last eval. " +
    "Costs more than reevaluate_run (~$0.20-0.40). Pass `confirm: true` to apply.",
  scope: "read_write",
  inputSchema,
  handler: async (ctx, input) => {
    assertWriteScope(ctx);

    const run = await prisma.run.findUnique({
      where: { id: input.runId },
      select: {
        id: true, projectId: true, status: true,
        hamsaCallId: true, conversationId: true,
        project: { select: { hamsaApiKey: true } },
      },
    });
    if (!run || run.projectId !== ctx.projectId) {
      throw new McpToolError("Run not found");
    }
    if (!run.hamsaCallId && !run.conversationId) {
      throw new McpToolError("Run has neither hamsaCallId nor conversationId — cannot rehydrate from Hamsa");
    }
    if (run.status === "EVALUATING" || run.status === "RUNNING") {
      throw new McpToolError(`Run is currently ${run.status} — wait for it to finish before rehydrating.`);
    }

    if (input.confirm !== true) {
      return dryRunResult({
        runId: run.id,
        currentStatus: run.status,
        hasHamsaIds: !!(run.hamsaCallId || run.conversationId),
        estimatedCostUsd: 0.30,
      });
    }

    // Claim the run by transitioning to PENDING. Same pattern as /runs/:id/rehydrate.
    const claimed = await prisma.run.updateMany({
      where: { id: run.id, status: { notIn: ["EVALUATING"] } },
      data: { status: "PENDING" },
    });
    if (claimed.count === 0) {
      throw new McpToolError("Could not claim run for rehydration — another process may be evaluating it");
    }

    // Lazy import to avoid pulling Hamsa API client into the auth path on
    // every read tool's request graph.
    const { fetchCallLog, fetchConversation, extractTranscriptFromConversation } =
      await import("../../../services/hamsaApi");
    const { runEvaluationCheck } = await import("../../../services/evaluationRunner");
    const apiKey = run.project.hamsaApiKey ?? undefined;
    const logJobId = run.conversationId || run.hamsaCallId!;

    // Fetch call log (required); if it fails, mark FAILED so the run isn't stuck PENDING.
    let freshCallLog: any;
    try {
      freshCallLog = await fetchCallLog(logJobId, apiKey);
    } catch (err) {
      await prisma.run.update({
        where: { id: run.id },
        data: { status: "FAILED", errorLog: `Rehydrate (MCP): call log fetch failed: ${(err as Error).message}` },
      });
      await auditMcpWrite(ctx, "mcp.write.rehydrate_run.failed", run.id, {
        reason: input.reason, error: (err as Error).message, stage: "fetchCallLog",
      });
      throw new McpToolError(`Hamsa call log fetch failed: ${(err as Error).message}`);
    }

    // Fetch conversation (transcript + metadata) — non-fatal on failure.
    let freshWebhookData: any;
    let freshTranscript: any[] | undefined;
    try {
      const conv = await fetchConversation(logJobId, apiKey);
      freshWebhookData = conv;
      const extracted = extractTranscriptFromConversation(conv);
      if (extracted && extracted.length > 0) freshTranscript = extracted;
    } catch { /* non-fatal — call log may carry transcript */ }

    const updatePayload: Record<string, any> = { callLog: freshCallLog };
    if (freshWebhookData !== undefined) updatePayload.webhookData = freshWebhookData;
    if (freshTranscript !== undefined) updatePayload.transcript = freshTranscript;

    // Atomically clear stale eval results and persist fresh data.
    await prisma.$transaction([
      prisma.evalResult.deleteMany({ where: { runId: run.id } }),
      prisma.run.update({
        where: { id: run.id },
        data: { ...updatePayload, overallScore: null, evalCost: null, errorLog: null },
      }),
    ]);

    runEvaluationCheck(run.id).catch((err) =>
      console.error(`[Mcp.rehydrate_run] eval trigger failed for ${run.id}:`, (err as Error).message),
    );

    await auditMcpWrite(ctx, "mcp.write.rehydrate_run", run.id, {
      reason: input.reason,
      previousStatus: run.status,
    });

    return {
      applied: true,
      runId: run.id,
      newStatus: "PENDING",
      transcriptRefreshed: !!freshTranscript,
      message: "Rehydration completed. Evaluation queued. Poll get_run_breakdown for results.",
    };
  },
};
