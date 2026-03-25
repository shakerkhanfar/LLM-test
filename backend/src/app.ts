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

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Routes
app.use("/api/projects", projectsRouter);
app.use("/api/runs", runsRouter);
app.use("/api/labels", labelsRouter);
app.use("/api/webhooks", webhooksRouter);

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
