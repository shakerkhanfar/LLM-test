import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { runEvaluationCheck } from "../services/evaluationRunner";

const router = Router();
const prisma = new PrismaClient();

// Get all labels for a run
router.get("/run/:runId", async (req, res) => {
  const labels = await prisma.wordLabel.findMany({
    where: { runId: req.params.runId },
    orderBy: { wordIndex: "asc" },
  });
  res.json(labels);
});

// Create a word label
router.post("/run/:runId", async (req, res) => {
  const { wordIndex, utteranceIndex, originalWord, labelType, correction } = req.body;

  const label = await prisma.wordLabel.create({
    data: {
      runId: req.params.runId,
      wordIndex,
      utteranceIndex: utteranceIndex ?? 0,
      originalWord,
      labelType,
      correction,
    },
  });

  // Re-evaluate word accuracy
  await runEvaluationCheck(req.params.runId);

  res.status(201).json(label);
});

// Remove a label
router.delete("/:id", async (req, res) => {
  const label = await prisma.wordLabel.findUnique({ where: { id: req.params.id } });
  if (!label) return res.status(404).json({ error: "Label not found" });

  await prisma.wordLabel.delete({ where: { id: req.params.id } });

  // Re-evaluate word accuracy
  await runEvaluationCheck(label.runId);

  res.json({ ok: true });
});

// Bulk create labels
router.post("/run/:runId/bulk", async (req, res) => {
  const { labels } = req.body; // Array of { wordIndex, utteranceIndex, originalWord, labelType, correction }

  const created = await prisma.wordLabel.createMany({
    data: labels.map((l: any) => ({
      runId: req.params.runId,
      wordIndex: l.wordIndex,
      utteranceIndex: l.utteranceIndex ?? 0,
      originalWord: l.originalWord,
      labelType: l.labelType,
      correction: l.correction,
    })),
    skipDuplicates: true,
  });

  await runEvaluationCheck(req.params.runId);

  res.status(201).json({ count: created.count });
});

export default router;
