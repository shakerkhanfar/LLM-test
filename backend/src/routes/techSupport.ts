import prisma from "../lib/prisma";
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { AuthRequest } from "../middleware/auth";
import { canAccess } from "../lib/ownership";
import { updateAgentWorkflow } from "../services/hamsaApi";

const router = Router();

// ── Validation constants ──────────────────────────────────────────────────────

const VALID_DOC_TYPES = new Set(["DESCRIPTION", "CODE_SNIPPET", "ERROR_CODES", "DATA_FLOW"]);
const VALID_ISSUE_TYPES = new Set([
  "AGENT_BEHAVIOR", "BACKEND_FAILURE", "DATA_MISMATCH",
  "VARIABLE_SETTER", "CONFIGURATION", "OTHER",
]);
const VALID_ISSUE_STATUSES = new Set(["OPEN", "IN_PROGRESS", "RESOLVED", "WONT_FIX"]);
const VALID_FIELD_TYPES = new Set(["message", "staticVariable"]);

const MAX_CONTENT_CHARS = 8_000;
const MAX_PROMPT_CHARS = 20_000;
const MAX_BUG_STRING_CHARS = 2_000;
const MAX_DESCRIPTION_CHARS = 4_000;

// ── Project helpers ───────────────────────────────────────────────────────────

/**
 * Lightweight helper for read/write metadata operations.
 * Does NOT select agentStructure or hamsaApiKey — never expose secrets
 * in handlers that don't need them.
 */
async function getProjectMeta(projectId: string, req: AuthRequest, res: any) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true, projectType: true },
  });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return null;
  }
  if (project.projectType !== "TECH_SUPPORT") {
    res.status(403).json({ error: "Endpoint only available for TECH_SUPPORT projects" });
    return null;
  }
  if (!await canAccess(project.userId, req)) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }
  return project;
}

/**
 * Helper for live-agent patch operations.
 * Selects agentStructure, hamsaApiKey, and updatedAt (for optimistic concurrency lock).
 */
async function getProjectForPatch(projectId: string, req: AuthRequest, res: any) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, userId: true, projectType: true,
      agentId: true, hamsaApiKey: true, agentStructure: true, updatedAt: true,
    },
  });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return null;
  }
  if (project.projectType !== "TECH_SUPPORT") {
    res.status(403).json({ error: "Endpoint only available for TECH_SUPPORT projects" });
    return null;
  }
  if (!await canAccess(project.userId, req)) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }
  return project;
}

/**
 * Resolve the patched node array from agentStructure given a nodeId and
 * patch mode (find-replace or full replacement). Returns null and sends
 * an error response if validation fails.
 */
function buildPatchedNodes(
  project: { agentStructure: any },
  nodeId: string,
  opts: { bugString?: string; fixString?: string; fieldType?: string; newPrompt?: string },
  res: any,
): { updatedNodes: any[]; appliedContent: string } | null {
  if (!project.agentStructure) {
    res.status(400).json({ error: "Agent structure not loaded. Sync the agent first." });
    return null;
  }
  const structure = project.agentStructure as any;
  const nodes: any[] = structure?.workflow?.nodes ?? [];
  const node = nodes.find((n: any) => n.id === nodeId);
  if (!node) {
    res.status(404).json({ error: `Node ${nodeId} not found in agent structure` });
    return null;
  }

  const { bugString, fixString, fieldType, newPrompt } = opts;

  if (bugString && fixString) {
    const target = fieldType === "staticVariable" ? "staticVariable" : "message";

    if (target === "message") {
      const original: string = node.message ?? "";
      const occurrences = original.split(bugString).length - 1;
      if (occurrences === 0) {
        res.status(400).json({ error: "bugString not found in node message. Already patched?" });
        return null;
      }
      if (occurrences > 1) {
        res.status(400).json({ error: `bugString matched ${occurrences} times — use a more specific string to avoid unintended replacements` });
        return null;
      }
      const patched = original.split(bugString).join(fixString);
      return {
        updatedNodes: nodes.map((n: any) => n.id === nodeId ? { ...n, message: patched } : n),
        appliedContent: patched,
      };
    } else {
      const staticVars: any[] = node.staticVariables ?? [];
      let matched = false;
      const patchedVars = staticVars.map((sv: any) => {
        const val: string = sv.value ?? "";
        if (val.includes(bugString)) {
          matched = true;
          return { ...sv, value: val.split(bugString).join(fixString) };
        }
        return sv;
      });
      if (!matched) {
        res.status(400).json({
          error: `bugString not found in any staticVariable in node ${nodeId}. Already patched?`,
        });
        return null;
      }
      return {
        updatedNodes: nodes.map((n: any) =>
          n.id === nodeId ? { ...n, staticVariables: patchedVars } : n
        ),
        appliedContent: `staticVariable patch: "${bugString}" → "${fixString}"`,
      };
    }
  }

  if (newPrompt) {
    const trimmed = newPrompt.trim();
    return {
      updatedNodes: nodes.map((n: any) => n.id === nodeId ? { ...n, message: trimmed } : n),
      appliedContent: trimmed,
    };
  }

  res.status(400).json({ error: "Provide either (bugString + fixString) or newPrompt" });
  return null;
}

