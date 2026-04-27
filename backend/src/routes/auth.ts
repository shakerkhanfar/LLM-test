import { Router } from "express";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma";
import { requireAuth, signToken, AuthRequest } from "../middleware/auth";

const router = Router();

// ── Simple in-memory rate limiter for login ────────────────────────
// Limits to 20 attempts per IP per 15-minute window.
// On platforms like Replit, all requests may share the same proxy IP,
// so we're generous with the limit.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    loginAttempts.set(ip, entry);
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true, retryAfterSec: 0 };
}

// Clean up stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (entry.resetAt < now) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000).unref();

// Pre-compute a valid dummy hash (for timing-attack prevention on non-existent users).
// This is a real bcrypt hash of the string "dummy" with cost 12.
let DUMMY_HASH = "";
bcrypt.hash("dummy", 12).then((h) => { DUMMY_HASH = h; });

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    || req.socket.remoteAddress
    || "unknown";

  const { allowed, retryAfterSec } = checkLoginRateLimit(ip);
  if (!allowed) {
    console.log(`[Auth] Rate limited IP: ${ip}`);
    res.setHeader("Retry-After", String(retryAfterSec));
    return res.status(429).json({ error: `Too many login attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.` });
  }

  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "Email is required" });
  }
  if (email.length > 254) {
    return res.status(400).json({ error: "Invalid email" });
  }
  if (!password || typeof password !== "string" || !password.trim()) {
    return res.status(400).json({ error: "Password is required" });
  }

  // Trim password to avoid copy-paste whitespace mismatches
  const cleanPassword = password.trim();
  if (cleanPassword.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const cleanEmail = email.trim().toLowerCase();

  try {
    const user = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    console.log(`[Auth] Login attempt: ip=${ip} email=${cleanEmail} found=${!!user} hashLen=${user?.passwordHash?.length ?? 0}`);

    if (!user) {
      // Timing-safe: always run bcrypt even when user doesn't exist
      if (DUMMY_HASH) {
        try { await bcrypt.compare(cleanPassword, DUMMY_HASH); } catch {}
      }
      return res.status(401).json({ error: "Invalid email or password" });
    }

    let valid = false;
    try {
      valid = await bcrypt.compare(cleanPassword, user.passwordHash);
    } catch (bcryptErr) {
      console.error("[Auth] bcrypt.compare threw:", {
        message: (bcryptErr as Error).message,
        hashLength: user.passwordHash?.length,
        hashPrefix: user.passwordHash?.slice(0, 7),
      });
    }
    console.log(`[Auth] bcrypt result: valid=${valid} passwordLen=${cleanPassword.length}`);

    if (!valid) {
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
