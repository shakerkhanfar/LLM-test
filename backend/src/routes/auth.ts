import { Router } from "express";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma";
import { requireAuth, signToken, AuthRequest } from "../middleware/auth";

const router = Router();

// ── Simple in-memory rate limiter for login ────────────────────────
// Limits to 10 attempts per IP per 15-minute window.
// (An in-process map is sufficient for a single-instance internal tool.)
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    loginAttempts.set(ip, entry);
  }
  // Check BEFORE incrementing so the (MAX+1)th request is the first to be blocked,
  // not the (MAX+2)th (off-by-one fix).
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true, retryAfterSec: 0 };
}

// Clean up stale entries every 30 minutes to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (entry.resetAt < now) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000).unref();

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    || req.socket.remoteAddress
    || "unknown";

  const { allowed, retryAfterSec } = checkLoginRateLimit(ip);
  if (!allowed) {
    res.setHeader("Retry-After", String(retryAfterSec));
    return res.status(429).json({ error: `Too many login attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.` });
  }

  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "Email is required" });
  }
  // Guard against extremely long inputs that could slow down DB queries or bcrypt
  if (email.length > 254) {
    return res.status(400).json({ error: "Invalid email" });
  }
  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Password is required" });
  }
  if (!password.trim()) {
    return res.status(400).json({ error: "Password is required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    // Always run bcrypt to prevent timing-based user enumeration
    const hash = user?.passwordHash ?? "$2b$10$invalidhashinvalidhashXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken(user.id, user.email);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error("[Auth] Login error:", err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// GET /api/auth/me — returns current user info
router.get("/me", requireAuth, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, createdAt: true },
    });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(user);
  } catch (err) {
    console.error("[Auth] /me error:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

export default router;
