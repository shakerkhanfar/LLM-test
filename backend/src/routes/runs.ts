import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { updateAgentModel } from "../services/hamsaApi";
import { runEvaluationCheck } from "../services/evaluationRunner";

const router = Router();
const prisma = new PrismaClient();

// List runs for a project
router.get("/project/:projectId", async (req, res) => {
  const runs = await prisma.run.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { createdAt: "desc" },
    include: {
      evalResults: { include: { criterion: true } },
      _count: { select: { wordLabels: true } },
    },
  });
  res.json(runs);
});

// Get single run with full details
router.get("/:id", async (req, res) => {
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
});

// Create a new run
router.post("/", async (req, res) => {
  const { projectId, modelUsed } = req.body;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) return res.status(404).json({ error: "Project not found" });

  const run = await prisma.run.create({
    data: {
      projectId,
      modelUsed,
      status: "PENDING",
      startedAt: new Date(),
    },
  });

  res.status(201).json(run);
});

// Switch agent model via Hamsa API (explicit action)
router.post("/:id/switch-model", async (req, res) => {
  const run = await prisma.run.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!run) return res.status(404).json({ error: "Run not found" });

  try {
    const result = await updateAgentModel(
      run.project.agentId,
      run.modelUsed,
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

// Manually attach call log to a run (for local testing without API)
router.post("/:id/call-log", async (req, res) => {
  const { callLog } = req.body;
  const run = await prisma.run.update({
    where: { id: req.params.id },
    data: { callLog },
  });

  // Check if we can evaluate
  await runEvaluationCheck(run.id);
  res.json(run);
});

// Manually attach transcript/webhook data to a run (for local testing)
router.post("/:id/transcript", async (req, res) => {
  const { transcript, webhookData } = req.body;
  const run = await prisma.run.update({
    where: { id: req.params.id },
    data: {
      transcript,
      webhookData,
    },
  });

  // Check if we can evaluate
  await runEvaluationCheck(run.id);
  res.json(run);
});

// Manually trigger evaluation
router.post("/:id/evaluate", async (req, res) => {
  await runEvaluationCheck(req.params.id);
  res.json({ ok: true, message: "Evaluation queued" });
});

// Set the hamsa call ID (after starting call via SDK)
router.patch("/:id", async (req, res) => {
  const { hamsaCallId, status } = req.body;
  const data: any = {};
  if (hamsaCallId !== undefined) data.hamsaCallId = hamsaCallId;
  if (status !== undefined) data.status = status;

  const run = await prisma.run.update({
    where: { id: req.params.id },
    data,
  });
  res.json(run);
});

// Delete a run
router.delete("/:id", async (req, res) => {
  await prisma.run.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// Compare multiple runs
router.post("/compare", async (req, res) => {
  const { runIds } = req.body;
  const runs = await prisma.run.findMany({
    where: { id: { in: runIds } },
    include: {
      evalResults: { include: { criterion: true } },
      _count: { select: { wordLabels: true } },
    },
  });
  res.json(runs);
});

export default router;
