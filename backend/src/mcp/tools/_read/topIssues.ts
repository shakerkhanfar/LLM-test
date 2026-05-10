/**
 * get_top_critical_issues / get_top_experience_issues / get_node_performance
 *
 * Aggregate Layer 4 issues across COMPLETE runs and return the most common
 * patterns with affected run IDs so the agent can drill into specific calls.
 *
 * Critical issues = real agent failures (hallucination, stuck, wrong info).
 * Experience issues = user-impacting situations the agent didn't cause
 *   (system limitations, no availability, etc.).
 * Node performance = per-node quality breakdown for surgical analysis.
 *
 * Aggregation runs in JS over a capped sample (default 1000 most recent runs)
 * because the data we need is buried in a JSON column. For a production
 * deployment with hundreds of thousands of runs we should materialise these
 * counts into a derived table — that's a Phase 4 optimisation.
 */
import { z } from "zod";
import prisma from "../../../lib/prisma";
import { parseEvalDetail, clampLimit } from "./_helpers";
import type { McpToolDefinition } from "../../registry";

const SAMPLE_CAP = 1000;

async function loadLayeredDetails(projectId: string) {
  const runs = await prisma.run.findMany({
    where: { projectId, status: "COMPLETE" },
    orderBy: { callDate: "desc" },
    take: SAMPLE_CAP,
    select: {
      id: true,
      conversationId: true,
      callDate: true,
      callOutcome: true,
      overallScore: true,
      evalResults: {
        where: { criterion: { type: "LAYERED_EVALUATION" } },
        select: { detail: true },
      },
    },
  });
  return runs;
}

const inputSchema = {
  limit: z.number().int().positive().max(50).optional()
    .describe("Maximum number of distinct issue patterns to return (default 10, max 50)"),
};

