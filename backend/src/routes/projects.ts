import prisma from "../lib/prisma";
import { Router } from "express";
import express from "express";
import { CriterionType, Prisma } from "@prisma/client";
import { z } from "zod";
import { getAgent } from "../services/hamsaApi";
import { generateAgentSummary } from "../services/llmJudge";
import { analyzeProject, compareAnalyses } from "../services/projectAnalyzer";
import { getProjectReport, generateIntelligenceReport } from "../services/reportingService";
import { compareReports, getObjectiveFailuresForRange } from "../services/reportComparison";
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
const VALID_PROJECT_TYPES   = new Set(["LIVE", "HISTORY", "WEBHOOK", "TECH_SUPPORT", "INGEST"]);
const VALID_RUN_STATUSES    = new Set(["PENDING","RUNNING","AWAITING_DATA","EVALUATING","COMPLETE","FAILED"]);
const VALID_RUN_SOURCES     = new Set(["LIVE","HISTORY","WEBHOOK"]);

// Strip sensitive credentials from project objects before sending to the client.
// hamsaApiKey and webhookSecret are server-side secrets — the frontend never needs them.
function stripSecrets<T extends Record<string, unknown>>(p: T): Omit<T, "hamsaApiKey" | "webhookSecret"> {
  const { hamsaApiKey: _k, webhookSecret: _w, ...rest } = p as any;
  return rest;
}

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
  res.json(projects.map(stripSecrets));
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

// Import a full project bundle — rate-limited to prevent abuse.
// The 50mb body parser is scoped to this route only so the global 1mb cap
// is not inadvertently raised for the rest of the API.
router.post("/import-bundle", express.json({ limit: "50mb" }), evalRateLimit, async (req: AuthRequest, res) => {
  try {
    // Auth check before any processing
    if (!req.userId) return res.status(401).json({ error: "Unauthorized" });

    // Accept either a single bundle (legacy) or { bundles: [...] } for merge mode
    const body = req.body;
    const bundles: any[] = Array.isArray(body?.bundles)
      ? body.bundles
      : (body?.project ? [body] : []);

    if (bundles.length === 0) {
      return res.status(400).json({ error: "Invalid request: expected a bundle or { bundles: [...] }" });
    }
    if (bundles.length > 20) {
      return res.status(400).json({ error: "Too many bundles: maximum 20 bundles per merge" });
    }

    for (let i = 0; i < bundles.length; i++) {
      const b = bundles[i];
      if (!b?.project || !Array.isArray(b.criteria) || !Array.isArray(b.runs)) {
        return res.status(400).json({ error: `Invalid bundle at index ${i}: missing project, criteria, or runs` });
      }
      if (typeof b.project.name !== "string" || !b.project.name.trim()) {
        return res.status(400).json({ error: `Invalid bundle at index ${i}: project.name is required` });
      }
    }

    const isMerge = bundles.length > 1;
    const primary = bundles[0];

    // Warn when bundles disagree on project-level metadata — primary's values are used
    const warnings: string[] = [];
    if (isMerge) {
      const metaFields = ["agentId", "projectType", "evalContext", "agentStructure", "flowDefinition", "agentSummary", "hamsaApiKey"];
      for (const field of metaFields) {
        const distinct = new Set(bundles.map(b => JSON.stringify(b.project[field] ?? null)));
        if (distinct.size > 1) {
          warnings.push(`Bundles differ on \`${field}\` — using value from "${primary.project.name.trim()}".`);
        }
      }
    }

    const projectName = isMerge
      ? `Merged: ${bundles.map(b => b.project.name.trim()).join(" + ")}`
      : `${primary.project.name.trim()} (imported)`;

    // Wrap everything in a transaction so partial failures roll back cleanly
    // Timeout: 10 min — large projects with 1000s of runs can take time
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create project from primary bundle's metadata
      const newProject = await tx.project.create({
        data: {
          name:           projectName,
          description:    primary.project.description    || undefined,
          projectType:    VALID_PROJECT_TYPES.has(primary.project.projectType) ? primary.project.projectType : "HISTORY",
          agentId:        primary.project.agentId        || "",
          hamsaApiKey:    primary.project.hamsaApiKey    || undefined,
          evalContext:    primary.project.evalContext     || undefined,
          agentStructure: primary.project.agentStructure || undefined,
          flowDefinition: primary.project.flowDefinition || undefined,
          agentSummary:   primary.project.agentSummary   || undefined,
          webhookSecret:  primary.project.webhookSecret  || undefined,
          historyStartDate: primary.project.historyStartDate ? new Date(primary.project.historyStartDate) : undefined,
          historyEndDate:   primary.project.historyEndDate   ? new Date(primary.project.historyEndDate)   : undefined,
          userId:         req.userId!,
        },
      });

      // Tracks criteria already inserted into the merged project, keyed by their final `key`.
      // signature = serialized (type, expectedValue) — used to detect "same key, same definition"
      // (which we dedupe) vs. "same key, different definition" (which we rename with _2, _3, …).
      const existingCriteria = new Map<string, { id: string; signature: string }>();

      let imported = 0;
      let totalRuns = 0;
      // Criterion-rename notices collected here and returned from the transaction to avoid
      // double-push if Prisma retries the transaction on a serialization conflict.
      const criterionWarnings: string[] = [];

      for (const bundle of bundles) {
        totalRuns += bundle.runs.length;
        // Per-bundle map: this bundle's criterion _exportId → new criterion ID in the merged project
        const criterionIdMap: Record<string, string> = {};
        let criterionIndex = 0;

        for (const c of bundle.criteria) {
          if (!VALID_CRITERION_TYPES.has(c.type)) continue;
          const baseKey = String(c.key || c._exportId || `criterion_${criterionIndex}`);
          const signature = JSON.stringify([c.type, c.expectedValue ?? {}]);

          // Search baseKey and its numeric variants (_2, _3, …) for an identical definition to
          // reuse, or find the next free suffix if there's a conflict.
          // IMPORTANT: only treat keys as "in this series" when the suffix is purely numeric —
          // a key like `score_category` must not be confused with `score_2`.
          let reuseId: string | null = null;
          let baseKeyTaken = false;
          let maxSuffix = 0;
          for (const [k, info] of existingCriteria.entries()) {
            if (k === baseKey) {
              baseKeyTaken = true;
              if (info.signature === signature && !reuseId) reuseId = info.id;
            } else if (k.startsWith(`${baseKey}_`)) {
              const tail = k.slice(baseKey.length + 1);
              if (/^\d+$/.test(tail)) {
                const n = parseInt(tail, 10);
                if (n > maxSuffix) maxSuffix = n;
                // Only match as a numeric variant — non-numeric suffixes (e.g. `score_v2`) are
                // unrelated criteria and must never be reused or counted.
                if (info.signature === signature && !reuseId) reuseId = info.id;
              }
            }
          }

          if (reuseId) {
            if (c._exportId) criterionIdMap[c._exportId] = reuseId;
            criterionIndex++;
            continue;
          }

          const finalKey = !baseKeyTaken ? baseKey : `${baseKey}_${Math.max(maxSuffix + 1, 2)}`;

          const newC = await tx.criterion.create({
            data: {
              projectId:     newProject.id,
              key:           finalKey,
              label:         c.label     || undefined,
              type:          c.type      as any,
              expectedValue: c.expectedValue ?? {},
              weight:        typeof c.weight === "number" ? c.weight : 1.0,
            },
          });
          existingCriteria.set(finalKey, { id: newC.id, signature });
          if (c._exportId) criterionIdMap[c._exportId] = newC.id;
          if (isMerge && finalKey !== baseKey) {
            criterionWarnings.push(`Criterion "${baseKey}" from "${bundle.project.name.trim()}" had a different definition — imported as "${finalKey}".`);
          }
          criterionIndex++;
        }

        // Runs + eval results — batched within each bundle
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
      }

      return { projectId: newProject.id, name: newProject.name, imported, total: totalRuns, criterionWarnings };
    }, { timeout: 600_000 }); // 10 min timeout for large projects

    // Assemble final warnings outside the transaction so retries can't double-push entries
    if (result.imported < result.total) {
      warnings.push(`Only ${result.imported} of ${result.total} runs imported`);
    }
    warnings.push(...result.criterionWarnings);

    res.json({
      projectId: result.projectId,
      name: result.name,
      imported: result.imported,
      // Legacy callers read `warning`; new callers can read the structured `warnings` array
      warning: warnings.length ? warnings.join(" ") : undefined,
      warnings: warnings.length ? warnings : undefined,
    });
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

/**
 * Compact per-run objective verdict, derived from the layered eval — the single
 * source of truth used everywhere we display "Met / Not met / N/A".
 *   "met"     — Layer 4 set objectiveAchieved true
 *   "not_met" — Layer 4 set objectiveAchieved false (incl. ACTION_HALLUCINATION override)
 *   "na"      — call abandoned/notApplicable, eval errored, or no objective verdict
 *   null      — no layered eval at all (not yet evaluated)
 * Deliberately does NOT fall back to the agent's self-reported outcomeResult.objective_met,
 * which can contradict the eval (e.g. WEBHOOK false positives) and produced the
 * "zero-turn call shows Not met" bug.
 */
function computeRunObjectiveStatus(
  evalResults: Array<{ detail?: string | null; criterion?: { type?: string | null } | null }> | null | undefined,
): "met" | "not_met" | "na" | null {
  const layered = (evalResults ?? []).find((er) => er.criterion?.type === "LAYERED_EVALUATION");
  if (!layered || !layered.detail) return null;
  let detail: any;
  try {
    detail = typeof layered.detail === "string" ? JSON.parse(layered.detail) : layered.detail;
  } catch {
    return null;
  }
  if (!detail || typeof detail !== "object") return null;
  if (detail.notApplicable === true || detail.error === true) return "na";
  const oa = detail.objectiveAchieved;
  if (oa === true || oa === 1) return "met";
  if (oa === false || oa === 0) return "not_met";
  return "na"; // null or undefined verdict → indeterminate
}

// ─── Intention funnel helpers ─────────────────────────────────────────
// Candidate keys (priority order) the agent uses to record the caller's intention.
// Mirrors the frontend detection in ProjectDashboard.tsx so server and client agree.
const INTENT_CANDIDATES = ["primary_intent", "intention", "intent", "call_intent", "caller_intent"];
// Values that mean "could not determine" — routed to the funnel's "couldn't continue"
// bucket, never counted as success or failure (mirrors the dashboard's N/A handling).
const INDETERMINATE_MARKERS = ["n/a", "na", "none", "null", "unknown", "undetermined", ""];

type FunnelSuccessMode = "values" | "present" | "objective";
interface FunnelConfig {
  intentField: string | null;   // outcomeResult key that holds the caller's intention
  successField: string | null;  // outcomeResult key that decides success (null when mode = "objective")
  successMode: FunnelSuccessMode;
  successValues: string[];       // values (lower-cased on compare) counted as success when mode = "values"
}

// Pick the intention field by scanning outcomeResult objects: highest-priority candidate
// present in ANY run, else the first key whose name contains "intent", else null.
function detectIntentField(samples: Array<Record<string, any>>): string | null {
  const present = new Set<string>();
  const fallbacks = new Set<string>();
  for (const or of samples) {
    if (!or || typeof or !== "object") continue;
    for (const c of INTENT_CANDIDATES) {
      if (or[c] != null && String(or[c]).trim() !== "") present.add(c);
    }
    for (const k of Object.keys(or)) {
      if (k.toLowerCase().includes("intent") && !INTENT_CANDIDATES.includes(k)) fallbacks.add(k);
    }
  }
  for (const c of INTENT_CANDIDATES) if (present.has(c)) return c;
  return fallbacks.size > 0 ? [...fallbacks][0] : null;
}

// Coerce a stored/POSTed config into a valid FunnelConfig, or null if unusable.
function normalizeFunnelConfig(raw: any): FunnelConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const mode: FunnelSuccessMode = ["values", "present", "objective"].includes(raw.successMode)
    ? raw.successMode : "objective";
  return {
    intentField: typeof raw.intentField === "string" && raw.intentField.trim() ? raw.intentField : null,
    successField: typeof raw.successField === "string" && raw.successField.trim() ? raw.successField : null,
    successMode: mode,
    successValues: Array.isArray(raw.successValues)
      ? raw.successValues.filter((v: any) => typeof v === "string" && v.trim() !== "")
      : [],
  };
}

