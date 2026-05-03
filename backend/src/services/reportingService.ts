import prisma from "../lib/prisma";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const GPT41_INPUT  = 2.00;
const GPT41_OUTPUT = 8.00;
function calcCost(p: number, c: number) {
  return (p / 1_000_000) * GPT41_INPUT + (c / 1_000_000) * GPT41_OUTPUT;
}

// ── Shared goal classifier (mirrors projectAnalyzer + frontend) ──────────────
// FIX: short-duration check now scoped to FAILED status only (not COMPLETED calls)
// A 10-second COMPLETED call is a valid short call, not a drop-off.
function classifyRun(run: any): {
  success: boolean; dropOff: boolean; escalation: boolean;
} {
  const status  = (run.callStatus  || "").toUpperCase();
  const outcome = (run.callOutcome || "").toLowerCase();
  const dur     = run.callDuration as number | null;

  const isDropOff =
    ["NO_ANSWER", "BUSY", "VOICEMAIL"].includes(status) ||
    (status === "FAILED" && (dur == null || dur <= 15));
  // Deliberately not flagging short-but-COMPLETED calls as drop-offs —
  // they may be legitimate quick resolutions.

  const isEscalation = !isDropOff && (
    outcome.includes("transfer") || outcome.includes("escalat") ||
    outcome.includes("human")    || outcome.includes("agent")
  );

  const isSuccess = !isDropOff && !isEscalation &&
    status === "COMPLETED" &&
    (run.overallScore == null || run.overallScore >= 0.5);

  return { success: isSuccess, dropOff: isDropOff, escalation: isEscalation };
}

// ── ISO-week helpers ─────────────────────────────────────────────────────────
function getIsoWeek(date: Date): { year: number; week: number } {
  // Work in UTC to avoid timezone drift
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

// FIX: bucket boundaries anchored to UTC midnight so labels and edges are consistent
// regardless of when the endpoint is called.
function getWeekBuckets(weeksBack: number): Array<{
  label: string; start: Date; end: Date;
}> {
  // Anchor to start of today (UTC midnight)
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);

  const buckets: Array<{ label: string; start: Date; end: Date }> = [];
  for (let i = weeksBack - 1; i >= 0; i--) {
    // end = start of day that is i*7 days before today
    const end = new Date(todayUTC);
    end.setUTCDate(end.getUTCDate() - i * 7);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 7);
    // Label from the midpoint of the bucket to get a stable ISO week number
    const mid = new Date((start.getTime() + end.getTime()) / 2);
    const { week } = getIsoWeek(mid);
    buckets.push({ label: `W${week}`, start, end });
  }
  return buckets;
}

// ── KPI Report ───────────────────────────────────────────────────────────────

export interface KpiReport {
  kpis: {
    successRate:    { current: number; trend: number[] };
    dropOffRate:    { current: number; trend: number[] };
    escalationRate: { current: number; trend: number[] };
  };
  weekLabels: string[];
  totalRuns: number;
  // Document metrics
  doc: {
    avgDurationSec:    number | null;
    avgTurnsPerCall:   number | null;
    totalTurns:        number;
    llmPassRate:       number | null;
    latencyPassRate:   number | null;
    genderAccuracy:    number | null;
    genderErrorRate:   number | null;
    asrAccuracy:       number | null;
    ttsAccuracy:       number | null;
    wordLabelCoverage: number; // % of runs with word labels
  };
  criterionRows: Array<{
    label: string;
    type: string;
    passRate: number | null;
    avgScore: number | null;
    count: number;
  }>;
}

