import OpenAI from "openai";
import prisma from "../lib/prisma";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = "gpt-4.1-mini";
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
};

/** Max candidates to send to the ranking LLM in one call */
const MAX_CANDIDATES_FOR_LLM = 40;

interface SearchFilters {
  scoreMin?: number;
  scoreMax?: number;
  callOutcomes?: string[];
  callStatuses?: string[];
  keywords?: string[];
  evalIssueTypes?: string[];
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

interface SearchIssue {
  title: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  calls: Array<{
    id: string;
    conversationId: string | null;
    callDate: string | null;
    callOutcome: string | null;
    overallScore: number | null;
  }>;
}

interface SearchResult {
  issues: SearchIssue[];
  runs: Array<{
    id: string;
    conversationId: string | null;
    callDate: string | null;
    callDuration: number | null;
    callOutcome: string | null;
    overallScore: number | null;
    matchReason: string;
    transcriptPreview: string;
  }>;
  summary: string;
  totalMatched: number;
  filters: SearchFilters;
  costUsd: number;
}

/**
 * Extract a human-readable summary from an eval detail field.
 * For structured JSON details (LAYERED_EVALUATION, FLOW_PROGRESSION, etc.),
 * extracts the narrative summary instead of truncating raw JSON.
 */
function extractReadableDetail(detail: string | null, maxLen: number): string {
  if (!detail) return "";
  // Try parsing as JSON to extract a summary field
  if (detail.startsWith("{")) {
    try {
      const parsed = JSON.parse(detail);
      // Common summary fields in structured eval results
      const narrative = parsed.summary || parsed.detail || parsed.description || "";
      if (typeof narrative === "string" && narrative.length > 0) {
        return narrative.slice(0, maxLen);
      }
    } catch {
      // Not valid JSON — fall through to plain text
    }
  }
  return detail.slice(0, maxLen);
}

/**
 * Search runs using natural language. Two-step LLM process:
 * 1. Convert question → structured filters
 * 2. Fetch candidates, let LLM rank and explain matches
 */
export async function searchRuns(
  projectId: string,
  question: string,
  agentSummary: string,
): Promise<SearchResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured — cannot perform AI search");
  }

  let totalCost = 0;

  // Sanitize inputs
  const sanitizedQuestion = question.replace(/[\r\n]+/g, " ").slice(0, 500);
  const sanitizedSummary = agentSummary.replace(/[\r\n]+/g, " ").slice(0, 500);

  // ── Step 1: Question → Filters ────────────────────────────────────
  const filterResponse = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a search query parser for a voice AI agent evaluation system. Convert the user's natural language question into structured search filters. Return ONLY valid JSON.

Agent context: ${sanitizedSummary}

