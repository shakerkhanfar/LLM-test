/**
 * get_run_tool_executions — extracts only the tool-related events from a
 * run's callLog and returns them as a clean structured list.
 *
 * Why a dedicated tool instead of telling agents to use `get_run_full`?
 *   1. Size: a full callLog can be hundreds of KB; the extracted view fits
 *      comfortably under the 512 KiB cap.
 *   2. Clarity: agents can answer "what did the agent's tools return?"
 *      without filtering INFO/DEBUG/CONVERSATION noise themselves.
 *   3. Bounded responses: each tool's response payload is summarised to keep
 *      the response compact even for tools that return large data (e.g. a
 *      physician search returning 50 doctor records).
 *
 * Privacy: we redact the same set of keys as the agent-structure tool
 * (authToken, apiKey, secret, etc.) from request and response payloads.
 * Internal Hamsa tool IDs are kept (they're not secrets) so agents can
 * cross-reference with `get_agent_structure`.
 */
import { z } from "zod";
import prisma from "../../../lib/prisma";
import { McpToolError, type McpToolDefinition } from "../../registry";

const inputSchema = {
  runId: z.string().min(1).describe("Run id (from list_runs / get_top_*_issues / etc.)"),
};

const REDACT_KEYS = new Set([
  "authtoken", "apikey", "secret", "password", "token", "bearer",
  "x-api-key", "x-hamsa-api-key", "authorization", "credentials",
]);
const URL_CRED_PATTERN = /([?&](?:api[_-]?key|token|secret|access[_-]?token|auth)=)[^&\s]+/gi;
const RESPONSE_PREVIEW_MAX_BYTES = 4096;

/**
 * Deep redact + cycle-safe walker. Same pattern as agentStructure tool but
 * inlined here so this tool doesn't import from a sibling tool (keeps the
 * read tools mutually independent).
 */