export async function getProjectReport(
  projectId: string,
  weeksBack = 7
): Promise<KpiReport> {
  // FIX: align windowStart to UTC midnight and extend one extra day before the
  // first bucket so the DB query covers the full first bucket window.
  const buckets = getWeekBuckets(weeksBack);
  const windowStart = buckets[0].start;  // first bucket's start edge

  // FIX: omit `transcript` from this query — it can be megabytes per run.
  // Turn count is derived separately below with a lightweight count query.
  const allRuns = await prisma.run.findMany({
    where: {
      projectId,
      status: "COMPLETE",
      // Include runs with no callDate (callDate: null) in overall counts;
      // they just won't appear in weekly trend buckets.
      OR: [
        { callDate: { gte: windowStart } },
        { callDate: null },
      ],
    },
    select: {
      id: true,
      callStatus: true,
      callOutcome: true,
      callDuration: true,
      overallScore: true,
      callDate: true,
      evalResults: {
        select: {
          passed: true,
          score: true,
          criterion: { select: { id: true, label: true, key: true, type: true } },
        },
      },
      wordLabels: { select: { labelType: true } },
    },
    orderBy: { callDate: "asc" },
    take: 2000,
  });

  // FIX: use a separate lightweight aggregation for avg turns per call,
  // avoiding loading full transcript JSON for 2000 runs.
  // We count transcript array length via a raw aggregation if possible,
  // or fall back to skipping it (turns data is optional/nice-to-have).
  let avgTurnsPerCall: number | null = null;
  let totalTurns = 0;
  try {
    // transcript is a Json? column — jsonb_array_length gives us the count cheaply
    const turnRows = await prisma.$queryRaw<Array<{ run_id: string; turns: number }>>`
      SELECT id AS run_id,
             jsonb_array_length(transcript) AS turns
      FROM "Run"
      WHERE "projectId" = ${projectId}
        AND status = 'COMPLETE'
        AND transcript IS NOT NULL
        AND jsonb_typeof(transcript) = 'array'
        AND (
          "callDate" >= ${windowStart} OR "callDate" IS NULL
        )
      LIMIT 2000
    `;
    if (turnRows.length > 0) {
      const sum = turnRows.reduce((acc, r) => acc + Number(r.turns), 0);
      totalTurns = sum;
      avgTurnsPerCall = parseFloat((sum / turnRows.length).toFixed(1));
    }
  } catch {
    // Non-fatal — ASR/transcript data is optional
  }

  // Per-week KPIs
  const successTrend:    number[] = [];
  const dropOffTrend:    number[] = [];
  const escalationTrend: number[] = [];

  for (const bucket of buckets) {
    const weekRuns = allRuns.filter((r) => {
      const d = r.callDate;
      return d != null && d >= bucket.start && d < bucket.end;
    });
    if (weekRuns.length === 0) {
      successTrend.push(0);
      dropOffTrend.push(0);
      escalationTrend.push(0);
      continue;
    }
    let s = 0, d = 0, e = 0;
    for (const r of weekRuns) {
      const c = classifyRun(r);
      if (c.success) s++;
      if (c.dropOff) d++;
      if (c.escalation) e++;
    }
    const wn = weekRuns.length;
    successTrend.push(parseFloat(((s / wn) * 100).toFixed(1)));
    dropOffTrend.push(parseFloat(((d / wn) * 100).toFixed(1)));
    escalationTrend.push(parseFloat(((e / wn) * 100).toFixed(1)));
  }

  // Overall KPIs (all fetched runs, including those with no callDate)
  let totalSuccess = 0, totalDrop = 0, totalEsc = 0;
  let totalDuration = 0, durationCount = 0;
  const runsWithLabels      = new Set<string>();
  const runsWithGenderError = new Set<string>();
  const runsWithAsrError    = new Set<string>();
  const runsWithTtsError    = new Set<string>();

  for (const run of allRuns) {
    const c = classifyRun(run);
    if (c.success)    totalSuccess++;
    if (c.dropOff)    totalDrop++;
    if (c.escalation) totalEsc++;

    if (run.callDuration != null) { totalDuration += run.callDuration; durationCount++; }

    for (const wl of run.wordLabels) {
      runsWithLabels.add(run.id);
      if (wl.labelType === "WRONG_GENDER")                                runsWithGenderError.add(run.id);
      if (wl.labelType === "ASR_ERROR" || wl.labelType === "WRONG_WORD") runsWithAsrError.add(run.id);
      if (wl.labelType === "TTS_ERROR")                                   runsWithTtsError.add(run.id);
    }
  }

  const n = allRuns.length;
  const currentSuccess    = n ? parseFloat(((totalSuccess / n) * 100).toFixed(1)) : 0;
  const currentDropOff    = n ? parseFloat(((totalDrop    / n) * 100).toFixed(1)) : 0;
  const currentEscalation = n ? parseFloat(((totalEsc     / n) * 100).toFixed(1)) : 0;

  // FIX: key criterion map by criterion ID (not type::label) to avoid merging
  // different criteria that share the same type and label.
  const critMap = new Map<string, { label: string; type: string; passed: number; total: number; scores: number[] }>();
  for (const run of allRuns) {
    for (const er of run.evalResults) {
      const critId = er.criterion.id;
      if (!critMap.has(critId)) {
        critMap.set(critId, {
          label:  er.criterion.label || er.criterion.key,
          type:   er.criterion.type,
          passed: 0, total: 0, scores: [],
        });
      }
      const s = critMap.get(critId)!;
      s.total++;
      if (er.passed === true) s.passed++;
      if (er.score != null) s.scores.push(er.score);
    }
  }

  const criterionRows = Array.from(critMap.values()).map((s) => ({
    label:    s.label,
    type:     s.type,
    passRate: s.total > 0 ? parseFloat(((s.passed / s.total) * 100).toFixed(1)) : null,
    avgScore: s.scores.length > 0
      ? parseFloat(((s.scores.reduce((a, b) => a + b, 0) / s.scores.length) * 100).toFixed(1))
      : null,
    count: s.total,
  })).sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));

  // FIX: aggregate all LLM_JUDGE and LATENCY criteria rather than taking the first
  const llmRows     = criterionRows.filter((r) => r.type === "LLM_JUDGE");
  const latencyRows = criterionRows.filter((r) => r.type === "LATENCY");

  function avgPassRate(rows: typeof criterionRows): number | null {
    const rates = rows.map((r) => r.passRate).filter((r): r is number => r != null);
    return rates.length > 0 ? parseFloat((rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1)) : null;
  }

  // FIX: use total runs (not just labeled runs) as denominator for accuracy metrics
  // and add a coverage note. Use total runs so the metric is meaningful overall.
  const totalRunsBase = n;
  const genderErrorRate = totalRunsBase > 0 ? parseFloat(((runsWithGenderError.size / totalRunsBase) * 100).toFixed(2)) : null;
  const asrErrorRate    = totalRunsBase > 0 ? parseFloat(((runsWithAsrError.size    / totalRunsBase) * 100).toFixed(2)) : null;
  const ttsErrorRate    = totalRunsBase > 0 ? parseFloat(((runsWithTtsError.size    / totalRunsBase) * 100).toFixed(2)) : null;

  return {
    kpis: {
      successRate:    { current: currentSuccess,    trend: successTrend    },
      dropOffRate:    { current: currentDropOff,    trend: dropOffTrend    },
      escalationRate: { current: currentEscalation, trend: escalationTrend },
    },
    weekLabels: buckets.map((b) => b.label),
    totalRuns: n,
    doc: {
      avgDurationSec:    durationCount > 0 ? Math.round(totalDuration / durationCount) : null,
      avgTurnsPerCall,
      totalTurns,
      llmPassRate:       avgPassRate(llmRows),
      latencyPassRate:   avgPassRate(latencyRows),
      genderAccuracy:    genderErrorRate != null ? parseFloat((100 - genderErrorRate).toFixed(2)) : null,
      genderErrorRate,
      asrAccuracy:       asrErrorRate   != null ? parseFloat((100 - asrErrorRate).toFixed(2)) : null,
      ttsAccuracy:       ttsErrorRate   != null ? parseFloat((100 - ttsErrorRate).toFixed(2)) : null,
      wordLabelCoverage: n > 0 ? parseFloat(((runsWithLabels.size / n) * 100).toFixed(1)) : 0,
    },
    criterionRows,
  };
}

