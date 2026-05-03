import prisma from "../lib/prisma";
import { Router } from "express";
import { CriterionType } from "@prisma/client";
import { z } from "zod";
import { getAgent } from "../services/hamsaApi";
import { generateAgentSummary } from "../services/llmJudge";
import { analyzeProject, compareAnalyses } from "../services/projectAnalyzer";
import { getProjectReport, generateIntelligenceReport } from "../services/reportingService";
import { searchRuns } from "../services/runSearch";
import { runEvaluationCheck } from "../services/evaluationRunner";
import { auditAgentPrompts } from "../services/promptAuditor";
import { updateAgentWorkflow } from "../services/hamsaApi";
import { AuthRequest } from "../middleware/auth";
import { canAccess } from "../lib/ownership";
import { evalRateLimit, llmRateLimit } from "../middleware/rateLimiter";
import { audit } from "../middleware/auditLog";

const router = Router();

const VALID_CRITERION_TYPES = new Set<string>(Object.values(CriterionType));
const VALID_PROJECT_TYPES   = new Set(["LIVE", "HISTORY", "WEBHOOK"]);
const VALID_RUN_STATUSES    = new Set(["PENDING","RUNNING","AWAITING_DATA","EVALUATING","COMPLETE","FAILED"]);
const VALID_RUN_SOURCES     = new Set(["LIVE","HISTORY","WEBHOOK"]);

// ─── Criterion expectedValue schemas ──────────────────────────────
// Validate the shape of each criterion type's expectedValue to prevent
// malformed data reaching the evaluator and LLM prompt builders.

const CriterionExpectedValueSchemas: Partial<Record<CriterionType, z.ZodTypeAny>> = {
  DETERMINISTIC: z.object({
    requiredTools: z.array(z.string()).optional(),
    requiredVariables: z.array(z.string()).optional(),
  }).refine(v => v.requiredTools || v.requiredVariables, {
    message: "DETERMINISTIC criterion must specify requiredTools or requiredVariables",
  }),
  STRUCTURAL: z.object({
    expectedSequence: z.array(z.string()),
  }),
  LLM_JUDGE: z.object({
    rule: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
  }).refine(v => v.rule || v.prompt, {
    message: "LLM_JUDGE criterion must specify rule or prompt",
  }),
  WORD_ACCURACY: z.object({
    threshold: z.number().min(0).max(1).optional(),
  }),
  LATENCY: z.object({
    maxToolLatencyMs: z.number().int().positive().optional(),
  }),
  // These types require no configuration
  FLOW_PROGRESSION: z.object({}).optional(),
  ACTION_CONSISTENCY: z.object({}).optional(),
  ACTION_HALLUCINATION: z.object({}).optional(),
  LAYERED_EVALUATION: z.object({}).optional(),
};

function validateCriterionExpectedValue(type: string, expectedValue: unknown): string | null {
  const schema = CriterionExpectedValueSchemas[type as CriterionType];
  if (!schema) return null; // unknown type — caught by VALID_CRITERION_TYPES check
  const result = schema.safeParse(expectedValue ?? {});
  if (!result.success) {
    const messages = result.error.errors.map(e => e.message).join("; ");
    return `Invalid expectedValue for ${type}: ${messages}`;
  }
  return null;
}


