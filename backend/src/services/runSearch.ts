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

interface SearchResult {
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
        if (t.Agent) return `Agent: ${(t.Agent as string).slice(0, 100)}`;
        if (t.User) return `User: ${(t.User as string).slice(0, 100)}`;
        return "";
      })
      .filter(Boolean)
      .join(" | ") || "";

    const evalSummaries = run.evalResults.map((er) => {
      const detail = extractReadableDetail(er.detail, 200);
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
      transcriptPreview: transcriptText.slice(0, 300),
      compact: `[${run.id.slice(0, 8)}] date:${run.callDate?.toISOString().split("T")[0] || "?"} outcome:${outcome} score:${score} dur:${run.callDuration || "?"}s\nTranscript: ${transcriptText.slice(0, 200)}\nEvals: ${evalSummaries.slice(0, 400)}`,
    };
  });

  // If we have keywords or evalIssueTypes, use the LLM to rank/filter
  const needsContentSearch = (filters.keywords?.length || 0) > 0
    || (filters.evalIssueTypes?.length || 0) > 0;

  if (!needsContentSearch) {
    const topResults = candidateSummaries.slice(0, filters.limit);
    return {
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
        content: `You are searching through voice AI call evaluations to answer a user's question. For each candidate call that matches, include it in results with a brief explanation. Return JSON: {"matches":[{"index":<0-based>,"reason":"<why>"}],"summary":"<2-3 sentences>"}. Rules: only include genuine matches, order by relevance, max ${filters.limit} matches.`,
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

  let rankResult: { matches: Array<{ index: number; reason: string }>; summary: string };
  try {
    rankResult = JSON.parse(rankResponse.choices[0].message.content || '{"matches":[],"summary":"No results"}');
  } catch {
    rankResult = { matches: [], summary: "Failed to parse search results" };
  }

  // Deduplicate and validate indices
  // Detect if LLM used 1-based indexing: if any returned index === llmCandidates.length
  // (one past the last 0-based index), they're likely all 1-based
  const likely1Based = rankResult.matches.some((m) => m.index === llmCandidates.length)
    || (rankResult.matches.length > 0 && rankResult.matches.every((m) => m.index >= 1));
  const indexOffset = likely1Based && !rankResult.matches.some((m) => m.index === 0) ? 1 : 0;

  const seenIndices = new Set<number>();
  const matchedRuns = rankResult.matches
    .filter((m) => {
      const idx = m.index - indexOffset;
      m.index = idx;
      if (idx < 0 || idx >= llmCandidates.length) return false;
      if (seenIndices.has(idx)) return false;
      seenIndices.add(idx);
      return true;
    })
    .slice(0, filters.limit)
    .map((m) => {
      const c = llmCandidates[m.index];
      return {
        id: c.id,
        conversationId: c.convId,
        callDate: c.date,
        callDuration: c.duration,
        callOutcome: c.outcome,
        overallScore: c.overallScore,
        matchReason: m.reason,
        transcriptPreview: c.transcriptPreview,
      };
    });

  return {
    runs: matchedRuns,
    summary: rankResult.summary,
    totalMatched: matchedRuns.length,
    filters,
    costUsd: totalCost,
  };
}
