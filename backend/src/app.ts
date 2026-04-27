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

app.listen(PORT, () => {
  console.log(`[App] Hamsa Eval API running on http://localhost:${PORT}`);
  initQueue();
});

export default app;
