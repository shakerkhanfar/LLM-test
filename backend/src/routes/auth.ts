import { Router } from "express";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma";
import redis from "../lib/redis";
import { requireAuth, signToken, AuthRequest } from "../middleware/auth";
import { BCRYPT_ROUNDS } from "../lib/config";
import { validatePassword } from "../lib/password";

const router = Router();

// ── Login rate limiter: Redis-backed with in-memory fallback ───────
// 10 attempts per IP per 15-minute window. Deliberately conservative.
// Redis is preferred so the limit holds across multiple Node.js processes
// (horizontal scaling, PM2 cluster). Falls back to per-process memory if
// Redis is unavailable — callers get less protection but the service stays up.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SEC = 15 * 60;

// In-memory fallback (single-process only)
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (entry.resetAt < now) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000).unref();

function checkLoginRateLimitMemory(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_SEC * 1000 };
    loginAttempts.set(ip, entry);
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true, retryAfterSec: 0 };
}

async function checkLoginRateLimit(ip: string): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const key = `login_rl:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      // Set TTL only on first increment — avoids resetting the window on every hit
      await redis.expire(key, RATE_LIMIT_WINDOW_SEC);
    }
    if (count > RATE_LIMIT_MAX) {
      const ttl = await redis.ttl(key);
      return { allowed: false, retryAfterSec: Math.max(ttl, 1) };
    }
    return { allowed: true, retryAfterSec: 0 };
  } catch {
    // Redis unavailable — fall back to in-process Map
    return checkLoginRateLimitMemory(ip);
  }
}

// Pre-compute a valid dummy hash for timing-attack prevention.
// Uses the same BCRYPT_ROUNDS constant so timing matches real hashes.
let DUMMY_HASH = "";
bcrypt.hash("dummy_timing_placeholder", BCRYPT_ROUNDS).then((h) => { DUMMY_HASH = h; });

// POST /api/auth/login
router.post("/login", async (req, res) => {
  // req.ip is safe because app.set("trust proxy", ...) is configured in app.ts.
  const ip = (req as any).ip || req.socket.remoteAddress || "unknown";

  const { allowed, retryAfterSec } = await checkLoginRateLimit(ip);
  if (!allowed) {
    console.warn(`[Auth] Rate limited IP: ${ip}`);
    res.setHeader("Retry-After", String(retryAfterSec));
    return res.status(429).json({
      error: `Too many login attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.`,
    });
  }

  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "Email is required" });
  }
  if (email.length > 254) return res.status(400).json({ error: "Invalid email" });
  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Password is required" });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanPassword = password; // do not trim — passwords may legitimately contain spaces

  try {
    const user = await prisma.user.findUnique({
      where: { email: cleanEmail },
      select: { id: true, email: true, passwordHash: true, organizationId: true, tokenVersion: true },
    });

    // Always run bcrypt even when user doesn't exist (timing-attack prevention)
    if (!user) {
      if (DUMMY_HASH) {
        try { await bcrypt.compare(cleanPassword, DUMMY_HASH); } catch {}
      }
      return res.status(401).json({ error: "Invalid email or password" });
    }

    let valid = false;
    try {
      valid = await bcrypt.compare(cleanPassword, user.passwordHash);
    } catch (bcryptErr) {
      console.error("[Auth] bcrypt.compare error:", (bcryptErr as Error).message);
    }

    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Embed organizationId and tokenVersion — tokenVersion enables explicit logout revocation
    const token = signToken(user.id, user.email, user.organizationId, user.tokenVersion);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error("[Auth] Login error:", err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// POST /api/auth/register — create a new account (admin-only in production)
router.post("/register", requireAuth, async (req: AuthRequest, res) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "Email is required" });
  }
  if (email.length > 254) return res.status(400).json({ error: "Invalid email" });
  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Password is required" });
  }

  const validationError = validatePassword(password);
  if (validationError) return res.status(400).json({ error: validationError });

  const cleanEmail = email.trim().toLowerCase();

  try {
    // New user inherits the creator's organization
    const creator = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { organizationId: true },
    });

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS); // do not trim — preserve exact password
    const newUser = await prisma.user.create({
      data: {
        email: cleanEmail,
        passwordHash: hash,
        organizationId: creator?.organizationId ?? null,
      },
    });

    console.log(`[Auth] User ${newUser.email} registered by ${req.userEmail} (req ${req.requestId})`);
    res.status(201).json({ id: newUser.id, email: newUser.email });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "Email already registered" });
    }
    console.error("[Auth] Register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, organizationId: true, createdAt: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    console.error("[Auth] /me error:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// POST /api/auth/logout — invalidate all existing tokens for this user
router.post("/logout", requireAuth, async (req: AuthRequest, res) => {
  try {
    await prisma.user.update({
      where: { id: req.userId },
      data: { tokenVersion: { increment: 1 } },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[Auth] Logout error:", err);
    res.status(500).json({ error: "Logout failed" });
  }
});

export { BCRYPT_ROUNDS };
export default router;