// ─── get_top_critical_issues ──────────────────────────────────────────
export const getTopCriticalIssuesTool: McpToolDefinition<typeof inputSchema> = {
  name: "get_top_critical_issues",
  title: "Top critical issues",
  description:
    "Aggregates real agent failures (hallucination, stuck, wrong information, broken flow) " +
    "across recent runs. Each entry includes the issue text, occurrence count, and a list " +
    "of affected run IDs. Pass any run ID to `get_run_breakdown` to inspect what happened.",
  scope: "read",
  inputSchema,
  handler: async (ctx, input) => {
    const limit = clampLimit(input.limit, 50, 10);
    const runs = await loadLayeredDetails(ctx.projectId);
    const issueMap = new Map<string, { severity: string; count: number; runIds: Set<string> }>();

    for (const run of runs) {
      for (const er of run.evalResults) {
        const detail = parseEvalDetail(er.detail);
        if (!detail || detail.notApplicable === true || detail.error === true) continue;
        if (!Array.isArray(detail.criticalIssues)) continue;
        for (const raw of detail.criticalIssues) {
          const text = typeof raw === "string" ? raw : (raw?.text ?? "").toString();
          const severity = typeof raw === "object" && raw?.severity ? String(raw.severity) : "critical";
          const key = text.trim().toLowerCase();
          if (!key) continue;
          const entry = issueMap.get(key) ?? { severity, count: 0, runIds: new Set() };
          if (!entry.runIds.has(run.id)) {
            entry.runIds.add(run.id);
            entry.count++;
          }
          issueMap.set(key, entry);
        }
      }
    }

    const issues = Array.from(issueMap.entries())
      .map(([text, e]) => ({
        text,
        severity: e.severity,
        count: e.count,
        // Cap the run id list so the response stays compact even for very
        // common issues. The total `count` reflects the full population.
        affectedRunIds: Array.from(e.runIds).slice(0, 25),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    return {
      sampleSize: runs.length,
      issues,
    };
  },
};

// ─── get_top_experience_issues ────────────────────────────────────────
export const getTopExperienceIssuesTool: McpToolDefinition<typeof inputSchema> = {
  name: "get_top_experience_issues",
  title: "Top experience issues",
  description:
    "Aggregates non-agent-fault issues across runs — system limitations, no availability, " +
    "missing capabilities, caller frustration not caused by agent error. These are product / " +
    "ops insights, not agent quality problems. Each entry includes affected run IDs for drill-down.",
  scope: "read",
  inputSchema,
  handler: async (ctx, input) => {
    const limit = clampLimit(input.limit, 50, 10);
    const runs = await loadLayeredDetails(ctx.projectId);
    const issueMap = new Map<string, { count: number; runIds: Set<string> }>();

    for (const run of runs) {
      for (const er of run.evalResults) {
        const detail = parseEvalDetail(er.detail);
        if (!detail || detail.notApplicable === true || detail.error === true) continue;
        if (!Array.isArray(detail.experienceIssues)) continue;
        for (const raw of detail.experienceIssues) {
          const text = typeof raw === "string" ? raw : (raw?.text ?? "").toString();
          const key = text.trim().toLowerCase();
          if (!key) continue;
          const entry = issueMap.get(key) ?? { count: 0, runIds: new Set() };
          if (!entry.runIds.has(run.id)) {
            entry.runIds.add(run.id);
            entry.count++;
          }
          issueMap.set(key, entry);
        }
      }
    }

    const issues = Array.from(issueMap.entries())
      .map(([text, e]) => ({
        text,
        count: e.count,
        affectedRunIds: Array.from(e.runIds).slice(0, 25),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    return { sampleSize: runs.length, issues };
  },
};

// ─── get_node_performance ─────────────────────────────────────────────
export const getNodePerformanceTool: McpToolDefinition<typeof inputSchema> = {
  name: "get_node_performance",
  title: "Per-workflow-node quality",
  description:
    "Returns per-node average quality, evaluation count, and a sample of run IDs that " +
    "exercised each node. Sorted by lowest average score first so the weakest nodes " +
    "surface at the top. Use this to identify which workflow nodes need prompt rework. " +
    "Drill into a specific node's prompt with `get_node_prompt`.",
  scope: "read",
  inputSchema,
  handler: async (ctx, input) => {
    const limit = clampLimit(input.limit, 50, 20);
    const runs = await loadLayeredDetails(ctx.projectId);
    const nodeMap = new Map<string, { scores: number[]; runIds: Set<string>; nodeIds: Set<string> }>();

    for (const run of runs) {
      for (const er of run.evalResults) {
        const detail = parseEvalDetail(er.detail);
        if (!detail || detail.notApplicable === true || detail.error === true) continue;
        if (!Array.isArray(detail.perNode)) continue;
        for (const node of detail.perNode) {
          const label: string = node.nodeLabel || node.label || node.node || "Unknown";
          const score: number | undefined = node.overallNodeScore ?? node.score;
          if (typeof score !== "number") continue;
          const entry = nodeMap.get(label) ?? { scores: [], runIds: new Set(), nodeIds: new Set() };
          entry.scores.push(score);
          entry.runIds.add(run.id);
          if (node.nodeId) entry.nodeIds.add(String(node.nodeId));
          nodeMap.set(label, entry);
        }
      }
    }

    const nodes = Array.from(nodeMap.entries())
      .map(([label, e]) => {
        const avg = e.scores.reduce((s, x) => s + x, 0) / e.scores.length;
        return {
          label,
          // The first known nodeId — useful as input to get_node_prompt.
          nodeId: e.nodeIds.values().next().value ?? null,
          avgScore: Math.round(avg * 10) / 10,
          evalCount: e.scores.length,
          affectedRunIds: Array.from(e.runIds).slice(0, 15),
        };
      })
      .sort((a, b) => a.avgScore - b.avgScore) // weakest first
      .slice(0, limit);

    return { sampleSize: runs.length, nodes };
  },
};
