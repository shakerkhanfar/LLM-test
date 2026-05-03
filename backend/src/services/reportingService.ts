import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

// L5 fix: explicit 60-second timeout so a hung LLM call doesn't stall the endpoint
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000 });

const GPT41_INPUT  = 2.00;
const GPT41_OUTPUT = 8.00;
function calcCost(p: number, c: number) {
  return (p / 1_000_000) * GPT41_INPUT + (c / 1_000_000) * GPT41_OUTPUT;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function n(v: bigint | number | string | null | undefined): number {
  if (v == null) return 0;
  return Number(v);
}

// ISO-week from the midpoint of a bucket — deterministic regardless of call time
function getIsoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
}

// Buckets anchored to UTC midnight so labels and DB window edges are consistent
function getWeekBuckets(weeksBack: number): Array<{ label: string; start: Date; end: Date }> {
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);
  const buckets: Array<{ label: string; start: Date; end: Date }> = [];
  for (let i = weeksBack - 1; i >= 0; i--) {
    const end = new Date(todayUTC);
    end.setUTCDate(end.getUTCDate() - i * 7);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 7);
    const mid = new Date((start.getTime() + end.getTime()) / 2);
    buckets.push({ label: `W${getIsoWeek(mid)}`, start, end });
  }
  return buckets;
}