// Default config when a project has none saved: intention auto-detected; success from
// outcomeResult.objective_met if present ("yes"/"true"), else the canonical Layer 4 verdict.
function defaultFunnelConfig(samples: Array<Record<string, any>>): FunnelConfig {
  const intentField = detectIntentField(samples);
  const hasObjectiveMet = samples.some((s) => s && Object.prototype.hasOwnProperty.call(s, "objective_met"));
  if (hasObjectiveMet) {
    return { intentField, successField: "objective_met", successMode: "values", successValues: ["yes", "true"] };
  }
  return { intentField, successField: null, successMode: "objective", successValues: [] };
}

// Recent COMPLETE runs' outcomeResult objects — used for field detection & value pickers.
async function loadOutcomeSamples(projectId: string, limit = 800): Promise<Array<Record<string, any>>> {
  const runs = await prisma.run.findMany({
    where: { projectId, status: "COMPLETE" },
    orderBy: { callDate: "desc" },
    take: limit,
    select: { outcomeResult: true },
  });
  const out: Array<Record<string, any>> = [];
  for (const r of runs) {
    const or = r.outcomeResult as any;
    if (or && typeof or === "object" && !Array.isArray(or)) out.push(or);
  }
  return out;
}

// Distinct non-empty scalar values per outcomeResult column (capped) for the success-value picker.
function columnValueMap(samples: Array<Record<string, any>>, cap = 40): Record<string, string[]> {
  const sets: Record<string, Set<string>> = {};
  for (const s of samples) {
    for (const [k, v] of Object.entries(s)) {
      if (v == null || typeof v === "object") continue; // skip null & nested objects/arrays
      const str = String(v).trim();
      if (!str) continue;
      (sets[k] ??= new Set()).add(str);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [k, set] of Object.entries(sets)) out[k] = [...set].slice(0, cap);
  return out;
}

// Parse ?from/?to into Date bounds + a reusable SQL date clause (alias "r" for Run).
function funnelDateRange(req: AuthRequest): { dateFrom: Date | null; dateTo: Date | null; dateClause: Prisma.Sql } {
  const re = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]*)?$/;
  const parse = (raw: string | undefined, endOfDay = false): Date | null => {
    if (!raw || !re.test(raw)) return null;
    const d = new Date(raw.length <= 10 ? raw + "T00:00:00Z" : raw);
    if (!Number.isFinite(d.getTime())) return null;
    if (endOfDay && raw.length <= 10) d.setUTCHours(23, 59, 59, 999);
    return d;
  };
  const dateFrom = parse(req.query.from as string | undefined);
  const dateTo = parse(req.query.to as string | undefined, true);
  const dateClause = dateFrom && dateTo
    ? Prisma.sql`AND COALESCE(r."callDate", r."createdAt") >= ${dateFrom} AND COALESCE(r."callDate", r."createdAt") <= ${dateTo}`
    : dateFrom ? Prisma.sql`AND COALESCE(r."callDate", r."createdAt") >= ${dateFrom}`
    : dateTo ? Prisma.sql`AND COALESCE(r."callDate", r."createdAt") <= ${dateTo}`
    : Prisma.empty;
  return { dateFrom, dateTo, dateClause };
}

// Optional per-request config override (?intentField&successField&successMode&successValues=a,b)
// so the UI can live-preview a column choice before persisting it. Null when no override given.
function configFromQuery(req: AuthRequest): FunnelConfig | null {
  const intentField = req.query.intentField as string | undefined;
  if (!intentField) return null;
  const successValues = typeof req.query.successValues === "string" && req.query.successValues
    ? (req.query.successValues as string).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  return normalizeFunnelConfig({
    intentField,
    successField: (req.query.successField as string | undefined) ?? null,
    successMode: (req.query.successMode as string | undefined) ?? "objective",
    successValues,
  });
}

// BFS the flowDefinition graph from the start node → canonical ordered stages (by label).
function canonicalStageOrder(flowDef: any): Array<{ label: string; type: string }> {
  if (!flowDef?.nodes || !flowDef.startNodeId) return [];
  const nodes = flowDef.nodes as Record<string, { label?: string; type?: string }>;
  const adjacency = (flowDef.adjacency ?? {}) as Record<string, string[]>;
  const order: Array<{ label: string; type: string }> = [];
  const seenLabel = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [flowDef.startNodeId];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const n = nodes[id];
    const label = n?.label || id;
    if (!seenLabel.has(label)) { seenLabel.add(label); order.push({ label, type: n?.type || "unknown" }); }
    for (const t of adjacency[id] ?? []) if (!visited.has(t)) queue.push(t);
  }
  // Append any unreachable nodes so the funnel can still surface them.
  for (const n of Object.values(nodes)) {
    const label = (n as any)?.label;
    if (label && !seenLabel.has(label)) { seenLabel.add(label); order.push({ label, type: (n as any).type || "unknown" }); }
  }
  return order;
}

