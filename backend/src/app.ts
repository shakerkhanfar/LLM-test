import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config();

// Validate required config before importing anything that depends on it
import { validateConfig, BCRYPT_ROUNDS } from "./lib/config";
validateConfig();

import projectsRouter from "./routes/projects";
import runsRouter from "./routes/runs";
import labelsRouter from "./routes/labels";
import webhooksRouter from "./routes/webhooks";
import historyRouter from "./routes/history";
import authRouter from "./routes/auth";
import usersRouter from "./routes/users";
import { requireAuth } from "./middleware/auth";
import { requestIdMiddleware } from "./middleware/requestId";
import { errorHandler } from "./middleware/errorHandler";
import { webhookRateLimit } from "./middleware/rateLimiter";
import prisma from "./lib/prisma";
import bcrypt from "bcryptjs";

const app = express();
const PORT = process.env.PORT || 3001;

// ── Request ID — must be first so all logs carry correlation ID ──
app.use(requestIdMiddleware);

// ── CORS ─────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    if (/\.replit\.app$/.test(origin) || /\.repl\.co$/.test(origin)) return cb(null, true);
    if (process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  exposedHeaders: ["X-Request-ID"],
}));

// ── Body parsing ──────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));

// ── Routes ───────────────────────────────────────────────────────
app.use("/api/auth", authRouter);
// Webhooks: no user auth but rate-limited per IP
app.use("/api/webhooks", webhookRateLimit, webhooksRouter);
// All other routes require a valid JWT
app.use("/api/projects", requireAuth, projectsRouter);
app.use("/api/runs", requireAuth, runsRouter);
app.use("/api/labels", requireAuth, labelsRouter);
app.use("/api/history", requireAuth, historyRouter);
app.use("/api/users", requireAuth, usersRouter);

// ── Deep health check ────────────────────────────────────────────
// Returns 503 if database or queue is unavailable so load balancers
// and orchestrators can stop routing traffic to broken instances.
let queueHealthy: boolean | null = null; // null = not using queue
export function setQueueHealth(healthy: boolean) { queueHealthy = healthy; }

app.get("/api/health", async (_req, res) => {
  const checks: Record<string, unknown> = {};
  let ok = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = true;
  } catch (err) {
    checks.db = false;
    ok = false;
    console.error("[Health] Database check failed:", err);
  }

  if (queueHealthy !== null) {
    checks.queue = queueHealthy;
    if (!queueHealthy) ok = false;
  }

  checks.timestamp = new Date().toISOString();
  res.status(ok ? 200 : 503).json({ ok, ...checks });
});

// ── Static frontend ───────────────────────────────────────────────
const frontendDist = path.join(__dirname, "../../frontend/dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
  console.log(`[App] Serving frontend from ${frontendDist}`);
}

// ── Centralised error handler (must be last) ──────────────────────
app.use(errorHandler);

// ── Startup ───────────────────────────────────────────────────────
import { initQueue } from "./services/evaluationRunner";

/**
 * Seed demo user using Prisma Client only — no raw SQL.
 * Controlled by DEMO_USER_EMAIL / DEMO_USER_PASSWORD env vars.
 */
async function ensureDemoUser() {
  const email = process.env.DEMO_USER_EMAIL;
  const password = process.env.DEMO_USER_PASSWORD;
  if (!email || !password) {
    // No demo user configured — skip silently
    return;
  }
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`[Seed] User ${email} already exists`);
      return;
    }
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await prisma.user.create({ data: { email, passwordHash: hash } });
    console.log(`[Seed] Created demo user ${email} (${user.id})`);
  } catch (err) {
    console.error("[Seed] Failed:", (err as Error).message);
  }
}

app.listen(PORT, () => {
  console.log(`[App] Hamsa Eval API running on http://localhost:${PORT}`);
  initQueue();
  ensureDemoUser();
});

export default app;
