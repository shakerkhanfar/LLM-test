import rateLimit from "express-rate-limit";
import type { Request } from "express";
import type { AuthRequest } from "./auth";

/**
 * Per-user rate limiter for LLM/evaluation endpoints that have real cost.
 * Falls back to IP if userId is not available.
 */
function userKeyGenerator(req: Request): string {
  return (req as AuthRequest).userId || req.ip || "anonymous";
}

/**
 * Evaluation endpoints: 60 evals per user per 10 minutes.
 * Prevents accidental or malicious mass-evaluation loops.
 */
export const evalRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
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
  keyGenerator: (req) => req.ip || "unknown",
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Webhook rate limit exceeded" },
  skip: () => process.env.NODE_ENV === "test",
});