// Get single project with criteria and runs (most recent 100 runs, cursor-paginatable)
// Query params:
//   ?before=<runId>  — cursor: return 100 runs older than this run (exclusive)
router.get("/:id", async (req: AuthRequest, res) => {
  console.log(`[Projects] GET /:id called with id=${req.params.id} userId=${req.userId}`);
  try {
    const beforeId = req.query.before as string | undefined;
    const PAGE_SIZE = 100;

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        criteria: true,
        _count: { select: { runs: true } },
        runs: {
          orderBy: { createdAt: "desc" },
          take: PAGE_SIZE,
          // Cursor pagination: skip the cursor run itself, then take the next PAGE_SIZE
          ...(beforeId ? { cursor: { id: beforeId }, skip: 1 } : {}),
          include: {
            // {id, criterionId, passed, score} drive the table; detail + criterion.type
            // are pulled ONLY to compute a compact per-run objectiveStatus below, then
            // stripped from the response so the payload stays small.
            evalResults: {
              select: {
                id: true, criterionId: true, passed: true, score: true,
                detail: true, criterion: { select: { type: true } },
              },
            },
          },
        },
      },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId ?? null, req)) {
      console.log(`[Projects] Access denied: project.userId=${project.userId} req.userId=${req.userId}`);
      return res.status(403).json({ error: "Access denied" });
    }

    // Accurate counts across ALL runs (not just the 200 loaded)
    const [failedRunCount, errorRunCount] = await Promise.all([
      prisma.run.count({ where: { projectId: req.params.id, status: "FAILED" } }),
      prisma.run.count({
        where: {
          projectId: req.params.id,
          status: "COMPLETE",
          evalResults: { some: { detail: { contains: "Evaluation error" } } },
        },
      }),
    ]);

    // Strip heavy fields from list response to keep payload small.
    // Individual run detail pages load full data via GET /runs/:id.
    // evalResults already scoped to {id, criterionId, passed, score} by the Prisma select above.
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
      // Canonical per-run objective verdict, computed once from the layered eval
      // (single source of truth). The table renders this directly so it is correct
      // for every loaded run regardless of any aggregation sample cap.
      const objectiveStatus = computeRunObjectiveStatus(run.evalResults);
      // Strip detail + criterion back out so the list payload stays small.
      const lightEvalResults = (run.evalResults ?? []).map((er: any) => ({
        id: er.id, criterionId: er.criterionId, passed: er.passed, score: er.score,
      }));
      return {
        ...run,
        evalResults: lightEvalResults,
        objectiveStatus,                            // "met" | "not_met" | "na" | null
        webhookData: lightWebhookData,
        callLog: run.callLog ? true : null,        // boolean flag — frontend checks existence
        transcript: run.transcript ? true : null,  // boolean flag — frontend checks existence
      };
    });
    const hasMoreRuns = lightRuns.length === PAGE_SIZE;
    const safeProject = stripSecrets(project as any);
    const responseSize = JSON.stringify({ ...safeProject, runs: lightRuns }).length;
    console.log(`[Projects] Returning project ${project.name} with ${lightRuns.length} runs (~${(responseSize / 1024).toFixed(0)}KB)`);
    res.json({ ...safeProject, runs: lightRuns, failedRunCount, errorRunCount, hasMoreRuns });
  } catch (err) {
    console.error("[Projects] GET /:id error:", (err as Error).message, (err as Error).stack?.slice(0, 300));
    res.status(500).json({ error: "Failed to fetch project" });
  }
});

