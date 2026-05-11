/**
 * Per-call inspection tools.
 *
 *   list_runs            — paginated, filterable run listing
 *   get_run_breakdown    — parsed Layer 2/3/4 eval detail (the focused one)
 *   get_run_full         — complete export bundle
 *   get_run_transcript   — just the conversation
 *   search_runs          — text search across transcripts
 *
 * Cross-project safety: every query is keyed by `projectId: ctx.projectId`.
 * Each run accessor also re-asserts `run.projectId === ctx.projectId` after
 * the lookup as defence-in-depth — protects against bugs in the WHERE clause
 * by failing closed.
 */
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { parseEvalDetail, clampLimit } from "./_helpers";
import { McpToolError, type McpToolDefinition } from "../../registry";

// ─── list_runs ────────────────────────────────────────────────────────
const listRunsInput = {
  limit: z.number().int().positive().max(100).optional()
    .describe("Max runs to return (default 25, max 100)"),
  offset: z.number().int().min(0).optional()
    .describe("Pagination offset (default 0)"),
  outcome: z.string().optional().describe("Filter by callOutcome (e.g. 'completed', 'stuck')"),
  status: z.enum(["PENDING", "RUNNING", "EVALUATING", "COMPLETE", "FAILED"]).optional(),
  minScore: z.number().min(0).max(1).optional().describe("Filter to overallScore >= this (0..1)"),
  maxScore: z.number().min(0).max(1).optional().describe("Filter to overallScore <= this (0..1)"),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
};

export const listRunsTool: McpToolDefinition<typeof listRunsInput> = {
  name: "list_runs",
  title: "List runs",
  description:
    "Paginated, filterable listing of runs in this project. Returns a compact summary per " +
    "run (id, dates, outcome, score, status). To inspect a single run in depth, call " +
    "`get_run_breakdown` with a run id.",
  scope: "read",
  inputSchema: listRunsInput,
  handler: async (ctx, input) => {
    const limit = clampLimit(input.limit, 100, 25);
    const offset = Math.max(0, Math.floor(input.offset ?? 0));

    const dateFrom = input.from ? new Date(input.from) : undefined;
    const dateTo = input.to ? new Date(input.to) : undefined;
    if (dateFrom && dateTo && dateFrom > dateTo) {
      throw new McpToolError("`from` must be earlier than or equal to `to`");
    }

    const where: any = { projectId: ctx.projectId };
    if (input.outcome) where.callOutcome = input.outcome;
    if (input.status) where.status = input.status;
    if (input.minScore !== undefined || input.maxScore !== undefined) {
      where.overallScore = {
        ...(input.minScore !== undefined ? { gte: input.minScore } : {}),
        ...(input.maxScore !== undefined ? { lte: input.maxScore } : {}),
      };
    }
    if (dateFrom || dateTo) {
      where.OR = [
        { callDate: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } },
        { callDate: null, createdAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } },
      ];
    }

    const [runs, total] = await Promise.all([
      prisma.run.findMany({
        where,
        orderBy: { callDate: "desc" },
        take: limit,
        skip: offset,
        select: {
          id: true,
          conversationId: true,
          callDate: true,
          callDuration: true,
          callOutcome: true,
          callStatus: true,
          status: true,
          overallScore: true,
        },
      }),
      prisma.run.count({ where }),
    ]);

    return {
      total,
      offset,
      limit,
      runs: runs.map(r => ({
        id: r.id,
        conversationId: r.conversationId,
        callDate: r.callDate,
        callDuration: r.callDuration,
        callOutcome: r.callOutcome,
        callStatus: r.callStatus,
        status: r.status,
        overallScore: r.overallScore,
      })),
    };
  },
};

// ─── get_run_breakdown ────────────────────────────────────────────────
const getRunBreakdownInput = {
  runId: z.string().min(1).describe("Run id from list_runs / get_top_*_issues / get_node_performance"),
};

