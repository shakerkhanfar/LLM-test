/**
 * MCP HTTP server — mounted at /api/mcp on the main Express app.
 *
 * Architecture: Stateless Streamable HTTP. Each POST creates a fresh
 * McpServer + transport, processes the request, and tears down. This means:
 *   - No session state to leak or to need cleanup.
 *   - Per-request authorization is enforced by middleware before the McpServer
 *     is even constructed — agents cannot mutate session state to escalate.
 *   - Tool registration happens inside the request handler so the tool list
 *     reflects the authenticated token's scope.
 *
 * Transport: StreamableHTTPServerTransport from @modelcontextprotocol/sdk.
 * Body: Express's express.json() middleware parses application/json. The
 * transport accepts the parsed body (req.body) directly.
 *
 * Operational notes:
 *   - Logs structured per-request: token id + project id + tool name +
 *     duration. No raw tokens, no transcripts in logs.
 *   - Errors during the request lifecycle are caught and turned into 500s
 *     with generic bodies — never leak stack traces to MCP clients.
 *   - Server identity: name+version reported to the client via initialize.
 *     Bump these when releasing capability changes.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthMiddleware } from "./auth";
import { mcpPerTokenRateLimit } from "./rateLimit";
import { mcpPreAuthRateLimit } from "../middleware/rateLimiter";
import { registerTools, type AnyTool } from "./registry";

import { pingTool } from "./tools/_read/ping";
import { getProjectOverviewTool } from "./tools/_read/overview";
import { getDashboardSummaryTool } from "./tools/_read/dashboardSummary";
import {
  getTopCriticalIssuesTool,
  getTopExperienceIssuesTool,
  getNodePerformanceTool,
} from "./tools/_read/topIssues";
import {
  listRunsTool,
  getRunBreakdownTool,
  getRunTranscriptTool,
  getRunFullTool,
  searchRunsTool,
} from "./tools/_read/runs";
import { getRunToolExecutionsTool } from "./tools/_read/runToolExecutions";
import { getAgentStructureTool, getNodePromptTool } from "./tools/_read/agentStructure";
import { applyNodePromptFixTool } from "./tools/_write/applyNodePromptFix";
import { reevaluateRunTool } from "./tools/_write/reevaluateRun";
import { rehydrateRunTool } from "./tools/_write/rehydrateRun";

if (process.env.MCP_ALLOW_QUERY_TOKEN === "true") {
  console.warn(
    "[Mcp] WARNING: MCP_ALLOW_QUERY_TOKEN=true — tokens accepted in query string. " +
    "URLs with tokens may leak into access logs and Referer headers. Disable in production."
  );
}

// Master tool list. Adding a new tool means adding an import + push here.
// Scope filtering happens at registration time per-request.
//
// Order matters for the tool list shown to agents — they tend to scan top-down.
// Drill-down chain: orientation → KPIs → issues → runs → structure.
const ALL_TOOLS: AnyTool[] = [
  pingTool,
  // Tier 1 — orientation
  getProjectOverviewTool,
  getDashboardSummaryTool,
  // Tier 2 — issues
  getTopCriticalIssuesTool,
  getTopExperienceIssuesTool,
  getNodePerformanceTool,
  // Tier 3 — runs
  listRunsTool,
  getRunBreakdownTool,
  getRunTranscriptTool,
  getRunToolExecutionsTool,
  getRunFullTool,
  searchRunsTool,
  // Tier 4 — agent structure
  getAgentStructureTool,
  getNodePromptTool,
  // Tier 5 — write (only available with read_write scope; see registry filter)
  applyNodePromptFixTool,
  reevaluateRunTool,
  rehydrateRunTool,
];

const SERVER_NAME = "hamsa-eval-mcp";
const SERVER_VERSION = "0.1.0";
const SERVER_INSTRUCTIONS =
  "You are connected to a Hamsa voice-agent evaluation project. " +
  "Start with `ping` to confirm connectivity, then use `get_dashboard` " +
  "(when available) for an overview, drill into specific issues with " +
  "`get_top_critical_issues` / `get_top_experience_issues`, then inspect " +
  "individual runs with `get_run_breakdown` and `get_run_full`. " +
  "Always cite specific run IDs as evidence when proposing fixes.";

const router: Router = Router();

// Layered protection:
//   1. Pre-auth IP rate limit — caps unauthenticated brute-force noise even
//      though token entropy makes guessing intractable.
//   2. Auth — verifies the bearer token and attaches req.mcp.
//   3. Per-token rate limit — caps cost/load per credential after we know
//      who's calling.
router.use(mcpPreAuthRateLimit);
router.use(mcpAuthMiddleware);
router.use(mcpPerTokenRateLimit);

/**
 * POST /api/mcp — handles a single MCP request (JSON-RPC over HTTP).
 * The transport may upgrade to SSE for streaming responses; we let the SDK
 * decide based on the request's Accept header.
 */
router.post("/", async (req: Request, res: Response) => {
  if (!req.mcp) {
    // Should be unreachable due to middleware, but guard for defence in depth.
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const ctx = req.mcp;

  try {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { instructions: SERVER_INSTRUCTIONS },
    );

    const { registered, skipped } = registerTools(server, ctx, ALL_TOOLS);
    if (skipped.length > 0) {
      const logToken = process.env.MCP_DEBUG === "true" ? ctx.tokenId : ctx.tokenId.slice(0, 8);
      console.log(
        `[Mcp] project=${ctx.projectId} token=${logToken} scope=${ctx.scope} ` +
        `tools_registered=${registered.length} tools_skipped=${skipped.length}`,
      );
    }

    // Stateless mode: no session id generator. Each request is independent.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    // If the client closes the connection, tear down the transport so we
    // don't leak resources on long-running streams.
    res.on("close", () => {
      transport.close().catch(() => { /* best effort */ });
      server.close().catch(() => { /* best effort */ });
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    const logToken = process.env.MCP_DEBUG === "true" ? ctx.tokenId : ctx.tokenId.slice(0, 8);
    console.error(
      `[Mcp] request handling failed for project=${ctx.projectId} token=${logToken}:`,
      (err as Error).message,
    );
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal MCP error" });
    }
  }
});

/**
 * GET / DELETE on stateless transports are not supported (no sessions).
 * Returning 405 informs MCP clients that they should use POST exclusively.
 */
router.get("/", (_req, res) => {
  res.status(405).json({ error: "GET not supported in stateless mode. Use POST." });
});
router.delete("/", (_req, res) => {
  res.status(405).json({ error: "DELETE not supported in stateless mode." });
});

export default router;
