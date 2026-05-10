/**
 * Agent-structure inspection tools.
 *
 *   get_agent_structure   — workflow nodes + edges (compact)
 *   get_node_prompt       — single node's full prompt + transitions for surgical fix proposals
 *
 * Sanitisation: hamsaApiKey, webhookSecret, raw API tokens that may live in
 * agentStructure.tools[*].overrides.authToken / serverUrl are NEVER returned.
 * We strip the entire `tools` block from agent structure responses; agents
 * working on prompt-level analysis don't need tool definitions.
 */
import { z } from "zod";
import prisma from "../../../lib/prisma";
import { McpToolError, type McpToolDefinition } from "../../registry";

// Recursively redact sensitive keys anywhere in a JSON object. Used as a
// defence-in-depth pass before returning any agent-structure data. Matches
// keys case-insensitively to handle variations like "Authorization" /
// "authorization", "X-API-Key" / "x-api-key".
const REDACT_KEYS = new Set([
  "authtoken", "apikey", "secret", "password", "token", "bearer",
  "x-api-key", "x-hamsa-api-key", "authorization", "credentials",
  "private_key", "privatekey", "client_secret", "clientsecret",
]);
// Pattern to mask tokens embedded in URLs (e.g. "https://api/?key=abc123").
// We walk strings and redact common credential-looking query params.
const URL_CRED_PATTERN = /([?&](?:api[_-]?key|token|secret|access[_-]?token|auth)=)[^&\s]+/gi;

function redactString(s: string): string {
  return s.replace(URL_CRED_PATTERN, "$1[redacted]");
}

function deepRedact(value: any): any {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (REDACT_KEYS.has(k.toLowerCase())) {
        out[k] = "[redacted]";
      } else {
        out[k] = deepRedact(v);
      }
    }
    return out;
  }
  return value;
}

// ─── get_agent_structure ──────────────────────────────────────────────
export const getAgentStructureTool: McpToolDefinition = {
  name: "get_agent_structure",
  title: "Workflow nodes and edges",
  description:
    "Returns the agent's workflow graph: every node (id, label, type, message-prompt summary) " +
    "and every edge (source, target, condition). Use this to understand the conversation " +
    "flow before suggesting prompt fixes. For a single node's full prompt, call `get_node_prompt`.",
  scope: "read",
  handler: async (ctx) => {
    const project = await prisma.project.findUnique({
      where: { id: ctx.projectId },
      select: { agentStructure: true, agentId: true },
    });
    if (!project) throw new McpToolError("Project not found");
    if (!project.agentStructure) {
      return { agentId: project.agentId, nodes: [], edges: [], note: "No agent structure available." };
    }

    const struct = project.agentStructure as any;
    const wf = struct?.workflow ?? {};
    const nodes: any[] = Array.isArray(wf.nodes) ? wf.nodes : [];
    const edges: any[] = Array.isArray(wf.edges) ? wf.edges : [];

    // For each node return only what an agent needs to navigate. Skip the
    // full message prompt (large) — fetch it explicitly via get_node_prompt
    // when needed. This keeps the response compact for projects with many nodes.
    return {
      agentId: project.agentId,
      agentName: deepRedact(struct.name) ?? null,
      voice: deepRedact(struct.voice ? { lang: struct.voice.lang, dialect: struct.voice.ttsParams?.dialect } : null),
      llm: deepRedact(struct.llm ? { model: struct.llm.model, temperature: struct.llm.temperature } : null),
      nodes: nodes.map(n => ({
        id: n.id,
        label: n.label || "",
        type: n.type,
        // Just a 200-char preview of the prompt so the agent can decide
        // which node to drill into. Full prompt via get_node_prompt.
        messagePreview: typeof n.message === "string" ? n.message.slice(0, 200) : null,
        transitionCount: Array.isArray(n.transitions) ? n.transitions.length : 0,
      })),
      edges: edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
      })),
    };
  },
};

// ─── get_node_prompt ──────────────────────────────────────────────────
const getNodePromptInput = {
  nodeId: z.string().min(1).describe("Workflow node id (from get_agent_structure or get_node_performance)"),
};

export const getNodePromptTool: McpToolDefinition<typeof getNodePromptInput> = {
  name: "get_node_prompt",
  title: "Single node prompt + transitions",
  description:
    "Returns the full message prompt, transitions (with conditions), variable extraction " +
    "config, and timeout for one workflow node. Use this when proposing a surgical fix " +
    "to a node's prompt.",
  scope: "read",
  inputSchema: getNodePromptInput,
  handler: async (ctx, input) => {
    const project = await prisma.project.findUnique({
      where: { id: ctx.projectId },
      select: { agentStructure: true },
    });
    if (!project?.agentStructure) throw new McpToolError("Agent structure not available");

    const wf = (project.agentStructure as any)?.workflow ?? {};
    const node = (wf.nodes as any[] | undefined)?.find(n => n.id === input.nodeId);
    if (!node) throw new McpToolError(`Node ${input.nodeId} not found`);

    return deepRedact({
      id: node.id,
      label: node.label,
      type: node.type,
      message: node.message,
      messageType: node.messageType,
      timeout: node.timeout,
      transitions: Array.isArray(node.transitions) ? node.transitions.map((t: any) => ({
        id: t.id,
        priority: t.priority,
        condition: t.condition,
        targetNodeId: t.targetNodeId,
      })) : [],
      extractVariables: node.extractVariables ?? null,
      isGlobal: node.isGlobal ?? false,
      requiresDoubleConfirm: node.requiresDoubleConfirm ?? false,
    });
  },
};
