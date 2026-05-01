import prisma from "../lib/prisma";
import { Router } from "express";
import { RunStatus } from "@prisma/client";
import { updateAgentModel } from "../services/hamsaApi";
import { runEvaluationCheck } from "../services/evaluationRunner";
import { AuthRequest } from "../middleware/auth";
import { assertProjectAccess, assertRunAccess, canAccess } from "../lib/ownership";

const router = Router();

const VALID_STATUSES = new Set<string>(Object.values(RunStatus));
// Only allow external callers to set these statuses (not e.g. EVALUATING or COMPLETE)
const CLIENT_SETTABLE_STATUSES = new Set<string>(["PENDING", "RUNNING", "AWAITING_DATA", "FAILED"]);

// List runs for a project (most recent 200, with pagination via ?skip=)
router.get("/project/:projectId", async (req: AuthRequest, res) => {
  const project = await assertProjectAccess(req.params.projectId, req, res);
  if (!project) return;

  const skip = parseInt(req.query.skip as string) || 0;
  const take = Math.min(parseInt(req.query.take as string) || 100, 200);

  const runs = await prisma.run.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { createdAt: "desc" },
    skip,
    take,
    include: {
      evalResults: { include: { criterion: true } },
      _count: { select: { wordLabels: true } },
    },
  });
  res.json(runs);
});

// Get single run with full details
router.get("/:id", async (req: AuthRequest, res) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: {
        project: { include: { criteria: true } },
        evalResults: { include: { criterion: true } },
        wordLabels: { orderBy: { wordIndex: "asc" } },
      },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });
    const projectUserId = (run.project as any)?.userId as string | null;
    if (!await canAccess(projectUserId, req)) {
      return res.status(403).json({ error: "Access denied" });
    }
    res.json(run);
  } catch {
    res.status(500).json({ error: "Failed to fetch run" });
  }
});

// Create a new run
router.post("/", async (req: AuthRequest, res) => {
  const { projectId, modelUsed } = req.body;
  if (!projectId) return res.status(400).json({ error: "projectId is required" });

  try {
    const project = await assertProjectAccess(projectId, req, res);
    if (!project) return;

    const run = await prisma.run.create({
      data: {
        projectId,
        modelUsed: modelUsed || null,
        status: "PENDING",
        startedAt: new Date(),
      },
    });

    res.status(201).json(run);
  } catch {
    res.status(500).json({ error: "Failed to create run" });
  }
});

// Switch agent model via Hamsa API (explicit action)
router.post("/:id/switch-model", async (req: AuthRequest, res) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!await canAccess((run.project as any).userId ?? null, req)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const result = await updateAgentModel(
      run.project.agentId,
      run.modelUsed || "openai/gpt-4.1",
      undefined,
      run.project.hamsaApiKey || undefined
    );
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({
      error: "Failed to update agent model",
      detail: (err as Error).message,
    });
  }
});

// Fetch call log from Hamsa API for a run
router.post("/:id/fetch-logs", async (req: AuthRequest, res) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!await canAccess((run.project as any).userId ?? null, req)) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (!run.hamsaCallId) return res.status(400).json({ error: "No call ID on this run" });

    const { fetchCallLog } = await import("../services/hamsaApi");
    const logs = await fetchCallLog(run.hamsaCallId, run.project.hamsaApiKey || undefined);
    await prisma.run.update({
      where: { id: run.id },
      data: { callLog: logs as any },
    });
    res.json({ ok: true, events: Array.isArray(logs) ? logs.length : 0 });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Manually attach call log to a run (for local testing without API)
router.post("/:id/call-log", async (req: AuthRequest, res) => {
  const { callLog } = req.body;
  if (callLog === undefined) return res.status(400).json({ error: "callLog is required" });
  if (!Array.isArray(callLog)) return res.status(400).json({ error: "callLog must be an array" });

  try {
    const access = await assertRunAccess(req.params.id, req, res);
    if (!access) return;

    const run = await prisma.run.update({
      where: { id: access.id },
      data: { callLog },
    });
    await runEvaluationCheck(run.id);
    res.json(run);
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Run not found" });
    res.status(500).json({ error: "Failed to attach call log" });
  }
});

