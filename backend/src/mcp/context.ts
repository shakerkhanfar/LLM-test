/**
 * Per-request MCP context — passed to every tool handler.
 *
 * Tools NEVER receive raw req/res. The context is the only way for a tool to
 * know which project it's operating on, preventing argument injection from
 * crossing project boundaries. The projectId here comes from the authenticated
 * token, not from tool arguments.
 */
export interface McpContext {
  /** DB id of the McpToken authenticating this request. Used for logging only. */
  readonly tokenId: string;
  /** Project this token is scoped to. Tools query/mutate ONLY this project. */
  readonly projectId: string;
  /** Token scope — gates which tools are available and which can mutate. */
  readonly scope: "read" | "read_write";
  /** Optional human-readable name of the token (for log correlation). */
  readonly tokenName: string | null;
}