// ── Intelligence Report ──────────────────────────────────────────────────────

export interface IntelligenceReport {
  insights: {
    topIntents:  string[];
    peakWindows: string;
    patterns:    string[];
  };
  failures: Array<{ title: string; pct?: number; detail: string }>;
  recommendations: Array<{ title: string; description: string }>;
  executiveSummary: string;
  cost: number;
  runsAnalyzed: number;
}

// FIX: validate date strings before use
function isValidDate(s: string | undefined): boolean {
  if (!s || typeof s !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
}

export async function generateIntelligenceReport(
  projectId: string,
  from?: string,
  to?: string
): Promise<IntelligenceReport> {
  // FIX: single project query — route passes projectId, we fetch name+summary here
  // but avoid a second round-trip by accepting projectName/agentSummary as optional params.
  // For now: one query here, route handler passes only projectId.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { agentSummary: true, name: true },
  });
  if (!project) throw new Error("Project not found");

  // FIX: validate from/to before constructing Date objects
  const where: any = { projectId, status: "COMPLETE" };
  if (isValidDate(from) || isValidDate(to)) {
    where.callDate = {};
    if (isValidDate(from)) where.callDate.gte = new Date(from! + "T00:00:00Z");
    if (isValidDate(to))   where.callDate.lte = new Date(to!   + "T23:59:59Z");
  }

  // FIX: remove `outcomeResult` (large Json? column, never used in prompt)
  // Add `transcript` count via separate lightweight aggregation below
  const runs = await prisma.run.findMany({
    where,
    orderBy: { callDate: "desc" },
    take: 200,
    select: {
      id: true,
      callStatus: true,
      callOutcome: true,
      callDuration: true,
      overallScore: true,
      callDate: true,
      evalResults: {
        select: {
          score: true,
          passed: true,
          detail: true,
          criterion: { select: { type: true, label: true, key: true } },
        },
      },
    },
  });

  if (runs.length < 3) {
    throw new Error(`At least 3 evaluated runs required (found ${runs.length})`);
  }

  // ── Aggregate for prompt ─────────────────────────────────────────

  const outcomeCounts: Record<string, number> = {};
  const scoreBuckets = { excellent: 0, good: 0, poor: 0, failed: 0, unscored: 0 };
  let total = 0, successCount = 0, dropCount = 0, escCount = 0;
  let totalDur = 0, durCount = 0;

  for (const run of runs) {
    total++;
    const c = classifyRun(run);
    if (c.success)    successCount++;
    if (c.dropOff)    dropCount++;
    if (c.escalation) escCount++;
    if (run.callDuration) { totalDur += run.callDuration; durCount++; }

    const o = run.callOutcome || "unknown";
    outcomeCounts[o] = (outcomeCounts[o] || 0) + 1;

    const score = run.overallScore;
    if (score == null)       scoreBuckets.unscored++;
    else if (score >= 0.9)   scoreBuckets.excellent++;
    else if (score >= 0.7)   scoreBuckets.good++;
    else if (score >= 0.5)   scoreBuckets.poor++;
    else                     scoreBuckets.failed++;
  }

  // Top issues from LAYERED_EVALUATION details
  const issueMap: Map<string, number> = new Map();
  const nodeMap:  Map<string, { scores: number[]; count: number }> = new Map();
  let detailParseFailures = 0;

  for (const run of runs) {
    const layered = run.evalResults.find((er: any) => er.criterion.type === "LAYERED_EVALUATION");
    if (!layered?.detail) continue;
    try {
      const d = typeof layered.detail === "string" ? JSON.parse(layered.detail) : layered.detail;
      for (const issue of (d.criticalIssues || [])) {
        const text = (typeof issue === "string" ? issue : (issue.text || "")).trim();
        if (text) issueMap.set(text, (issueMap.get(text) || 0) + 1);
      }
      for (const node of (d.perNode || [])) {
        const label = (node.nodeLabel || node.label || "Unknown").trim();
        const score = node.overallNodeScore ?? node.score;
        if (score != null && label) {
          if (!nodeMap.has(label)) nodeMap.set(label, { scores: [], count: 0 });
          const e = nodeMap.get(label)!;
          e.scores.push(score);
          e.count++;
        }
      }
    } catch {
      detailParseFailures++;
    }
  }

  const topIssues = [...issueMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t, c]) => `"${t}" (${c} runs)`);

  const nodePerf = [...nodeMap.entries()]
    .map(([label, { scores, count }]) => ({
      label,
      avg: scores.reduce((a, b) => a + b, 0) / scores.length,
      count,
    }))
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 5)
    .map((n) => `${n.label}: avg ${(n.avg * 10).toFixed(1)}/10 (${n.count} runs)`);

  const avgDur = durCount > 0 ? Math.round(totalDur / durCount) : null;

  const scoreSection = Object.entries(scoreBuckets)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  const prompt = `You are analyzing AI voice agent performance data for a customer service platform.

Agent: ${project.name || "Unknown"}
${project.agentSummary ? `\nAgent summary: ${project.agentSummary.slice(0, 600)}` : ""}

── DATA ──────────────────────────────────────────────────────
Calls analyzed: ${total}
Avg duration: ${avgDur != null ? `${Math.floor(avgDur / 60)}m ${avgDur % 60}s` : "N/A"}
Success rate: ${total > 0 ? ((successCount / total) * 100).toFixed(1) : 0}%
Drop-off rate: ${total > 0 ? ((dropCount / total) * 100).toFixed(1) : 0}%
Escalation rate: ${total > 0 ? ((escCount / total) * 100).toFixed(1) : 0}%

Score distribution (${scoreBuckets.unscored} unscored):
${scoreSection}

Outcome distribution (top 10):
${Object.entries(outcomeCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `  ${k}: ${v}`).join("\n")}

Top recurring issues (by run frequency):
${topIssues.length > 0 ? topIssues.join("\n") : "  None identified"}

Worst-performing workflow nodes:
${nodePerf.length > 0 ? nodePerf.join("\n") : "  No node data available"}
${detailParseFailures > 0 ? `\n(Note: ${detailParseFailures} runs had unparseable evaluation details)` : ""}
── END DATA ──────────────────────────────────────────────────

Produce a concise operational intelligence report. Respond with JSON only:
{
  "executiveSummary": "2-3 sentences summarizing overall agent performance and most critical finding",
  "insights": {
    "topIntents": ["top 3 successful call types based on outcome distribution, one per item"],
    "peakWindows": "Data not available (no time-of-day data in this analysis)",
    "patterns": ["2-3 key behavioral patterns observed from outcomes and issues"]
  },
  "failures": [
    { "title": "short failure title", "pct": <number or null>, "detail": "one-line description" }
  ],
  "recommendations": [
    { "title": "short recommendation title", "description": "one concrete action step" }
  ]
}

Rules:
- failures: 2-4 items ordered by impact; omit pct if no reliable % available
- recommendations: 2-4 items, one per failure
- All strings under 80 chars
- Base all claims on the data above; do not fabricate metrics`;

  const response = await openai.chat.completions.create({
    model:           "gpt-4.1",
    messages:        [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature:     0.2,
    max_tokens:      1500,
  });

  const finishReason = response.choices[0]?.finish_reason;
  if (finishReason === "length") throw new Error("LLM response was truncated — too many issues to summarize");

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("LLM returned empty response");

  let result: any;
  try { result = JSON.parse(raw); }
  catch { throw new Error("Failed to parse LLM intelligence response"); }

  const usage = response.usage;
  const cost  = usage ? calcCost(usage.prompt_tokens, usage.completion_tokens) : 0;

  // Ensure all arrays are present (guard against LLM omitting fields)
  return {
    insights: {
      topIntents:  Array.isArray(result.insights?.topIntents)  ? result.insights.topIntents  : [],
      peakWindows: typeof result.insights?.peakWindows === "string" ? result.insights.peakWindows : "Data not available",
      patterns:    Array.isArray(result.insights?.patterns)    ? result.insights.patterns    : [],
    },
    failures:         Array.isArray(result.failures)        ? result.failures        : [],
    recommendations:  Array.isArray(result.recommendations) ? result.recommendations : [],
    executiveSummary: typeof result.executiveSummary === "string" ? result.executiveSummary : "",
    cost,
    runsAnalyzed: total,
  };
}
