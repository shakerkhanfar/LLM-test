import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config();

import projectsRouter from "./routes/projects";
import runsRouter from "./routes/runs";
import labelsRouter from "./routes/labels";
import webhooksRouter from "./routes/webhooks";
import historyRouter from "./routes/history";
import authRouter from "./routes/auth";
import { requireAuth } from "./middleware/auth";

const app = express();
const PORT = process.env.PORT || 3001;

// CORS: allow any localhost port in development, plus an explicit production URL.
// Server-to-server callers (Hamsa webhooks) don't send an Origin header,
// so they're unaffected by CORS policy.
app.use(cors({
  origin: (origin, cb) => {
    // No Origin header (same-origin / server-to-server) → always allow
    if (!origin) return cb(null, true);
    // Any localhost port → allow (safe for local dev)
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    // Replit hosting (same-origin but browser may still send Origin header)
    if (/\.replit\.app$/.test(origin) || /\.repl\.co$/.test(origin)) return cb(null, true);
    // Explicit production URL from env
    if (process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));

// Routes
app.use("/api/auth", authRouter);
// Webhooks are called by Hamsa server — no user auth
app.use("/api/webhooks", webhooksRouter);
// All other API routes require a valid JWT
app.use("/api/projects", requireAuth, projectsRouter);
app.use("/api/runs", requireAuth, runsRouter);
app.use("/api/labels", requireAuth, labelsRouter);
app.use("/api/history", requireAuth, historyRouter);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Serve built frontend in production
const frontendDist = path.join(__dirname, "../../frontend/dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
  console.log(`[App] Serving frontend from ${frontendDist}`);
}

import { initQueue } from "./services/evaluationRunner";
import prisma from "./lib/prisma";
import bcrypt from "bcryptjs";

// Ensure the demo user exists on every startup — no manual scripts needed.
async function ensureDemoUser() {
  const email = "demo@tryhamsa.com";
  const password = "Hamsa@1234";
  try {
    // Ensure the User table exists (raw SQL — works even if prisma db push wasn't run)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "User" (
        "id" TEXT NOT NULL,
        "email" TEXT NOT NULL,
        "passwordHash" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "User_pkey" PRIMARY KEY ("id")
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email")
    `);
    // Ensure Project.userId column exists
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "userId" TEXT
    `);
    console.log("[Seed] Schema verified");

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`[Seed] User ${email} exists (${existing.id})`);
      return;
    }
    const hash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({ data: { email, passwordHash: hash } });
    console.log(`[Seed] Created user ${email} (${user.id})`);
    // Assign any unowned projects to this user
    const result = await prisma.project.updateMany({ where: { userId: null }, data: { userId: user.id } });
    if (result.count > 0) console.log(`[Seed] Assigned ${result.count} unowned projects to ${email}`);
  } catch (err) {
    console.error(`[Seed] Failed:`, (err as Error).message);
  }
}

app.listen(PORT, () => {
  console.log(`[App] Hamsa Eval API running on http://localhost:${PORT}`);
  initQueue();
  ensureDemoUser();
});

export default app;
