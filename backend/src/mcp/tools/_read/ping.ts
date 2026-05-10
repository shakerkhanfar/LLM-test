/**
 * ping — diagnostic tool that echoes the authenticated context back to the agent.
 *
 * Useful for:
 *   - Verifying the agent's MCP token is valid and which project it points to.
 *   - Smoke-testing the transport during integration.
 *
 * Returns NO sensitive data. Project name is NOT included to avoid leaking
 * org-internal naming via a misconfigured token.
 */
import type { McpToolDefinition } from "../../registry";

export const pingTool: McpToolDefinition = {
  name: "ping",
  title: "Ping the MCP server",
  description:
    "Returns the project ID and token scope this MCP session is bound to. " +
    "Use to confirm connectivity before calling other tools.",
  scope: "read",
  handler: async (ctx) => {
    return {
      ok: true,
      projectId: ctx.projectId,
      scope: ctx.scope,
      serverTime: new Date().toISOString(),
    };
  },
};