// List projects: user's own projects + org-mates' projects + legacy projects (userId=null)
router.get("/", async (req: AuthRequest, res) => {
  // Collect all user IDs in the same org (includes self) for project visibility.
  // Use a Set to avoid O(n²) includes() scan on large orgs.
  const orgUserIdSet = new Set<string>(req.userId ? [req.userId] : []);
  if (req.organizationId) {
    const orgMembers = await prisma.user.findMany({
      where: { organizationId: req.organizationId },
      select: { id: true },
    });
    for (const m of orgMembers) orgUserIdSet.add(m.id);
  }
  const orgUserIds = [...orgUserIdSet];
  const projects = await prisma.project.findMany({
    where: { OR: [{ userId: { in: orgUserIds } }, { userId: null }] },
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

// Export conversation IDs as CSV
router.get("/:id/export-call-ids", async (req: AuthRequest, res) => {
  const p = await prisma.project.findUnique({ where: { id: req.params.id }, select: { userId: true, name: true } });
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (!await canAccess(p.userId, req)) return res.status(403).json({ error: "Access denied" });

  const runs = await prisma.run.findMany({
    where: { projectId: req.params.id, conversationId: { not: null } },
    select: { conversationId: true, callDate: true, callOutcome: true, callStatus: true, overallScore: true },
    orderBy: { callDate: "desc" },
  });

  function csvEscape(val: string) {
    if (/[",\n\r]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
    return val;
  }
  const header = "conversation_id,call_date,call_outcome,call_status,score";
  const rows = runs.map((r) =>
    [r.conversationId, r.callDate?.toISOString() || "", csvEscape(r.callOutcome || ""), csvEscape(r.callStatus || ""), r.overallScore != null ? (r.overallScore * 100).toFixed(0) + "%" : ""].join(",")
  );
  const csv = [header, ...rows].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${p.name.replace(/[^a-zA-Z0-9]/g, "_")}_call_ids.csv"`);
  res.send(csv);
});

// Full project bundle export — streams runs in batches to avoid loading everything into memory
router.get("/:id/full-export", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { criteria: { orderBy: { createdAt: "asc" } } },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId ?? null, req)) return res.status(403).json({ error: "Access denied" });

    const safeName = (project.name.replace(/[^a-zA-Z0-9]/g, "_") || "project");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}_export.json"`);

    // Stream JSON manually so we never load all runs into memory at once
    const preamble = {
      version:    "1.0",
      exportedAt: new Date().toISOString(),
      project: {
        name:           project.name,
        description:    (project as any).description    ?? null,
        projectType:    (project as any).projectType    ?? null,
        agentId:        (project as any).agentId        ?? null,
        hamsaApiKey:    (project as any).hamsaApiKey    ?? null,
        evalContext:    (project as any).evalContext    ?? null,
        agentStructure: (project as any).agentStructure ?? null,
        flowDefinition: (project as any).flowDefinition ?? null,
        agentSummary:   (project as any).agentSummary   ?? null,
        webhookSecret:  (project as any).webhookSecret  ?? null,
        historyStartDate: (project as any).historyStartDate?.toISOString() ?? null,
        historyEndDate:   (project as any).historyEndDate?.toISOString()   ?? null,
      },
      criteria: project.criteria.map((c: any) => ({
        _exportId:     c.id,
        key:           c.key,
        label:         c.label           ?? null,
        type:          c.type,
        expectedValue: c.expectedValue   ?? null,
        weight:        c.weight          ?? null,
      })),
    };

    res.write(JSON.stringify(preamble).slice(0, -1)); // strip closing "}"
    res.write(',"runs":[');

    // Abort streaming if the client disconnects mid-export
    let clientGone = false;
    res.on("close", () => { clientGone = true; });

    // Stream runs in batches of 100 to bound memory usage
    const EXPORT_BATCH = 100;
    let cursor: string | undefined;
    let firstRun = true;
    while (true) {
      if (clientGone) break;
      const batch: any[] = await prisma.run.findMany({
        where:   { projectId: req.params.id },
        orderBy: { createdAt: "asc" },
        take:    EXPORT_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { evalResults: true },
      });
      if (batch.length === 0) break;

      for (const run of batch) {
        const runJson = JSON.stringify({
          conversationId: run.conversationId ?? null,
          status:         run.status,
          overallScore:   run.overallScore   ?? null,
          callDate:       run.callDate?.toISOString() ?? null,
          callDuration:   run.callDuration   ?? null,
          callOutcome:    run.callOutcome     ?? null,
          callStatus:     run.callStatus      ?? null,
          evalCost:       run.evalCost        ?? null,
          modelUsed:      run.modelUsed       ?? null,
          source:         run.source          ?? null,
          hamsaCallId:    run.hamsaCallId     ?? null,
          errorLog:       run.errorLog        ?? null,
          startedAt:      run.startedAt?.toISOString()   ?? null,
          completedAt:    run.completedAt?.toISOString() ?? null,
          outcomeResult:  run.outcomeResult  ?? null,
          webhookData:    run.webhookData    ?? null,
          transcript:     run.transcript     ?? null,
          callLog:        run.callLog        ?? null,
          evalResults: run.evalResults
            .filter((er: any) => er.criterionId)
            .map((er: any) => ({
              _criterionExportId: er.criterionId,
              score:    er.score    ?? null,
              passed:   er.passed   ?? null,
              detail:   er.detail   ?? null,
              metadata: er.metadata ?? null,
            })),
        });
        res.write((firstRun ? "" : ",") + runJson);
        firstRun = false;
      }

      cursor = batch[batch.length - 1].id;
      if (batch.length < EXPORT_BATCH) break;
    }

    res.write("]}"); // close runs array + root object
    res.end();
  } catch (err) {
    console.error("[Projects] full-export error:", (err as Error).message);
    // If headers already sent we can't send a JSON error — just close
    if (!res.headersSent) res.status(500).json({ error: "Export failed" });
    else res.end();
  }
});

// Import a full project bundle — rate-limited to prevent abuse
router.post("/import-bundle", evalRateLimit, async (req: AuthRequest, res) => {
  try {
    // Auth check before any processing
    if (!req.userId) return res.status(401).json({ error: "Unauthorized" });

    const bundle = req.body;
    if (!bundle?.project || !Array.isArray(bundle.criteria) || !Array.isArray(bundle.runs)) {
      return res.status(400).json({ error: "Invalid bundle: missing project, criteria, or runs" });
    }
    if (typeof bundle.project.name !== "string" || !bundle.project.name.trim()) {
      return res.status(400).json({ error: "Invalid bundle: project.name is required" });
    }

    // Wrap everything in a transaction so partial failures roll back cleanly
    // Timeout: 10 min — large projects with 1000s of runs can take time
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create project
      const newProject = await tx.project.create({
        data: {
          name:           `${bundle.project.name.trim()} (imported)`,
          description:    bundle.project.description    || undefined,
          projectType:    VALID_PROJECT_TYPES.has(bundle.project.projectType) ? bundle.project.projectType : "HISTORY",
          agentId:        bundle.project.agentId        || "",
          hamsaApiKey:    bundle.project.hamsaApiKey    || undefined,
          evalContext:    bundle.project.evalContext     || undefined,
          agentStructure: bundle.project.agentStructure || undefined,
          flowDefinition: bundle.project.flowDefinition || undefined,
          agentSummary:   bundle.project.agentSummary   || undefined,
          webhookSecret:  bundle.project.webhookSecret  || undefined,
          historyStartDate: bundle.project.historyStartDate ? new Date(bundle.project.historyStartDate) : undefined,
          historyEndDate:   bundle.project.historyEndDate   ? new Date(bundle.project.historyEndDate)   : undefined,
          userId:         req.userId!,
        },
      });

      // 2. Create criteria — build _exportId → new ID map
      const criterionIdMap: Record<string, string> = {};
      let criterionIndex = 0;
      for (const c of bundle.criteria) {
        if (!VALID_CRITERION_TYPES.has(c.type)) continue;
        const newC = await tx.criterion.create({
          data: {
            projectId:     newProject.id,
            // Ensure key uniqueness within the project even if source bundle has duplicates
            key:           String(c.key || c._exportId || `criterion_${criterionIndex}`),
            label:         c.label     || undefined,
            type:          c.type      as any,
            expectedValue: c.expectedValue ?? {},
            weight:        typeof c.weight === "number" ? c.weight : 1.0,
          },
        });
        if (c._exportId) criterionIdMap[c._exportId] = newC.id;
        criterionIndex++;
      }

      // 3. Create runs + eval results — sequential batches inside transaction
      let imported = 0;
      const BATCH = 20;
      for (let i = 0; i < bundle.runs.length; i += BATCH) {
        await Promise.all(bundle.runs.slice(i, i + BATCH).map(async (run: any) => {
          // Dedupe eval results: one per criterion (schema @@unique([runId, criterionId]))
          const seenCriteria = new Set<string>();
          const validEvals = (run.evalResults ?? []).filter((er: any) => {
            const newCid = criterionIdMap[er._criterionExportId];
            if (!newCid || seenCriteria.has(newCid)) return false;
            seenCriteria.add(newCid);
            return true;
          });

          await tx.run.create({
            data: {
              projectId:      newProject.id,
              conversationId: run.conversationId  || undefined,
              // Remap in-flight statuses: an EVALUATING/PENDING run from prod
              // will never be picked up by a worker in the imported environment.
              status:         (run.status === "EVALUATING" || run.status === "PENDING")
                                ? "FAILED"
                                : VALID_RUN_STATUSES.has(run.status) ? run.status : "COMPLETE",
              overallScore:   run.overallScore    ?? undefined,
              callDate:       run.callDate ? new Date(run.callDate) : undefined,
              callDuration:   run.callDuration    ?? undefined,
              callOutcome:    run.callOutcome      || undefined,
              callStatus:     run.callStatus       || undefined,
              evalCost:       run.evalCost         ?? undefined,
              modelUsed:      run.modelUsed        || undefined,
              source:         VALID_RUN_SOURCES.has(run.source) ? run.source : "HISTORY",
              // hamsaCallId intentionally omitted — unique per project, would collide on re-import
              errorLog:       run.errorLog         || undefined,
              startedAt:      run.startedAt   ? new Date(run.startedAt)   : undefined,
              completedAt:    run.completedAt ? new Date(run.completedAt) : undefined,
              outcomeResult:  run.outcomeResult    ?? undefined,
              webhookData:    run.webhookData      ?? undefined,
              transcript:     run.transcript       ?? undefined,
              callLog:        run.callLog          ?? undefined,
              evalResults: {
                create: validEvals.map((er: any) => ({
                  criterionId: criterionIdMap[er._criterionExportId],
                  score:       er.score    ?? undefined,
                  passed:      er.passed   ?? undefined,
                  detail:      er.detail   ?? undefined,
                  metadata:    er.metadata ?? undefined,
                })),
              },
            },
          });
          imported++;
        }));
      }

      return { projectId: newProject.id, name: newProject.name, imported, total: bundle.runs.length };
    }, { timeout: 600_000 }); // 10 min timeout for large projects

    const warning = result.imported < result.total
      ? `Only ${result.imported} of ${result.total} runs imported`
      : undefined;
    res.json({ projectId: result.projectId, name: result.name, imported: result.imported, warning });
  } catch (err) {
    console.error("[Projects] import-bundle error:", (err as Error).message);
    const msg = (err as Error).message;
    // Surface constraint violations with a friendlier message
    const friendly = msg.includes("Unique constraint")
      ? "Import failed: duplicate key conflict. Try importing again (a new project will be created)."
      : `Import failed: ${msg}`;
    res.status(500).json({ error: friendly });
  }
});