function deepRedact(value: any, seen: WeakSet<object> = new WeakSet(), depth = 0): any {
  if (depth > 30) return "[depth-limited]";
  if (typeof value === "string") return value.replace(URL_CRED_PATTERN, "$1[redacted]");
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.map(v => deepRedact(v, seen, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (REDACT_KEYS.has(k.toLowerCase())) out[k] = "[redacted]";
      else out[k] = deepRedact(v, seen, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Truncate large tool-response payloads to keep the aggregate response
 * within the registry's 512 KiB cap. Preserves the top-level shape so the
 * agent can still tell what kind of response it was, then notes the length.
 */
function summariseResponse(response: any): { preview: any; truncated: boolean; bytes: number } {
  const json = JSON.stringify(response);
  if (json.length <= RESPONSE_PREVIEW_MAX_BYTES) {
    return { preview: response, truncated: false, bytes: json.length };
  }
  // For oversized responses, keep the top-level keys + a sample of array
  // elements so the agent learns the shape without flooding context.
  if (Array.isArray(response)) {
    return {
      preview: response.slice(0, 3),
      truncated: true,
      bytes: json.length,
    };
  }
  if (response && typeof response === "object") {
    const result = response.result ?? response;
    if (result && typeof result === "object") {
      const data = (result as any).data;
      if (Array.isArray(data)) {
        return {
          preview: {
            ...response,
            result: {
              ...(result as object),
              data: data.slice(0, 3),
              dataLength: data.length,
              dataTruncated: true,
            },
          },
          truncated: true,
          bytes: json.length,
        };
      }
    }
  }
  // Fallback: return a stringified slice with a marker.
  return {
    preview: json.slice(0, RESPONSE_PREVIEW_MAX_BYTES) + "…[truncated]",
    truncated: true,
    bytes: json.length,
  };
}

interface ToolExecutionEvent {
  ts: string | null;
  toolName: string | null;
  toolId: string | null;
  args: any;
  success: boolean | null;
  response: any;
  responseTruncated: boolean;
  responseBytes: number;
  durationMs: number | null;
  errorMessage?: string;
}

/**
 * Walk the callLog and assemble one ToolExecutionEvent per "Executing Tool"
 * entry, pairing it with the subsequent "Tool Success" / "Tool Failure" /
 * "Tool API call completed" record. Order is preserved.
 *
 * The callLog shape is messy because Hamsa emits each lifecycle event as a
 * separate row (Executing → Putting on hold → Off hold → Success). We pair
 * by chronological proximity and the implicit "the next Tool Success after
 * this Tool Executing belongs to it" rule. For projects that interleave
 * concurrent tool calls this pairing may be inexact; in practice Hamsa
 * voice flows execute tools sequentially per call so we rely on that.
 */
function extractToolExecutions(callLog: any): ToolExecutionEvent[] {
  if (!Array.isArray(callLog)) return [];
  const events: ToolExecutionEvent[] = [];
  let pending: ToolExecutionEvent | null = null;
  let pendingStartTs: number | null = null;

  for (const entry of callLog) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.category !== "TOOLS") continue;
    const ts: string | null = entry.timestamp ?? entry.createdAt ?? null;
    const message: string = entry.message ?? "";
    const payload = entry.payload ?? {};

    if (message === "Executing Tool") {
      // Close any unmatched prior pending (defensive — shouldn't happen if
      // log is well-formed, but better than dropping the previous tool call).
      if (pending) events.push(pending);
      pending = {
        ts,
        toolName: payload.toolName ?? null,
        toolId: payload.toolId ?? null,
        args: deepRedact(payload.args ?? {}),
        success: null,
        response: null,
        responseTruncated: false,
        responseBytes: 0,
        durationMs: null,
      };
      pendingStartTs = ts ? Date.parse(ts) : null;
      if (Number.isNaN(pendingStartTs)) pendingStartTs = null;
    } else if (message === "Tool Success" && pending) {
      pending.success = true;
      const responseRaw = deepRedact(payload.response);
      const { preview, truncated, bytes } = summariseResponse(responseRaw);
      pending.response = preview;
      pending.responseTruncated = truncated;
      pending.responseBytes = bytes;
      if (ts && pendingStartTs !== null) {
        const dt = Date.parse(ts) - pendingStartTs;
        if (!Number.isNaN(dt) && dt >= 0) pending.durationMs = dt;
      }
      events.push(pending);
      pending = null;
      pendingStartTs = null;
    } else if (message === "Tool Failure" && pending) {
      pending.success = false;
      pending.errorMessage = typeof payload.error === "string"
        ? payload.error.slice(0, 500)
        : JSON.stringify(payload).slice(0, 500);
      if (ts && pendingStartTs !== null) {
        const dt = Date.parse(ts) - pendingStartTs;
        if (!Number.isNaN(dt) && dt >= 0) pending.durationMs = dt;
      }
      events.push(pending);
      pending = null;
      pendingStartTs = null;
    }
  }
  // Don't drop a still-pending event (tool that never completed within the call).
  if (pending) events.push(pending);
  return events;
}

export const getRunToolExecutionsTool: McpToolDefinition<typeof inputSchema> = {
  name: "get_run_tool_executions",
  title: "Tools called during a run",
  description:
    "Returns the ordered list of agent-side tools called during one run (e.g. " +
    "fetch-physicians, search-patient), with arguments, success/failure, " +
    "duration, and a size-bounded preview of the response. Use this when you " +
    "need to reason about WHY the agent said something (e.g. 'agent said no " +
    "doctor available' — was that because the tool returned an empty list?). " +
    "Pair with `get_run_transcript` for the conversation context.",
  scope: "read",
  inputSchema,
  handler: async (ctx, input) => {
    const run = await prisma.run.findUnique({
      where: { id: input.runId },
      select: { id: true, projectId: true, conversationId: true, callDate: true, callLog: true },
    });
    if (!run || run.projectId !== ctx.projectId) {
      throw new McpToolError("Run not found");
    }

    const executions = extractToolExecutions(run.callLog);

    return {
      runId: run.id,
      conversationId: run.conversationId,
      callDate: run.callDate,
      totalToolCalls: executions.length,
      uniqueTools: Array.from(new Set(executions.map(e => e.toolName).filter(Boolean))),
      executions,
    };
  },
};