// C3 fix: regex + round-trip ISO check catches Feb-30, etc.
function isValidDate(s: string | undefined): boolean {
  if (!s || typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

// ── Shared SQL classification fragments ───────────────────────────────────────
// These mirror classifyRun() and run entirely inside Postgres — no row loading.

/** IS drop-off: NO_ANSWER/BUSY/VOICEMAIL or FAILED with short/null duration */
const DROP_SQL = Prisma.sql`(
  "callStatus" IN ('NO_ANSWER','BUSY','VOICEMAIL')
  OR ("callStatus" = 'FAILED' AND ("callDuration" IS NULL OR "callDuration" <= 15))
)`;

/** IS escalation: not a drop-off AND outcome contains transfer/escalate/human/agent */
const ESC_SQL = Prisma.sql`(
  NOT (
    "callStatus" IN ('NO_ANSWER','BUSY','VOICEMAIL')
    OR ("callStatus" = 'FAILED' AND ("callDuration" IS NULL OR "callDuration" <= 15))
  )
  AND (
    lower(COALESCE("callOutcome", '')) LIKE '%transfer%'
    OR lower(COALESCE("callOutcome", '')) LIKE '%escalat%'
    OR lower(COALESCE("callOutcome", '')) LIKE '%human%'
    OR lower(COALESCE("callOutcome", '')) LIKE '%agent%'
  )
)`;

/** IS success: COMPLETED, not drop-off, not escalation, score >= 0.5 or null */
const SUCC_SQL = Prisma.sql`(
  "callStatus" = 'COMPLETED'
  AND NOT (
    "callStatus" IN ('NO_ANSWER','BUSY','VOICEMAIL')
    OR ("callStatus" = 'FAILED' AND ("callDuration" IS NULL OR "callDuration" <= 15))
  )
  AND NOT (
    lower(COALESCE("callOutcome", '')) LIKE '%transfer%'
    OR lower(COALESCE("callOutcome", '')) LIKE '%escalat%'
    OR lower(COALESCE("callOutcome", '')) LIKE '%human%'
    OR lower(COALESCE("callOutcome", '')) LIKE '%agent%'
  )
  AND ("overallScore" IS NULL OR "overallScore" >= 0.5)
)`;

// ── KPI Report ────────────────────────────────────────────────────────────────

export interface KpiReport {
  kpis: {
    successRate:    { current: number; trend: number[] };
    dropOffRate:    { current: number; trend: number[] };
    escalationRate: { current: number; trend: number[] };
  };
  weekLabels:   string[];
  totalRuns:    number;
  nullDateRuns: number; // runs with no callDate — included in KPIs but not in weekly trend
  doc: {
    avgDurationSec:    number | null;
    avgTurnsPerCall:   number | null;
    totalTurns:        number;
    // Matches dashboard "Pass Rate" definition: % of runs with overallScore >= 0.7
    overallPassRate:        number | null;
    overallPassRateScored:  number; // denominator (runs with a score)
    // Matches dashboard "Objective Achieved": objectiveAchieved=true in LAYERED_EVALUATION
    objectiveAchievedRate:  number | null;
    objectiveAchievedTotal: number; // denominator (runs with objectiveAchieved field)
    // Word-level quality (only meaningful when wordLabelCoverage > 0)
    genderAccuracy:    number | null;
    genderErrorRate:   number | null;
    asrAccuracy:       number | null;
    ttsAccuracy:       number | null;
    wordLabelCoverage: number;
  };
  criterionRows: Array<{
    label:    string;
    type:     string;
    passRate: number | null;
    avgScore: number | null;
    count:    number;
  }>;
}

export async function getProjectReport(projectId: string, weeksBack = 7): Promise<KpiReport> {
  const buckets     = getWeekBuckets(weeksBack);
  const windowStart = buckets[0].start;

  // ── Run 7 queries in parallel — all aggregate at DB level, no row limits ──
  const [overallRows, dayRows, critRows, labelRows, turnRows, passRateRows, objRows] = await Promise.all([

    // 1. Overall KPIs — single row, counts entire project history
    prisma.$queryRaw<Array<{
      total: bigint; dropoffs: bigint; escalations: bigint; successes: bigint;
      null_dates: bigint; avg_duration: number | null;
    }>>`
      SELECT
        COUNT(*)                                    AS total,
        COUNT(*) FILTER (WHERE "callDate" IS NULL)  AS null_dates,
        SUM(CASE WHEN ${DROP_SQL}  THEN 1 ELSE 0 END) AS dropoffs,
        SUM(CASE WHEN ${ESC_SQL}   THEN 1 ELSE 0 END) AS escalations,
        SUM(CASE WHEN ${SUCC_SQL}  THEN 1 ELSE 0 END) AS successes,
        AVG("callDuration")::double precision         AS avg_duration
      FROM "Run"
      WHERE "projectId" = ${projectId} AND status = 'COMPLETE'
    `,

    // 2. Per-day trend — returns at most ~365 rows even for 52-week windows
    prisma.$queryRaw<Array<{
      day: Date; total: bigint; dropoffs: bigint; escalations: bigint; successes: bigint;
    }>>`
      SELECT
        DATE_TRUNC('day', "callDate")                 AS day,
        COUNT(*)                                      AS total,
        SUM(CASE WHEN ${DROP_SQL}  THEN 1 ELSE 0 END) AS dropoffs,
        SUM(CASE WHEN ${ESC_SQL}   THEN 1 ELSE 0 END) AS escalations,
        SUM(CASE WHEN ${SUCC_SQL}  THEN 1 ELSE 0 END) AS successes
      FROM "Run"
      WHERE "projectId" = ${projectId}
        AND status = 'COMPLETE'
        AND "callDate" >= ${windowStart}
      GROUP BY DATE_TRUNC('day', "callDate")
      ORDER BY day
    `,

    // 3. Criterion pass rates — one row per criterion, no run data loaded
    prisma.$queryRaw<Array<{
      id: string; label: string | null; key: string; type: string;
      total: bigint; passed: bigint; avg_score: number | null;
    }>>`
      SELECT
        c.id, c.label, c.key, c.type,
        COUNT(er.id)                                        AS total,
        SUM(CASE WHEN er.passed = true THEN 1 ELSE 0 END)  AS passed,
        AVG(er.score)::double precision                     AS avg_score
      FROM "EvalResult" er
      JOIN "Criterion" c ON er."criterionId" = c.id
      JOIN "Run"       r ON er."runId"       = r.id
      WHERE r."projectId" = ${projectId} AND r.status = 'COMPLETE'
      GROUP BY c.id, c.label, c.key, c.type
      ORDER BY AVG(er.score) DESC NULLS LAST
    `,

    // 4. Word label accuracy — single row with DISTINCT run counts per error type
    prisma.$queryRaw<Array<{
      total_runs: bigint; labeled_runs: bigint;
      gender_errors: bigint; asr_errors: bigint; tts_errors: bigint;
    }>>`
      SELECT
        COUNT(DISTINCT r.id)                                                           AS total_runs,
        COUNT(DISTINCT wl."runId")                                                     AS labeled_runs,
        COUNT(DISTINCT CASE WHEN wl."labelType" = 'WRONG_GENDER'               THEN wl."runId" END) AS gender_errors,
        COUNT(DISTINCT CASE WHEN wl."labelType" IN ('ASR_ERROR', 'WRONG_WORD')  THEN wl."runId" END) AS asr_errors,
        COUNT(DISTINCT CASE WHEN wl."labelType" = 'TTS_ERROR'                  THEN wl."runId" END) AS tts_errors
      FROM "Run" r
      LEFT JOIN "WordLabel" wl ON wl."runId" = r.id
      WHERE r."projectId" = ${projectId} AND r.status = 'COMPLETE'
    `,

    // 5. Turn count via jsonb_array_length — cheap, no full JSON loaded
    prisma.$queryRaw<Array<{ total_turns: bigint | null; run_count: bigint }>>`
      SELECT
        SUM(jsonb_array_length(transcript))::bigint AS total_turns,
        COUNT(*)::bigint                            AS run_count
      FROM "Run"
      WHERE "projectId" = ${projectId}
        AND status = 'COMPLETE'
        AND transcript IS NOT NULL
        AND jsonb_typeof(transcript) = 'array'
    `.catch((err: unknown) => {
      // H6 fix: log the error so it shows up in server logs instead of silently vanishing
      console.warn("[reportingService] transcript turn aggregation failed:", err instanceof Error ? err.message : err);
      return [{ total_turns: null, run_count: BigInt(0) }];
    }),

    // 6. Overall pass rate — same definition as dashboard: % of runs with overallScore >= 0.7
    prisma.$queryRaw<Array<{ scored: bigint; passed: bigint }>>`
      SELECT
        COUNT(*) FILTER (WHERE "overallScore" IS NOT NULL) AS scored,
        COUNT(*) FILTER (WHERE "overallScore" >= 0.7)      AS passed
      FROM "Run"
      WHERE "projectId" = ${projectId} AND status = 'COMPLETE'
    `,

    // 7. Objective achieved rate — same definition as dashboard: objectiveAchieved=true
    //    in the LAYERED_EVALUATION detail JSON (EvalResult.detail is TEXT, cast to jsonb)
    prisma.$queryRaw<Array<{ obj_total: bigint; obj_achieved: bigint }>>`
      SELECT
        COUNT(*) FILTER (
          WHERE er.detail IS NOT NULL
            AND er.detail::jsonb ? 'objectiveAchieved'
        ) AS obj_total,
        COUNT(*) FILTER (
          WHERE er.detail IS NOT NULL
            AND (
              er.detail::jsonb->>'objectiveAchieved' = 'true'
              OR er.detail::jsonb->>'objectiveAchieved' = '1'
            )
        ) AS obj_achieved
      FROM "EvalResult" er
      JOIN "Criterion" c ON er."criterionId" = c.id
      JOIN "Run"       r ON er."runId"       = r.id
      WHERE r."projectId" = ${projectId}
        AND r.status = 'COMPLETE'
        AND c.type = 'LAYERED_EVALUATION'
    `.catch(() => [{ obj_total: 0n, obj_achieved: 0n }]),

  ]);

  // ── Derive overall KPIs ───────────────────────────────────────────────────
  const overall = overallRows[0] ?? { total: 0n, dropoffs: 0n, escalations: 0n, successes: 0n, null_dates: 0n, avg_duration: null };
  const total   = n(overall.total);
  const drops   = n(overall.dropoffs);
  const escs    = n(overall.escalations);
  const succs   = n(overall.successes);

  const pct = (part: number, whole: number) =>
    whole > 0 ? parseFloat(((part / whole) * 100).toFixed(1)) : 0;

  const currentSuccess    = pct(succs,  total);
  const currentDropOff    = pct(drops,  total);
  const currentEscalation = pct(escs,   total);
  const avgDurationSec    = overall.avg_duration != null ? Math.round(Number(overall.avg_duration)) : null;

  // ── Build weekly trend by assigning per-day rows to buckets ──────────────
  // dayRows has at most ~365 entries — trivial JS loop
  const successTrend:    number[] = [];
  const dropOffTrend:    number[] = [];
  const escalationTrend: number[] = [];

  for (const bucket of buckets) {
    const days = dayRows.filter(r => r.day >= bucket.start && r.day < bucket.end);
    if (days.length === 0) {
      successTrend.push(0);
      dropOffTrend.push(0);
      escalationTrend.push(0);
      continue;
    }
    let wTotal = 0, wDrop = 0, wEsc = 0, wSucc = 0;
    for (const d of days) {
      wTotal += n(d.total);
      wDrop  += n(d.dropoffs);
      wEsc   += n(d.escalations);
      wSucc  += n(d.successes);
    }
    successTrend.push(pct(wSucc, wTotal));
    dropOffTrend.push(pct(wDrop, wTotal));
    escalationTrend.push(pct(wEsc, wTotal));
  }

  // ── Criterion rows ────────────────────────────────────────────────────────
  const criterionRows = critRows.map(r => ({
    label:    r.label ?? r.key,
    type:     r.type,
    passRate: n(r.total) > 0 ? parseFloat(((n(r.passed) / n(r.total)) * 100).toFixed(1)) : null,
    avgScore: r.avg_score != null ? parseFloat((Number(r.avg_score) * 100).toFixed(1)) : null,
    count:    n(r.total),
  }));

  // ── Word label metrics ────────────────────────────────────────────────────
  const lr         = labelRows[0] ?? { total_runs: 0n, labeled_runs: 0n, gender_errors: 0n, asr_errors: 0n, tts_errors: 0n };
  const totalRuns  = n(lr.total_runs);
  const genderErr  = n(lr.gender_errors);
  const asrErr     = n(lr.asr_errors);
  const ttsErr     = n(lr.tts_errors);

  const genderErrorRate = totalRuns > 0 ? parseFloat(((genderErr / totalRuns) * 100).toFixed(2)) : null;
  const asrErrorRate    = totalRuns > 0 ? parseFloat(((asrErr    / totalRuns) * 100).toFixed(2)) : null;
  const ttsErrorRate    = totalRuns > 0 ? parseFloat(((ttsErr    / totalRuns) * 100).toFixed(2)) : null;

  // ── Turn counts ───────────────────────────────────────────────────────────
  const tr            = turnRows[0] ?? { total_turns: null, run_count: 0n };
  const totalTurns    = tr.total_turns != null ? n(tr.total_turns) : 0;
  const turnRunCount  = n(tr.run_count);
  const avgTurnsPerCall = turnRunCount > 0 ? parseFloat((totalTurns / turnRunCount).toFixed(1)) : null;

  // ── Overall pass rate (dashboard definition: overallScore >= 0.7) ─────────
  const pr             = passRateRows[0] ?? { scored: 0n, passed: 0n };
  const scoredCount    = n(pr.scored);
  const passedCount    = n(pr.passed);
  const overallPassRate = scoredCount > 0
    ? parseFloat(((passedCount / scoredCount) * 100).toFixed(1))
    : null;

  // ── Objective achieved rate (dashboard definition: objectiveAchieved=true) ─
  const or              = objRows[0] ?? { obj_total: 0n, obj_achieved: 0n };
  const objTotal        = n(or.obj_total);
  const objAchieved     = n(or.obj_achieved);
  const objectiveAchievedRate = objTotal > 0
    ? parseFloat(((objAchieved / objTotal) * 100).toFixed(1))
    : null;

  return {
    kpis: {
      successRate:    { current: currentSuccess,    trend: successTrend    },
      dropOffRate:    { current: currentDropOff,    trend: dropOffTrend    },
      escalationRate: { current: currentEscalation, trend: escalationTrend },
    },
    weekLabels:   buckets.map(b => b.label),
    totalRuns:    total,
    nullDateRuns: n(overall.null_dates),
    doc: {
      avgDurationSec,
      avgTurnsPerCall,
      totalTurns,
      overallPassRate,
      overallPassRateScored:   scoredCount,
      objectiveAchievedRate,
      objectiveAchievedTotal:  objTotal,
      genderAccuracy:    genderErrorRate != null ? parseFloat((100 - genderErrorRate).toFixed(2)) : null,
      genderErrorRate,
      asrAccuracy:       asrErrorRate   != null ? parseFloat((100 - asrErrorRate).toFixed(2)) : null,
      ttsAccuracy:       ttsErrorRate   != null ? parseFloat((100 - ttsErrorRate).toFixed(2)) : null,
      wordLabelCoverage: totalRuns > 0 ? parseFloat(((n(lr.labeled_runs) / totalRuns) * 100).toFixed(1)) : 0,
    },
    criterionRows,
  };
}

// ── Intelligence Report ───────────────────────────────────────────────────────

export interface IntelligenceReport {
  insights: {
    topIntents:  string[];
    peakWindows: string;
    patterns:    string[];
  };
  failures:        Array<{ title: string; pct?: number; detail: string }>;
  recommendations: Array<{ title: string; description: string }>;
  executiveSummary: string;
  cost:         number;
  runsAnalyzed: number;
}

// classifyRun is still needed for the small stratified sample
function classifyRun(run: { callStatus?: string | null; callOutcome?: string | null; callDuration?: number | null; overallScore?: number | null }) {
  const status  = (run.callStatus  ?? "").toUpperCase();
  const outcome = (run.callOutcome ?? "").toLowerCase();
  const dur     = run.callDuration as number | null;

  const isDropOff =
    ["NO_ANSWER", "BUSY", "VOICEMAIL"].includes(status) ||
    (status === "FAILED" && (dur == null || dur <= 15));

  const isEscalation = !isDropOff && (
    outcome.includes("transfer") || outcome.includes("escalat") ||
    outcome.includes("human")    || outcome.includes("agent")
  );

  const isSuccess = !isDropOff && !isEscalation &&
    status === "COMPLETED" &&
    (run.overallScore == null || run.overallScore >= 0.5);

  return { success: isSuccess, dropOff: isDropOff, escalation: isEscalation };
}

export async function generateIntelligenceReport(
  projectId: string,
  from?: string,
  to?: string
): Promise<IntelligenceReport> {

  const project = await prisma.project.findUnique({
    where:  { id: projectId },
    select: { agentSummary: true, name: true },
  });
  if (!project) throw new Error("Project not found");

  // Build optional date filter fragments — C3 fix: validated with round-trip ISO check
  const fromDate = isValidDate(from) ? new Date(from! + "T00:00:00Z") : null;
  const toDate   = isValidDate(to)   ? new Date(to!   + "T23:59:59Z") : null;
  // C3 fix: guard against inverted range
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error("Invalid date range: 'from' must be before 'to'");
  }

  const fromFilter = fromDate ? Prisma.sql`AND "callDate" >= ${fromDate}` : Prisma.empty;
  const toFilter   = toDate   ? Prisma.sql`AND "callDate" <= ${toDate}`   : Prisma.empty;

  // ── 1. Full-dataset aggregate stats — runs at DB level, no row limit ──────
  const [aggRows, outcomeRows] = await Promise.all([

    prisma.$queryRaw<Array<{
      total: bigint; successes: bigint; dropoffs: bigint; escalations: bigint;
      avg_duration: number | null;
      score_excellent: bigint; score_good: bigint; score_poor: bigint;
      score_failed: bigint; score_unscored: bigint;
    }>>`
      SELECT
        COUNT(*)                                     AS total,
        SUM(CASE WHEN ${SUCC_SQL} THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN ${DROP_SQL} THEN 1 ELSE 0 END) AS dropoffs,
        SUM(CASE WHEN ${ESC_SQL}  THEN 1 ELSE 0 END) AS escalations,
        AVG("callDuration")::double precision         AS avg_duration,
        SUM(CASE WHEN "overallScore" >= 0.9           THEN 1 ELSE 0 END) AS score_excellent,
        SUM(CASE WHEN "overallScore" >= 0.7 AND "overallScore" < 0.9 THEN 1 ELSE 0 END) AS score_good,
        SUM(CASE WHEN "overallScore" >= 0.5 AND "overallScore" < 0.7 THEN 1 ELSE 0 END) AS score_poor,
        SUM(CASE WHEN "overallScore" < 0.5            THEN 1 ELSE 0 END) AS score_failed,
        SUM(CASE WHEN "overallScore" IS NULL           THEN 1 ELSE 0 END) AS score_unscored
      FROM "Run"
      WHERE "projectId" = ${projectId} AND status = 'COMPLETE'
        ${fromFilter} ${toFilter}
    `,

    prisma.$queryRaw<Array<{ outcome: string | null; cnt: bigint }>>`
      SELECT "callOutcome" AS outcome, COUNT(*) AS cnt
      FROM "Run"
      WHERE "projectId" = ${projectId} AND status = 'COMPLETE'
        ${fromFilter} ${toFilter}
      GROUP BY "callOutcome"
      ORDER BY cnt DESC
      LIMIT 10
    `,
  ]);

  const agg   = aggRows[0];
  const total = n(agg?.total ?? 0n);

  if (total < 3) {
    throw new Error(`At least 3 evaluated runs required (found ${total})`);
  }

  // ── 2. Stratified sample — 50 most-recent runs per outcome bucket ─────────
  // This ensures the LLM sees a balanced view regardless of how many total runs exist.
  // Uses a single CTE with ROW_NUMBER() OVER (PARTITION BY bucket) to avoid 4 round-trips.
  type SampleRow = { id: string };
  const sampleRows = await prisma.$queryRaw<SampleRow[]>`
    WITH classified AS (
      SELECT
        id,
        CASE
          WHEN ${DROP_SQL}  THEN 'dropoff'
          WHEN ${ESC_SQL}   THEN 'escalation'
          WHEN ${SUCC_SQL}  THEN 'success'
          ELSE 'other'
        END AS bucket,
        ROW_NUMBER() OVER (
          PARTITION BY (
            CASE
              WHEN ${DROP_SQL}  THEN 'dropoff'
              WHEN ${ESC_SQL}   THEN 'escalation'
              WHEN ${SUCC_SQL}  THEN 'success'
              ELSE 'other'
            END
          )
          ORDER BY "callDate" DESC NULLS LAST
        ) AS rn
      FROM "Run"
      WHERE "projectId" = ${projectId} AND status = 'COMPLETE'
        ${fromFilter} ${toFilter}
    )
    SELECT id FROM classified WHERE rn <= 50
  `;

  const sampleIds = sampleRows.map(r => r.id);

  // Fetch eval details only for the sample (max 200 rows)
  const sampleRuns = await prisma.run.findMany({
    where: { id: { in: sampleIds } },
    select: {
      id: true,
      callStatus: true,
      callOutcome: true,
      callDuration: true,
      overallScore: true,
      callDate: true,
      evalResults: {
        select: {
          score:  true,
          passed: true,
          detail: true,
          criterion: { select: { type: true, label: true, key: true } },
        },
      },
    },
  });

  // ── 3. Extract issues from sampled eval details ───────────────────────────
  const issueMap: Map<string, number> = new Map();
  const nodeMap:  Map<string, { scores: number[]; count: number }> = new Map();
  let detailParseFailures = 0;

  for (const run of sampleRuns) {
    const layered = run.evalResults.find((er: any) => er.criterion.type === "LAYERED_EVALUATION");
    if (!layered?.detail) continue;
    try {
      const d = typeof layered.detail === "string" ? JSON.parse(layered.detail) : layered.detail;
      for (const issue of (Array.isArray(d.criticalIssues) ? d.criticalIssues : [])) {
        const text = (typeof issue === "string" ? issue : (issue?.text ?? "")).trim();
        if (text) issueMap.set(text, (issueMap.get(text) ?? 0) + 1);
      }
      for (const node of (Array.isArray(d.perNode) ? d.perNode : [])) {
        const label = ((node.nodeLabel ?? node.label ?? "")).trim() || "Unknown";
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
    .map(([t, c]) => `"${t}" (${c} of ${sampleRuns.length} sampled runs)`);

  const nodePerf = [...nodeMap.entries()]
    .map(([label, { scores, count }]) => ({
      label,
      avg:   scores.reduce((a, b) => a + b, 0) / scores.length,
      count,
    }))
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 5)
    .map(nn => `${nn.label}: avg ${(nn.avg * 10).toFixed(1)}/10 (${nn.count} sampled runs)`);

  // ── 4. Build prompt from full aggregate stats + sampled eval details ───────
  const avgDur    = agg?.avg_duration != null ? Math.round(Number(agg.avg_duration)) : null;
  const sampledN  = sampleRuns.length;
  const pct       = (p: number, w: number) => w > 0 ? ((p / w) * 100).toFixed(1) : "0";

  const scoreSection = [
    `  excellent (≥90%): ${n(agg?.score_excellent)}`,
    `  good      (70–89%): ${n(agg?.score_good)}`,
    `  poor      (50–69%): ${n(agg?.score_poor)}`,
    `  failed    (<50%): ${n(agg?.score_failed)}`,
    `  unscored: ${n(agg?.score_unscored)}`,
  ].join("\n");

  const prompt = `You are analyzing AI voice agent performance data for a customer service platform.

Agent: ${project.name ?? "Unknown"}
${project.agentSummary ? `\nAgent summary: ${project.agentSummary.slice(0, 600)}` : ""}

── FULL-DATASET STATISTICS (all ${total} calls) ──────────────────────────────
Avg duration: ${avgDur != null ? `${Math.floor(avgDur / 60)}m ${avgDur % 60}s` : "N/A"}
Success rate: ${pct(n(agg?.successes), total)}%
Drop-off rate: ${pct(n(agg?.dropoffs), total)}%
Escalation rate: ${pct(n(agg?.escalations), total)}%

Score distribution:
${scoreSection}

Outcome distribution (top 10):
${outcomeRows.map(r => `  ${r.outcome ?? "(none)"}: ${n(r.cnt)}`).join("\n")}

── SAMPLED DETAIL (${sampledN} representative calls, ≤50 per outcome bucket) ─
Top recurring issues (by frequency in sample):
${topIssues.length > 0 ? topIssues.join("\n") : "  None identified"}

Worst-performing workflow nodes (from sample):
${nodePerf.length > 0 ? nodePerf.join("\n") : "  No node data available"}
${detailParseFailures > 0 ? `\n(${detailParseFailures} sampled runs had unparseable evaluation details)` : ""}
── END DATA ──────────────────────────────────────────────────────────────────

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
- failures: 2-4 items ordered by impact; pct must be a number or null (never a string)
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

  if (response.choices[0]?.finish_reason === "length") {
    throw new Error("LLM response was truncated — reduce the dataset size or try again");
  }

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("LLM returned empty response");

  let result: any;
  try { result = JSON.parse(raw); }
  catch { throw new Error("Failed to parse LLM intelligence response"); }

  const usage = response.usage;
  const cost  = usage ? calcCost(usage.prompt_tokens, usage.completion_tokens) : 0;

  // H3/H5 fix: guard all fields — LLM may return null, wrong types, or omit keys
  const failures: Array<{ title: string; pct?: number; detail: string }> =
    Array.isArray(result.failures)
      ? result.failures
          .filter((f: any) => f && typeof f.title === "string")
          .map((f: any) => ({
            title:  String(f.title).slice(0, 120),
            detail: typeof f.detail === "string" ? f.detail.slice(0, 200) : "",
            ...(typeof f.pct === "number" ? { pct: f.pct } : {}),
          }))
      : [];

  const recommendations: Array<{ title: string; description: string }> =
    Array.isArray(result.recommendations)
      ? result.recommendations
          .filter((r: any) => r && typeof r.title === "string")
          .map((r: any) => ({
            title:       String(r.title).slice(0, 120),
            description: typeof r.description === "string" ? r.description.slice(0, 300) : "",
          }))
      : [];

  return {
    insights: {
      topIntents:  Array.isArray(result.insights?.topIntents)
        ? (result.insights.topIntents as any[]).filter(s => typeof s === "string")
        : [],
      peakWindows: typeof result.insights?.peakWindows === "string"
        ? result.insights.peakWindows
        : "Data not available",
      patterns: Array.isArray(result.insights?.patterns)
        ? (result.insights.patterns as any[]).filter(s => typeof s === "string")
        : [],
    },
    failures,
    recommendations,
    executiveSummary: typeof result.executiveSummary === "string"
      ? result.executiveSummary
      : "",
    cost,
    runsAnalyzed: total,
  };
}
