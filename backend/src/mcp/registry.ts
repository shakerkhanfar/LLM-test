/**
 * MCP tool registry.
 *
 * Tools are declared as plain objects with a Zod input schema, a description,
 * a required scope, and a handler. The registry is responsible for:
 *  - Filtering tools by required scope (an agent with "read" scope never even
 *    sees the tools it cannot call — better than runtime rejection because
 *    the tool list itself becomes accurate documentation of what's allowed).
 *  - Wrapping handlers with timing + structured logging.
 *  - Mapping tool exceptions to MCP-friendly error responses without leaking
 *    stack traces or DB internals to the calling agent.
 *
 * Tools NEVER receive the raw Express req or the McpServer — only the
 * McpContext. This isolates tools from the transport and makes them trivial
 * to unit-test.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "./context";

export type ToolScope = "read" | "read_write";

/**
 * Sentinel for errors a tool wants to surface verbatim to the caller (validation
 * messages, not-found, "no such run", etc). All other errors are sanitised to
 * a generic "Tool failed" so we never leak DB or infra details to the agent.
 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

const TOOL_TIMEOUT_MS = parseInt(process.env.MCP_TOOL_TIMEOUT_MS || "30000", 10);
const DEBUG = process.env.MCP_DEBUG === "true";

/**
 * Cap on the JSON-serialized size of a tool result. Agents are expensive to
 * feed huge payloads and the network round-trip is wasted. If a tool returns
 * more than this, we replace the body with an error pointing the agent at
 * narrower tools (e.g. get_run_breakdown instead of get_run_full).
 */
const TOOL_RESULT_MAX_BYTES = parseInt(process.env.MCP_TOOL_RESULT_MAX_BYTES || "524288", 10); // 512 KiB

function tokenLogId(tokenId: string): string {
  // Log only the first 8 chars of the cuid; full id is privacy-adjacent and
  // appears unredacted in stdout logs which may be aggregated to third parties.
  return DEBUG ? tokenId : tokenId.slice(0, 8);
}

/** Discriminated by whether a Zod input schema is supplied. */
export interface McpToolDefinition<TInput extends z.ZodRawShape | undefined = undefined> {
  name: string;
  /** Short description; agent reads this to decide when to call. Keep tight. */
  description: string;
  /** Long-form drill-down hint shown only in tool list, not always in calls. */
  title?: string;
  /** Minimum scope required to use this tool. */
  scope: ToolScope;
  /**
   * Zod object shape for the tool's arguments. `undefined` means no arguments.
   * Strict mode rejects extra keys to avoid silent argument injection.
   */
  inputSchema?: TInput;
  /**
   * Tool handler. Receives the per-request context and validated input.
   * Return value is JSON-serialized into the MCP tool result.
   *
   * Exceptions are caught by the registry and surfaced to the agent as a
   * tool error without leaking internal details.
   */
  handler: (
    ctx: McpContext,
    input: TInput extends z.ZodRawShape ? z.infer<z.ZodObject<TInput>> : Record<string, never>,
  ) => Promise<unknown>;
}

export type AnyTool = McpToolDefinition<any>;

/**
 * Register all tools that the given context's scope allows. Returns the names
 * of the tools that were skipped due to insufficient scope (for logging).
 */
export function registerTools(
  server: McpServer,
  ctx: McpContext,
  tools: AnyTool[],
): { registered: string[]; skipped: string[] } {
  const registered: string[] = [];
  const skipped: string[] = [];

  for (const tool of tools) {
    if (!hasScope(ctx.scope, tool.scope)) {
      skipped.push(tool.name);
      continue;
    }
    registerSingleTool(server, ctx, tool);
    registered.push(tool.name);
  }

  return { registered, skipped };
}

function hasScope(have: ToolScope, need: ToolScope): boolean {
  if (need === "read") return have === "read" || have === "read_write";
  return have === "read_write";
}

function registerSingleTool(server: McpServer, ctx: McpContext, tool: AnyTool): void {
  const config: {
    description: string;
    title?: string;
    inputSchema?: z.ZodRawShape;
  } = {
    description: tool.description,
  };
  if (tool.title) config.title = tool.title;
  if (tool.inputSchema) config.inputSchema = tool.inputSchema;

  // The McpServer wraps our callback in its own error handling. We add an
  // outer try/catch to ensure any thrown error is caught, logged with token
  // and project context, and returned as a sanitised tool error.
  server.registerTool(tool.name, config as any, async (rawInput: unknown) => {
    const start = Date.now();
    const logToken = tokenLogId(ctx.tokenId);
    try {
      // McpServer already validates inputs against the Zod schema, but we
      // re-validate defensively to ensure the SDK didn't pass through extras.
      const input = (tool.inputSchema
        ? z.object(tool.inputSchema).strict().parse(rawInput ?? {})
        : {}) as any;
      // Race the handler against a timeout so a hung tool can't tie up a
      // request slot indefinitely.
      const result = await Promise.race([
        tool.handler(ctx, input),
        new Promise((_, reject) => setTimeout(
          () => reject(new McpToolError(`Tool ${tool.name} exceeded ${TOOL_TIMEOUT_MS}ms timeout`)),
          TOOL_TIMEOUT_MS,
        )),
      ]);
      const duration = Date.now() - start;
      const text = JSON.stringify(result);
      if (text.length > TOOL_RESULT_MAX_BYTES) {
        console.warn(
          `[Mcp] tool=${tool.name} project=${ctx.projectId} token=${logToken}` +
          ` duration_ms=${duration} status=oversized bytes=${text.length} limit=${TOOL_RESULT_MAX_BYTES}`,
        );
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Tool error: response too large (${text.length} bytes; limit ${TOOL_RESULT_MAX_BYTES}). ` +
              `Use a narrower tool (e.g. get_run_breakdown instead of get_run_full, or set ` +
              `includeCallLog/includeWebhookData=false), or paginate via list_runs.`,
          }],
        };
      }
      console.log(
        `[Mcp] tool=${tool.name} project=${ctx.projectId} token=${logToken}` +
        ` scope=${ctx.scope} duration_ms=${duration} status=ok bytes=${text.length}`,
      );
      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (err) {
      const duration = Date.now() - start;
      const isExposable = err instanceof McpToolError || err instanceof z.ZodError;
      const internalMessage = (err as Error).message ?? "unknown";
      // Agents only see safe, intentional messages. Everything else is
      // generic, with the real message in server logs only.
      const agentMessage = isExposable
        ? (err instanceof z.ZodError
          ? `Invalid arguments: ${err.issues.map(i => i.message).join("; ")}`
          : internalMessage)
        : "Tool execution failed";
      console.warn(
        `[Mcp] tool=${tool.name} project=${ctx.projectId} token=${logToken}` +
        ` scope=${ctx.scope} duration_ms=${duration} status=error` +
        ` exposed=${isExposable} message="${internalMessage.replace(/"/g, "'")}"`,
      );
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Tool error: ${agentMessage}` }],
      };
    }
  });
}
