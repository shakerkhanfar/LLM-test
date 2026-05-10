/**
 * Shared utilities for MCP write tools.
 *
 * Defence layers stacked here:
 *  - Confirmation: every mutation requires `confirm: true`. Prevents agent
 *    hallucination from accidentally applying changes during exploration.
 *  - Reason: every mutation requires a `reason` string ≥ 10 chars. Forces the
 *    agent to articulate intent — captured verbatim in audit logs.
 *  - Audit: each write writes an AuditLog row tagged with the MCP token id,
 *    the user who issued the token, and a structured meta payload (incl. diff).
 *  - Per-token write rate limit: enforced upstream by mcpPerTokenRateLimit
 *    (already set at 120/min); writes also share that bucket. Acceptable for
 *    v1 — write tools are gated by the read_write scope which requires
 *    explicit token issuance.
 *
 * If a tool ships without these guardrails, that's a bug — never an exception.
 */
import { z } from "zod";
import prisma from "../../../lib/prisma";
import type { McpContext } from "../../context";
import { McpToolError } from "../../registry";

/** Minimum length for the `reason` field on every write tool. */
export const REASON_MIN_LENGTH = 10;

/** Reusable Zod fragments for write inputs. */
export const reasonField = z.string().min(REASON_MIN_LENGTH).max(500)
  .describe(
    "Required: short rationale for this change (≥10 chars). Stored verbatim " +
    "in the audit log so a human can later understand why the AI made this change."
  );
export const confirmField = z.literal(true)
  .describe(
    "Required: must be exactly `true` to apply the change. Without it the tool " +
    "runs in dry-run mode and returns a preview without mutating anything."
  );

/**
 * Audit log writer for MCP write tools. Pulls user identity from the token
 * record so we can attribute the change to the token-issuer (and through them,
 * to a real user). Never throws — audit failures only log, never block.
 */
export async function auditMcpWrite(
  ctx: McpContext,
  action: string,
  resourceId: string | null,
  meta: Record<string, unknown>,
): Promise<void> {
  let issuerId: string | null = null;
  try {
    const token = await prisma.mcpToken.findUnique({
      where: { id: ctx.tokenId },
      select: { createdByUserId: true },
    });
    issuerId = token?.createdByUserId ?? null;
  } catch { /* non-critical */ }

  prisma.auditLog
    .create({
      data: {
        userId: issuerId,
        userEmail: null,
        action,
        resourceId,
        meta: {
          ...meta,
          mcp: {
            tokenId: ctx.tokenId,
            tokenName: ctx.tokenName,
            projectId: ctx.projectId,
            scope: ctx.scope,
          },
        } as any,
        ip: null,
        requestId: null,
      },
    })
    .catch((err) =>
      console.error(`[McpAudit] Failed to write audit (action=${action}):`, (err as Error).message),
    );
}

/**
 * Compact unified diff helper for prompt rewrites. Returns a side-by-side
 * "OLD:" / "NEW:" view rather than a full unified diff because tool output
 * goes through size limits and has no need for git-style hunk headers.
 *
 * For very large prompts we truncate each side at 4 KiB so the response fits
 * within the registry's 512 KiB cap. Agents can call get_node_prompt for the
 * full unedited prompt before deciding.
 */
export function compactDiff(oldText: string, newText: string): {
  unchanged: boolean;
  oldPreview: string;
  newPreview: string;
  oldLength: number;
  newLength: number;
} {
  const MAX = 4096;
  return {
    unchanged: oldText === newText,
    oldPreview: oldText.length > MAX ? oldText.slice(0, MAX) + "…[truncated]" : oldText,
    newPreview: newText.length > MAX ? newText.slice(0, MAX) + "…[truncated]" : newText,
    oldLength: oldText.length,
    newLength: newText.length,
  };
}

/**
 * Produces a "this would have been the result, but you didn't pass confirm: true"
 * payload. Tools call this when `confirm` is omitted/false.
 */
export function dryRunResult<T extends Record<string, unknown>>(preview: T): {
  dryRun: true;
  applied: false;
  hint: string;
} & T {
  return {
    dryRun: true,
    applied: false,
    hint: "Set confirm: true and re-call this tool to apply the change.",
    ...preview,
  };
}

/**
 * Throw a McpToolError when a write is attempted but the tool requires
 * read_write scope. Defence in depth — the registry already filters tools
 * by scope, but a misconfigured token shouldn't slip through silently.
 */
export function assertWriteScope(ctx: McpContext): void {
  if (ctx.scope !== "read_write") {
    throw new McpToolError(
      "This tool requires a token with read_write scope. Issue a new token with write access enabled.",
    );
  }
}