export const getRunBreakdownTool: McpToolDefinition<typeof getRunBreakdownInput> = {
  name: "get_run_breakdown",
  title: "Run quality breakdown (Layer 2/3/4)",
  description:
    "Returns the parsed layered evaluation detail for a single run: per-node analysis, " +
    "navigation/structural issues, critical issues (agent failures), experience issues " +
    "(non-agent-fault), efficiency, and the Layer 4 summary. This is the focused, " +
    "agent-friendly view. For raw transcript and full call log, call `get_run_full` next.",
  scope: "read",
  inputSchema: getRunBreakdownInput,
  handler: async (ctx, input) => {
    const run = await prisma.run.findUnique({
      where: { id: input.runId },
      select: {
        id: true,
        projectId: true,
        conversationId: true,
        callDate: true,
        callDuration: true,
        callOutcome: true,
        callStatus: true,
        status: true,
        overallScore: true,
        outcomeResult: true,
        evalResults: {
          select: {
            criterion: { select: { key: true, label: true, type: true } },
            passed: true,
            score: true,
            detail: true,
          },
        },
      },
    });
    if (!run) throw new McpToolError("Run not found");
    // Defence in depth: even though we filter by projectId in WHERE clauses
    // elsewhere, here we use the run id directly so we MUST verify scope.
    if (run.projectId !== ctx.projectId) {
      throw new McpToolError("Run not found");
    }

    const layered = run.evalResults.find(r => r.criterion.type === "LAYERED_EVALUATION");
    const layeredDetail = parseEvalDetail(layered?.detail);

    return {
      run: {
        id: run.id,
        conversationId: run.conversationId,
        callDate: run.callDate,
        callDuration: run.callDuration,
        callOutcome: run.callOutcome,
        callStatus: run.callStatus,
        status: run.status,
        overallScore: run.overallScore,
        outcomeResult: run.outcomeResult,
      },
      layered: layeredDetail
        ? {
            qualityScore: layeredDetail.qualityScore ?? null,
            complianceScore: layeredDetail.complianceScore ?? null,
            objectiveAchieved: layeredDetail.objectiveAchieved ?? null,
            callerSentiment: layeredDetail.callerSentiment ?? null,
            summary: layeredDetail.summary ?? null,
            navigation: layeredDetail.navigation ?? null,
            perNode: Array.isArray(layeredDetail.perNode) ? layeredDetail.perNode : [],
            criticalIssues: Array.isArray(layeredDetail.criticalIssues) ? layeredDetail.criticalIssues : [],
            experienceIssues: Array.isArray(layeredDetail.experienceIssues) ? layeredDetail.experienceIssues : [],
            comments: Array.isArray(layeredDetail.comments) ? layeredDetail.comments : [],
            improvements: Array.isArray(layeredDetail.improvements) ? layeredDetail.improvements : [],
            efficiency: layeredDetail.efficiency ?? null,
          }
        : null,
      criteria: run.evalResults
        .filter(r => r.criterion.type !== "LAYERED_EVALUATION")
        .map(r => ({
          key: r.criterion.key,
          label: r.criterion.label,
          type: r.criterion.type,
          passed: r.passed,
          score: r.score,
          // detail can be plain text (LLM judge narrative) or structured JSON.
          // We pass it through as-is and let the agent decide.
          detail: r.detail,
        })),
    };
  },
};

// ─── get_run_transcript ───────────────────────────────────────────────
export const getRunTranscriptTool: McpToolDefinition<typeof getRunBreakdownInput> = {
  name: "get_run_transcript",
  title: "Run transcript",
  description:
    "Returns the raw conversation transcript for a run (lightweight). Use this when you " +
    "need the actual user/agent words but don't need eval analysis or call log.",
  scope: "read",
  inputSchema: getRunBreakdownInput,
  handler: async (ctx, input) => {
    const run = await prisma.run.findUnique({
      where: { id: input.runId },
      select: { id: true, projectId: true, transcript: true, conversationId: true, callDate: true },
    });
    if (!run || run.projectId !== ctx.projectId) {
      throw new McpToolError("Run not found");
    }
    return {
      runId: run.id,
      conversationId: run.conversationId,
      callDate: run.callDate,
      transcript: run.transcript ?? null,
    };
  },
};

// ─── get_run_full ─────────────────────────────────────────────────────
// Both heavy fields default to FALSE — the common case is "give me the
// transcript and eval results" which already returns plenty. Agents that
// genuinely need callLog or webhookData must opt in explicitly. This avoids
// blowing the 512 KiB tool result cap on routine inspection.
const getRunFullInput = {
  runId: z.string().min(1),
  includeCallLog: z.boolean().optional().default(false)
    .describe("Include the raw call log (node movements, tool calls, timestamps). Large; opt-in."),
  includeWebhookData: z.boolean().optional().default(false)
    .describe("Include full webhook payload (large, often redundant with transcript+outcome). Opt-in."),
};

export const getRunFullTool: McpToolDefinition<typeof getRunFullInput> = {
  name: "get_run_full",
  title: "Run full export",
  description:
    "Returns the complete data for one run: transcript, all eval results with detail, " +
    "and (optionally) call log + webhook data. Large response — use `get_run_breakdown` " +
    "instead when you only need parsed eval analysis.",
  scope: "read",
  inputSchema: getRunFullInput,
  handler: async (ctx, input) => {
    const run = await prisma.run.findUnique({
      where: { id: input.runId },
      select: {
        id: true,
        projectId: true,
        modelUsed: true,
        hamsaCallId: true,
        conversationId: true,
        source: true,
        callDate: true,
        callDuration: true,
        callStatus: true,
        callOutcome: true,
        outcomeResult: true,
        status: true,
        overallScore: true,
        evalCost: true,
        callLog: input.includeCallLog,
        transcript: true,
        webhookData: input.includeWebhookData,
        createdAt: true,
        evalResults: {
          select: {
            criterion: { select: { key: true, label: true, type: true } },
            passed: true,
            score: true,
            detail: true,
            metadata: true,
          },
        },
      },
    });
    if (!run || run.projectId !== ctx.projectId) {
      throw new McpToolError("Run not found");
    }
    // Note: we deliberately do NOT include `errorLog` (may contain stack
    // traces) or hamsaApiKey (not selected anyway). Project-level secrets
    // never reach this tool.
    return run;
  },
};

