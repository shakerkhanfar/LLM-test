import prisma from "../lib/prisma";
import { Router } from "express";
import { CriterionType } from "@prisma/client";
import { getAgent } from "../services/hamsaApi";
import { generateAgentSummary } from "../services/llmJudge";
import { analyzeProject, compareAnalyses } from "../services/projectAnalyzer";
import { searchRuns } from "../services/runSearch";
import { AuthRequest } from "../middleware/auth";

const router = Router();

const VALID_CRITERION_TYPES = new Set<string>(Object.values(CriterionType));
const VALID_PROJECT_TYPES = new Set(["LIVE", "HISTORY", "WEBHOOK"]);

// List all projects scoped to the authenticated user
router.get("/", async (req: AuthRequest, res) => {
  const projects = await prisma.project.findMany({
    where: { userId: req.userId },
    include: {
      _count: { select: { criteria: true, runs: true } },
      runs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true, modelUsed: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(projects);
});

// Preview agent details from Hamsa API (before creating a project)
// POST because the API key must not appear in the URL / server access logs
router.post("/agent-preview", async (req, res) => {
  const { agentId, apiKey } = req.body as { agentId?: string; apiKey?: string };
  if (!agentId || typeof agentId !== "string" || !agentId.trim()) {
    return res.status(400).json({ error: "agentId is required" });
  }

  try {
    const agent = await getAgent(agentId.trim(), apiKey?.trim());
    res.json({
      id: agent.id,
      name: agent.name,
      type: agent.type,
      language: agent.voice?.lang,
      llm: agent.llm,
      preamble: agent.conversation?.preamble,
      greetingMessage: agent.conversation?.greetingMessage,
      hasWorkflow: !!(agent.workflow?.nodes?.length),
      nodeCount: agent.workflow?.nodes?.length ?? 0,
      toolCount: agent.tools?.length ?? 0,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Get single project with criteria and runs (most recent 100 runs)
router.get("/:id", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        criteria: true,
        runs: {
          orderBy: { createdAt: "desc" },
          take: 100,
          include: {
            evalResults: { include: { criterion: true } },
          },
        },
      },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.userId && project.userId !== req.userId) {
      return res.status(403).json({ error: "Access denied" });
    }
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch project" });
  }
});

// Create project
router.post("/", async (req: AuthRequest, res) => {
  const { name, agentId, hamsaApiKey, description, agentStructure, criteria, projectType, historyStartDate, historyEndDate } = req.body;

  // Basic input validation
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Project name is required" });
  }
  if (!agentId || typeof agentId !== "string" || !agentId.trim()) {
    return res.status(400).json({ error: "Agent ID is required" });
  }
  if (projectType && !VALID_PROJECT_TYPES.has(projectType)) {
    return res.status(400).json({ error: `Invalid projectType. Must be LIVE, HISTORY, or WEBHOOK` });
  }
  if (criteria?.length) {
    for (const c of criteria) {
      if (!VALID_CRITERION_TYPES.has(c.type)) {
        return res.status(400).json({ error: `Invalid criterion type: ${c.type}` });
      }
    }
  }

  try {
    // Auto-fetch agent details if no structure was manually provided
    let resolvedAgentStructure = agentStructure;
    if (!resolvedAgentStructure && agentId) {
      try {
        const agent = await getAgent(agentId.trim(), hamsaApiKey?.trim());
        resolvedAgentStructure = agent;
        console.log(`[Projects] Auto-fetched agent details for ${agentId}: ${agent.name} (${agent.type})`);
      } catch (err) {
        console.warn(`[Projects] Could not auto-fetch agent details: ${(err as Error).message}`);
      }
    }

    // Generate LLM summary of the agent's purpose, flow, and success criteria.
    // Run in background after project creation so it doesn't block the response.
    const project = await prisma.project.create({
      data: {
        userId: req.userId,
        name: name.trim(),
        agentId: agentId.trim(),
        hamsaApiKey: hamsaApiKey?.trim() || null,
        description: description?.trim() || null,
        projectType: projectType || "LIVE",
        historyStartDate: historyStartDate ? new Date(historyStartDate) : undefined,
        historyEndDate: historyEndDate ? new Date(historyEndDate) : undefined,
        agentStructure: resolvedAgentStructure,
        flowDefinition: (resolvedAgentStructure?.workflow
          ? extractFlowDefinition(resolvedAgentStructure.workflow)
          : undefined) as any,
        criteria: criteria?.length
          ? {
              create: criteria.map((c: any) => ({
                key: c.key,
                label: c.label,
                type: c.type as CriterionType,
                expectedValue: c.expectedValue,
                weight: c.weight ?? 1.0,
              })),
            }
          : undefined,
      },
      include: { criteria: true },
    });

    res.status(201).json(project);

    // Fire-and-forget: generate and store agent summary after responding
    if (resolvedAgentStructure) {
      generateAgentSummary(resolvedAgentStructure)
        .then((summary) => {
          if (!summary) return;
          return prisma.project.update({
            where: { id: project.id },
            data: { agentSummary: summary },
          });
        })
        .then(() => console.log(`[Projects] Agent summary generated for ${project.id}`))
        .catch((err) => console.warn(`[Projects] Agent summary failed: ${(err as Error).message}`));
    }
  } catch (err) {
    console.error("[Projects] Create error:", err);
    res.status(500).json({ error: "Failed to create project" });
  }
});

// Update project
router.patch("/:id", async (req: AuthRequest, res) => {
  const { name, description, agentStructure } = req.body;

  try {
    const existing = await prisma.project.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!existing) return res.status(404).json({ error: "Project not found" });
    if (existing.userId && existing.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

    const data: any = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (agentStructure !== undefined) {
      data.agentStructure = agentStructure;
      data.flowDefinition = agentStructure?.workflow
        ? extractFlowDefinition(agentStructure.workflow)
        : null;
    }

    const project = await prisma.project.update({
      where: { id: req.params.id },
      data,
      include: { criteria: true },
    });
    res.json(project);
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Project not found" });
    res.status(500).json({ error: "Failed to update project" });
  }
});

// Refresh agent details from Hamsa API
router.post("/:id/refresh-agent", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.userId && project.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

    const agent = await getAgent(project.agentId, project.hamsaApiKey || undefined);
    const updated = await prisma.project.update({
      where: { id: req.params.id },
      data: {
        agentStructure: agent as any,
        flowDefinition: (agent.workflow
          ? extractFlowDefinition(agent.workflow)
          : null) as any,
      },
      include: { criteria: true },
    });
    res.json({ ok: true, agentName: agent.name, project: updated });

    // Regenerate agent summary in background
    generateAgentSummary(agent)
      .then((summary) => {
        if (!summary) return;
        return prisma.project.update({ where: { id: req.params.id }, data: { agentSummary: summary } });
      })
      .then(() => console.log(`[Projects] Agent summary refreshed for ${req.params.id}`))
      .catch((err) => console.warn(`[Projects] Agent summary refresh failed: ${(err as Error).message}`));
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Project not found" });
    res.status(500).json({ error: (err as Error).message });
  }
});

// Delete project
router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.project.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!existing) return res.status(404).json({ error: "Project not found" });
    if (existing.userId && existing.userId !== req.userId) return res.status(403).json({ error: "Access denied" });
    await prisma.project.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Project not found" });
    res.status(500).json({ error: "Failed to delete project" });
  }
});

