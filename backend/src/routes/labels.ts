import prisma from "../lib/prisma";
import { Router } from "express";
import { runEvaluationCheck } from "../services/evaluationRunner";
import { AuthRequest } from "../middleware/auth";
import { assertRunAccess, canAccess } from "../lib/ownership";

const router = Router();

// Get all labels for a run
router.get("/run/:runId", async (req: AuthRequest, res) => {
  const access = await assertRunAccess(req.params.runId, req, res);
  if (!access) return;

  const labels = await prisma.wordLabel.findMany({
    where: { runId: access.id },
    orderBy: { wordIndex: "asc" },
  });
  res.json(labels);
});

// Create a word label
router.post("/run/:runId", async (req: AuthRequest, res) => {
  const access = await assertRunAccess(req.params.runId, req, res);
  if (!access) return;

  const { wordIndex, utteranceIndex, originalWord, labelType, correction } = req.body;

  try {
    const label = await prisma.wordLabel.create({
      data: {
        runId: access.id,
        wordIndex,
        utteranceIndex: utteranceIndex ?? 0,
        originalWord,
        labelType,
        correction,
      },
    });

    // Re-evaluate word accuracy
    await runEvaluationCheck(access.id);

    res.status(201).json(label);
  } catch (err: any) {
    if (err?.code === "P2003") return res.status(404).json({ error: "Run not found" });
    if (err?.code === "P2002") return res.status(409).json({ error: "Label at this word index already exists" });
    res.status(500).json({ error: "Failed to create label" });
  }
});

// Remove a label
router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const label = await prisma.wordLabel.findUnique({
      where: { id: req.params.id },
      include: { run: { select: { project: { select: { userId: true } } } } },
    });
    if (!label) return res.status(404).json({ error: "Label not found" });

    const projectUserId = (label as any).run?.project?.userId as string | null;
    if (!await canAccess(projectUserId, req)) {
      return res.status(403).json({ error: "Access denied" });
    }

    await prisma.wordLabel.delete({ where: { id: req.params.id } });

    // Re-evaluate word accuracy
    await runEvaluationCheck(label.runId);

    res.json({ ok: true });
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Label not found" });
    res.status(500).json({ error: "Failed to delete label" });
  }
});

// Bulk create labels
router.post("/run/:runId/bulk", async (req: AuthRequest, res) => {
  const access = await assertRunAccess(req.params.runId, req, res);
  if (!access) return;

  const { labels } = req.body;
  if (!Array.isArray(labels) || labels.length === 0) {
    return res.status(400).json({ error: "labels must be a non-empty array" });
  }

  try {
    const created = await prisma.wordLabel.createMany({
      data: labels.map((l: any) => ({
        runId: access.id,
        wordIndex: l.wordIndex,
        utteranceIndex: l.utteranceIndex ?? 0,
        originalWord: l.originalWord,
        labelType: l.labelType,
        correction: l.correction,
      })),
      skipDuplicates: true,
    });

    await runEvaluationCheck(access.id);

    res.status(201).json({ count: created.count });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to bulk create labels" });
  }
});

export default router;
