/**
 * get_project_overview — orientation tool. Returns project name, agent
 * summary, criteria types, and eval rule presence.
 *
 * Privacy: hamsaApiKey, webhookSecret, organizationId, ownership info, raw
 * agentStructure are NOT included. The eval context (custom evaluation rules)
 * is summarised by character length — callers can request the full text via
 * a future tool if needed (currently considered too sensitive to return wholesale).
 */
import prisma from "../../../lib/prisma";
import { loadProjectOrThrow } from "./_helpers";
import type { McpToolDefinition } from "../../registry";

export const getProjectOverviewTool: McpToolDefinition = {
  name: "get_project_overview",
  title: "Project overview",
  description:
    "Returns this project's name, type, agent summary, criteria types, and a high-level " +
    "configuration snapshot. Call this first to orient yourself before diving into the " +
    "dashboard or specific runs. After this, call `get_dashboard_summary` for KPIs.",
  scope: "read",
  handler: async (ctx) => {
    const project = await loadProjectOrThrow(ctx);

    const criteria = await prisma.criterion.findMany({
      where: { projectId: ctx.projectId },
      select: { key: true, label: true, type: true, weight: true },
      orderBy: { createdAt: "asc" },
    });

    return {
      name: project.name,
      description: project.description,
      projectType: project.projectType,
      agentId: project.agentId,
      agentSummary: project.agentSummary,
      hasEvalContext: !!project.evalContext,
      evalContextLength: project.evalContext?.length ?? 0,
      historyDateRange: project.historyStartDate && project.historyEndDate
        ? { from: project.historyStartDate, to: project.historyEndDate }
        : null,
      createdAt: project.createdAt,
      criteria: criteria.map(c => ({
        key: c.key,
        label: c.label,
        type: c.type,
        weight: c.weight,
      })),
    };
  },
};
