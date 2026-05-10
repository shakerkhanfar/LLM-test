/**
 * apply_node_prompt_fix — pushes a prompt rewrite to the Hamsa agent and
 * updates the local agent structure cache.
 *
 * Two-phase by default:
 *   1) Dry run (no `confirm: true`) — returns oldPrompt + newPrompt + diff.
 *   2) Real apply (`confirm: true`) — pushes to Hamsa, updates DB, audit-logs.
 *
 * This is intentionally NOT idempotent against external state — Hamsa's API
 * will accept a new prompt every time even if it equals the existing one. We
 * short-circuit when `oldPrompt === newPrompt` to avoid no-op API calls and
 * meaningless audit entries.
 *
 * Failure modes handled:
 *   - Project not found / wrong project → McpToolError (404-equivalent)
 *   - Node id missing in agent structure → McpToolError
 *   - Hamsa API failure → McpToolError with the underlying message; the local
 *     agent structure is NOT updated, leaving DB and Hamsa consistent.
 */
import { z } from "zod";
import prisma from "../../../lib/prisma";
import { updateAgentWorkflow } from "../../../services/hamsaApi";
import { McpToolError, type McpToolDefinition } from "../../registry";
import {
  reasonField, confirmField, auditMcpWrite,
  compactDiff, dryRunResult, assertWriteScope,
} from "./_helpers";

const inputSchema = {
  nodeId: z.string().min(1)
    .describe("Workflow node id (from get_agent_structure or get_node_performance)"),
  newPrompt: z.string().min(1).max(50_000)
    .describe("The full replacement prompt for this node. Will overwrite the existing message."),
  reason: reasonField,
  confirm: confirmField.optional()
    .describe("Set to `true` to apply. Omit for a dry-run preview that returns the diff."),
};

export const applyNodePromptFixTool: McpToolDefinition<typeof inputSchema> = {
  name: "apply_node_prompt_fix",
  title: "Update a workflow node's prompt",
  description:
    "Pushes a new prompt to a workflow node on the Hamsa agent. By default runs as a dry-run " +
    "showing the diff; pass `confirm: true` to actually apply the change. Returns the OLD prompt " +
    "in the response so you can revert if needed. Audit-logged with your reason.",
  scope: "read_write",
  inputSchema,
  handler: async (ctx, input) => {
    assertWriteScope(ctx);

    const project = await prisma.project.findUnique({
      where: { id: ctx.projectId },
      select: { agentId: true, hamsaApiKey: true, agentStructure: true },
    });
    if (!project) throw new McpToolError("Project not found");
    if (!project.agentStructure) {
      throw new McpToolError("Agent structure is not loaded for this project. Refresh from the UI first.");
    }

    const structure = project.agentStructure as any;
    const nodes: any[] = structure?.workflow?.nodes ?? [];
    const node = nodes.find((n: any) => n.id === input.nodeId);
    if (!node) throw new McpToolError(`Node ${input.nodeId} not found in agent structure`);

    const oldPrompt: string = typeof node.message === "string" ? node.message : "";
    const newPrompt = input.newPrompt;
    const diff = compactDiff(oldPrompt, newPrompt);

    if (diff.unchanged) {
      // No-op short-circuit. Don't push to Hamsa, don't audit.
      return {
        applied: false,
        unchanged: true,
        nodeId: input.nodeId,
        nodeLabel: node.label ?? null,
        message: "newPrompt is identical to the existing prompt — no change applied.",
      };
    }

    if (input.confirm !== true) {
      return dryRunResult({
        nodeId: input.nodeId,
        nodeLabel: node.label ?? null,
        diff,
      });
    }

    // Apply: build the updated nodes array and push.
    const updatedNodes = nodes.map((n: any) =>
      n.id === input.nodeId ? { ...n, message: newPrompt } : n,
    );

    try {
      await updateAgentWorkflow(project.agentId, updatedNodes, project.hamsaApiKey ?? undefined);
    } catch (err) {
      // Hamsa rejected the update. Local DB unchanged. Audit the FAILED attempt
      // so we can debug the apparent inconsistency between agent and our cache.
      await auditMcpWrite(ctx, "mcp.write.apply_node_prompt_fix.failed", input.nodeId, {
        reason: input.reason,
        nodeLabel: node.label ?? null,
        error: (err as Error).message,
      });
      throw new McpToolError(`Hamsa API rejected the update: ${(err as Error).message}`);
    }

    // Update our local copy so subsequent get_agent_structure calls see the new prompt.
    const updatedStructure = {
      ...structure,
      workflow: { ...structure.workflow, nodes: updatedNodes },
    };
    await prisma.project.update({
      where: { id: ctx.projectId },
      data: { agentStructure: updatedStructure },
    });

    await auditMcpWrite(ctx, "mcp.write.apply_node_prompt_fix", input.nodeId, {
      reason: input.reason,
      nodeLabel: node.label ?? null,
      diff: { oldLength: diff.oldLength, newLength: diff.newLength },
      // Persist the full diff so a human can review what changed.
      oldPrompt,
      newPrompt,
    });

    return {
      applied: true,
      nodeId: input.nodeId,
      nodeLabel: node.label ?? null,
      oldPrompt,
      newPrompt,
      diff,
    };
  },
};
