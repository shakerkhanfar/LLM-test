import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

// List all projects
router.get("/", async (_req, res) => {
  const projects = await prisma.project.findMany({
    include: {
      _count: { select: { criteria: true, runs: true } },
      runs: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, modelUsed: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(projects);
});

// Get single project with criteria and runs
router.get("/:id", async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: {
      criteria: true,
      runs: {
        orderBy: { createdAt: "desc" },
        include: {
          evalResults: { include: { criterion: true } },
        },
      },
    },
  });
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json(project);
});

// Create project
router.post("/", async (req, res) => {
  const { name, agentId, hamsaApiKey, description, agentStructure, criteria } = req.body;

  const project = await prisma.project.create({
    data: {
      name,
      agentId,
      hamsaApiKey,
      description,
      agentStructure,
      flowDefinition: (agentStructure?.workflow
        ? extractFlowDefinition(agentStructure.workflow)
        : undefined) as any,
      criteria: criteria?.length
        ? {
            create: criteria.map((c: any) => ({
              key: c.key,
              label: c.label,
              type: c.type,
              expectedValue: c.expectedValue,
              weight: c.weight ?? 1.0,
            })),
          }
        : undefined,
    },
    include: { criteria: true },
  });

  res.status(201).json(project);
});

// Update project
router.patch("/:id", async (req, res) => {
  const { name, description, agentStructure } = req.body;
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
});

// Delete project
router.delete("/:id", async (req, res) => {
  await prisma.project.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// Add criterion to project
router.post("/:id/criteria", async (req, res) => {
  const { key, label, type, expectedValue, weight } = req.body;
  const criterion = await prisma.criterion.create({
    data: {
      projectId: req.params.id,
      key,
      label,
      type,
      expectedValue,
      weight: weight ?? 1.0,
    },
  });
  res.status(201).json(criterion);
});

// Delete criterion
router.delete("/:id/criteria/:criterionId", async (req, res) => {
  await prisma.criterion.delete({ where: { id: req.params.criterionId } });
  res.json({ ok: true });
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

  // Build adjacency list from edges
  const adjacency: Record<string, string[]> = {};
  for (const edge of workflow.edges) {
    if (!adjacency[edge.source]) adjacency[edge.source] = [];
    if (!adjacency[edge.source].includes(edge.target)) {
      adjacency[edge.source].push(edge.target);
    }
  }

  // Find start node
  const startNode = workflow.nodes.find((n: any) => n.type === "start");

  // Extract tool nodes
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

export default router;
