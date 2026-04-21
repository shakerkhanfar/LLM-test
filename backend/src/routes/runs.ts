import prisma from "../lib/prisma";
import { Router } from "express";
import { RunStatus } from "@prisma/client";
import { updateAgentModel } from "../services/hamsaApi";
import { runEvaluationCheck } from "../services/evaluationRunner";

const router = Router();

const VALID_STATUSES = new Set<string>(Object.values(RunStatus));
// Only allow external callers to set these statuses (not e.g. EVALUATING or COMPLETE)
const CLIENT_SETTABLE_STATUSES = new Set<string>(["PENDING", "RUNNING", "AWAITING_DATA", "FAILED"]);

// List runs for a project (most recent 200, with pagination via ?skip=)
router.get("/project/:projectId", async (req, res) => {
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
router.get("/:id", async (req, res) => {
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
    res.json(run);
  } catch {
    res.status(500).json({ error: "Failed to fetch run" });
  }
});

// Create a new run
router.post("/", async (req, res) => {
  const { projectId, modelUsed } = req.body;
  if (!projectId) return res.status(400).json({ error: "projectId is required" });

  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: "Project not found" });

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
router.post("/:id/switch-model", async (req, res) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });

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
router.post("/:id/fetch-logs", async (req, res) => {
  try {
    const run = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });
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
router.post("/:id/call-log", async (req, res) => {
  const { callLog } = req.body;
  if (callLog === undefined) return res.status(400).json({ error: "callLog is required" });
  if (!Array.isArray(callLog)) return res.status(400).json({ error: "callLog must be an array" });

  try {
    const existing = await prisma.run.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Run not found" });

    const run = await prisma.run.update({
      where: { id: req.params.id },
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
router.post("/:id/transcript", async (req, res) => {
  const { transcript, webhookData } = req.body;

  try {
    const existing = await prisma.run.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Run not found" });

    const run = await prisma.run.update({
      where: { id: req.params.id },
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
router.post("/:id/evaluate", async (req, res) => {
  try {
    // Atomic reset: only proceeds if the run exists; 404s cleanly otherwise.
    // notIn guard prevents interrupting an already in-progress evaluation.
    const updated = await prisma.run.updateMany({
      where: { id: req.params.id, status: { notIn: ["EVALUATING"] } },
      data: { status: "PENDING" },
    });

    if (updated.count === 0) {
      // Either the run doesn't exist or it's currently being evaluated
      const exists = await prisma.run.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
      if (!exists) return res.status(404).json({ error: "Run not found" });
      return res.status(409).json({ error: "Evaluation already in progress" });
    }

    await runEvaluationCheck(req.params.id);
    res.json({ ok: true, message: "Evaluation queued" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Set the hamsa call ID or status (after starting call via SDK)
router.patch("/:id", async (req, res) => {
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
    const data: any = {};
    if (hamsaCallId !== undefined) data.hamsaCallId = hamsaCallId;
    if (status !== undefined) data.status = status;

    const run = await prisma.run.update({
      where: { id: req.params.id },
      data,
    });
    res.json(run);
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Run not found" });
    res.status(500).json({ error: "Failed to update run" });
  }
});

// Delete a run
router.delete("/:id", async (req, res) => {
  try {
    await prisma.run.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Run not found" });
    res.status(500).json({ error: "Failed to delete run" });
  }
});

// Compare multiple runs — max 20, must all belong to the same project
router.post("/compare", async (req, res) => {
  const { runIds } = req.body;
  if (!Array.isArray(runIds) || runIds.length === 0) {
    return res.status(400).json({ error: "runIds must be a non-empty array" });
  }
  if (runIds.length > 20) {
    return res.status(400).json({ error: "Cannot compare more than 20 runs at once" });
  }

  try {
    const runs = await prisma.run.findMany({
      where: { id: { in: runIds } },
      include: {
        evalResults: { include: { criterion: true } },
        _count: { select: { wordLabels: true } },
      },
    });

    // Verify all runs belong to the same project
    const projectIds = new Set(runs.map((r) => r.projectId));
    if (projectIds.size > 1) {
      return res.status(400).json({ error: "All runs must belong to the same project" });
    }

    res.json(runs);
  } catch {
    res.status(500).json({ error: "Failed to compare runs" });
  }
});

export default router;