Available filter fields:
- scoreMin/scoreMax: overall evaluation score 0.0–1.0 (0.7 = 70%)
- callOutcomes: array of outcome strings like "stuck", "completed", "not_interested", "hangup", "interested", "booked", "followup", "callback"
- callStatuses: array like "COMPLETED", "FAILED", "NO_ANSWER", "BUSY", "VOICEMAIL"
- keywords: array of words/phrases to search for in transcripts and evaluation details (use the actual words, in the language they'd appear in the transcript — Arabic or English)
- evalIssueTypes: array of evaluation issue types: "hallucination", "stuck", "off_topic", "wrong_transition", "dead_end", "loop", "backward_jump", "skipped_node", "instruction_violated"
- dateFrom/dateTo: ISO date strings like "2026-04-01"
- limit: max results (default 20, max 50)

Example: {"keywords": ["hospital location"], "evalIssueTypes": ["hallucination"], "limit": 20}`,
      },
      { role: "user", content: sanitizedQuestion },
    ],
  });

  const filterTokens = filterResponse.usage;
  if (filterTokens) {
    const costs = MODEL_COSTS[MODEL]!;
    totalCost += (filterTokens.prompt_tokens / 1_000_000) * costs.input
      + (filterTokens.completion_tokens / 1_000_000) * costs.output;
  }

  let filters: SearchFilters;
  try {
    filters = JSON.parse(filterResponse.choices[0].message.content || "{}");
  } catch {
    filters = { keywords: [sanitizedQuestion], limit: 20 };
  }

  // Sanitize filter values
  filters.limit = Math.min(Math.max(1, filters.limit || 20), 50);
  if (filters.scoreMin != null) {
    const n = Number(filters.scoreMin);
    filters.scoreMin = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined;
  }
  if (filters.scoreMax != null) {
    const n = Number(filters.scoreMax);
    filters.scoreMax = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined;
  }

  // Normalize callOutcomes to lowercase (DB stores lowercase)
  if (filters.callOutcomes?.length) {
    filters.callOutcomes = filters.callOutcomes.map((o) => String(o).toLowerCase());
  }

  // Validate date strings — drop invalid ones
  if (filters.dateFrom && isNaN(new Date(filters.dateFrom).getTime())) {
    filters.dateFrom = undefined;
  }
  if (filters.dateTo && isNaN(new Date(filters.dateTo).getTime())) {
    filters.dateTo = undefined;
  }

  // ── Step 2: Build Prisma query ────────────────────────────────────
  const where: any = { projectId, status: "COMPLETE" };

  if (filters.scoreMin != null || filters.scoreMax != null) {
    where.overallScore = {};
    if (filters.scoreMin != null) where.overallScore.gte = filters.scoreMin;
    if (filters.scoreMax != null) where.overallScore.lte = filters.scoreMax;
  }

  if (filters.callOutcomes?.length) {
    where.callOutcome = { in: filters.callOutcomes };
  }

  if (filters.callStatuses?.length) {
    where.callStatus = { in: filters.callStatuses };
  }

  if (filters.dateFrom || filters.dateTo) {
    where.callDate = {};
    if (filters.dateFrom) where.callDate.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.callDate.lte = new Date(filters.dateTo + "T23:59:59.999Z");
  }

  // Fetch candidate runs — cast a wide net, then filter by content
  const candidateLimit = Math.min(Math.max(filters.limit * 3, 60), 200);
  const candidates = await prisma.run.findMany({
    where,
    orderBy: [
      { callDate: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
    ],
    take: candidateLimit,
    select: {
      id: true,
      conversationId: true,
      callDate: true,
      callDuration: true,
      callOutcome: true,
      callStatus: true,
      overallScore: true,
      transcript: true,
      outcomeResult: true,
      evalResults: {
        select: {
          score: true,
          passed: true,
          detail: true,
          criterion: { select: { key: true, label: true, type: true } },
        },
      },
    },
  });

  if (candidates.length === 0) {
    return {
      issues: [],
      runs: [],
      summary: "No completed runs found matching the filters.",
      totalMatched: 0,
      filters,
      costUsd: totalCost,
    };
  }

  // ── Step 3: Content filtering + LLM ranking ───────────────────────
  const candidateSummaries = candidates.map((run) => {
    const transcript = run.transcript as any[] | null;
    const transcriptText = transcript
      ?.map((t: any) => {
        if (t.Agent) return `Agent: ${(t.Agent as string).slice(0, 300)}`;
        if (t.User) return `User: ${(t.User as string).slice(0, 200)}`;
        return "";
      })
      .filter(Boolean)
      .join(" | ") || "";

    const evalSummaries = run.evalResults.map((er) => {
      const detail = extractReadableDetail(er.detail, 500);
      return `[${er.criterion?.label || er.criterion?.key}] score=${er.score} passed=${er.passed} ${detail}`;
    }).join(" /// ");

    const outcome = run.callOutcome || "unknown";
    const score = run.overallScore != null ? `${(run.overallScore * 100).toFixed(0)}%` : "N/A";

    return {
      id: run.id,
      convId: run.conversationId,
      date: run.callDate?.toISOString().split("T")[0] || "?",
      duration: run.callDuration,
      outcome,
      score,
      overallScore: run.overallScore,
      transcriptPreview: transcriptText.slice(0, 500),
      compact: `[${run.id.slice(0, 8)}] date:${run.callDate?.toISOString().split("T")[0] || "?"} outcome:${outcome} score:${score} dur:${run.callDuration || "?"}s\nTranscript: ${transcriptText.slice(0, 600)}\nEvals: ${evalSummaries.slice(0, 800)}`,
    };
  });

  // If we have keywords or evalIssueTypes, use the LLM to rank/filter
  const needsContentSearch = (filters.keywords?.length || 0) > 0
    || (filters.evalIssueTypes?.length || 0) > 0;

  if (!needsContentSearch) {
    const topResults = candidateSummaries.slice(0, filters.limit);
    return {
      issues: [],
      runs: topResults.map((r) => ({
        id: r.id,
        conversationId: r.convId,
        callDate: r.date,
        callDuration: r.duration,
        callOutcome: r.outcome,
        overallScore: r.overallScore,
        matchReason: "Matched filter criteria",
        transcriptPreview: r.transcriptPreview,
      })),
      summary: `Found ${candidates.length} calls matching the filters. Showing top ${topResults.length}.`,
      totalMatched: candidates.length,
      filters,
      costUsd: totalCost,
    };
  }

  // Cap candidates sent to LLM to avoid context window overflow
  const llmCandidates = candidateSummaries.slice(0, MAX_CANDIDATES_FOR_LLM);

  const rankResponse = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an expert analyst for voice AI call evaluations. Analyze the provided calls and identify distinct ISSUES — patterns, bugs, failures, or problems across calls.

For each issue, provide:
- title: Short issue name (e.g. "Agent stuck on national ID collection", "Out of scope question not handled")
- description: What's happening, based on transcripts, eval results, flow data, and tool calls
- severity: "critical" | "high" | "medium" | "low"
- callIndices: 0-based indices of calls exhibiting this issue

Look for:
- Where users get stuck or frustrated
- Agent hallucinations (saying things not in its instructions/knowledge)
- Going out of scope (discussing topics outside the agent's purpose)
- Flow issues (wrong transitions, dead ends, loops, backward jumps)
- Tool call failures or incorrect tool usage
- Language/gender detection errors
- Repeated patterns across multiple calls

Return JSON:
{
  "issues": [{"title":"...","description":"...","severity":"high","callIndices":[0,3,5]}],
  "summary": "2-3 sentence overview of findings"
}

Rules:
- Group similar problems into single issues (don't list the same problem per-call)
- A call can appear in multiple issues
- Order issues by severity (critical first)
- Be specific — cite what the agent said or did wrong
- Max 15 issues`,
      },
      {
        role: "user",
        content: `Question: ${sanitizedQuestion}\n\nKeywords: ${JSON.stringify(filters.keywords || [])}\nIssue types: ${JSON.stringify(filters.evalIssueTypes || [])}\n\n${llmCandidates.map((c, i) => `--- ${i} ---\n${c.compact}`).join("\n\n")}`,
      },
    ],
  });

  const rankTokens = rankResponse.usage;
  if (rankTokens) {
    const costs = MODEL_COSTS[MODEL]!;
    totalCost += (rankTokens.prompt_tokens / 1_000_000) * costs.input
      + (rankTokens.completion_tokens / 1_000_000) * costs.output;
  }

  let rankResult: {
    issues: Array<{ title: string; description: string; severity: string; callIndices: number[] }>;
    summary: string;
  };
  try {
    rankResult = JSON.parse(rankResponse.choices[0].message.content || '{"issues":[],"summary":"No results"}');
  } catch {
    rankResult = { issues: [], summary: "Failed to parse search results" };
  }

  // Detect 1-based indexing
  const allIndices = rankResult.issues.flatMap((iss) => iss.callIndices || []);
  const likely1Based = allIndices.some((i) => i === llmCandidates.length)
    || (allIndices.length > 0 && allIndices.every((i) => i >= 1) && !allIndices.includes(0));
  const indexOffset = likely1Based ? 1 : 0;

  // Map issues to real call data
  const issues: SearchIssue[] = rankResult.issues
    .filter((iss) => iss.title && iss.callIndices?.length > 0)
    .map((iss) => {
      const validIndices = [...new Set(iss.callIndices)]
        .map((i) => i - indexOffset)
        .filter((i) => i >= 0 && i < llmCandidates.length);
      return {
        title: iss.title,
        description: iss.description || "",
        severity: (["critical", "high", "medium", "low"].includes(iss.severity) ? iss.severity : "medium") as SearchIssue["severity"],
        calls: validIndices.map((i) => {
          const c = llmCandidates[i];
          return {
            id: c.id,
            conversationId: c.convId,
            callDate: c.date,
            callOutcome: c.outcome,
            overallScore: c.overallScore,
          };
        }),
      };
    });

  // Also build a flat runs list (all unique calls across all issues) for backward compatibility
  const seenRunIds = new Set<string>();
  const matchedRuns = issues.flatMap((iss) => iss.calls).filter((c) => {
    if (seenRunIds.has(c.id)) return false;
    seenRunIds.add(c.id);
    return true;
  }).map((c) => ({
    id: c.id,
    conversationId: c.conversationId,
    callDate: c.callDate,
    callDuration: null as number | null,
    callOutcome: c.callOutcome,
    overallScore: c.overallScore,
    matchReason: issues.filter((iss) => iss.calls.some((ic) => ic.id === c.id)).map((iss) => iss.title).join("; "),
    transcriptPreview: "",
  }));

  return {
    issues,
    runs: matchedRuns,
    summary: rankResult.summary,
    totalMatched: matchedRuns.length,
    filters,
    costUsd: totalCost,
  };
}