// Find the Hamsa project that contains a given agent.
// Fetches all projects for the API key, then checks each for the agent.
router.post("/hamsa-projects", async (req: AuthRequest, res) => {
  const { apiKey, agentId } = req.body as { apiKey?: string; agentId?: string };
  const key = apiKey?.trim() || process.env.HAMSA_API_KEY;
  if (!key) return res.status(400).json({ error: "API key is required" });

  try {
    const base = process.env.HAMSA_API_BASE || "https://api.tryhamsa.com";

    // Step 1: list all projects for this account
    const projRes = await fetch(`${base}/v1/projects`, {
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
    });
    if (!projRes.ok) {
      return res.status(projRes.status).json({ error: "Failed to fetch Hamsa projects" });
    }
    const projJson = await projRes.json() as any;
    const projects: any[] = projJson.data || projJson;

    // Step 2: if agentId provided, find which project contains it
    if (agentId?.trim()) {
      for (const project of projects) {
        try {
          const agentsRes = await fetch(`${base}/v2/voice-agents?projectId=${project.id}`, {
            headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
          });
          if (!agentsRes.ok) continue;
          const agentsJson = await agentsRes.json() as any;
          const agents = agentsJson.data?.voiceAgents || [];
          if (agents.some((a: any) => a.id === agentId.trim())) {
            return res.json({ projectId: project.id, projectName: project.name, projects });
          }
        } catch { continue; }
      }
      // Agent not found in any project — return all projects as fallback
      return res.json({ projectId: null, projects });
    }

    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get single project with criteria and runs (most recent 100 runs)
router.get("/:id", async (req: AuthRequest, res) => {
  console.log(`[Projects] GET /:id called with id=${req.params.id} userId=${req.userId}`);
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        criteria: true,
        _count: { select: { runs: true } },
        runs: {
          orderBy: { createdAt: "desc" },
          take: 200,
          include: {
            evalResults: { include: { criterion: true } },
          },
        },
      },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId ?? null, req)) {
      console.log(`[Projects] Access denied: project.userId=${project.userId} req.userId=${req.userId}`);
      return res.status(403).json({ error: "Access denied" });
    }

    // Accurate failed-run count across ALL runs (not just the 200 loaded)
    const failedRunCount = await prisma.run.count({
      where: { projectId: req.params.id, status: "FAILED" },
    });

    // Strip heavy fields from list response to keep payload under proxy limits.
    // Individual run detail pages load full data via GET /runs/:id.
    const lightRuns = project.runs.map((run: any) => {
      // Keep only the fields the project page actually uses from webhookData
      const wd = run.webhookData as any;
      const lightWebhookData = wd ? {
        caller_info: wd.caller_info ? { call_type: wd.caller_info.call_type } : undefined,
        channelType: wd.channelType,                   // history runs: top-level
        channel: wd.channel,                           // history runs: alternate field
        callType: wd.callType,                         // history runs: alternate field
        data: wd.data ? { channelType: wd.data.channelType } : undefined, // webhook runs
      } : undefined;
      return {
        ...run,
        webhookData: lightWebhookData,
        callLog: run.callLog ? true : null,       // boolean flag — frontend checks existence
        transcript: run.transcript ? true : null,  // boolean flag — frontend checks existence
        evalResults: run.evalResults.map((er: any) => ({
          ...er,
          detail: undefined,
          metadata: undefined,
        })),
      };
    });
    const responseSize = JSON.stringify({ ...project, runs: lightRuns }).length;
    console.log(`[Projects] Returning project ${project.name} with ${lightRuns.length} runs (~${(responseSize / 1024).toFixed(0)}KB)`);
    res.json({ ...project, runs: lightRuns, failedRunCount });
  } catch (err) {
    console.error("[Projects] GET /:id error:", (err as Error).message, (err as Error).stack?.slice(0, 300));
    res.status(500).json({ error: "Failed to fetch project" });
  }
});

