/**
 * MCP token service — single source of truth for issuing, hashing, validating,
 * and revoking MCP access tokens.
 *
 * Design principles:
 * - Raw tokens are visible exactly once (at creation) and never persisted.
 * - Tokens are hashed with HMAC-SHA-256 keyed by MCP_TOKEN_PEPPER. Without the
 *   pepper, hashes are useless even if the DB leaks.
 * - Lookups use constant-time comparison via crypto.timingSafeEqual to
 *   defend against timing attacks (defence-in-depth — primary defense is the
 *   256-bit token entropy).
 * - lastUsedAt updates are debounced to avoid hot-write contention on the
 *   token row when the same agent makes many MCP calls per minute.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import prisma from "../lib/prisma";
import { MCP_TOKEN_PEPPER, MCP_TOKEN_DEFAULT_TTL_DAYS } from "../lib/config";

const TOKEN_PREFIX = "mcp_proj_";

/** HMAC-SHA-256 of the raw token, keyed by MCP_TOKEN_PEPPER. Hex-encoded. */
export function hashToken(raw: string): string {
  if (!MCP_TOKEN_PEPPER) {
    // Defence in depth: production validation should have prevented this, but
    // throwing here ensures we never persist an unkeyed hash by accident.
    throw new Error("MCP_TOKEN_PEPPER is not set — cannot hash tokens.");
  }
  return createHmac("sha256", MCP_TOKEN_PEPPER).update(raw).digest("hex");
}

/** Validate that two hex-digest strings match in constant time. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export interface IssueTokenInput {
  projectId: string;
  name?: string | null;
  scope?: "read" | "read_write";
  ttlDays?: number | null; // null = no expiry; undefined = default
  createdByUserId?: string | null;
}

export interface IssuedToken {
  id: string;
  rawToken: string; // ONLY returned at creation time
  createdAt: Date;
  expiresAt: Date | null;
}

export async function issueToken(input: IssueTokenInput): Promise<IssuedToken> {
  // 32 bytes = 256 bits of random entropy. Base64url encoding is URL/header
  // safe and produces 43 characters with no padding.
  const raw = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const tokenHash = hashToken(raw);

  let expiresAt: Date | null = null;
  if (input.ttlDays === null) {
    expiresAt = null;
  } else {
    const days = input.ttlDays ?? MCP_TOKEN_DEFAULT_TTL_DAYS;
    if (!Number.isFinite(days) || days <= 0 || days > 365 * 10) {
      throw new Error("ttlDays must be between 1 and 3650 (or null for no expiry)");
    }
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const scope = input.scope === "read_write" ? "read_write" : "read";
  // Trim and clamp the user-supplied name to avoid abuse via huge labels.
  const name = input.name?.trim().slice(0, 80) || null;

  const created = await prisma.mcpToken.create({
    data: {
      projectId: input.projectId,
      tokenHash,
      name,
      scope,
      createdByUserId: input.createdByUserId ?? null,
      expiresAt,
    },
    select: { id: true, createdAt: true, expiresAt: true },
  });

  return {
    id: created.id,
    rawToken: raw,
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
  };
}

/**
 * Revoke a single token by its DB id (soft-delete via revokedAt).
 * Idempotent: revoking an already-revoked token is a no-op.
 */
export async function revokeToken(tokenId: string): Promise<{ revoked: boolean }> {
  const result = await prisma.mcpToken.updateMany({
    where: { id: tokenId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { revoked: result.count > 0 };
}

/**
 * List active (not revoked, not expired) and recent revoked tokens for a project.
 * Raw token values are NEVER returned; the UI only sees metadata.
 */
export async function listProjectTokens(projectId: string) {
  const now = new Date();
  return prisma.mcpToken.findMany({
    where: {
      projectId,
      OR: [{ revokedAt: null }, { revokedAt: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      scope: true,
      createdAt: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      createdByUserId: true,
    },
  });
}

/**
 * Look up an active token by its raw value. Returns the token row WITH the
 * project relation, or null if not found / revoked / expired / wrong format.
 *
 * Used by the MCP HTTP auth middleware. Constant-time comparison + indexed
 * lookup on tokenHash means this is fast and timing-safe.
 */
export async function authenticateToken(raw: string): Promise<{
  tokenId: string;
  projectId: string;
  scope: string;
  name: string | null;
} | null> {
  if (typeof raw !== "string" || raw.length < TOKEN_PREFIX.length || !raw.startsWith(TOKEN_PREFIX)) {
    return null;
  }
  const tokenHash = hashToken(raw);
  const row = await prisma.mcpToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      projectId: true,
      scope: true,
      name: true,
      revokedAt: true,
      expiresAt: true,
      tokenHash: true,
    },
  });
  if (!row) return null;
  // Defence in depth: re-verify the hash in constant time, even though the DB
  // lookup is already keyed by the indexed column. A tampered query layer
  // could in theory return the wrong row; this catches that.
  if (!safeEqualHex(row.tokenHash, tokenHash)) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() < Date.now()) return null;
  if (!row.projectId) return null; // org-scoped tokens not yet supported by callers
  return { tokenId: row.id, projectId: row.projectId, scope: row.scope, name: row.name };
}

// In-memory debounce for lastUsedAt updates. Map token id → last write time.
// We accept the trade-off that this is per-process (in a multi-instance
// deployment, each replica writes once per minute per token). Cheap enough.
const LAST_USED_DEBOUNCE_MS = 60_000;
const lastUsedWriteMap = new Map<string, number>();

/**
 * Update lastUsedAt on a token. Debounced to once per LAST_USED_DEBOUNCE_MS
 * per process per token to avoid hot-write contention. Failures are logged
 * but never bubble up — last-used tracking is operational metadata, not
 * security-critical.
 */
export function touchTokenLastUsed(tokenId: string): void {
  const now = Date.now();
  const last = lastUsedWriteMap.get(tokenId) ?? 0;
  if (now - last < LAST_USED_DEBOUNCE_MS) return;
  lastUsedWriteMap.set(tokenId, now);
  prisma.mcpToken
    .update({ where: { id: tokenId }, data: { lastUsedAt: new Date(now) } })
    .catch((err) => {
      console.warn(`[McpToken] lastUsedAt update failed for ${tokenId}:`, (err as Error).message);
    });
}