// Fetch specific runs by IDs — used when a filter (issue/node) references runs not in the loaded 200.
// POST is preferred: a comma-joined query param breaks at ~100 CUIDs (URL length limits).
router.post("/:id/runs-by-ids", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId ?? null, req)) return res.status(403).json({ error: "Access denied" });

    const rawIds: unknown = req.body?.ids;
    if (!Array.isArray(rawIds)) return res.status(400).json({ error: "ids must be an array" });
    const ids = (rawIds as unknown[]).filter((id): id is string => typeof id === "string" && !!id).slice(0, 500);
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

    // ── Optional date range filter ──────────────────────────────────────
    // Validate before passing to Prisma — new Date("garbage") produces an Invalid
    // Date whose getTime() is NaN; Prisma then throws a 500 on the raw query.
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]*)?$/;
    const parseQueryDate = (raw: string | undefined, endOfDay = false): Date | null => {
      if (!raw) return null;
      if (!ISO_DATE_RE.test(raw)) return null;
      const d = new Date(raw.length <= 10 ? raw + "T00:00:00Z" : raw);
      if (!Number.isFinite(d.getTime())) return null;
      if (endOfDay && raw.length <= 10) d.setUTCHours(23, 59, 59, 999);
      return d;
    };
    const dateFrom = parseQueryDate(req.query.from as string | undefined);
    const dateTo   = parseQueryDate(req.query.to   as string | undefined, true);
    // Reusable SQL fragment — injected into every query that uses alias "r" for the Run table
    const dateClause = dateFrom && dateTo
      ? Prisma.sql`AND COALESCE(r."callDate", r."createdAt") >= ${dateFrom} AND COALESCE(r."callDate", r."createdAt") <= ${dateTo}`
      : dateFrom
      ? Prisma.sql`AND COALESCE(r."callDate", r."createdAt") >= ${dateFrom}`
      : dateTo
      ? Prisma.sql`AND COALESCE(r."callDate", r."createdAt") <= ${dateTo}`
      : Prisma.empty;

    // Accurate KPI aggregates over ALL runs — no row limit
    // total_all   = every run regardless of status (shown as "Total Runs/Calls")
    // total_complete / avg_score / passed = stats for COMPLETE runs only (for KPI cards)
    // avg_score / passed / total_meaningful exclude runs where fewer than 2 criteria were
    // actually evaluated (non-null passed value) — single-greeting calls would otherwise
    // inflate the average via a trivial Word Accuracy 100%.
    // total_eval_cost = sum of eval spend across all runs
    const MIN_EVALUATED_CRITERIA = 2;
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
        AVG("overallScore") FILTER (
          WHERE status = 'COMPLETE'
            AND "overallScore" IS NOT NULL
            AND (
              SELECT COUNT(*) FROM "EvalResult" er
              WHERE er."runId" = r.id AND er.passed IS NOT NULL
            ) >= ${MIN_EVALUATED_CRITERIA}
        )::double precision                                                    AS avg_score,
        COUNT(*) FILTER (
          WHERE "overallScore" >= 0.7
            AND (
              SELECT COUNT(*) FROM "EvalResult" er
              WHERE er."runId" = r.id AND er.passed IS NOT NULL
            ) >= ${MIN_EVALUATED_CRITERIA}
        )                                                                      AS passed,
        AVG("callDuration") FILTER (WHERE status = 'COMPLETE')::double precision AS avg_duration,
        SUM("evalCost")::double precision                                       AS total_eval_cost
      FROM "Run" r
      WHERE r."projectId" = ${req.params.id}
      ${dateClause}
    `;

    // SQL-level: score distribution in 10% buckets over ALL complete scored runs
    const scoreDistRows = await prisma.$queryRaw<Array<{ bucket: number; cnt: bigint }>>`
      SELECT
        LEAST(FLOOR("overallScore" * 10)::int, 9) AS bucket,
        COUNT(*) AS cnt
      FROM "Run" r
      WHERE r."projectId" = ${req.params.id}
        AND r.status = 'COMPLETE'
        AND r."overallScore" IS NOT NULL
        AND (
          SELECT COUNT(*) FROM "EvalResult" er
          WHERE er."runId" = r.id AND er.passed IS NOT NULL
        ) >= ${MIN_EVALUATED_CRITERIA}
        ${dateClause}
      GROUP BY bucket
      ORDER BY bucket
    `;

    // SQL-level: outcome distribution over ALL runs (callOutcome is a plain column, no JSON)
    const outcomeDistRows = await prisma.$queryRaw<Array<{ outcome: string | null; cnt: bigint }>>`
      SELECT r."callOutcome" AS outcome, COUNT(*) AS cnt
      FROM "Run" r
      WHERE r."projectId" = ${req.params.id} AND r.status = 'COMPLETE'
      ${dateClause}
      GROUP BY r."callOutcome"
      ORDER BY cnt DESC
      LIMIT 30
    `;

    // SQL-level: score trend over ALL complete runs (used for Score Over Time chart)
    // Use hourly granularity for short date ranges (≤2 days) so single-day views show data
    const rangeMs = dateFrom && dateTo ? dateTo.getTime() - dateFrom.getTime() : Infinity;
    const trendGranularity = rangeMs <= 2 * 24 * 60 * 60 * 1000 ? "hour" : "day";
    const trendTrunc = trendGranularity === "hour" ? Prisma.sql`'hour'` : Prisma.sql`'day'`;

    const scoreTrendRows = await prisma.$queryRaw<Array<{
      period: Date; avg_score: number; run_count: bigint;
    }>>`
      SELECT
        DATE_TRUNC(${trendTrunc}, "callDate")    AS period,
        AVG("overallScore")::double precision    AS avg_score,
        COUNT(*)                                 AS run_count
      FROM "Run" r
      WHERE r."projectId" = ${req.params.id}
        AND r.status = 'COMPLETE'
        AND r."callDate" IS NOT NULL
        AND r."overallScore" IS NOT NULL
        AND (
          SELECT COUNT(*) FROM "EvalResult" er
          WHERE er."runId" = r.id AND er.passed IS NOT NULL
        ) >= ${MIN_EVALUATED_CRITERIA}
        ${dateClause}
      GROUP BY DATE_TRUNC(${trendTrunc}, "callDate")
      ORDER BY period
    `;

    const runs = await prisma.run.findMany({
      where: {
        projectId: req.params.id,
        status: "COMPLETE",
        // Date range filter — uses callDate when available, otherwise createdAt
        ...(dateFrom || dateTo ? {
          OR: [
            { callDate: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } },
            // Runs without callDate: fall back to createdAt
            { callDate: null, createdAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } },
          ],
        } : {}),
      },
      orderBy: { callDate: "asc" },
      take: 1000,   // cap at 1000 for detailed JSON analysis (sentiment, issues, node perf)
      select: {
        id: true,
        overallScore: true,
        callDate: true,
        callDuration: true,
        callOutcome: true,
        conversationId: true,
        outcomeResult: true,
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
    const indeterminateRunIds: string[] = [];
    // Outcome-extractor objective — from outcomeResult.objective_met ("yes"/"no"/bool)
    let outcomeObjCount = 0;
    let outcomeObjTotal = 0;
    let outcomeObjNa = 0; // outcomeResult present but objective_met is "n/a"/null/empty
    // Criteria performance — per-criterion pass/fail stats + failed run IDs
    const criteriaPerf: Record<string, { name: string; type: string; total: number; passed: number; failedRunIds: string[] }> = {};
    // Compliance and experience scores — extracted from layered eval detail
    const complianceScores: number[] = [];
    const experienceScores: number[] = [];

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
      } catch {
        // Non-JSON detail = eval was skipped (abandoned call, no transcript, etc.).
        // Log at debug level so corrupt detail strings are discoverable without
        // flooding production logs on normal abandoned calls.
        if (typeof layered.detail === "string" && layered.detail.trim().startsWith("{")) {
          console.warn(`[Dashboard] Corrupt eval detail for run ${run.id}: parse failed`);
        }
        continue;
      }
      // notApplicable = call abandoned before user spoke (or no workflow/log available).
      // Still add to indeterminateRunIds so the dashboard shows "—" / N/A instead of
      // falling back to outcomeResult.objective_met which would show a false "Not met".
      if (detail?.notApplicable === true) {
        indeterminateRunIds.push(run.id);
        continue;
      }
      if (detail?.error === true) {
        // Errored eval has no valid metrics — but track as indeterminate so the run
        // shows "—" rather than silently vanishing from the objective view.
        indeterminateRunIds.push(run.id);
        continue;
      }

      // Compliance score (from split eval: quality vs compliance)
      if (detail.complianceScore != null && typeof detail.complianceScore === "number") {
        complianceScores.push(detail.complianceScore);
      }

      // Experience score
      if (detail.experienceScore != null && typeof detail.experienceScore === "number") {
        experienceScores.push(detail.experienceScore);
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

      // Objective (layered eval)
      if (detail.objectiveAchieved != null) {
        objectiveTotal++;
        if (detail.objectiveAchieved === true || detail.objectiveAchieved === 1) {
          objectiveCount++;
          achievedRunIds.push(run.id);
        } else {
          notAchievedRunIds.push(run.id);
        }
      } else {
        // No objective verdict — explicit null (indeterminate, e.g. caller hang-up)
        // OR the field was omitted entirely (undefined). Both must be tracked as
        // indeterminate so the frontend shows "—" instead of falling back to
        // outcomeResult.objective_met, which would surface a false "Not met".
        indeterminateRunIds.push(run.id);
      }

      // Objective (outcome extractor — outcomeResult.objective_met = "yes"/"no"/bool/"n/a")
      const or = run.outcomeResult as any;
      if (or != null) {
        const raw = or.objective_met;
        if (raw != null && raw !== "" && String(raw).toLowerCase() !== "n/a") {
          outcomeObjTotal++;
          if (raw === true || raw === 1 || (typeof raw === "string" && raw.toLowerCase() === "yes")) {
            outcomeObjCount++;
          }
        } else if (typeof raw === "string" && raw.toLowerCase() === "n/a") {
          // Only count explicit "n/a" strings — null/undefined/empty means the agent
          // doesn't populate this field at all, which is different from "not applicable".
          outcomeObjNa++;
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
          .sort((a, b) => b.count - a.count);
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

    // Score distribution from SQL — 10 buckets: 0-10, 10-20 … 90-100
    const scoreDist = Array.from({ length: 10 }, (_, i) => ({
      range: `${i * 10}-${i * 10 + 10}`,
      count: 0,
    }));
    for (const row of scoreDistRows) {
      const idx = Math.min(Math.max(Number(row.bucket), 0), 9);
      scoreDist[idx].count = Number(row.cnt);
    }

    // Outcome distribution from SQL (all runs, plain column — no JSON parsing)
    const outcomeDist: Record<string, number> = {};
    for (const row of outcomeDistRows) {
      outcomeDist[row.outcome ?? "unknown"] = Number(row.cnt);
    }

    // Score trend from SQL — per-day or per-hour averages depending on range
    const scoreTrend = scoreTrendRows.map(r => ({
      day:      r.period instanceof Date ? r.period.toISOString() : String(r.period),
      avgScore: r.avg_score != null ? Math.round(Number(r.avg_score) * 100 * 10) / 10 : null,
      count:    Number(r.run_count),
    }));

    res.json({
      totalRuns: totalAll,       // ALL runs (any status) — matches project list count
      totalFailed,               // FAILED runs — accurate count across all runs (not capped 200)
      totalComplete,             // COMPLETE runs only — denominator for avgScore/passRate
      avgScore,
      avgCompliance: complianceScores.length > 0
        ? Math.round(complianceScores.reduce((s, v) => s + v, 0) / complianceScores.length * 10) / 10
        : null,
      avgExperience: experienceScores.length > 0
        ? Math.round(experienceScores.reduce((s, v) => s + v, 0) / experienceScores.length * 10) / 10
        : null,
      passRate,
      avgDuration,
      totalEvalCost,
      outcomeDist,               // Full outcome distribution (all runs, SQL-level)
      scoreTrend,                // Per-day (or per-hour for short ranges) score averages
      trendGranularity,          // "hour" | "day" — tells frontend how to format axis labels
      sentiment: sentimentCounts,
      objectiveRate: objectiveTotal > 0 ? Math.round((objectiveCount / objectiveTotal) * 100) / 100 : null,
      outcomeObjectiveRate: outcomeObjTotal > 0 ? Math.round((outcomeObjCount / outcomeObjTotal) * 100) / 100 : null,
      outcomeObjectiveTotal: outcomeObjTotal,
      outcomeObjectiveCount: outcomeObjCount,  // raw count — avoids lossy rate×total reconstruction on frontend
      outcomeObjectiveNa: outcomeObjNa,
      // Dedup defensively — a run should only land in one bucket per request, but
      // guarantee uniqueness so the frontend can rely on disjoint sets.
      achievedRunIds: [...new Set(achievedRunIds)],
      notAchievedRunIds: [...new Set(notAchievedRunIds)],
      indeterminateRunIds: [...new Set(indeterminateRunIds)],
      nodePerformance,
      topIssues,
      outcomeBreakdown,
      scoreDist,
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

// ── Report: KPI metrics + daily/hourly trends ────────────────────────────────
// GET /:id/report?days=7   (accepts legacy ?weeks= too, interpreted as days)
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

    const rawDays = parseInt((req.query.days ?? req.query.weeks) as string) || 7;
    const days = Math.min(Math.max(rawDays, 1), 90);
    const report = await getProjectReport(req.params.id, days);
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

// ─── Intention funnel ────────────────────────────────────────────────
// GET /:id/funnel-config — saved intention/success column config (or auto-detected default),
// plus the available outcomeResult columns and their observed values for the UI pickers.
router.get("/:id/funnel-config", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { userId: true, intentionConfig: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });

    const samples = await loadOutcomeSamples(req.params.id);
    const columnValues = columnValueMap(samples);
    const columns = Object.keys(columnValues).sort();
    const saved = normalizeFunnelConfig(project.intentionConfig);
    const config = saved ?? defaultFunnelConfig(samples);
    res.json({ config, columns, columnValues, saved: !!saved });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /:id/funnel-config — persist the chosen intention/success columns on the project.
router.put("/:id/funnel-config", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });

    const config = normalizeFunnelConfig(req.body?.config ?? req.body);
    if (!config) return res.status(400).json({ error: "Invalid config" });
    if (!config.intentField) return res.status(400).json({ error: "intentField is required" });
    if (config.successMode !== "objective" && !config.successField) {
      return res.status(400).json({ error: "successField is required unless successMode is 'objective'" });
    }
    if (config.successMode === "values" && config.successValues.length === 0) {
      return res.status(400).json({ error: "successValues must list at least one value when successMode is 'values'" });
    }
    const updated = await prisma.project.update({
      where: { id: req.params.id },
      data: { intentionConfig: config as unknown as Prisma.InputJsonValue },
      select: { intentionConfig: true },
    });
    res.json({ config: updated.intentionConfig });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /:id/outcome-funnel?from&to — Approach B: cross-tab of intention column × success
// column, computed in SQL over ALL complete runs in range (not capped). Each intention is
// split into started / succeeded / failed / incomplete ("couldn't continue").
router.get("/:id/outcome-funnel", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { userId: true, intentionConfig: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });

    let config = configFromQuery(req) ?? normalizeFunnelConfig(project.intentionConfig);
    if (!config) config = defaultFunnelConfig(await loadOutcomeSamples(req.params.id));
    if (!config.intentField) return res.json({ config, rows: [] });

    const { dateClause } = funnelDateRange(req);
    const intentExpr = Prisma.sql`LOWER(TRIM(r."outcomeResult" ->> ${config.intentField}))`;
    const intentNotEmpty = Prisma.sql`r."outcomeResult" ->> ${config.intentField} IS NOT NULL AND TRIM(r."outcomeResult" ->> ${config.intentField}) <> ''`;

    let rows: Array<{ intention: string | null; started: bigint; succeeded: bigint; failed?: bigint; incomplete?: bigint }>;
    if (config.successMode === "objective") {
      // Success = canonical Layer 4 objective verdict (LATERAL join, one row per run).
      rows = await prisma.$queryRaw`
        SELECT ${intentExpr} AS intention,
          COUNT(*) AS started,
          COUNT(*) FILTER (WHERE oa.verdict IN ('true','1','yes'))  AS succeeded,
          COUNT(*) FILTER (WHERE oa.verdict IN ('false','0','no'))  AS failed
        FROM "Run" r
        LEFT JOIN LATERAL (
          SELECT lower(er.detail::jsonb ->> 'objectiveAchieved') AS verdict
          FROM "EvalResult" er
          JOIN "Criterion" c ON c.id = er."criterionId" AND c.type = 'LAYERED_EVALUATION'
          WHERE er."runId" = r.id
            AND er.detail IS NOT NULL
            AND er.detail ~ '^\\s*\\{'
            AND jsonb_typeof(er.detail::jsonb) = 'object'
          LIMIT 1
        ) oa ON true
        WHERE r."projectId" = ${req.params.id} AND r.status = 'COMPLETE'
          AND ${intentNotEmpty}
          ${dateClause}
        GROUP BY 1
        ORDER BY started DESC
      `;
    } else {
      const successRaw = Prisma.sql`r."outcomeResult" ->> ${config.successField}`;
      const successNorm = Prisma.sql`LOWER(TRIM(${successRaw}))`;
      const incompleteBase = Prisma.sql`(${successRaw} IS NULL OR TRIM(${successRaw}) = '' OR ${successNorm} = ANY(${INDETERMINATE_MARKERS}))`;
      const successValuesLower = config.successValues.map((v) => v.trim().toLowerCase());
      const successCond = config.successMode === "values"
        ? Prisma.sql`${successNorm} = ANY(${successValuesLower})`
        : Prisma.sql`NOT ${incompleteBase}`;
      // Keep buckets disjoint: a value counted as success is never also counted incomplete.
      const incompleteCond = Prisma.sql`${incompleteBase} AND NOT (${successCond})`;
      rows = await prisma.$queryRaw`
        SELECT ${intentExpr} AS intention,
          COUNT(*) AS started,
          COUNT(*) FILTER (WHERE ${successCond})    AS succeeded,
          COUNT(*) FILTER (WHERE ${incompleteCond}) AS incomplete
        FROM "Run" r
        WHERE r."projectId" = ${req.params.id} AND r.status = 'COMPLETE'
          AND ${intentNotEmpty}
          ${dateClause}
        GROUP BY 1
        ORDER BY started DESC
      `;
    }

    const out = rows.map((r) => {
      const started = Number(r.started);
      const succeeded = Number(r.succeeded ?? 0);
      let failed: number, incomplete: number;
      if (config!.successMode === "objective") {
        failed = Number(r.failed ?? 0);
        incomplete = Math.max(0, started - succeeded - failed);
      } else {
        incomplete = Number(r.incomplete ?? 0);
        failed = Math.max(0, started - succeeded - incomplete);
      }
      return {
        intention: r.intention ?? "unknown",
        started, succeeded, failed, incomplete,
        successRate: started > 0 ? Math.round((succeeded / started) * 1000) / 10 : null,
      };
    });
    res.json({ config, rows: out });
  } catch (err) {
    console.error("[Projects] outcome-funnel error:", (err as Error).message);
    res.status(500).json({ error: "Failed to compute outcome funnel" });
  }
});

// GET /:id/intention-node-funnel?from&to — Approach A: per-intention progression through
// the agent's workflow nodes, with drop-off at each stage. Reuses the dashboard's run window
// (COMPLETE, date-filtered, capped at 1000 for JSON path analysis).
router.get("/:id/intention-node-funnel", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { userId: true, intentionConfig: true, flowDefinition: true, agentStructure: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });

    // Canonical stage order + label→type from the flow graph (fall back to deriving from agentStructure).
    const flowDef = project.flowDefinition
      ?? ((project.agentStructure as any)?.workflow ? extractFlowDefinition((project.agentStructure as any).workflow) : null);
    const canonical = canonicalStageOrder(flowDef);
    const labelType = new Map<string, string>(canonical.map((s) => [s.label, s.type]));
    const hasEndCall = canonical.some((s) => s.type === "end_call");

    const { dateFrom, dateTo } = funnelDateRange(req);
    const dateWhere = (dateFrom || dateTo) ? {
      OR: [
        { callDate: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } },
        { callDate: null, createdAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } },
      ],
    } : {};
    const RUN_CAP = 1000;
    const runs = await prisma.run.findMany({
      where: { projectId: req.params.id, status: "COMPLETE", ...dateWhere },
      orderBy: { callDate: "desc" }, // most recent N when capped — matches the UI's wording
      take: RUN_CAP,
      select: {
        outcomeResult: true,
        evalResults: {
          where: { criterion: { type: "LAYERED_EVALUATION" } },
          select: { detail: true },
        },
      },
    });

    let config = configFromQuery(req) ?? normalizeFunnelConfig(project.intentionConfig);
    if (!config) config = defaultFunnelConfig(runs.map((r) => r.outcomeResult as any).filter((o) => o && typeof o === "object"));
    const intentField = config.intentField;
    if (!intentField) {
      return res.json({ intentField: null, intentions: [], capped: runs.length >= RUN_CAP, runWindow: runs.length, note: "No intention field detected." });
    }

    interface Bucket {
      total: number; completed: number;
      reached: Record<string, number>; stuck: Record<string, number>; hallucination: Record<string, number>;
    }
    const intentions: Record<string, Bucket> = {};
    const minIndex = new Map<string, number>(); // earliest observed position per node label → stage order
    let anyEndCallVisited = false;              // did any run actually reach a label typed end_call?

    for (const run of runs) {
      const or = run.outcomeResult as any;
      const intentRaw = or && typeof or === "object" ? or[intentField] : null;
      const intent = (intentRaw == null ? "" : String(intentRaw)).trim().toLowerCase();
      if (!intent) continue;
      const layered = run.evalResults[0];
      if (!layered?.detail) continue;
      let detail: any;
      try { detail = typeof layered.detail === "string" ? JSON.parse(layered.detail) : layered.detail; } catch { continue; }
      if (!detail || typeof detail !== "object") continue;

      const seq: string[] = Array.isArray(detail?.navigation?.nodeSequence)
        ? detail.navigation.nodeSequence.map((s: any) => String(s))
        : Array.isArray(detail?.perNode)
        ? detail.perNode.map((n: any) => n?.nodeLabel || n?.label).filter(Boolean).map((s: any) => String(s))
        : [];
      if (seq.length === 0) continue;

      const bucket = (intentions[intent] ??= { total: 0, completed: 0, reached: {}, stuck: {}, hallucination: {} });
      bucket.total++;

      const visited = new Set<string>();
      seq.forEach((label, idx) => {
        visited.add(label);
        if (!minIndex.has(label) || idx < (minIndex.get(label) as number)) minIndex.set(label, idx);
      });
      for (const label of visited) bucket.reached[label] = (bucket.reached[label] || 0) + 1;

      // Completed = reached an end_call node (only counts when the eval's node labels
      // actually align with the graph's typed labels — see anyEndCallVisited fallback below).
      const reachedEnd = hasEndCall && [...visited].some((l) => labelType.get(l) === "end_call");
      if (reachedEnd) { bucket.completed++; anyEndCallVisited = true; }

      if (Array.isArray(detail.perNode)) {
        for (const n of detail.perNode) {
          const label = n?.nodeLabel || n?.label;
          if (!label) continue;
          if (n?.stuck?.detected === true) bucket.stuck[label] = (bucket.stuck[label] || 0) + 1;
          if (n?.hallucination?.detected === true) bucket.hallucination[label] = (bucket.hallucination[label] || 0) + 1;
        }
      }
    }

    // Stage order is taken from the OBSERVED call paths (earliest position a label was
    // seen), not the flow graph: in practice the evaluator emits human node labels while
    // the graph stores raw node IDs, so the two rarely align. The graph is used only as a
    // best-effort source of node type. Only stages that ≥1 run actually reached are shown.
    const order = [...minIndex.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([label]) => ({ label, type: labelType.get(label) || "unknown" }));
    // If the graph's end_call label never matched a visited label, completion can't be
    // derived from it — fall back to "reached the final observed stage".
    const useEndCall = hasEndCall && anyEndCallVisited;

    const intentionsOut = Object.entries(intentions)
      .map(([intention, b]) => {
        const stages = order
          .filter((s) => (b.reached[s.label] || 0) > 0)
          .map((s) => ({
            nodeLabel: s.label,
            nodeType: s.type,
            reached: b.reached[s.label] || 0,
            stuckCount: b.stuck[s.label] || 0,
            hallucinationCount: b.hallucination[s.label] || 0,
          }));
        // Drop-off between consecutive funnel stages (clamped at 0 for branchy paths).
        for (let i = 0; i < stages.length; i++) {
          const next = stages[i + 1]?.reached ?? stages[i].reached;
          const dropped = Math.max(0, stages[i].reached - next);
          (stages[i] as any).droppedAfter = i < stages.length - 1 ? dropped : 0;
          (stages[i] as any).dropPct = stages[i].reached > 0 && i < stages.length - 1
            ? Math.round((dropped / stages[i].reached) * 1000) / 10 : 0;
        }
        const completed = useEndCall ? b.completed : (stages.length ? stages[stages.length - 1].reached : 0);
        return { intention, total: b.total, completed, stages };
      })
      .sort((a, b) => b.total - a.total);

    res.json({
      intentField,
      // True only when graph labels actually align with the eval's node labels; the UI uses
      // this to caption how stage order / completion were derived.
      hasFlowGraph: useEndCall,
      capped: runs.length >= RUN_CAP,
      runWindow: runs.length,
      intentions: intentionsOut,
    });
  } catch (err) {
    console.error("[Projects] intention-node-funnel error:", (err as Error).message);
    res.status(500).json({ error: "Failed to compute intention node funnel" });
  }
});

// GET /:id/outcomes.csv?from&to — full server-side CSV export of ALL complete runs in range
// (every outcomeResult column + score/outcome/objective). Not capped, unlike the client export.
router.get("/:id/outcomes.csv", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { userId: true, name: true } });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });

    const { dateClause } = funnelDateRange(req);

    // Union of outcomeResult keys across the range → dynamic columns.
    const keyRows = await prisma.$queryRaw<Array<{ k: string }>>`
      SELECT DISTINCT k
      FROM "Run" r, LATERAL jsonb_object_keys(r."outcomeResult") AS k
      WHERE r."projectId" = ${req.params.id} AND r.status = 'COMPLETE'
        AND jsonb_typeof(r."outcomeResult") = 'object'
        ${dateClause}
      ORDER BY k
    `;
    const dynKeys = keyRows.map((r) => r.k);

    const rows = await prisma.$queryRaw<Array<{
      conv_id: string | null; dt: Date | null; call_outcome: string | null;
      score: number | null; duration: number | null; objective: string | null; outcome_result: any;
    }>>`
      SELECT
        r."conversationId" AS conv_id,
        COALESCE(r."callDate", r."createdAt") AS dt,
        r."callOutcome" AS call_outcome,
        r."overallScore" AS score,
        r."callDuration" AS duration,
        oa.verdict AS objective,
        r."outcomeResult" AS outcome_result
      FROM "Run" r
      LEFT JOIN LATERAL (
        SELECT lower(er.detail::jsonb ->> 'objectiveAchieved') AS verdict
        FROM "EvalResult" er
        JOIN "Criterion" c ON c.id = er."criterionId" AND c.type = 'LAYERED_EVALUATION'
        WHERE er."runId" = r.id
          AND er.detail IS NOT NULL
          AND er.detail ~ '^\\s*\\{'
          AND jsonb_typeof(er.detail::jsonb) = 'object'
        LIMIT 1
      ) oa ON true
      WHERE r."projectId" = ${req.params.id} AND r.status = 'COMPLETE'
        ${dateClause}
      ORDER BY COALESCE(r."callDate", r."createdAt") DESC
    `;

    const objectiveLabel = (v: string | null): string =>
      v == null ? "" : ["true", "1", "yes"].includes(v) ? "met" : ["false", "0", "no"].includes(v) ? "not met" : "n/a";
    const csvEscape = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

    const headers = ["Conv ID", "Date", "Call Outcome", "Score", "Duration (s)", "Objective", ...dynKeys];
    const lines = [headers.map(csvEscape).join(",")];
    for (const r of rows) {
      const or = (r.outcome_result && typeof r.outcome_result === "object") ? r.outcome_result : {};
      const base = [
        r.conv_id || "",
        r.dt ? new Date(r.dt).toISOString() : "",
        r.call_outcome || "",
        r.score != null ? Math.round(r.score * 100) + "%" : "",
        r.duration != null ? String(r.duration) : "",
        objectiveLabel(r.objective),
      ];
      const dyn = dynKeys.map((k) => {
        const val = or[k];
        if (val == null) return "";
        return typeof val === "object" ? JSON.stringify(val) : String(val);
      });
      lines.push([...base, ...dyn].map(String).map(csvEscape).join(","));
    }

    const safeName = (project.name || "project").replace(/[^a-zA-Z0-9]/g, "_");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}_outcomes.csv"`);
    res.send(lines.join("\n"));
  } catch (err) {
    console.error("[Projects] outcomes.csv error:", (err as Error).message);
    res.status(500).json({ error: "Failed to export outcomes CSV" });
  }
});