// ─── search_runs ──────────────────────────────────────────────────────
//
// Three search scopes, all opt-in via flags:
//   transcript      — what was actually said
//   outcome         — Hamsa-extracted summary, intent, failure_reason, etc.
//   eval            — Layer 4 summary, comments, improvements, critical/experience issues
//
// Defaults to all three so an agent can ask "find calls about X" without
// having to think about WHERE the keyword might appear. Each scope can be
// disabled when the agent wants narrower results.
const searchRunsInput = {
  query: z.string().min(2).max(200)
    .describe("Substring to look for. Case-insensitive. ILIKE pattern; agents passing % or _ get literal matches."),
  limit: z.number().int().positive().max(50).optional()
    .describe("Max results (default 10, max 50)"),
  searchTranscript: z.boolean().optional().default(true)
    .describe("Search what was said in the conversation. Default true."),
  searchOutcome: z.boolean().optional().default(true)
    .describe("Search the Hamsa outcome summary (Sunnary, failure_reason, doctor_requested, etc.). Default true."),
  searchEval: z.boolean().optional().default(true)
    .describe("Search the layered eval detail: Layer 4 summary, comments, improvements, criticalIssues, experienceIssues. Default true."),
};

export const searchRunsTool: McpToolDefinition<typeof searchRunsInput> = {
  name: "search_runs",
  title: "Search runs by transcript / outcome / eval text",
  description:
    "Finds runs whose conversation, outcome summary, OR layered evaluation analysis contains " +
    "the query. Substring match (case-insensitive). Use for hypothesis-driven investigation " +
    "such as: 'find calls flagged with a specific improvement', 'find calls where the agent " +
    "couldn't find a doctor', 'find runs mentioning a particular issue'. " +
    "Flags let you narrow which fields are searched. Drill in with `get_run_breakdown` for " +
    "the matching context.",
  scope: "read",
  inputSchema: searchRunsInput,
  handler: async (ctx, input) => {
    const limit = clampLimit(input.limit, 50, 10);
    const cleaned = input.query.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
    if (cleaned.length < 2) throw new McpToolError("Query must contain at least 2 visible characters");

    const searchTranscript = input.searchTranscript !== false;
    const searchOutcome = input.searchOutcome !== false;
    const searchEval = input.searchEval !== false;
    if (!searchTranscript && !searchOutcome && !searchEval) {
      throw new McpToolError("At least one of searchTranscript / searchOutcome / searchEval must be true");
    }

    // Escape LIKE wildcards so user `%`/`_` match literal chars, not patterns.
    const escaped = cleaned
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const pattern = `%${escaped}%`;

    // Build the WHERE OR clauses based on which scopes are enabled. We use
    // Prisma.sql template chunks so values stay parameterised.
    const orClauses: any[] = [];
    if (searchTranscript) {
      orClauses.push(Prisma.sql`r."transcript"::text ILIKE ${pattern} ESCAPE '\\'`);
    }
    if (searchOutcome) {
      orClauses.push(Prisma.sql`r."outcomeResult"::text ILIKE ${pattern} ESCAPE '\\'`);
      orClauses.push(Prisma.sql`r."callOutcome" ILIKE ${pattern} ESCAPE '\\'`);
    }
    // Eval search joins EvalResult filtered to the LAYERED_EVALUATION criterion
    // — that's the row whose detail field contains the summary/comments/issues
    // an agent typically wants to find. EXISTS keeps the join cheap and avoids
    // duplicate rows from the LEFT JOIN approach.
    if (searchEval) {
      orClauses.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "EvalResult" er
        JOIN "Criterion" c ON c.id = er."criterionId" AND c.type = 'LAYERED_EVALUATION'
        WHERE er."runId" = r.id AND er.detail ILIKE ${pattern} ESCAPE '\\'
      )`);
    }
    // Manually join the OR clauses; Prisma.join is the supported helper.
    const orSql = Prisma.join(orClauses, " OR ");

    const results = await prisma.$queryRaw<Array<{
      id: string;
      conversationId: string | null;
      callDate: Date | null;
      callOutcome: string | null;
      overallScore: number | null;
    }>>(Prisma.sql`
      SELECT r.id, r."conversationId", r."callDate", r."callOutcome", r."overallScore"
      FROM "Run" r
      WHERE r."projectId" = ${ctx.projectId}
        AND (${orSql})
      ORDER BY r."callDate" DESC NULLS LAST
      LIMIT ${limit}
    `);

    return {
      scope: { transcript: searchTranscript, outcome: searchOutcome, eval: searchEval },
      query: cleaned,
      count: results.length,
      results,
    };
  },
};
