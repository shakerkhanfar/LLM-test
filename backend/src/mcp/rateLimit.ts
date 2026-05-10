/**
 * Per-token in-process rate limiter for the MCP server.
 *
 * Why in-process: tokens have 256-bit entropy, so brute-force is intractable
 * regardless of rate limiting. This layer protects against:
 *   - Buggy agents in tight loops
 *   - Compromised tokens being used to hammer DB
 *   - Cost runaway if write tools are eventually enabled
 *
 * Multi-instance caveat: each replica enforces its own bucket. For 3 replicas
 * with `MCP_RATE_LIMIT_PER_MIN=120`, an attacker can hit 360 req/min against
 * the cluster. Acceptable for v1; can move to Redis-backed counters later
 * without API changes.
 *
 * Bucket cleanup: the map grows unbounded if many tokens connect once and
 * never return. We periodically sweep to evict stale entries (memory bound).
 */
import type { Request, Response, NextFunction } from "express";

const RATE_LIMIT_PER_MIN = parseInt(process.env.MCP_RATE_LIMIT_PER_MIN || "120", 10);
const WINDOW_MS = 60_000;
const SWEEP_EVERY_MS = 5 * 60_000;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

function sweepStaleBuckets(): void {
  const cutoff = Date.now() - 2 * WINDOW_MS;
  for (const [key, b] of buckets.entries()) {
    if (b.windowStart < cutoff) buckets.delete(key);
  }
}

// Kick off a sweep timer once. unref() so this never holds the process open.
const sweepHandle = setInterval(sweepStaleBuckets, SWEEP_EVERY_MS);
sweepHandle.unref();

export function mcpPerTokenRateLimit(req: Request, res: Response, next: NextFunction): void {
  // mcpAuthMiddleware must have run first.
  const tokenId = req.mcp?.tokenId;
  if (!tokenId) {
    // Defence in depth — should be unreachable from a route protected by auth.
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const now = Date.now();
  let bucket = buckets.get(tokenId);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    buckets.set(tokenId, bucket);
  }
  bucket.count++;

  if (bucket.count > RATE_LIMIT_PER_MIN) {
    res.set("Retry-After", "60");
    res.status(429).json({ error: "Rate limit exceeded for this token" });
    console.warn(`[Mcp] rate_limit_exceeded token=${tokenId} project=${req.mcp?.projectId}`);
    return;
  }

  next();
}