// Add criterion to project
router.post("/:id/criteria", async (req: AuthRequest, res) => {
  const { key, label, type, expectedValue, weight } = req.body;

  if (!key || typeof key !== "string") {
    return res.status(400).json({ error: "criterion key is required" });
  }
  if (!VALID_CRITERION_TYPES.has(type)) {
    return res.status(400).json({ error: `Invalid criterion type: ${type}` });
  }

  try {
    const existing = await prisma.project.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!existing) return res.status(404).json({ error: "Project not found" });
    if (existing.userId !== null && existing.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

    const criterion = await prisma.criterion.create({
      data: {
        projectId: req.params.id,
        key,
        label,
        type: type as CriterionType,
        expectedValue,
        weight: weight ?? 1.0,
      },
    });
    res.status(201).json(criterion);
  } catch (err: any) {
    if (err?.code === "P2003") return res.status(404).json({ error: "Project not found" });
    if (err?.code === "P2002") return res.status(409).json({ error: `Criterion with key '${key}' already exists` });
    res.status(500).json({ error: "Failed to create criterion" });
  }
});

// Delete criterion — verify it belongs to this project first
router.delete("/:id/criteria/:criterionId", async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.project.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!existing) return res.status(404).json({ error: "Project not found" });
    if (existing.userId !== null && existing.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

    const criterion = await prisma.criterion.findFirst({
      where: { id: req.params.criterionId, projectId: req.params.id },
    });
    if (!criterion) return res.status(404).json({ error: "Criterion not found in this project" });

    await prisma.criterion.delete({ where: { id: req.params.criterionId } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete criterion" });
  }
});

// ─── Helpers ───────────────────────────────────────────────────────

function extractFlowDefinition(workflow: any) {
  if (!workflow?.nodes || !workflow?.edges) return null;

  const nodeMap: Record<string, any> = {};
  for (const node of workflow.nodes) {
    nodeMap[node.id] = {
      id: node.id,
      type: node.type,
      label: node.label,
      subType: node.subType,
    };
  }

  const adjacency: Record<string, string[]> = {};
  for (const edge of workflow.edges) {
    if (!adjacency[edge.source]) adjacency[edge.source] = [];
    if (!adjacency[edge.source].includes(edge.target)) {
      adjacency[edge.source].push(edge.target);
    }
  }

  const startNode = workflow.nodes.find((n: any) => n.type === "start");

  const toolNodes = workflow.nodes
    .filter((n: any) => n.type === "tool")
    .map((n: any) => ({
      nodeId: n.id,
      label: n.label,
      description: n.description,
      toolId: n.toolId,
    }));

  return {
    startNodeId: startNode?.id,
    nodes: nodeMap,
    adjacency,
    toolNodes,
    totalNodes: workflow.nodes.length,
  };
}