/**
 * Push updatedNodes to Hamsa, then atomically update the local agentStructure cache
 * and create a TechIssueFix record in a single DB transaction.
 * Uses updatedAt for optimistic concurrency — returns 409 if another patch raced this one.
 */
async function pushPatchAndLog(opts: {
  project: { id: string; agentId: string; hamsaApiKey: string | null; agentStructure: any; updatedAt: Date };
  updatedNodes: any[];
  fixData: {
    issueId: string;
    description: string;
    nodeId: string | null;
    oldPrompt: string | null;
    newPrompt: string | null;
    appliedBy: string | null;
  };
  res: any;
}): Promise<{ fix: any } | null> {
  const { project, updatedNodes, fixData, res } = opts;
  const structure = project.agentStructure as any;
  const newStructure = { ...structure, workflow: { ...structure.workflow, nodes: updatedNodes } };

  // Push to Hamsa first — this is the mutation that cannot be rolled back.
  await updateAgentWorkflow(project.agentId, updatedNodes, project.hamsaApiKey ?? undefined);

  // Atomically: log the fix + update local agentStructure cache.
  // The optimistic updatedAt check prevents a concurrent patch from silently
  // overwriting another's changes in the local cache.
  const [fix, updateResult] = await prisma.$transaction([
    prisma.techIssueFix.create({ data: fixData }),
    prisma.project.updateMany({
      where: { id: project.id, updatedAt: project.updatedAt },
      data: { agentStructure: newStructure },
    }),
  ]);

  if (updateResult.count === 0) {
    // Hamsa was already patched successfully. The local cache diverged due to
    // a concurrent patch — caller should re-sync the agent to reconcile.
    res.status(409).json({
      error: "Concurrent patch detected. Fix was applied to the live agent but local cache needs re-sync. Re-fetch the agent and retry.",
    });
    return null;
  }

  console.log(JSON.stringify({
    event: "agent_patched",
    projectId: project.id,
    agentId: project.agentId,
    nodeId: fixData.nodeId,
    issueId: fixData.issueId,
    appliedBy: fixData.appliedBy,
    timestamp: new Date().toISOString(),
  }));

  return { fix };
}

// ── System Documents ──────────────────────────────────────────────────────────

