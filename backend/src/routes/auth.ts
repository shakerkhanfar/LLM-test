import { Router } from "express";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma";
import { requireAuth, signToken, AuthRequest } from "../middleware/auth";
import { BCRYPT_ROUNDS } from "../lib/config";
import { validatePassword } from "../lib/password";

const router = Router();

// ── In-memory rate limiter for login ──────────────────────────────
// 10 attempts per IP per 15-minute window. Deliberately conservative.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

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

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (entry.resetAt < now) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000).unref();

// Pre-compute a valid dummy hash for timing-attack prevention.
// Uses the same BCRYPT_ROUNDS constant so timing matches real hashes.
let DUMMY_HASH = "";
bcrypt.hash("dummy_timing_placeholder", BCRYPT_ROUNDS).then((h) => { DUMMY_HASH = h; });

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const { allowed, retryAfterSec } = checkLoginRateLimit(ip);
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
  const cleanPassword = password.trim();

  try {
    const user = await prisma.user.findUnique({
      where: { email: cleanEmail },
      select: { id: true, email: true, passwordHash: true, organizationId: true },
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

    // Embed organizationId in token — eliminates DB hit on every authenticated request
    const token = signToken(user.id, user.email, user.organizationId);
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

  const validationError = validatePassword(password.trim());
  if (validationError) return res.status(400).json({ error: validationError });

  const cleanEmail = email.trim().toLowerCase();

  try {
    // New user inherits the creator's organization
    const creator = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { organizationId: true },
    });

    const hash = await bcrypt.hash(password.trim(), BCRYPT_ROUNDS);
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

export { BCRYPT_ROUNDS };
export default router;