// ─── Project Analysis (versioned) ─────────────────────────────────

// In-process guard: prevents concurrent analyses on the same project from
// racing on version numbers (both would fetch the same previousVersion, then
// both try prisma.create with the same version → P2002 unique constraint).
const analyzingProjects = new Set<string>();

// Trigger a new analysis version for the project
router.post("/:id/analyze", async (req: AuthRequest, res) => {
  const projectId = req.params.id;
  const { dateFilterType, from, to } = req.body;

  if (dateFilterType && !["CALL_DATE", "EVAL_DATE"].includes(dateFilterType)) {
    return res.status(400).json({ error: "dateFilterType must be CALL_DATE or EVAL_DATE" });
  }

  if (analyzingProjects.has(projectId)) {
    return res.status(409).json({ error: "An analysis is already running for this project" });
  }

  // Ownership check
  const projectOwner = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } });
  if (!projectOwner) return res.status(404).json({ error: "Project not found" });
  if (projectOwner.userId !== null && projectOwner.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

  analyzingProjects.add(projectId);
  try {
    const result = await analyzeProject(projectId, {
      dateFilterType: dateFilterType || undefined,
      from: from || undefined,
      to:   to   || undefined,
    });
    res.json(result);
  } catch (err: any) {
    const msg = (err as Error).message;
    // P2002 = unique constraint violation: another concurrent request (from a
    // different process/instance) already inserted this version. Treat as 409.
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "Another analysis completed at the same time. Please try again." });
    }
    // Return 400 for known user-facing errors (not enough runs, project not found)
    const isClientError = msg.includes("At least 3") || msg.includes("not found");
    res.status(isClientError ? 400 : 500).json({ error: msg });
  } finally {
    analyzingProjects.delete(projectId);
  }
});

// List all analysis versions for the project (newest first)
router.get("/:id/analyses", async (req: AuthRequest, res) => {
  try {
    const p = await prisma.project.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!p) return res.status(404).json({ error: "Project not found" });
    if (p.userId !== null && p.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

    const analyses = await prisma.projectAnalysis.findMany({
      where:   { projectId: req.params.id },
      orderBy: { version: "desc" },
    });
    res.json(analyses);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Compare multiple analysis versions (LLM-powered)
router.post("/:id/analyses/compare", async (req: AuthRequest, res) => {
  const { analysisIds } = req.body;
  if (!Array.isArray(analysisIds) || analysisIds.length < 2) {
    return res.status(400).json({ error: "Provide at least 2 analysisIds to compare" });
  }
  if (analysisIds.length > 6) {
    return res.status(400).json({ error: "Maximum 6 versions can be compared at once" });
  }
  // Guard against non-string IDs (e.g. injected objects or numbers)
  if (analysisIds.some((id: unknown) => typeof id !== "string" || !id.trim())) {
    return res.status(400).json({ error: "Each analysisId must be a non-empty string" });
  }
  try {
    const result = await compareAnalyses(req.params.id, analysisIds);
    // Warn the caller if some IDs were filtered out (wrong project / deleted)
    if (result.analyses.length < analysisIds.length) {
      const found = result.analyses.map((a: any) => a.id);
      const missing = analysisIds.filter((id: string) => !found.includes(id));
      return res.status(400).json({
        error: `${missing.length} analysis ID(s) not found in this project: ${missing.join(", ")}`,
      });
    }
    res.json(result);
  } catch (err: any) {
    const msg = (err as Error).message;
    const isClientError = msg.includes("At least 2") || msg.includes("not found");
    res.status(isClientError ? 400 : 500).json({ error: msg });
  }
});

// Delete a single analysis version (ownership check: analysisId must belong to this project)
router.delete("/:id/analyses/:analysisId", async (req: AuthRequest, res) => {
  try {
    const p = await prisma.project.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!p) return res.status(404).json({ error: "Project not found" });
    if (p.userId !== null && p.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

    await prisma.projectAnalysis.delete({
      where: { id: req.params.analysisId, projectId: req.params.id },
    });
    res.json({ ok: true });
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Analysis not found" });
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/projects/:id/ask
 *
 * Natural language search across evaluated runs.
 * Body: { question: string }
 * Returns matching runs with explanations.
 */
router.post("/:id/ask", async (req: AuthRequest, res) => {
  const { question } = req.body;
  if (!question || typeof question !== "string" || question.trim().length < 3) {
    return res.status(400).json({ error: "Please provide a question (min 3 characters)" });
  }

  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.userId !== null && project.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

  // 30s timeout — two LLM calls + DB query can take time
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: "Search timed out. Try a more specific question." });
    }
  }, 30_000);

  try {
    const result = await searchRuns(project.id, question.trim(), project.agentSummary || "");
    clearTimeout(timeout);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    clearTimeout(timeout);
    console.error("[Ask] Search failed:", err);
    if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
