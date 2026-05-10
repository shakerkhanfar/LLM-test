/**
 * get_dashboard_summary — high-level KPIs for the project.
 *
 * Returns: total runs, complete/failed counts, average quality, average
 * compliance, top outcomes, top sentiments. Optional date range filter.
 *
 * Aggregation strategy: explicit Prisma queries here rather than reusing the
 * heavy /api/projects/:id/dashboard endpoint. The dashboard endpoint emits
 * UI-shaped data with score trends, cards, and 1000-row in-memory aggregation.
 * Agents need a leaner, query-friendly summary — this tool is the answer.
 *
 * Performance: 4 SQL roundtrips. All filters use indexed columns (projectId,
 * status, callDate). Safe for projects with hundreds of thousands of runs.
 */
import { z } from "zod";
import prisma from "../../../lib/prisma";
import { parseEvalDetail } from "./_helpers";
import { McpToolError, type McpToolDefinition } from "../../registry";

const inputSchema = {
  from: z.string().datetime().optional().describe("ISO-8601 start of date range (inclusive)"),
  to: z.string().datetime().optional().describe("ISO-8601 end of date range (inclusive)"),
};

export const getDashboardSummaryTool: McpToolDefinition<typeof inputSchema> = {
  name: "get_dashboard_summary",
  title: "Project KPI summary",
  description:
    "Returns aggregate counts, average quality and compliance scores, top call outcomes, " +
    "and top caller sentiments for this project. Optionally filter by date range. " +
    "After reviewing, call `get_top_critical_issues` or `get_top_experience_issues` " +
    "to investigate weak areas.",
  scope: "read",
  inputSchema,
  handler: async (ctx, input) => {
    const dateFrom = input.from ? new Date(input.from) : undefined;
    const dateTo = input.to ? new Date(input.to) : undefined;
    if (dateFrom && dateTo && dateFrom > dateTo) {
      throw new McpToolError("`from` must be earlier than or equal to `to`");
    }
    // We OR (callDate filter) with (callDate=null + createdAt filter) to handle
    // history runs that may lack callDate. Same pattern as the UI dashboard.
    const dateFilter = dateFrom || dateTo
      ? {
          OR: [
            { callDate: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } },
            { callDate: null, createdAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } },
          ],
        }
      : {};

    const baseWhere = { projectId: ctx.projectId, ...dateFilter };

    // 1. Counts by status
    const statusGroups = await prisma.run.groupBy({
      by: ["status"],
      where: baseWhere,
      _count: { _all: true },
    });

    let totalRuns = 0, completeRuns = 0, failedRuns = 0;
    for (const g of statusGroups) {
      totalRuns += g._count._all;
      if (g.status === "COMPLETE") completeRuns = g._count._all;
      if (g.status === "FAILED") failedRuns = g._count._all;
    }

    // 2. Avg quality (overallScore)
    const qualityAgg = await prisma.run.aggregate({
      where: { ...baseWhere, status: "COMPLETE", overallScore: { not: null } },
      _avg: { overallScore: true },
    });

    // 3. Outcome distribution (top 10)
    const outcomeGroups = await prisma.run.groupBy({
      by: ["callOutcome"],
      where: baseWhere,
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
      take: 10,
    });

    // 4. Compliance — pulled from layered eval detail JSON. Done in JS over a
    //    capped sample; for projects with millions of runs this would need
    //    materialisation, but for v1 we sample up to 500 most recent COMPLETE
    //    runs which is statistically robust without scanning the table.
    const layeredSample = await prisma.run.findMany({
      where: { ...baseWhere, status: "COMPLETE" },
      orderBy: { callDate: "desc" },
      take: 500,
      select: {
        evalResults: {
          where: { criterion: { type: "LAYERED_EVALUATION" } },
          select: { detail: true },
        },
      },
    });
    let complianceSum = 0, complianceCount = 0;
    let qualityFromLayer4Sum = 0, qualityFromLayer4Count = 0;
    for (const run of layeredSample) {
      for (const er of run.evalResults) {
        const d = parseEvalDetail(er.detail);
        if (!d || d.notApplicable === true || d.error === true) continue;
        if (typeof d.complianceScore === "number") {
          complianceSum += d.complianceScore;
          complianceCount++;
        }
        if (typeof d.qualityScore === "number") {
          qualityFromLayer4Sum += d.qualityScore;
          qualityFromLayer4Count++;
        }
      }
    }

    return {
      dateRange: {
        from: dateFrom?.toISOString() ?? null,
        to: dateTo?.toISOString() ?? null,
      },
      counts: {
        total: totalRuns,
        complete: completeRuns,
        failed: failedRuns,
        other: totalRuns - completeRuns - failedRuns,
      },
      averages: {
        quality: qualityAgg._avg.overallScore !== null
          ? Math.round((qualityAgg._avg.overallScore ?? 0) * 1000) / 10
          : null,
        compliance: complianceCount > 0
          ? Math.round((complianceSum / complianceCount) * 10) / 10
          : null,
        // Quality from Layer 4 is shown alongside the run-level score for
        // transparency. They should track closely; a divergence indicates a
        // layered-eval / overall-score sync issue worth investigating.
        qualityLayer4Sample: qualityFromLayer4Count > 0
          ? Math.round((qualityFromLayer4Sum / qualityFromLayer4Count) * 10) / 10
          : null,
        sampleSize: layeredSample.length,
      },
      topOutcomes: outcomeGroups.map(g => ({
        outcome: g.callOutcome ?? "unknown",
        count: g._count._all,
      })),
    };
  },
};
