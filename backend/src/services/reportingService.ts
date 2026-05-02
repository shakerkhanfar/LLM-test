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
function classifyRun(run: any): {
  success: boolean; dropOff: boolean; escalation: boolean;
} {
  const status  = (run.callStatus  || "").toUpperCase();
  const outcome = (run.callOutcome || "").toLowerCase();
  const dur     = run.callDuration as number | null;

  const isDropOff =
    ["NO_ANSWER", "BUSY", "VOICEMAIL"].includes(status) ||
    (status === "FAILED" && (dur == null || dur <= 15)) ||
    (dur != null && dur <= 15);

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
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function getWeekBuckets(weeksBack: number): Array<{
  label: string; start: Date; end: Date;
}> {
  const now = new Date();
  const buckets: Array<{ label: string; start: Date; end: Date }> = [];
  for (let i = weeksBack - 1; i >= 0; i--) {
    const end = new Date(now);
    end.setDate(end.getDate() - i * 7);
    const start = new Date(end);
    start.setDate(start.getDate() - 7);
    const { week } = getIsoWeek(end);
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
    avgDurationSec:   number | null;
    avgTurnsPerCall:  number | null;
    totalTurns:       number;
    llmPassRate:      number | null;
    latencyPassRate:  number | null;
    genderAccuracy:   number | null;
    genderErrorRate:  number | null;
    asrAccuracy:      number | null;
    ttsAccuracy:      number | null;
    wordLabelCoverage: number;     // % of runs with word labels
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
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - weeksBack * 7);

  const allRuns = await prisma.run.findMany({
    where: {
      projectId,
      status: "COMPLETE",
      callDate: { gte: windowStart },
    },
    select: {
      id: true,
      callStatus: true,
      callOutcome: true,
      callDuration: true,
      overallScore: true,
      callDate: true,
      transcript: true,
      evalResults: {
        select: {
          passed: true,
          score: true,
          criterion: { select: { label: true, key: true, type: true } },
        },
      },
      wordLabels: { select: { labelType: true } },
    },
    orderBy: { callDate: "asc" },
    take: 2000,
  });

  const buckets = getWeekBuckets(weeksBack);

  // Per-week KPIs
  const successTrend:    number[] = [];
  const dropOffTrend:    number[] = [];
  const escalationTrend: number[] = [];

  for (const bucket of buckets) {
    const weekRuns = allRuns.filter((r) => {
      const d = r.callDate ?? null;
      return d && d >= bucket.start && d < bucket.end;
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
    const n = weekRuns.length;
    successTrend.push(parseFloat(((s / n) * 100).toFixed(1)));
    dropOffTrend.push(parseFloat(((d / n) * 100).toFixed(1)));
    escalationTrend.push(parseFloat(((e / n) * 100).toFixed(1)));
  }

  // Overall KPIs
  let totalSuccess = 0, totalDrop = 0, totalEsc = 0;
  let totalDuration = 0, durationCount = 0;
  let totalTurns = 0, turnsCount = 0;
  const runsWithLabels = new Set<string>();
  const runsWithGenderError = new Set<string>();
  const runsWithAsrError    = new Set<string>();
  const runsWithTtsError    = new Set<string>();

  for (const run of allRuns) {
    const c = classifyRun(run);
    if (c.success) totalSuccess++;
    if (c.dropOff) totalDrop++;
    if (c.escalation) totalEsc++;

    if (run.callDuration != null) { totalDuration += run.callDuration; durationCount++; }

    const transcript = Array.isArray(run.transcript) ? run.transcript : [];
    const userTurns = transcript.filter((t: any) => t.User || t.user || t.role === "user").length;
    if (userTurns > 0) { totalTurns += userTurns; turnsCount++; }

    for (const wl of run.wordLabels) {
      runsWithLabels.add(run.id);
      if (wl.labelType === "WRONG_GENDER")  runsWithGenderError.add(run.id);
      if (wl.labelType === "ASR_ERROR" || wl.labelType === "WRONG_WORD") runsWithAsrError.add(run.id);
      if (wl.labelType === "TTS_ERROR")     runsWithTtsError.add(run.id);
    }
  }

  const n = allRuns.length;
  const currentSuccess    = n ? parseFloat(((totalSuccess / n) * 100).toFixed(1)) : 0;
  const currentDropOff    = n ? parseFloat(((totalDrop    / n) * 100).toFixed(1)) : 0;
  const currentEscalation = n ? parseFloat(((totalEsc     / n) * 100).toFixed(1)) : 0;

  // Criterion-level aggregation
  const critMap = new Map<string, { label: string; type: string; passed: number; total: number; scores: number[] }>();
  for (const run of allRuns) {
    for (const er of run.evalResults) {
      const key = `${er.criterion.type}::${er.criterion.label || er.criterion.key}`;
      if (!critMap.has(key)) {
        critMap.set(key, { label: er.criterion.label || er.criterion.key, type: er.criterion.type, passed: 0, total: 0, scores: [] });
      }
      const s = critMap.get(key)!;
      s.total++;
      if (er.passed === true) s.passed++;
      if (er.score != null) s.scores.push(er.score);
    }
  }

  const criterionRows = Array.from(critMap.values()).map((s) => ({
    label: s.label,
    type:  s.type,
    passRate: s.total > 0 ? parseFloat(((s.passed / s.total) * 100).toFixed(1)) : null,
    avgScore: s.scores.length > 0
      ? parseFloat(((s.scores.reduce((a, b) => a + b, 0) / s.scores.length) * 100).toFixed(1))
      : null,
    count: s.total,
  })).sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));

  // Specific rates for doc metrics
  const llmRow     = criterionRows.find((r) => r.type === "LLM_JUDGE");
  const latencyRow = criterionRows.find((r) => r.type === "LATENCY");

  const labelBase = runsWithLabels.size;
  const genderErrorRate = labelBase > 0 ? parseFloat(((runsWithGenderError.size / labelBase) * 100).toFixed(2)) : null;
  const asrErrorRate    = labelBase > 0 ? parseFloat(((runsWithAsrError.size    / labelBase) * 100).toFixed(2)) : null;
  const ttsErrorRate    = labelBase > 0 ? parseFloat(((runsWithTtsError.size    / labelBase) * 100).toFixed(2)) : null;

  return {
    kpis: {
      successRate:    { current: currentSuccess,    trend: successTrend    },
      dropOffRate:    { current: currentDropOff,    trend: dropOffTrend    },
      escalationRate: { current: currentEscalation, trend: escalationTrend },
    },
    weekLabels: buckets.map((b) => b.label),
    totalRuns: n,
    doc: {
      avgDurationSec:   durationCount > 0 ? Math.round(totalDuration / durationCount) : null,
      avgTurnsPerCall:  turnsCount    > 0 ? parseFloat((totalTurns / turnsCount).toFixed(1)) : null,
      totalTurns,
      llmPassRate:      llmRow?.passRate ?? null,
      latencyPassRate:  latencyRow?.passRate ?? null,
      genderAccuracy:   genderErrorRate != null ? parseFloat((100 - genderErrorRate).toFixed(2)) : null,
      genderErrorRate,
      asrAccuracy:      asrErrorRate    != null ? parseFloat((100 - asrErrorRate).toFixed(2)) : null,
      ttsAccuracy:      ttsErrorRate    != null ? parseFloat((100 - ttsErrorRate).toFixed(2)) : null,
      wordLabelCoverage: n > 0 ? parseFloat(((labelBase / n) * 100).toFixed(1)) : 0,
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

export async function generateIntelligenceReport(
  projectId: string,
  from?: string,
  to?: string
): Promise<IntelligenceReport> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { agentSummary: true, name: true },
  });

  const where: any = { projectId, status: "COMPLETE" };
  if (from || to) {
    where.callDate = {};
    if (from) where.callDate.gte = new Date(from + "T00:00:00Z");
    if (to)   where.callDate.lte = new Date(to   + "T23:59:59Z");
  }

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
      outcomeResult: true,
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

  // Outcome distribution
  const outcomeCounts: Record<string, number> = {};
  for (const run of runs) {
    const o = run.callOutcome || "unknown";
    outcomeCounts[o] = (outcomeCounts[o] || 0) + 1;
  }

  // Score distribution
  const scoreBuckets = { excellent: 0, good: 0, poor: 0, failed: 0 };
  let total = 0, successCount = 0, dropCount = 0, escCount = 0;
  let totalDur = 0, durCount = 0;

  for (const run of runs) {
    total++;
    const c = classifyRun(run);
    if (c.success)    successCount++;
    if (c.dropOff)    dropCount++;
    if (c.escalation) escCount++;
    if (run.callDuration) { totalDur += run.callDuration; durCount++; }

    const score = run.overallScore;
    if (score == null) { /* skip */ }
    else if (score >= 0.9) scoreBuckets.excellent++;
    else if (score >= 0.7) scoreBuckets.good++;
    else if (score >= 0.5) scoreBuckets.poor++;
    else                   scoreBuckets.failed++;
  }

  // Top issues from LAYERED_EVALUATION details
  const issueMap: Map<string, number> = new Map();
  const nodeMap:  Map<string, { scores: number[]; count: number }> = new Map();

  for (const run of runs) {
    const layered = run.evalResults.find((er: any) => er.criterion.type === "LAYERED_EVALUATION");
    if (!layered?.detail) continue;
    try {
      const d = typeof layered.detail === "string" ? JSON.parse(layered.detail) : layered.detail;
      for (const issue of (d.criticalIssues || [])) {
        const text = typeof issue === "string" ? issue : (issue.text || "");
        if (text) issueMap.set(text, (issueMap.get(text) || 0) + 1);
      }
      for (const node of (d.perNode || [])) {
        const label = node.nodeLabel || node.label || "Unknown";
        const score = node.overallNodeScore ?? node.score;
        if (score != null) {
          if (!nodeMap.has(label)) nodeMap.set(label, { scores: [], count: 0 });
          const e = nodeMap.get(label)!;
          e.scores.push(score);
          e.count++;
        }
      }
    } catch { /* skip */ }
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

  const prompt = `You are analyzing AI voice agent performance data for a customer service platform.

Agent: ${project?.name || "Unknown"}
${project?.agentSummary ? `\nAgent summary: ${project.agentSummary.slice(0, 600)}` : ""}

── DATA ──────────────────────────────────────────────────────
Calls analyzed: ${total}
Avg duration: ${avgDur != null ? `${Math.floor(avgDur / 60)}m ${avgDur % 60}s` : "N/A"}
Success rate: ${total > 0 ? ((successCount / total) * 100).toFixed(1) : 0}%
Drop-off rate: ${total > 0 ? ((dropCount / total) * 100).toFixed(1) : 0}%
Escalation rate: ${total > 0 ? ((escCount / total) * 100).toFixed(1) : 0}%

Score distribution:
  Excellent (90%+): ${scoreBuckets.excellent}
  Good (70-89%):    ${scoreBuckets.good}
  Poor (50-69%):    ${scoreBuckets.poor}
  Failed (<50%):    ${scoreBuckets.failed}

Outcome distribution: ${JSON.stringify(outcomeCounts)}

Top recurring issues (by run frequency):
${topIssues.length > 0 ? topIssues.join("\n") : "None identified"}

Worst-performing workflow nodes:
${nodePerf.length > 0 ? nodePerf.join("\n") : "No node data"}
── END DATA ──────────────────────────────────────────────────

Produce a concise operational intelligence report. Respond with JSON only:
{
  "executiveSummary": "2-3 sentences summarizing overall agent performance and most critical finding",
  "insights": {
    "topIntents": ["top 3 call types or intents that performed well, one per item"],
    "peakWindows": "peak usage description or 'Data not available'",
    "patterns": ["2-3 key behavioral patterns observed"]
  },
  "failures": [
    { "title": "short failure title", "pct": <number or null>, "detail": "one-line description" }
  ],
  "recommendations": [
    { "title": "short recommendation title", "description": "one concrete action step" }
  ]
}

Rules:
- failures: 2-4 items, ordered by impact
- recommendations: 2-4 items matching the failures
- Keep all strings under 80 chars
- Use actual % numbers where data supports it, otherwise omit pct`;

  const response = await openai.chat.completions.create({
    model:           "gpt-4.1",
    messages:        [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature:     0.2,
    max_tokens:      1500,
  });

  const finishReason = response.choices[0]?.finish_reason;
  if (finishReason === "length") throw new Error("LLM response was truncated");

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("LLM returned empty response");

  let result: any;
  try { result = JSON.parse(raw); }
  catch { throw new Error("Failed to parse LLM response"); }

  const usage = response.usage;
  const cost  = usage ? calcCost(usage.prompt_tokens, usage.completion_tokens) : 0;

  return {
    insights:         result.insights         || { topIntents: [], peakWindows: "", patterns: [] },
    failures:         result.failures         || [],
    recommendations:  result.recommendations  || [],
    executiveSummary: result.executiveSummary || "",
    cost,
    runsAnalyzed: total,
  };
}
