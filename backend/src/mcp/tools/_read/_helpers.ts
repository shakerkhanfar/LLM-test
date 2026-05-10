/**
 * Shared helpers for MCP read tools.
 *
 * Security guardrails:
 *  - parseEvalDetail() safely JSON.parses the EvalResult.detail string. Returns
 *    null for plain-string narratives or malformed JSON instead of throwing.
 *  - Project-scoped queries always include `projectId: ctx.projectId` so no
 *    tool can ever leak data across project boundaries.
 *  - DTOs are explicit; we never spread DB rows directly into responses.
 */
import prisma from "../../../lib/prisma";
import type { McpContext } from "../../context";
import { McpToolError } from "../../registry";

/**
 * Safe JSON parse for layered eval detail strings. Returns null on any failure
 * — callers must handle the null case rather than crashing the agent's flow.
 */
export function parseEvalDetail(raw: string | null | undefined): Record<string, any> | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Verify the project belongs to the authenticated context (defence in depth —
 * the auth middleware already binds the projectId, but tools that load
 * additional rows benefit from re-asserting).
 */
export async function loadProjectOrThrow(ctx: McpContext) {
  const project = await prisma.project.findUnique({
    where: { id: ctx.projectId },
    select: {
      id: true,
      name: true,
      agentId: true,
      description: true,
      agentSummary: true,
      evalContext: true,
      projectType: true,
      historyStartDate: true,
      historyEndDate: true,
      createdAt: true,
    },
  });
  if (!project) throw new McpToolError("Project not found");
  return project;
}

/**
 * Clamp a user-provided limit into a safe range. Default 20, max 100.
 */
export function clampLimit(limit: number | undefined, max = 100, fallback = 20): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), max);
}