// Manually attach transcript/webhook data to a run (for local testing)
router.post("/:id/transcript", async (req: AuthRequest, res) => {
  const { transcript, webhookData } = req.body;

  try {
    const access = await assertRunAccess(req.params.id, req, res);
    if (!access) return;

    const run = await prisma.run.update({
      where: { id: access.id },
      data: { transcript, webhookData },
    });
    await runEvaluationCheck(run.id);
    res.json(run);
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Run not found" });
    res.status(500).json({ error: "Failed to attach transcript" });
  }
});

// Manually trigger evaluation (force re-run even if status is COMPLETE)
router.post("/:id/evaluate", async (req: AuthRequest, res) => {
  try {
    const access = await assertRunAccess(req.params.id, req, res);
    if (!access) return;

    // Atomic reset: prevents interrupting an in-progress evaluation.
    const updated = await prisma.run.updateMany({
      where: { id: access.id, status: { notIn: ["EVALUATING"] } },
      data: { status: "PENDING" },
    });

    if (updated.count === 0) {
      return res.status(409).json({ error: "Evaluation already in progress" });
    }

    await runEvaluationCheck(access.id);
    res.json({ ok: true, message: "Evaluation queued" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Set the hamsa call ID or status (after starting call via SDK)
router.patch("/:id", async (req: AuthRequest, res) => {
  const { hamsaCallId, status } = req.body;

  if (status !== undefined) {
    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: `Invalid status: ${status}` });
    }
    if (!CLIENT_SETTABLE_STATUSES.has(status)) {
      return res.status(400).json({ error: `Status '${status}' cannot be set via this endpoint` });
    }
  }

  try {
    const access = await assertRunAccess(req.params.id, req, res);
    if (!access) return;

    const data: any = {};
    if (hamsaCallId !== undefined) data.hamsaCallId = hamsaCallId;
    if (status !== undefined) data.status = status;

    const run = await prisma.run.update({
      where: { id: access.id },
      data,
    });
    res.json(run);
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Run not found" });
    res.status(500).json({ error: "Failed to update run" });
  }
});

// Delete a run
router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const access = await assertRunAccess(req.params.id, req, res);
    if (!access) return;

    await prisma.run.delete({ where: { id: access.id } });
    res.json({ ok: true });
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Run not found" });
    res.status(500).json({ error: "Failed to delete run" });
  }
});

// Compare multiple runs — max 20, must all belong to the same project
router.post("/compare", async (req: AuthRequest, res) => {
  const { runIds } = req.body;
  if (!Array.isArray(runIds) || runIds.length === 0) {
    return res.status(400).json({ error: "runIds must be a non-empty array" });
  }
  if (runIds.length > 20) {
    return res.status(400).json({ error: "Cannot compare more than 20 runs at once" });
  }
  if (runIds.some((id: unknown) => typeof id !== "string" || !id.trim())) {
    return res.status(400).json({ error: "Each runId must be a non-empty string" });
  }

  try {
    const runs = await prisma.run.findMany({
      where: { id: { in: runIds } },
      include: {
        evalResults: { include: { criterion: true } },
        _count: { select: { wordLabels: true } },
        project: { select: { userId: true } },
      },
    });

    // If none of the requested IDs exist, return 404 rather than an empty 200
    if (runs.length === 0) {
      return res.status(404).json({ error: "No runs found for the provided IDs" });
    }

    // Verify all runs belong to the same project
    const projectIds = new Set(runs.map((r) => r.projectId));
    if (projectIds.size > 1) {
      return res.status(400).json({ error: "All runs must belong to the same project" });
    }

    // Verify the user owns the project (runs.length > 0 is guaranteed above)
    const projectUserId = (runs[0].project as any)?.userId as string | null;
    if (!await canAccess(projectUserId, req)) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Return only the runs the caller explicitly requested (IDs not found are silently absent)
    res.json(runs);
  } catch {
    res.status(500).json({ error: "Failed to compare runs" });
  }
});

export default router;