// ── Objective failures — breakdown of runs where Layer 4 said objective was
// not achieved, with the reasons clustered. Used by the project dashboard
// (and reused by the comparison endpoint for both sides).
// GET /:id/objective-failures?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/:id/objective-failures", async (req: AuthRequest, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { userId: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(project.userId ?? null, req)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { from, to } = req.query as { from?: string; to?: string };
    const summary = await getObjectiveFailuresForRange({ projectId: req.params.id, from, to });
    res.json(summary);
  } catch (err) {
    console.error("[Report] objective-failures error:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Report comparison: KPIs + issues, two windows side-by-side ──────────────
// POST /report/compare
// Body: { left: { projectId, from?, to? }, right: { projectId, from?, to? } }
// Returns a ComparisonReport (see reportComparison.ts).
//
// Rate-limited (evalRateLimit) because each call scans up to MAX_RUNS_PER_WINDOW
// runs per side with JSON.parse on each detail — capable of stalling the event
// loop if hammered. 60s timeout: cold-Neon connections + large windows can be
// slow, but anything past 60s is almost certainly stuck.
const COMPARE_TIMEOUT_MS = 60_000;
router.post("/report/compare", evalRateLimit, async (req: AuthRequest, res) => {
  try {
    const { left, right } = (req.body ?? {}) as {
      left?:  { projectId?: string; from?: string; to?: string };
      right?: { projectId?: string; from?: string; to?: string };
    };
    if (!left?.projectId || !right?.projectId) {
      return res.status(400).json({ error: "left.projectId and right.projectId are required" });
    }

    // Auth: caller must have access to BOTH projects.
    const [lp, rp] = await Promise.all([
      prisma.project.findUnique({ where: { id: left.projectId  }, select: { userId: true, name: true } }),
      prisma.project.findUnique({ where: { id: right.projectId }, select: { userId: true, name: true } }),
    ]);
    if (!lp) return res.status(404).json({ error: "left project not found" });
    if (!rp) return res.status(404).json({ error: "right project not found" });
    if (!await canAccess(lp.userId ?? null, req)) return res.status(403).json({ error: "Access denied to left project" });
    if (!await canAccess(rp.userId ?? null, req)) return res.status(403).json({ error: "Access denied to right project" });

    // Promise.race timeout. The compare promise keeps running after the race —
    // that's OK, it's bounded by MAX_RUNS_PER_WINDOW and will resolve eventually.
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Comparison timed out after ${COMPARE_TIMEOUT_MS / 1000}s`)),
        COMPARE_TIMEOUT_MS,
      );
    });
    try {
      const report = await Promise.race([
        compareReports(
          { projectId: left.projectId,  from: left.from,  to: left.to  },
          { projectId: right.projectId, from: right.from, to: right.to },
        ),
        timeoutPromise,
      ]);
      // Attach display names so the frontend can label sides without a second roundtrip.
      res.json({
        ...report,
        left:  { ...report.left,  projectName: lp.name },
        right: { ...report.right, projectName: rp.name },
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    const msg = (err as Error).message ?? "Unknown error";
    console.error("[Report] Compare error:", msg);
    const statusCode = msg.includes("Invalid range") ? 400 :
                       msg.includes("timed out")     ? 504 : 500;
    res.status(statusCode).json({ error: msg });
  }
});

// ── Resolution narrative — LLM-driven explanation of why an issue may have
// been resolved on one side vs the other. Bounded cost: single LLM call with
// 2-3 sample transcripts per side, no full-corpus loading.
// POST /report/compare/resolution
// Body: {
//   left:  { projectId, from?, to? },
//   right: { projectId, from?, to? },
//   issueText: string,                           // the canonical text of the issue
//   issueSource: "L4_critical"|"L3_node"|"intel_failure",
//   nodeLabel?: string,                          // optional, for L3 issues
//   leftRunIds: string[],                        // sample runs that hit the issue on left
//   rightRunIds?: string[],                      // optional — empty for "resolved" issues
// }
router.post("/report/compare/resolution", llmRateLimit, async (req: AuthRequest, res) => {
  try {
    const body = (req.body ?? {}) as {
      left?:  { projectId?: string };
      right?: { projectId?: string };
      issueText?: string;
      issueSource?: string;
      nodeLabel?: string;
      leftRunIds?: string[];
      rightRunIds?: string[];
    };
    if (!body.left?.projectId || !body.right?.projectId || !body.issueText) {
      return res.status(400).json({ error: "left.projectId, right.projectId and issueText are required" });
    }

    // Access check — same as comparison endpoint.
    const [lp, rp] = await Promise.all([
      prisma.project.findUnique({
        where: { id: body.left.projectId },
        select: { userId: true, name: true, agentSummary: true, agentStructure: true },
      }),
      prisma.project.findUnique({
        where: { id: body.right.projectId },
        select: { userId: true, name: true, agentSummary: true, agentStructure: true },
      }),
    ]);
    if (!lp || !rp) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(lp.userId ?? null, req)) return res.status(403).json({ error: "Access denied" });
    if (!await canAccess(rp.userId ?? null, req)) return res.status(403).json({ error: "Access denied" });

    // Pull up to 3 sample runs per side. We don't load full transcripts —
    // just the conversation up to ~1500 chars per side total.
    const leftIds  = (body.leftRunIds  ?? []).slice(0, 3);
    const rightIds = (body.rightRunIds ?? []).slice(0, 3);

    const [leftRuns, rightRuns] = await Promise.all([
      leftIds.length > 0
        ? prisma.run.findMany({
            where: { id: { in: leftIds }, projectId: body.left.projectId },
            select: { id: true, transcript: true, callOutcome: true },
          })
        : Promise.resolve([]),
      rightIds.length > 0
        ? prisma.run.findMany({
            where: { id: { in: rightIds }, projectId: body.right.projectId },
            select: { id: true, transcript: true, callOutcome: true },
          })
        : Promise.resolve([]),
    ]);

    function summarizeRun(run: { id: string; transcript: any; callOutcome: string | null }, maxChars: number): string {
      const tr = Array.isArray(run.transcript) ? run.transcript : [];
      const text = tr.slice(0, 12).map((t: any) => {
        if (t?.Agent) return `Agent: ${String(t.Agent).slice(0, 160)}`;
        if (t?.User)  return `User: ${String(t.User).slice(0, 120)}`;
        return "";
      }).filter(Boolean).join(" | ").slice(0, maxChars);
      return `[run ${run.id.slice(0, 8)} | outcome=${run.callOutcome ?? "?"}] ${text}`;
    }

    const leftSamples  = leftRuns.map(r => summarizeRun(r, 500)).join("\n");
    const rightSamples = rightRuns.map(r => summarizeRun(r, 500)).join("\n");

    // For agent context, we use agentSummary (which is short and human-curated).
    // We avoid sending the full agentStructure here — too big and high signal-to-noise penalty.
    const leftCtx  = (lp.agentSummary ?? "").slice(0, 600);
    const rightCtx = (rp.agentSummary ?? "").slice(0, 600);

    const sameProject = body.left.projectId === body.right.projectId;
    const status = rightRuns.length === 0 ? "resolved" : "reduced/changed";

    const prompt = `You are comparing two AI voice agent setups (or two time windows of the same setup) to explain why a specific issue appears on one side but not (or less) on the other.

ISSUE:
${body.issueText.slice(0, 500)}
${body.nodeLabel ? `Node: ${body.nodeLabel}` : ""}
Source: ${body.issueSource ?? "unknown"}
Status on right side: ${status}
Same project: ${sameProject ? "yes (likely a prompt/config change between dates)" : "no (cross-project comparison)"}

LEFT SIDE — ${lp.name}
Agent summary: ${leftCtx || "(none)"}
Sample calls where the issue occurred:
${leftSamples || "(none)"}

RIGHT SIDE — ${rp.name}
Agent summary: ${rightCtx || "(none)"}
${rightRuns.length > 0 ? `Sample calls where the issue STILL occurs (reduced):\n${rightSamples}` : "(no calls on the right exhibit this issue)"}

Write a concise explanation (3-5 sentences max) of the MOST LIKELY reason the issue is absent or reduced on the right side. Cite specific differences in agent setup, prompt instructions, or interaction patterns when visible. If the data is insufficient to say, say so plainly — do not fabricate.

Respond with JSON only:
{"explanation": "...", "confidence": "high" | "medium" | "low"}`;

    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000 });
    const completion = await openai.chat.completions.create({
      model:           "gpt-4.1-mini",
      temperature:     0.2,
      response_format: { type: "json_object" },
      messages:        [{ role: "user", content: prompt }],
      max_tokens:      400,
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch {}
    const explanation = typeof parsed.explanation === "string" ? parsed.explanation.slice(0, 1200) : "";
    const confidence  = ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium";

    // Estimate cost (input + output @ gpt-4.1-mini rates).
    const u = completion.usage;
    const costUsd = u
      ? (u.prompt_tokens / 1_000_000) * 0.4 + (u.completion_tokens / 1_000_000) * 1.6
      : 0;

    res.json({ explanation, confidence, costUsd: parseFloat(costUsd.toFixed(4)) });
  } catch (err) {
    const msg = (err as Error).message ?? "Unknown error";
    console.error("[Report] Resolution error:", msg);
    res.status(500).json({ error: msg });
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
    return res.status(400).json({ error: `Invalid projectType. Must be LIVE, HISTORY, WEBHOOK, TECH_SUPPORT, or INGEST` });
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

    // Auto-create TECH_SUPPORT_ANALYSIS criterion unless the caller already provided one
    const hasTsAnalysis = criteria?.some((c: any) => c.type === "TECH_SUPPORT_ANALYSIS");
    if ((projectType || "LIVE") === "TECH_SUPPORT" && !hasTsAnalysis) {
      await prisma.criterion.create({
        data: {
          projectId: project.id,
          key: "tech_support_analysis",
          label: "Technical Issue Analysis",
          type: "TECH_SUPPORT_ANALYSIS" as CriterionType,
          expectedValue: {},
          weight: 1.0,
        },
      });
    }

    res.status(201).json(stripSecrets(project as any));

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
  const { name, description, agentStructure, evaluationEnabled } = req.body;

  try {
    const existing = await prisma.project.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!existing) return res.status(404).json({ error: "Project not found" });
    if (!await canAccess(existing.userId ?? null, req)) return res.status(403).json({ error: "Access denied" });

    const data: any = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (typeof evaluationEnabled === "boolean") data.evaluationEnabled = evaluationEnabled;
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
    res.json(stripSecrets(project as any));
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
    res.json({ ok: true, agentName: agent.name, project: stripSecrets(updated as any) });

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
 * POST /api/projects/:id/re-evaluate-runs
 *
 * Re-evaluate a specific set of run IDs (selected by the user in the dashboard).
 * Body: { runIds: string[] }  — max 200 at once
 */
router.post("/:id/re-evaluate-runs", evalRateLimit, async (req: AuthRequest, res) => {
  const projectId = req.params.id;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } });
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (!await canAccess(p.userId, req)) return res.status(403).json({ error: "Access denied" });

  const { runIds: rawRunIds } = req.body as { runIds?: unknown[] };
  if (!Array.isArray(rawRunIds) || rawRunIds.length === 0) {
    return res.status(400).json({ error: "runIds must be a non-empty array" });
  }
  // Validate each element is a non-empty string (issues #3, #4)
  if (rawRunIds.some(id => typeof id !== "string" || id.trim() === "")) {
    return res.status(400).json({ error: "Each runId must be a non-empty string" });
  }
  // Deduplicate so the 200-limit reflects unique runs, not repeated IDs
  const runIds = [...new Set(rawRunIds as string[])];
  if (runIds.length > 200) {
    return res.status(400).json({ error: "Maximum 200 unique runs per re-evaluate request" });
  }

  try {
    // Only re-evaluate runs in a safe state — skip EVALUATING/RUNNING to avoid
    // mid-flight data corruption (issue #1)
    const [, result] = await prisma.$transaction([
      prisma.evalResult.deleteMany({
        where: { runId: { in: runIds }, run: { projectId, status: { notIn: ["EVALUATING", "RUNNING"] } } },
      }),
      prisma.run.updateMany({
        where: { id: { in: runIds }, projectId, status: { notIn: ["EVALUATING", "RUNNING"] } },
        data: { status: "PENDING", overallScore: null, evalCost: null, errorLog: null }, // issue #5: clear errorLog
      }),
    ]);

    // Trigger eval outside the transaction (known gap: crash between commit and here
    // leaves runs in PENDING — BullMQ recovery handles this in production). (issue #2)
    const runs = await prisma.run.findMany({
      where: { id: { in: runIds }, projectId, status: "PENDING" },
      select: { id: true },
    });
    for (const run of runs) {
      runEvaluationCheck(run.id).catch((err) =>
        console.error(`[ReEvaluateRuns] Failed to trigger eval for ${run.id}: ${(err as Error).message}`)
      );
    }

    // Log count only, not the full ID array, to keep audit log lean (issue #7)
    audit(req, "project.re_evaluate_runs", projectId, { resetCount: result.count, runCount: runIds.length });
    res.json({ ok: true, resetCount: result.count });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/projects/:id/rehydrate-runs
 *
 * Batch rehydrate: re-fetch fresh callLog + transcript from Hamsa for each run,
 * overwrite stale data, then trigger re-evaluation. Use this when Hamsa data
 * has been updated since the last eval (e.g. agent changes, transcript fixes)
 * — unlike /re-evaluate-runs which re-runs eval on existing local data.
 *
 * Flow:
 *   1) Synchronously claim eligible runs (set to PENDING, clear stale eval results)
 *      — this is fast and lets us return immediately.
 *   2) Respond with `acceptedRunIds` so the frontend knows which runs to poll.
 *   3) Process Hamsa fetches in the background (chunks of 4 in parallel).
 *      Each successful fetch updates the run and triggers re-evaluation.
 *      Failures mark the run as FAILED with errorLog populated.
 *
 * The synchronous response avoids edge-proxy timeouts on large batches and
 * prevents the frontend from polling runs that aren't actually being processed.
 */
router.post("/:id/rehydrate-runs", evalRateLimit, async (req: AuthRequest, res) => {
  const projectId = req.params.id;
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true, hamsaApiKey: true },
  });
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (!await canAccess(p.userId, req)) return res.status(403).json({ error: "Access denied" });

  const { runIds: rawRunIds } = req.body as { runIds?: unknown[] };
  if (!Array.isArray(rawRunIds) || rawRunIds.length === 0) {
    return res.status(400).json({ error: "runIds must be a non-empty array" });
  }
  if (rawRunIds.some(id => typeof id !== "string" || (id as string).trim() === "")) {
    return res.status(400).json({ error: "Each runId must be a non-empty string" });
  }
  const runIds = [...new Set(rawRunIds as string[])];
  if (runIds.length > 200) {
    return res.status(400).json({ error: "Maximum 200 unique runs per rehydrate request" });
  }

  try {
    // Load only runs that belong to this project AND aren't mid-flight
    const runs = await prisma.run.findMany({
      where: {
        id: { in: runIds },
        projectId,
        status: { notIn: ["EVALUATING", "RUNNING"] },
      },
      select: { id: true, hamsaCallId: true, conversationId: true, status: true },
    });

    // Partition: runs with at least one Hamsa identifier are processable.
    // Runs without identifiers cannot be rehydrated (we have no way to fetch from Hamsa).
    const eligible = runs.filter(r => r.hamsaCallId || r.conversationId);
    const skippedNoIdsCount = runs.length - eligible.length;
    const notFoundCount = runIds.length - runs.length; // not in project, or mid-flight

    if (eligible.length === 0) {
      return res.json({
        ok: true,
        acceptedRunIds: [],
        skippedNoIdsCount,
        notFoundCount,
      });
    }

    // Step 1: synchronously claim eligible runs — set to PENDING and clear stale
    // eval results. After this commits, BullMQ recovery (if it runs) would only
    // see PENDING runs with empty evalResults, which is the correct fresh state.
    // The actual Hamsa fetches happen in the background loop below.
    const eligibleIds = eligible.map(r => r.id);
    await prisma.$transaction([
      prisma.evalResult.deleteMany({ where: { runId: { in: eligibleIds } } }),
      prisma.run.updateMany({
        where: { id: { in: eligibleIds }, status: { notIn: ["EVALUATING", "RUNNING"] } },
        data: { status: "PENDING", overallScore: null, evalCost: null, errorLog: null },
      }),
    ]);

    // Step 2: respond immediately so the client doesn't time out
    audit(req, "project.rehydrate_runs", projectId, {
      requestedCount: runIds.length,
      acceptedCount: eligibleIds.length,
      skippedNoIdsCount,
      notFoundCount,
    });
    res.json({
      ok: true,
      acceptedRunIds: eligibleIds,
      skippedNoIdsCount,
      notFoundCount,
    });

    // Step 3: process Hamsa fetches in the background. Errors here cannot
    // affect the response, but they are logged and persisted to errorLog.
    const apiKey = p.hamsaApiKey || undefined;
    (async () => {
      const { fetchCallLog, fetchConversation, extractTranscriptFromConversation } = await import("../services/hamsaApi");
      const { runEvaluationCheck } = await import("../services/evaluationRunner");
      const CHUNK_SIZE = 4;
      for (let i = 0; i < eligible.length; i += CHUNK_SIZE) {
        const chunk = eligible.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (run) => {
          try {
            const logJobId = run.conversationId || run.hamsaCallId!;
            const freshCallLog = await fetchCallLog(logJobId, apiKey);

            let freshWebhookData: any;
            let freshTranscript: any[] | undefined;
            try {
              const conv = await fetchConversation(logJobId, apiKey);
              freshWebhookData = conv;
              const extracted = extractTranscriptFromConversation(conv);
              if (extracted && extracted.length > 0) freshTranscript = extracted;
            } catch {
              // Conversation fetch is non-fatal — call log may carry the transcript
            }

            const updatePayload: Record<string, any> = { callLog: freshCallLog };
            if (freshWebhookData !== undefined) updatePayload.webhookData = freshWebhookData;
            if (freshTranscript !== undefined) updatePayload.transcript = freshTranscript;

            // Update fresh data; only if the run is still PENDING (it could have been
            // re-claimed by another process). updateMany with a status filter is safe.
            await prisma.run.updateMany({
              where: { id: run.id, status: "PENDING" },
              data: updatePayload,
            });

            runEvaluationCheck(run.id).catch((err) =>
              console.error(`[RehydrateBatch] Eval trigger failed for ${run.id}: ${(err as Error).message}`)
            );
          } catch (err) {
            const msg = (err as Error).message;
            console.error(`[RehydrateBatch] Hamsa fetch failed for ${run.id}: ${msg}`);
            await prisma.run.updateMany({
              where: { id: run.id, status: "PENDING" },
              data: { status: "FAILED", errorLog: `Rehydrate failed: ${msg}` },
            }).catch(() => { /* best effort */ });
          }
        }));
      }
    })().catch((err) => {
      console.error(`[RehydrateBatch] Background loop crashed: ${(err as Error).message}`);
    });
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
 * POST /api/projects/:id/re-evaluate-errors
 *
 * Finds COMPLETE runs that have one or more eval results with quota/rate-limit
 * errors (detail contains "429" or "Evaluation error") and re-queues them.
 * These runs are COMPLETE but have partial/null scores on some criteria.
 */
router.post("/:id/re-evaluate-errors", evalRateLimit, async (req: AuthRequest, res) => {
  const projectId = req.params.id;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } });
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (!await canAccess(p.userId, req)) return res.status(403).json({ error: "Access denied" });

  try {
    // Find COMPLETE runs that have at least one eval result with an error detail
    const errorRuns = await prisma.run.findMany({
      where: {
        projectId,
        status: "COMPLETE",
        evalResults: {
          some: {
            detail: { contains: "Evaluation error" },
          },
        },
      },
      select: { id: true },
    });
    const errorRunIds = errorRuns.map((r) => r.id);

    if (errorRunIds.length === 0) {
      return res.json({ ok: true, resetCount: 0 });
    }

    await prisma.$transaction([
      prisma.evalResult.deleteMany({ where: { runId: { in: errorRunIds } } }),
      prisma.run.updateMany({
        where: { id: { in: errorRunIds } },
        data: { status: "PENDING", overallScore: null, evalCost: null },
      }),
    ]);

    for (const run of errorRuns) {
      runEvaluationCheck(run.id).catch((err) =>
        console.error(`[ReEvaluateErrors] Failed to trigger eval for ${run.id}: ${(err as Error).message}`)
      );
    }

    audit(req, "project.re_evaluate_errors", projectId, { resetCount: errorRunIds.length });
    res.json({ ok: true, resetCount: errorRunIds.length });
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

// ─── MCP Access Tokens ───────────────────────────────────────────────
// Per-project API tokens used by AI agents (via Model Context Protocol) to
// access project data. See backend/src/services/mcpTokens.ts for the auth
// model. Every token operation is project-owner-or-org-member gated via
// canAccess() — same semantics as other project write operations.
//
// Notes for security review:
//  - Raw tokens are returned exactly once on issuance and never persisted.
//  - Hashes are HMAC-SHA-256 keyed by MCP_TOKEN_PEPPER (env-required in prod).
//  - Tokens are revocable (soft-delete) and have configurable TTL.
//  - All operations are audit-logged with the issuing user's identity.
//  - Generation is rate-limited via llmRateLimit (reused — this caps token
//    issuance at the same rate as other privileged ops).

import { issueToken, revokeToken, listProjectTokens } from "../services/mcpTokens";

/**
 * GET /api/projects/:id/mcp-tokens
 * List active and recently revoked tokens for the project. Token metadata
 * only — raw values are never retrievable after issuance.
 */
router.get("/:id/mcp-tokens", async (req: AuthRequest, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    select: { userId: true },
  });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });

  const tokens = await listProjectTokens(req.params.id);
  res.json({ tokens });
});

/**
 * POST /api/projects/:id/mcp-tokens
 * Issue a new MCP token. Multiple tokens per project are supported (each
 * agent/laptop should get its own named token for clean revocation).
 *
 * Body: { name?, scope?: "read" | "read_write", ttlDays?: number | null }
 */
router.post("/:id/mcp-tokens", llmRateLimit, async (req: AuthRequest, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    select: { userId: true },
  });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });

  const { name, scope, ttlDays } = (req.body ?? {}) as {
    name?: unknown; scope?: unknown; ttlDays?: unknown;
  };

  // Validate and narrow inputs. We default rather than reject on missing values,
  // but reject obviously invalid types to keep the service layer simple.
  if (name !== undefined && name !== null && typeof name !== "string") {
    return res.status(400).json({ error: "name must be a string or null" });
  }
  if (scope !== undefined && scope !== "read" && scope !== "read_write") {
    return res.status(400).json({ error: 'scope must be "read" or "read_write"' });
  }
  if (ttlDays !== undefined && ttlDays !== null && (typeof ttlDays !== "number" || !Number.isFinite(ttlDays))) {
    return res.status(400).json({ error: "ttlDays must be a positive number or null for no expiry" });
  }

  try {
    const issued = await issueToken({
      projectId: req.params.id,
      name: (name as string | null | undefined) ?? null,
      scope: (scope as "read" | "read_write" | undefined) ?? "read",
      // null is meaningful (no expiry); undefined means "use default"
      ttlDays: ttlDays === null ? null : (ttlDays as number | undefined),
      createdByUserId: req.userId ?? null,
    });

    audit(req, "mcp_token.issue", issued.id, {
      projectId: req.params.id,
      scope: scope ?? "read",
      hasName: !!name,
      expiresAt: issued.expiresAt,
    });
    // The raw token is in this response and nowhere else. No-store prevents
    // any caching layer from holding it.
    res.set("Cache-Control", "no-store");
    res.json({
      id: issued.id,
      token: issued.rawToken,
      createdAt: issued.createdAt,
      expiresAt: issued.expiresAt,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * DELETE /api/projects/:id/mcp-tokens/:tokenId
 * Revoke (soft-delete) a single token. Idempotent — revoking a non-existent
 * or already-revoked token returns 200 with revoked: false.
 */
router.delete("/:id/mcp-tokens/:tokenId", async (req: AuthRequest, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    select: { userId: true },
  });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!await canAccess(project.userId, req)) return res.status(403).json({ error: "Access denied" });

  // Verify the token belongs to this project before allowing revocation —
  // prevents an org member from revoking another project's tokens by guessing
  // a token id (defence in depth; ids are cuids and not enumerable in practice).
  const tok = await prisma.mcpToken.findUnique({
    where: { id: req.params.tokenId },
    select: { projectId: true },
  });
  if (!tok || tok.projectId !== req.params.id) {
    return res.status(404).json({ error: "Token not found for this project" });
  }

  const result = await revokeToken(req.params.tokenId);
  audit(req, "mcp_token.revoke", req.params.tokenId, {
    projectId: req.params.id,
    alreadyRevoked: !result.revoked,
  });
  res.json({ ok: true, revoked: result.revoked });
});

export default router;
