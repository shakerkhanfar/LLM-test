/**
 * MCP authentication middleware.
 *
 * Extracts a Bearer token from the Authorization header, verifies it via the
 * mcpTokens service, and attaches an McpContext to req.
 *
 * Security notes:
 *  - Constant-time comparison happens inside authenticateToken().
 *  - On any failure (missing header, malformed token, invalid hash, expired,
 *    revoked) we return 401 with a generic body. We never reveal which check
 *    failed — that would help an attacker enumerate.
 *  - WWW-Authenticate header per RFC 6750 informs clients that Bearer auth is
 *    required.
 *  - lastUsedAt is touched fire-and-forget; failures don't impact auth.
 *  - We also accept the token via the legacy `?token=...` query param ONLY if
 *    explicitly enabled via env, because URLs can leak into logs/referrers.
 *    Default off.
 */
import type { Request, Response, NextFunction } from "express";
import { authenticateToken, touchTokenLastUsed } from "../services/mcpTokens";
import type { McpContext } from "./context";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mcp?: McpContext;
    }
  }
}

const ALLOW_QUERY_TOKEN = process.env.MCP_ALLOW_QUERY_TOKEN === "true";

function unauthorized(res: Response, reason: string): void {
  // Generic 401 body — `reason` only goes to logs, not the client.
  res.set("WWW-Authenticate", 'Bearer realm="MCP", error="invalid_token"');
  res.status(401).json({ error: "Unauthorized" });
  // Structured log for ops debugging (no token material in logs).
  console.warn(`[McpAuth] 401: ${reason}`);
}

export async function mcpAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let raw: string | undefined;

  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    raw = authHeader.slice("Bearer ".length).trim();
  } else if (ALLOW_QUERY_TOKEN && typeof req.query.token === "string") {
    // Optional escape hatch for clients that cannot set headers (e.g. some
    // SSE EventSource implementations). Off by default — leaks to access logs.
    raw = req.query.token;
  }

  if (!raw) {
    unauthorized(res, "missing Bearer token");
    return;
  }

  // Length sanity-check before hashing — prevents DoS via massive tokens.
  if (raw.length > 200) {
    unauthorized(res, "token too long");
    return;
  }

  let auth: Awaited<ReturnType<typeof authenticateToken>>;
  try {
    auth = await authenticateToken(raw);
  } catch (err) {
    // Any unexpected error during auth (e.g. DB hiccup) becomes 401 to avoid
    // leaking failure details. The error is logged for ops.
    console.error(`[McpAuth] authenticateToken threw:`, (err as Error).message);
    unauthorized(res, "auth check failed");
    return;
  }

  if (!auth) {
    unauthorized(res, "invalid/expired/revoked token");
    return;
  }

  const ctx: McpContext = {
    tokenId: auth.tokenId,
    projectId: auth.projectId,
    scope: auth.scope === "read_write" ? "read_write" : "read",
    tokenName: auth.name,
  };
  req.mcp = ctx;

  // Touch lastUsedAt — debounced to once per minute per process per token.
  // Fire-and-forget; never blocks the request.
  touchTokenLastUsed(auth.tokenId);

  next();
}