// Fetch specific runs by IDs — used when a filter (issue/node) references runs not in the loaded 200
router.get("/:id/runs-by-ids", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId ?? null, req)) return res.status(403).json({ error: "Access denied" });

    const raw = typeof req.query.ids === "string" ? req.query.ids : "";
    const ids = raw.split(",").map(s => s.trim()).filter(Boolean).slice(0, 500);
    if (ids.length === 0) return res.json([]);

    const runs = await prisma.run.findMany({
      where: { id: { in: ids }, projectId: req.params.id },
      include: { evalResults: { include: { criterion: true } } },
    });

    const light = runs.map((run: any) => {
      const wd = run.webhookData as any;
      return {
        ...run,
        webhookData: wd ? {
          caller_info: wd.caller_info ? { call_type: wd.caller_info.call_type } : undefined,
          channelType: wd.channelType, channel: wd.channel, callType: wd.callType,
          data: wd.data ? { channelType: wd.data.channelType } : undefined,
        } : undefined,
        callLog: run.callLog ? true : null,
        transcript: run.transcript ? true : null,
        evalResults: run.evalResults.map((er: any) => ({ ...er, detail: undefined, metadata: undefined })),
      };
    });
    res.json(light);
  } catch (err) {
    console.error("[Projects] GET /:id/runs-by-ids error:", (err as Error).message);
    res.status(500).json({ error: "Failed to fetch runs" });
  }
});

