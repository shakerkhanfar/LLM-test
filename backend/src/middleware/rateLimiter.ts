import rateLimit from "express-rate-limit";
import type { Request } from "express";
import type { AuthRequest } from "./auth";

/**
 * Normalize an IP address for use as a rate-limit key.
 * Strips the IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 → 1.2.3.4) so
 * IPv4 and IPv4-mapped IPv6 requests share the same bucket, and satisfies
 * express-rate-limit's IPv6 key-generator validation requirement.
 */
function normalizeIp(ip: string | undefined): string {
  if (!ip) return "unknown";
  return ip.replace(/^::ffff:/i, "");
}

/**
 * Per-user rate limiter for LLM/evaluation endpoints that have real cost.
 * Falls back to normalized IP if userId is not available.
 */
function userKeyGenerator(req: Request): string {
  return (req as AuthRequest).userId || normalizeIp(req.ip);
}

/**
 * Evaluation endpoints: 60 evals per user per 10 minutes.
 * Prevents accidental or malicious mass-evaluation loops.
 */
// express-rate-limit v8 validates that custom keyGenerators don't use req.ip
// directly without the ipKeyGenerator helper. Our normalizeIp() already handles
// IPv6 correctly (strips ::ffff: prefix), so suppress the false-positive warning.
const noIpv6Warn = { xForwardedForHeader: false, ipv6: false } as const;

export const evalRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  validate: noIpv6Warn,
  message: { error: "Too many evaluation requests. Please wait before trying again." },
  skip: () => process.env.NODE_ENV === "test",
});

/**
 * LLM search / analysis endpoints: 20 requests per user per 5 minutes.
 * These trigger full OpenAI completions and are more expensive.
 */
export const llmRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  validate: noIpv6Warn,
  message: { error: "Too many AI requests. Please wait a moment before trying again." },
  skip: () => process.env.NODE_ENV === "test",
});

/**
 * Webhook endpoint: 300 calls per IP per minute.
 * Prevents cost-exhaustion attacks via fake webhook floods.
 */
export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: (req) => normalizeIp(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  validate: noIpv6Warn,
  message: { error: "Webhook rate limit exceeded" },
  skip: () => process.env.NODE_ENV === "test",
});