router.get("/:projectId/system-docs", asyncHandler(async (req: AuthRequest, res) => {
  const project = await getProjectMeta(req.params.projectId, req, res);
  if (!project) return;

  const docs = await prisma.systemDocument.findMany({
    where: { projectId: req.params.projectId },
    // Return summary fields by default; include content only when not in list mode
    select: { id: true, name: true, docType: true, order: true, createdAt: true, updatedAt: true,
      content: req.query.summary !== "true" },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  res.json(docs);
}));

router.post("/:projectId/system-docs", asyncHandler(async (req: AuthRequest, res) => {
  const project = await getProjectMeta(req.params.projectId, req, res);
  if (!project) return;

  const { name, docType = "DESCRIPTION", content, order = 0 } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  if (!content?.trim()) return res.status(400).json({ error: "content is required" });
  if (!VALID_DOC_TYPES.has(docType)) {
    return res.status(400).json({ error: `Invalid docType. Must be one of: ${[...VALID_DOC_TYPES].join(", ")}` });
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return res.status(400).json({ error: `content exceeds ${MAX_CONTENT_CHARS} character limit` });
  }
  if (typeof order !== "number" || !Number.isInteger(order)) {
    return res.status(400).json({ error: "order must be an integer" });
  }

  const doc = await prisma.systemDocument.create({
    data: {
      projectId: req.params.projectId,
      name: name.trim(),
      docType: docType as any,
      content: content.trim(),
      order,
    },
  });
  res.status(201).json(doc);
}));

router.patch("/:projectId/system-docs/:docId", asyncHandler(async (req: AuthRequest, res) => {
  const project = await getProjectMeta(req.params.projectId, req, res);
  if (!project) return;

  const { name, docType, content, order } = req.body;

  if (docType !== undefined && !VALID_DOC_TYPES.has(docType)) {
    return res.status(400).json({ error: `Invalid docType. Must be one of: ${[...VALID_DOC_TYPES].join(", ")}` });
  }
  // Guard against null.trim() crash — content: null means "clear it" which is disallowed
  if (content !== undefined && content !== null && typeof content !== "string") {
    return res.status(400).json({ error: "content must be a string" });
  }
  if (typeof content === "string" && content.length > MAX_CONTENT_CHARS) {
    return res.status(400).json({ error: `content exceeds ${MAX_CONTENT_CHARS} character limit` });
  }
  if (order !== undefined && (typeof order !== "number" || !Number.isInteger(order))) {
    return res.status(400).json({ error: "order must be an integer" });
  }

  const data: any = {};
  if (name !== undefined) data.name = name.trim();
  if (docType !== undefined) data.docType = docType;
  if (content !== undefined) data.content = content.trim();
  if (order !== undefined) data.order = order;

  const result = await prisma.systemDocument.updateMany({
    where: { id: req.params.docId, projectId: req.params.projectId },
    data,
  });
  if (result.count === 0) return res.status(404).json({ error: "Document not found" });
  res.json({ ok: true });
}));

router.delete("/:projectId/system-docs/:docId", asyncHandler(async (req: AuthRequest, res) => {
  const project = await getProjectMeta(req.params.projectId, req, res);
  if (!project) return;

  const result = await prisma.systemDocument.deleteMany({
    where: { id: req.params.docId, projectId: req.params.projectId },
  });
  if (result.count === 0) return res.status(404).json({ error: "Document not found" });
  res.json({ ok: true });
}));

// ── Issues ────────────────────────────────────────────────────────────────────

router.get("/:projectId/issues", asyncHandler(async (req: AuthRequest, res) => {
  const project = await getProjectMeta(req.params.projectId, req, res);
  if (!project) return;

  const take = Math.min(parseInt(req.query.take as string) || 50, 100);
  const skip = parseInt(req.query.skip as string) || 0;

  const issues = await prisma.techIssue.findMany({
    where: { projectId: req.params.projectId },
    include: {
      fixes: { orderBy: { appliedAt: "asc" }, take: 50 },
      runs: {
        include: { run: { select: { id: true, callDate: true, status: true, overallScore: true } } },
        orderBy: { addedAt: "desc" },
        take: 20,
      },
    },
    orderBy: { createdAt: "desc" },
    take,
    skip,
  });
  res.json(issues);
}));

router.post("/:projectId/issues", asyncHandler(async (req: AuthRequest, res) => {
  const project = await getProjectMeta(req.params.projectId, req, res);
  if (!project) return;

  const { title, issueType, description, rootCause, fix, component } = req.body;

  if (!title?.trim()) return res.status(400).json({ error: "title is required" });
  if (!description?.trim()) return res.status(400).json({ error: "description is required" });
  if (!issueType) return res.status(400).json({ error: "issueType is required" });
  if (!VALID_ISSUE_TYPES.has(issueType)) {
    return res.status(400).json({ error: `Invalid issueType. Must be one of: ${[...VALID_ISSUE_TYPES].join(", ")}` });
  }

  const issue = await prisma.techIssue.create({
    data: {
      projectId: req.params.projectId,
      title: title.trim(),
      issueType: issueType as any,
      description: description.trim(),
      rootCause: rootCause?.trim() || null,
      fix: fix?.trim() || null,
      component: component?.trim() || null,
    },
  });
  res.status(201).json(issue);
}));

router.get("/:projectId/issues/:issueId", asyncHandler(async (req: AuthRequest, res) => {
  const project = await getProjectMeta(req.params.projectId, req, res);
  if (!project) return;

  const issue = await prisma.techIssue.findFirst({
    where: { id: req.params.issueId, projectId: req.params.projectId },
    include: {
      fixes: { orderBy: { appliedAt: "asc" } },
      runs: {
        include: { run: { select: { id: true, callDate: true, status: true, overallScore: true } } },
        orderBy: { addedAt: "desc" },
      },
    },
  });
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  res.json(issue);
}));

router.patch("/:projectId/issues/:issueId", asyncHandler(async (req: AuthRequest, res) => {
  const project = await getProjectMeta(req.params.projectId, req, res);
  if (!project) return;

  const { title, issueType, status, description, rootCause, fix, component } = req.body;

  if (issueType !== undefined && !VALID_ISSUE_TYPES.has(issueType)) {
    return res.status(400).json({ error: `Invalid issueType. Must be one of: ${[...VALID_ISSUE_TYPES].join(", ")}` });
  }
  if (status !== undefined && !VALID_ISSUE_STATUSES.has(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${[...VALID_ISSUE_STATUSES].join(", ")}` });
  }

  const data: any = {};
  if (title !== undefined) data.title = title.trim();
  if (issueType !== undefined) data.issueType = issueType;
  if (status !== undefined) data.status = status;
  if (description !== undefined) data.description = description.trim();
  if (rootCause !== undefined) data.rootCause = rootCause?.trim() || null;
  if (fix !== undefined) data.fix = fix?.trim() || null;
  if (component !== undefined) data.component = component?.trim() || null;

  const result = await prisma.techIssue.updateMany({
    where: { id: req.params.issueId, projectId: req.params.projectId },
    data,
  });
  if (result.count === 0) return res.status(404).json({ error: "Issue not found" });
  res.json({ ok: true });
}));

router.delete("/:projectId/issues/:issueId", asyncHandler(async (req: AuthRequest, res) => {
  const project = await getProjectMeta(req.params.projectId, req, res);
  if (!project) return;

  const result = await prisma.techIssue.deleteMany({
    where: { id: req.params.issueId, projectId: req.params.projectId },
  });
  if (result.count === 0) return res.status(404).json({ error: "Issue not found" });
  res.json({ ok: true });
}));

// ── Issue ↔ Run linking ───────────────────────────────────────────────────────

router.post("/:projectId/issues/:issueId/link/:runId", asyncHandler(async (req: AuthRequest, res) => {
  const project = await getProjectMeta(req.params.projectId, req, res);
  if (!project) return;

  // Verify both issue and run exist in this project in one parallel fetch
  const [issue, run] = await Promise.all([
    prisma.techIssue.findFirst({
      where: { id: req.params.issueId, projectId: req.params.projectId },
      select: { id: true },
    }),
    prisma.run.findFirst({
      where: { id: req.params.runId, projectId: req.params.projectId },
      select: { id: true },
    }),
  ]);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  if (!run) return res.status(404).json({ error: "Run not found in this project" });

  await prisma.techIssueRun.upsert({
    where: { issueId_runId: { issueId: req.params.issueId, runId: req.params.runId } },
    create: { issueId: req.params.issueId, runId: req.params.runId },
    update: {},
  });
  res.json({ ok: true });
}));

router.delete("/:projectId/issues/:issueId/link/:runId", asyncHandler(async (req: AuthRequest, res) => {
  const project = await getProjectMeta(req.params.projectId, req, res);
  if (!project) return;

  await prisma.techIssueRun.deleteMany({
    where: { issueId: req.params.issueId, runId: req.params.runId },
  });
  res.json({ ok: true });
}));

// ── Apply Fix ─────────────────────────────────────────────────────────────────
//
// Body: { description, nodeId?, oldPrompt?, newPrompt?, bugString?, fixString?, fieldType? }
//
// Patch modes (when nodeId is set):
//   bugString + fixString  — surgical find-replace in message field or staticVariables.value
//   newPrompt              — full replacement of node.message
//
// Operation order (intentional):
//   1. Validate all inputs
//   2. Push to live Hamsa agent  ← point of no return
//   3. Atomically: log TechIssueFix + update local agentStructure cache (optimistic lock)
//      If the atomic write fails, a 409 is returned so the caller knows to re-sync.

router.post("/:projectId/issues/:issueId/apply-fix", asyncHandler(async (req: AuthRequest, res) => {
  const project = await getProjectForPatch(req.params.projectId, req, res);
  if (!project) return;

  const issue = await prisma.techIssue.findFirst({
    where: { id: req.params.issueId, projectId: req.params.projectId },
    select: { id: true },
  });
  if (!issue) return res.status(404).json({ error: "Issue not found" });

  const { description, nodeId, oldPrompt, newPrompt, bugString, fixString, fieldType } = req.body;

  // ── Input validation ────────────────────────────────────────────────────────
  if (!description?.trim()) return res.status(400).json({ error: "description is required" });
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return res.status(400).json({ error: `description exceeds ${MAX_DESCRIPTION_CHARS} chars` });
  }
  if (bugString !== undefined && bugString.length > MAX_BUG_STRING_CHARS) {
    return res.status(400).json({ error: `bugString exceeds ${MAX_BUG_STRING_CHARS} chars` });
  }
  if (fixString !== undefined && fixString.length > MAX_BUG_STRING_CHARS) {
    return res.status(400).json({ error: `fixString exceeds ${MAX_BUG_STRING_CHARS} chars` });
  }
  if (newPrompt !== undefined && newPrompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: `newPrompt exceeds ${MAX_PROMPT_CHARS} chars` });
  }
  if (fieldType !== undefined && !VALID_FIELD_TYPES.has(fieldType)) {
    return res.status(400).json({ error: `Invalid fieldType. Must be one of: ${[...VALID_FIELD_TYPES].join(", ")}` });
  }

  if (!nodeId) {
    // Log-only fix (no live patch) — still useful for recording manual fixes
    const fix = await prisma.techIssueFix.create({
      data: {
        issueId: req.params.issueId,
        description: description.trim(),
        nodeId: null,
        oldPrompt: oldPrompt?.trim() || null,
        newPrompt: newPrompt?.trim() || null,
        appliedBy: req.userId || null,
      },
    });
    await prisma.techIssue.updateMany({
      where: { id: req.params.issueId, status: "OPEN" },
      data: { status: "IN_PROGRESS" },
    });
    return res.json({ ok: true, fix });
  }

  // ── Build the patched node array ────────────────────────────────────────────
  const patch = buildPatchedNodes(project, nodeId, { bugString, fixString, fieldType, newPrompt }, res);
  if (!patch) return;

  // ── Push to Hamsa + log atomically ─────────────────────────────────────────
  const result = await pushPatchAndLog({
    project,
    updatedNodes: patch.updatedNodes,
    fixData: {
      issueId: req.params.issueId,
      description: description.trim(),
      nodeId,
      oldPrompt: oldPrompt?.trim() || bugString || null,
      newPrompt: patch.appliedContent,
      appliedBy: req.userId || null,
    },
    res,
  });
  if (!result) return; // 409 already sent by pushPatchAndLog

  await prisma.techIssue.updateMany({
    where: { id: req.params.issueId, status: "OPEN" },
    data: { status: "IN_PROGRESS" },
  });

  res.json({ ok: true, fix: result.fix });
}));

export default router;