// Dashboard aggregation endpoint
router.get("/:id/dashboard", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { userId: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId ?? null, req)) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Accurate KPI aggregates over ALL runs — no row limit
    // total_all   = every run regardless of status (shown as "Total Runs/Calls")
    // total_complete / avg_score / passed = stats for COMPLETE runs only (for KPI cards)
    // total_eval_cost = sum of eval spend across all runs
    const [kpiAgg] = await prisma.$queryRaw<Array<{
      total_all: bigint;
      total_complete: bigint;
      total_failed: bigint;
      avg_score: number | null;
      passed: bigint;
      avg_duration: number | null;
      total_eval_cost: number | null;
    }>>`
      SELECT
        COUNT(*)                                                               AS total_all,
        COUNT(*) FILTER (WHERE status = 'COMPLETE')                            AS total_complete,
        COUNT(*) FILTER (WHERE status = 'FAILED')                              AS total_failed,
        AVG("overallScore") FILTER (WHERE status = 'COMPLETE')::double precision AS avg_score,
        COUNT(*) FILTER (WHERE "overallScore" >= 0.7)                          AS passed,
        AVG("callDuration") FILTER (WHERE status = 'COMPLETE')::double precision AS avg_duration,
        SUM("evalCost")::double precision                                       AS total_eval_cost
      FROM "Run"
      WHERE "projectId" = ${req.params.id}
    `;

    // SQL-level: outcome distribution over ALL runs (callOutcome is a plain column, no JSON)
    const outcomeDistRows = await prisma.$queryRaw<Array<{ outcome: string | null; cnt: bigint }>>`
      SELECT "callOutcome" AS outcome, COUNT(*) AS cnt
      FROM "Run"
      WHERE "projectId" = ${req.params.id} AND status = 'COMPLETE'
      GROUP BY "callOutcome"
      ORDER BY cnt DESC
      LIMIT 30
    `;

    // SQL-level: per-day score trend over ALL complete runs (used for Score Over Time chart)
    const scoreTrendRows = await prisma.$queryRaw<Array<{
      day: Date; avg_score: number; run_count: bigint;
    }>>`
      SELECT
        DATE_TRUNC('day', "callDate")            AS day,
        AVG("overallScore")::double precision    AS avg_score,
        COUNT(*)                                 AS run_count
      FROM "Run"
      WHERE "projectId" = ${req.params.id}
        AND status = 'COMPLETE'
        AND "callDate" IS NOT NULL
        AND "overallScore" IS NOT NULL
      GROUP BY DATE_TRUNC('day', "callDate")
      ORDER BY day
    `;

    const runs = await prisma.run.findMany({
      where: { projectId: req.params.id, status: "COMPLETE" },
      orderBy: { callDate: "asc" },
      take: 1000,   // cap at 1000 for detailed JSON analysis (sentiment, issues, node perf)
      select: {
        id: true,
        overallScore: true,
        callDate: true,
        callDuration: true,
        callOutcome: true,
        conversationId: true,
        evalResults: {
          include: { criterion: true },
        },
      },
    });

    const sentimentCounts: Record<string, number> = { positive: 0, neutral: 0, negative: 0, unknown: 0 };
    const nodeScores: Record<string, { scores: number[]; runIds: string[] }> = {};
    const issueCounts: Record<string, { severity: string; count: number; runIds: string[] }> = {};
    // outcome → issue text → {severity, runIds}
    const outcomeIssueMap: Record<string, Record<string, { severity: string; runIds: string[] }>> = {};
    // outcome → total run count (for all runs, not just evaluated ones)
    const outcomeTotals: Record<string, number> = {};
    let objectiveCount = 0;
    let objectiveTotal = 0;
    const achievedRunIds: string[] = [];
    const notAchievedRunIds: string[] = [];
    // Criteria performance — per-criterion pass/fail stats + failed run IDs
    const criteriaPerf: Record<string, { name: string; type: string; total: number; passed: number; failedRunIds: string[] }> = {};

    // Count all outcome totals first (including runs without eval results)
    for (const run of runs) {
      const outcome = (run.callOutcome || "unknown");
      outcomeTotals[outcome] = (outcomeTotals[outcome] || 0) + 1;
    }

    // Criteria pass/fail — covers all eval results (not just LAYERED_EVALUATION)
    for (const run of runs) {
      for (const er of run.evalResults as any[]) {
        if (!er.criterion) continue;
        const cid: string = er.criterionId;
        const cname: string = er.criterion.label || er.criterion.key || cid;
        const ctype: string = er.criterion.type || "UNKNOWN";
        if (!criteriaPerf[cid]) criteriaPerf[cid] = { name: cname, type: ctype, total: 0, passed: 0, failedRunIds: [] };
        // Only count runs where the criterion was actually evaluated (passed !== null).
        // null means "not applicable" (e.g. no action claims, call abandoned) — not a failure.
        if (er.passed === null) continue;
        criteriaPerf[cid].total++;
        if (er.passed === true) criteriaPerf[cid].passed++;
        else if (!criteriaPerf[cid].failedRunIds.includes(run.id)) criteriaPerf[cid].failedRunIds.push(run.id);
      }
    }

    for (const run of runs) {
      const layered = run.evalResults.find((er: any) => er.criterion?.type === "LAYERED_EVALUATION");
      if (!layered || !layered.detail) continue;

      let detail: any;
      try {
        detail = typeof layered.detail === "string"
          ? JSON.parse(layered.detail)
          : layered.detail;   // Prisma may already parse JSON columns
      } catch (e) {
        console.warn(`[Dashboard] Could not parse eval detail for run ${run.id}: ${(e as Error).message}`);
        continue;
      }

      // Sentiment
      const sentiment: string = (detail.callerSentiment || detail.sentiment || "unknown").toLowerCase();
      if (sentiment in sentimentCounts) {
        sentimentCounts[sentiment]++;
      } else {
        sentimentCounts.unknown++;
      }

      // Node scores
      if (Array.isArray(detail.perNode)) {
        for (const node of detail.perNode) {
          const label: string = node.nodeLabel || node.label || node.node || "Unknown";
          const score: number | undefined = node.overallNodeScore ?? node.score;
          if (score != null) {
            if (!nodeScores[label]) nodeScores[label] = { scores: [], runIds: [] };
            nodeScores[label].scores.push(score);
            if (!nodeScores[label].runIds.includes(run.id)) nodeScores[label].runIds.push(run.id);
          }
        }
      }

      // Issues + per-outcome issue tracking
      if (Array.isArray(detail.criticalIssues)) {
        const outcome = (run.callOutcome || "unknown");
        if (!outcomeIssueMap[outcome]) outcomeIssueMap[outcome] = {};

        for (const issue of detail.criticalIssues) {
          const rawText: string = typeof issue === "string" ? issue : (issue.text || String(issue));
          const text = rawText.trim().toLowerCase();  // normalize for dedup
          const severity: string = (typeof issue === "object" && issue.severity) ? issue.severity : "critical";

          // Global issue counts — count per run (not per occurrence within a run)
          if (!issueCounts[text]) {
            issueCounts[text] = { severity, count: 0, runIds: [] };
          }
          if (!issueCounts[text].runIds.includes(run.id)) {
            issueCounts[text].count++;
            issueCounts[text].runIds.push(run.id);
          }

          // Per-outcome issue tracking (deduplicate per run)
          if (!outcomeIssueMap[outcome][text]) {
            outcomeIssueMap[outcome][text] = { severity, runIds: [] };
          }
          if (!outcomeIssueMap[outcome][text].runIds.includes(run.id)) {
            outcomeIssueMap[outcome][text].runIds.push(run.id);
          }
        }
      }

      // Objective
      if (detail.objectiveAchieved != null) {
        objectiveTotal++;
        if (detail.objectiveAchieved === true || detail.objectiveAchieved === 1) {
          objectiveCount++;
          achievedRunIds.push(run.id);
        } else {
          notAchievedRunIds.push(run.id);
        }
      }
    }

    const nodePerformance = Object.entries(nodeScores)
      .map(([label, { scores, runIds }]) => ({
        label,
        avg: Math.round((scores.reduce((a: number, b: number) => a + b, 0) / scores.length) * 10) / 10,
        count: scores.length,
        runIds,
      }))
      .sort((a, b) => b.avg - a.avg);

    const topIssues = Object.entries(issueCounts)
      .map(([text, { severity, count, runIds }]) => ({
        text: text.charAt(0).toUpperCase() + text.slice(1),
        severity, count, runIds,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50); // cap at 50 — frontend controls how many to show

    // Build outcome breakdown: for each outcome, top issues sorted by how many of those calls had the issue
    const outcomeBreakdown = Object.entries(outcomeTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([outcome, total]) => {
        const issueMap = outcomeIssueMap[outcome] ?? {};
        const issues = Object.entries(issueMap)
          .map(([text, { severity, runIds }]) => ({
            text: text.charAt(0).toUpperCase() + text.slice(1),
            severity,
            count: runIds.length,
            pct: total > 0 ? Math.round((runIds.length / total) * 100) : 0,
            runIds,
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 4);
        return { outcome, total, issues };
      })
      .filter(b => b.issues.length > 0);

    const totalAll      = Number(kpiAgg?.total_all      ?? 0);
    const totalComplete = Number(kpiAgg?.total_complete ?? 0);
    const totalFailed   = Number(kpiAgg?.total_failed   ?? 0);
    const avgScore = kpiAgg?.avg_score != null
      ? Math.round(Number(kpiAgg.avg_score) * 100 * 10) / 10
      : null;
    const passRate = totalComplete > 0
      ? Math.round((Number(kpiAgg?.passed ?? 0) / totalComplete) * 100)
      : null;
    const avgDuration = kpiAgg?.avg_duration != null
      ? Math.round(Number(kpiAgg.avg_duration))
      : null;
    const totalEvalCost = kpiAgg?.total_eval_cost != null
      ? Number(kpiAgg.total_eval_cost)
      : 0;

    // Outcome distribution from SQL (all runs, plain column — no JSON parsing)
    const outcomeDist: Record<string, number> = {};
    for (const row of outcomeDistRows) {
      outcomeDist[row.outcome ?? "unknown"] = Number(row.cnt);
    }

    // Score trend from SQL (all runs, per-day averages)
    const scoreTrend = scoreTrendRows.map(r => ({
      day:      r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
      avgScore: r.avg_score != null ? Math.round(Number(r.avg_score) * 100 * 10) / 10 : null,
      count:    Number(r.run_count),
    }));

    res.json({
      totalRuns: totalAll,       // ALL runs (any status) — matches project list count
      totalFailed,               // FAILED runs — accurate count across all runs (not capped 200)
      totalComplete,             // COMPLETE runs only — denominator for avgScore/passRate
      avgScore,
      passRate,
      avgDuration,
      totalEvalCost,
      outcomeDist,               // Full outcome distribution (all runs, SQL-level)
      scoreTrend,                // Per-day score averages (all runs, SQL-level)
      sentiment: sentimentCounts,
      objectiveRate: objectiveTotal > 0 ? Math.round((objectiveCount / objectiveTotal) * 100) / 100 : null,
      achievedRunIds,
      notAchievedRunIds,
      nodePerformance,
      topIssues,
      outcomeBreakdown,
      criteriaPerformance: Object.values(criteriaPerf)
        .map(c => ({
          name: c.name,
          type: c.type,
          total: c.total,
          passRate: c.total > 0 ? Math.round((c.passed / c.total) * 1000) / 10 : null,
          failedRunIds: c.failedRunIds,
        }))
        .sort((a, b) => (b.passRate ?? 0) - (a.passRate ?? 0)),
    });
  } catch (err) {
    console.error("[Projects] GET /:id/dashboard error:", (err as Error).message);
    res.status(500).json({ error: "Failed to fetch dashboard" });
  }
});

// ── Report: KPI metrics + weekly trends ─────────────────────────────────────
// GET /:id/report?weeks=7
// Pure DB aggregation — no LLM, no rate limit needed.
router.get("/:id/report", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { userId: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId ?? null, req)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const weeks = Math.min(Math.max(parseInt(req.query.weeks as string) || 7, 1), 26);
    const report = await getProjectReport(req.params.id, weeks);
    res.json(report);
  } catch (err) {
    console.error("[Report] KPI error:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Report: LLM-generated intelligence ─────────────────────────────────────
// POST /:id/report/intelligence
// Body: { from?: "YYYY-MM-DD", to?: "YYYY-MM-DD" }
router.post("/:id/report/intelligence", llmRateLimit, async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { userId: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId ?? null, req)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { from, to } = req.body as { from?: string; to?: string };
    const intelligence = await generateIntelligenceReport(req.params.id, from, to);
    res.json(intelligence);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    console.error("[Report] Intelligence error:", msg);
    // Surface specific OpenAI errors as clean user-facing messages
    if (msg.includes("429") || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("rate limit")) {
      return res.status(429).json({ error: "OpenAI quota exceeded. Please check your OpenAI billing and try again." });
    }
    if (msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("timed out")) {
      return res.status(504).json({ error: "Report generation timed out. Try again in a moment." });
    }
    const statusCode = msg.startsWith("At least 3") ? 400 : 500;
    res.status(statusCode).json({ error: msg });
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
      const valErr = validateCriterionExpectedValue(c.type, c.expectedValue);
      if (valErr) return res.status(400).json({ error: valErr });
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
    if (!await canAccess(existing.userId ?? null, req)) return res.status(403).json({ error: "Access denied" });

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
    if (!await canAccess(project.userId ?? null, req)) return res.status(403).json({ error: "Access denied" });

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
    if (!await canAccess(existing.userId ?? null, req)) return res.status(403).json({ error: "Access denied" });
    await prisma.project.delete({ where: { id: req.params.id } });
    audit(req, "project.delete", req.params.id);
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
  const valErr = validateCriterionExpectedValue(type, expectedValue);
  if (valErr) return res.status(400).json({ error: valErr });

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
const rehydratingProjects = new Set<string>();

// Trigger a new analysis version for the project
router.post("/:id/analyze", evalRateLimit, async (req: AuthRequest, res) => {
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
  if (!await canAccess(projectOwner.userId, req)) return res.status(403).json({ error: "Access denied" });

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
    if (!await canAccess(p.userId, req)) return res.status(403).json({ error: "Access denied" });

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
    if (!await canAccess(p.userId, req)) return res.status(403).json({ error: "Access denied" });

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
 * POST /api/projects/:id/re-evaluate
 *
 * Reset all COMPLETE/FAILED runs to PENDING so they get re-evaluated.
 * Deletes existing eval results so criteria run fresh.
 */
router.post("/:id/re-evaluate", evalRateLimit, async (req: AuthRequest, res) => {
  const projectId = req.params.id;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } });
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (!await canAccess(p.userId, req)) return res.status(403).json({ error: "Access denied" });

  try {
    // Atomic: delete eval results + reset runs in one transaction
    const [, result] = await prisma.$transaction([
      prisma.evalResult.deleteMany({ where: { run: { projectId } } }),
      prisma.run.updateMany({
        where: { projectId, status: { in: ["COMPLETE", "FAILED"] } },
        data: { status: "PENDING", overallScore: null, evalCost: null },
      }),
    ]);

    // Trigger evaluation for each reset run (log errors instead of swallowing)
    const runs = await prisma.run.findMany({
      where: { projectId, status: "PENDING" },
      select: { id: true },
    });
    for (const run of runs) {
      runEvaluationCheck(run.id).catch((err) =>
        console.error(`[ReEvaluate] Failed to trigger eval for ${run.id}: ${(err as Error).message}`)
      );
    }

    audit(req, "project.re_evaluate", projectId, { resetCount: result.count });
    res.json({ ok: true, resetCount: result.count });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/projects/:id/re-evaluate-failed
 *
 * Re-queues only FAILED runs for evaluation, preserving COMPLETE run results.
 * Useful after quota errors where only some calls failed.
 */
router.post("/:id/re-evaluate-failed", evalRateLimit, async (req: AuthRequest, res) => {
  const projectId = req.params.id;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } });
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (!await canAccess(p.userId, req)) return res.status(403).json({ error: "Access denied" });

  try {
    // Delete eval results only for failed runs, then reset them to PENDING
    const failedRuns = await prisma.run.findMany({
      where: { projectId, status: "FAILED" },
      select: { id: true },
    });
    const failedRunIds = failedRuns.map((r) => r.id);

    if (failedRunIds.length === 0) {
      return res.json({ ok: true, resetCount: 0 });
    }

    await prisma.$transaction([
      prisma.evalResult.deleteMany({ where: { runId: { in: failedRunIds } } }),
      prisma.run.updateMany({
        where: { id: { in: failedRunIds } },
        data: { status: "PENDING", overallScore: null, evalCost: null, errorLog: null },
      }),
    ]);

    // Trigger evaluation for each reset run
    for (const run of failedRuns) {
      runEvaluationCheck(run.id).catch((err) =>
        console.error(`[ReEvaluateFailed] Failed to trigger eval for ${run.id}: ${(err as Error).message}`)
      );
    }

    audit(req, "project.re_evaluate_failed", projectId, { resetCount: failedRunIds.length });
    // Return resetCount (all failed runs in the project, not just the 200 loaded in the frontend)
    res.json({ ok: true, resetCount: failedRunIds.length, totalFailed: failedRunIds.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/projects/:id/re-hydrate
 *
 * Re-fetches conversation details for all runs that have a conversationId,
 * then re-evaluates them. Processes one at a time with a delay to avoid
 * hitting Hamsa/OpenAI rate limits.
 */
router.post("/:id/re-hydrate", async (req: AuthRequest, res) => {
  const projectId = req.params.id;
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });

  if (rehydratingProjects.has(projectId)) {
    return res.status(409).json({ error: "Re-hydration already in progress for this project." });
  }

  const runs = await prisma.run.findMany({
    where: { projectId, conversationId: { not: null } },
    select: { id: true, conversationId: true },
    orderBy: { createdAt: "asc" },
  });

  if (runs.length === 0) {
    return res.json({ ok: true, total: 0, message: "No runs with conversation IDs found" });
  }

  rehydratingProjects.add(projectId);

  // Respond immediately — hydration runs in background
  res.json({ ok: true, total: runs.length, message: `Re-hydrating ${runs.length} calls in the background (1 at a time with delays).` });

  // Background: fetch conversation details one by one, then evaluate
  const apiKey = project.hamsaApiKey || process.env.HAMSA_API_KEY;
  const { fetchConversation, extractTranscriptFromConversation, fetchCallLog, extractJobIdFromConversation } = await import("../services/hamsaApi");

  let completed = 0;
  let failed = 0;

  for (const run of runs) {
    try {
      console.log(`[ReHydrate] ${completed + failed + 1}/${runs.length} Fetching conv ${run.conversationId}`);

      const conv = await fetchConversation(run.conversationId!, apiKey);
      const transcript = extractTranscriptFromConversation(conv);
      const callLog = Array.isArray(conv?.logs) && conv.logs.length > 0 ? conv.logs : null;
      const callStatus = conv?.status || null;
      const callDuration = typeof conv?.callDuration === "number" ? conv.callDuration : null;
      const callDate = conv?.createdAt ? new Date(conv.createdAt) : null;
      const outcomeResult = conv?.jobResponse?.outcomeResult ?? null;
      const callOutcome: string | null = outcomeResult?.call_outcome ?? null;
      const jobId = extractJobIdFromConversation(conv);
      const modelUsed = conv?.agentDetails?.llm?.model || conv?.voiceAgent?.llm?.model || conv?.model || null;

      // Update run with fresh data
      await prisma.run.update({
        where: { id: run.id },
        data: {
          transcript: transcript as any,
          callLog: callLog as any,
          callStatus,
          callDuration,
          callDate,
          callOutcome,
          outcomeResult: outcomeResult as any,
          hamsaCallId: jobId,
          modelUsed,
          webhookData: conv as any,
          status: "PENDING",
          overallScore: null,
          evalCost: null,
        },
      });

      // Also try supplemental logs via jobId
      if (jobId) {
        try {
          const logs = await fetchCallLog(jobId, apiKey);
          if (Array.isArray(logs) && logs.length > (callLog?.length ?? 0)) {
            await prisma.run.update({ where: { id: run.id }, data: { callLog: logs as any } });
          }
        } catch {}
      }

      // Delete old eval results for this run
      await prisma.evalResult.deleteMany({ where: { runId: run.id } });

      // Trigger evaluation
      await runEvaluationCheck(run.id);
      completed++;

      // Wait 3 seconds between calls to avoid rate limits
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      console.error(`[ReHydrate] Failed run ${run.id}:`, (err as Error).message);
      failed++;
      // Still wait before next call
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  rehydratingProjects.delete(projectId);
  console.log(`[ReHydrate] Done: ${completed} succeeded, ${failed} failed out of ${runs.length}`);
});

/**
 * POST /api/projects/:id/ask
 *
 * Natural language search across evaluated runs.
 * Body: { question: string }
 * Returns matching runs with explanations.
 */
router.post("/:id/ask", llmRateLimit, async (req: AuthRequest, res) => {
  const { question } = req.body;
  if (!question || typeof question !== "string" || question.trim().length < 3) {
    return res.status(400).json({ error: "Please provide a question (min 3 characters)" });
  }

  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });

  // 90s timeout — two LLM calls with enriched context + DB query
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: "Search timed out. Try a more specific question." });
    }
  }, 90_000);

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

// ─── Tool Result Search ───────────────────────────────────────────
// POST /:id/tool-search — full-text search through call log tool events.
// No LLM involved — pure Postgres text search on the callLog JSON column.
// Returns matching runs with the specific tool events that contain the query.
router.post("/:id/tool-search", async (req: AuthRequest, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!await canAccess(project.userId ?? null, req)) return res.status(403).json({ error: "Access denied" });

  const { query } = req.body as { query?: string };
  if (!query || typeof query !== "string" || query.trim().length < 2) {
    return res.status(400).json({ error: "query must be at least 2 characters" });
  }

  const cleanQuery = query.trim();

  try {
    // Use Postgres text cast: callLog is JSONB so ::text is efficient.
    // The cast produces the full JSON string which ILIKE can search over.
    // Fetch 101 rows so we can detect truncation without a separate COUNT query.
    type RawRun = {
      id: string;
      hamsaCallId: string | null;
      conversationId: string | null;
      callDate: Date | null;
      callDuration: number | null;
      callOutcome: string | null;
      callStatus: string | null;
      overallScore: number | null;
      callLog: any;
    };
    const PAGE_SIZE = 100;
    const rawRuns = await prisma.$queryRaw<RawRun[]>`
      SELECT id, "hamsaCallId", "conversationId", "callDate", "callDuration",
             "callOutcome", "callStatus", "overallScore", "callLog"
      FROM "Run"
      WHERE "projectId" = ${project.id}
        AND "callLog" IS NOT NULL
        AND "callLog"::text ILIKE ${'%' + cleanQuery + '%'}
      ORDER BY "callDate" DESC NULLS LAST
      LIMIT ${PAGE_SIZE + 1}
    `;

    // Detect truncation — if we got more than PAGE_SIZE rows, there are more results
    const hasMore = rawRuns.length > PAGE_SIZE;
    const runs = hasMore ? rawRuns.slice(0, PAGE_SIZE) : rawRuns;

    const queryLower = cleanQuery.toLowerCase();

    // For each matching run, extract the TOOLS events that contain the query
    const results = runs.map((run) => {
      // $queryRaw may return JSONB columns as a parsed object or as a JSON string
      // depending on the Prisma version / pg driver — handle both.
      let callLog: any[];
      if (Array.isArray(run.callLog)) {
        callLog = run.callLog;
      } else if (typeof run.callLog === "string") {
        try { callLog = JSON.parse(run.callLog); } catch { callLog = []; }
      } else {
        callLog = [];
      }

      // Collect all TOOLS events and pair Executing + Success/Error events together.
      // We match result events by toolName so concurrent tool calls don't get
      // mismatched responses.
      const toolEventGroups: Array<{
        toolName: string;
        request: any;
        response: any;
        status: "success" | "error" | "unknown";
        matchesQuery: boolean;
      }> = [];

      for (let i = 0; i < callLog.length; i++) {
        const e = callLog[i];
        if (e.category !== "TOOLS") continue;
        if (e.message !== "Executing Tool") continue;

        const toolName = e.payload?.toolName || "unknown";
        const request = e.payload?.request || e.payload?.params || null;

        // Search ahead for the matching result event for this specific toolName.
        // Scan up to 10 events (wider window handles interleaved concurrent calls).
        let response: any = null;
        let status: "success" | "error" | "unknown" = "unknown";
        const scanLimit = Math.min(i + 10, callLog.length);
        for (let j = i + 1; j < scanLimit; j++) {
          const r = callLog[j];
          if (r.category !== "TOOLS") continue;
          // Match by toolName when available; fall back to first result event.
          const resultTool = r.payload?.toolName ?? r.payload?.name;
          if (resultTool && resultTool !== toolName) continue;
          if (r.message === "Tool Success" || r.message === "Tool API call completed") {
            response = r.payload?.response ?? r.payload;
            status = (r.payload?.response?.ok === false) ? "error" : "success";
            break;
          }
          if (r.message === "Tool Error" || r.message === "Tool Failed") {
            response = r.payload;
            status = "error";
            break;
          }
        }

        // Check if this tool event (request or response) contains the query
        const eventText = JSON.stringify({ toolName, request, response }).toLowerCase();
        const matchesQuery = eventText.includes(queryLower);

        if (matchesQuery) {
          toolEventGroups.push({ toolName, request, response, status, matchesQuery: true });
        }
      }

      return {
        id: run.id,
        hamsaCallId: run.hamsaCallId,
        conversationId: run.conversationId,
        callDate: run.callDate,
        callDuration: run.callDuration,
        callOutcome: run.callOutcome,
        callStatus: run.callStatus,
        overallScore: run.overallScore,
        matchCount: toolEventGroups.length,
        toolMatches: toolEventGroups,
      };
    }).filter((r) => r.matchCount > 0);

    res.json({ query: cleanQuery, total: results.length, hasMore, results });
  } catch (err) {
    console.error("[ToolSearch] Error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Eval Context (per-project evaluation rules) ──────────────────

// GET  /:id/eval-context  — return current context
router.get("/:id/eval-context", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { userId: true, evalContext: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });
    res.json({ evalContext: project.evalContext ?? "" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /:id/eval-context  — save context
router.patch("/:id/eval-context", async (req: AuthRequest, res) => {
  const { evalContext } = req.body as { evalContext?: string };
  if (typeof evalContext !== "string") return res.status(400).json({ error: "evalContext must be a string" });
  if (evalContext.length > 5000) return res.status(400).json({ error: "evalContext must be 5000 characters or fewer" });
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { userId: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });
    const updated = await prisma.project.update({
      where: { id: req.params.id },
      data: { evalContext: evalContext.trim() || null },
      select: { evalContext: true },
    });
    res.json({ evalContext: updated.evalContext ?? "" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Prompt Audit ──────────────────────────────────────────────────

// POST /:id/prompt-audit
// Body: { instructions?: string }
// Audits all workflow node prompts using the project's evalContext + optional
// one-off instructions. Returns per-node findings and suggested rewrites.
router.post("/:id/prompt-audit", llmRateLimit, async (req: AuthRequest, res) => {
  const { instructions } = req.body as { instructions?: string };
  if (instructions && instructions.length > 3000) {
    return res.status(400).json({ error: "instructions must be 3000 characters or fewer" });
  }

  // 120s timeout — audit can be slow with many nodes
  const timeout = setTimeout(() => {
    if (!res.headersSent) res.status(504).json({ error: "Prompt audit timed out. Try again." });
  }, 120_000);

  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { userId: true, agentSummary: true, agentStructure: true, evalContext: true },
    });
    if (!project) { clearTimeout(timeout); return res.status(404).json({ error: "Project not found" }); }
    if (!await canAccess(project.userId, req)) { clearTimeout(timeout); return res.status(403).json({ error: "Access denied" }); }
    if (!project.agentStructure) { clearTimeout(timeout); return res.status(400).json({ error: "Agent structure not loaded. Refresh the agent first." }); }

    const result = await auditAgentPrompts(
      project.agentSummary ?? null,
      project.agentStructure,
      project.evalContext ?? null,
      instructions?.trim() || null
    );

    clearTimeout(timeout);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    clearTimeout(timeout);
    console.error("[PromptAudit] Failed:", err);
    if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
  }
});

// POST /:id/prompt-audit/apply
// Body: { nodeId: string, prompt: string }
// Applies a single approved rewrite to the live Hamsa agent.
router.post("/:id/prompt-audit/apply", async (req: AuthRequest, res) => {
  const { nodeId, prompt } = req.body as { nodeId?: string; prompt?: string };
  if (!nodeId || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "nodeId and prompt are required" });
  }
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { userId: true, agentId: true, hamsaApiKey: true, agentStructure: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });
    if (!project.agentStructure) return res.status(400).json({ error: "Agent structure not loaded." });

    const structure = project.agentStructure as any;
    const nodes: any[] = structure?.workflow?.nodes ?? [];
    const node = nodes.find((n: any) => n.id === nodeId);
    if (!node) return res.status(404).json({ error: `Node ${nodeId} not found in agent structure` });

    // Build the updated nodes array (only the target node's message changes)
    const updatedNodes = nodes.map((n: any) =>
      n.id === nodeId ? { ...n, message: prompt.trim() } : n
    );

    // Push to Hamsa
    await updateAgentWorkflow(project.agentId, updatedNodes, project.hamsaApiKey ?? undefined);

    // Update our local copy of agentStructure so future audits see the new prompt
    const updatedStructure = {
      ...structure,
      workflow: { ...structure.workflow, nodes: updatedNodes },
    };
    await prisma.project.update({
      where: { id: req.params.id },
      data: { agentStructure: updatedStructure },
    });

    audit(req, "prompt_audit.apply", req.params.id, { nodeId, nodeLabel: node.label });
    res.json({ ok: true, nodeId, nodeLabel: node.label });
  } catch (err) {
    console.error("[PromptAudit] Apply failed:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
