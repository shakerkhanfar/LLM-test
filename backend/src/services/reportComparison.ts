/**
 * Report comparison service — produces a side-by-side comparison of two
 * "report windows". A window is (projectId, optional from-date, optional to-date).
 *
 * The two windows can be:
 *   - same project / different date ranges     (e.g. last 7 days vs the 7 before)
 *   - different projects / no dates             (cross-project apples-to-apples)
 *   - different projects / different ranges     (broader still)
 *
 * Two main concerns:
 *   1. KPIs over the window: success / drop-off / escalation rates, avg duration,
 *      pass rate. Mirrors getProjectReport's definitions (DB-level aggregation —
 *      no run-loading).
 *   2. Issues over the window: surfaces L4 critical issues, L3 per-node findings,
 *      and (optionally) LLM-clustered failures. Each issue carries the run IDs
 *      and conversation IDs that exhibited it, so the UI can deep-link.
 *
 * Cross-side diffing: after both sides are gathered, issues are normalized to a
 * canonical text key and bucketed into onlyOnLeft / onlyOnRight / shared.
 * Exact-text matching after whitespace+punctuation normalization. We do NOT
 * use embeddings here — that's a separate cost we'd want to add later if
 * fuzzy clustering matters for the user.
 */
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

// ── Shared SQL classification fragments (same as reportingService) ───────────

const DROP_SQL = Prisma.sql`(
  "callStatus" IN ('NO_ANSWER','BUSY','VOICEMAIL')
  OR ("callStatus" = 'FAILED' AND ("callDuration" IS NULL OR "callDuration" <= 15))
)`;

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

const n = (v: bigint | number | string | null | undefined): number =>
  v == null ? 0 : Number(v);

// Round-trip ISO validator — rejects garbage and "Feb 30"-style strings.
function isValidIsoDate(s: string | null | undefined): s is string {
  if (!s || typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

// ── KPI snapshot for an arbitrary date window ────────────────────────────────

export interface KpiSnapshot {
  totalRuns: number;
  successRate: number;       // % 0..100
  dropOffRate: number;
  escalationRate: number;
  avgDurationSec: number | null;
  overallPassRate: number | null;     // %, runs with score >= 0.7 / scored runs
  overallPassRateScored: number;
  objectiveAchievedRate: number | null; // % of LAYERED runs where objectiveAchieved=true
  objectiveAchievedTotal: number;
  avgTurnsPerCall: number | null;
}

export interface WindowSpec {
  projectId: string;
  from?: string; // ISO date "YYYY-MM-DD"
  to?: string;
}

/**
 * Compute KPIs for one window. Date filter applied at SQL level so we don't
 * load rows. Returns nulls where denominators are zero rather than fake 0s —
 * a comparison view distinguishes "no data" from "0%".
 */
export async function getKpisForRange(spec: WindowSpec): Promise<KpiSnapshot> {
  const fromDate = isValidIsoDate(spec.from) ? new Date(spec.from + "T00:00:00Z") : null;
  const toDate   = isValidIsoDate(spec.to)   ? new Date(spec.to   + "T23:59:59.999Z") : null;
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error(`Invalid range for project ${spec.projectId}: 'from' is after 'to'`);
  }

  const fromFilter = fromDate ? Prisma.sql`AND "callDate" >= ${fromDate}` : Prisma.empty;
  const toFilter   = toDate   ? Prisma.sql`AND "callDate" <= ${toDate}`   : Prisma.empty;

  // Single query — all aggregates in one row.
  const [overall] = await prisma.$queryRaw<Array<{
    total: bigint;
    dropoffs: bigint;
    escalations: bigint;
    successes: bigint;
    avg_duration: number | null;
    scored: bigint;
    pass_score: bigint;
  }>>`
    SELECT
      COUNT(*)                                                      AS total,
      SUM(CASE WHEN ${DROP_SQL}  THEN 1 ELSE 0 END)                 AS dropoffs,
      SUM(CASE WHEN ${ESC_SQL}   THEN 1 ELSE 0 END)                 AS escalations,
      SUM(CASE WHEN ${SUCC_SQL}  THEN 1 ELSE 0 END)                 AS successes,
      AVG("callDuration")::double precision                          AS avg_duration,
      COUNT(*) FILTER (WHERE "overallScore" IS NOT NULL)             AS scored,
      COUNT(*) FILTER (WHERE "overallScore" >= 0.7)                  AS pass_score
    FROM "Run"
    WHERE "projectId" = ${spec.projectId}
      AND status = 'COMPLETE'
      ${fromFilter} ${toFilter}
  `;

  const total = n(overall?.total);
  const pct = (part: number, whole: number) =>
    whole > 0 ? parseFloat(((part / whole) * 100).toFixed(1)) : 0;

  // Objective-achieved (Layer 4) — separate join.
  const [obj] = await prisma.$queryRaw<Array<{ obj_total: bigint; obj_achieved: bigint }>>`
    SELECT
      COUNT(*) FILTER (WHERE er.detail IS NOT NULL AND er.detail::jsonb ? 'objectiveAchieved') AS obj_total,
      COUNT(*) FILTER (WHERE er.detail IS NOT NULL AND lower(er.detail::jsonb->>'objectiveAchieved') IN ('true','1','yes')) AS obj_achieved
    FROM "EvalResult" er
    JOIN "Criterion" c ON er."criterionId" = c.id
    JOIN "Run"       r ON er."runId"       = r.id
    WHERE r."projectId" = ${spec.projectId}
      AND r.status = 'COMPLETE'
      AND c.type   = 'LAYERED_EVALUATION'
      ${fromFilter ? Prisma.sql`AND r."callDate" >= ${fromDate}` : Prisma.empty}
      ${toFilter   ? Prisma.sql`AND r."callDate" <= ${toDate}`   : Prisma.empty}
  `.catch(() => [{ obj_total: 0n, obj_achieved: 0n }] as Array<{ obj_total: bigint; obj_achieved: bigint }>);

  // Avg turns per call.
  const [turns] = await prisma.$queryRaw<Array<{ total_turns: bigint | null; run_count: bigint }>>`
    SELECT
      SUM(jsonb_array_length(transcript))::bigint AS total_turns,
      COUNT(*)::bigint                            AS run_count
    FROM "Run"
    WHERE "projectId" = ${spec.projectId}
      AND status = 'COMPLETE'
      AND transcript IS NOT NULL
      AND jsonb_typeof(transcript) = 'array'
      ${fromFilter} ${toFilter}
  `.catch(() => [{ total_turns: null, run_count: 0n }] as Array<{ total_turns: bigint | null; run_count: bigint }>);

  const objTotal    = n(obj?.obj_total);
  const objAchieved = n(obj?.obj_achieved);
  const scored      = n(overall?.scored);
  const passed      = n(overall?.pass_score);
  const totalTurns  = turns?.total_turns != null ? n(turns.total_turns) : 0;
  const turnRuns    = n(turns?.run_count);

  return {
    totalRuns:             total,
    successRate:           pct(n(overall?.successes),  total),
    dropOffRate:           pct(n(overall?.dropoffs),   total),
    escalationRate:        pct(n(overall?.escalations), total),
    avgDurationSec:        overall?.avg_duration != null ? Math.round(Number(overall.avg_duration)) : null,
    overallPassRate:       scored > 0 ? pct(passed, scored) : null,
    overallPassRateScored: scored,
    objectiveAchievedRate: objTotal > 0 ? pct(objAchieved, objTotal) : null,
    objectiveAchievedTotal: objTotal,
    avgTurnsPerCall:       turnRuns > 0 ? parseFloat((totalTurns / turnRuns).toFixed(1)) : null,
  };
}

// ── Issues with call IDs ─────────────────────────────────────────────────────

export type IssueSource = "L4_critical" | "L3_node" | "intel_failure";

export interface IssueOccurrence {
  runId: string;
  conversationId: string | null;
  callDate: string | null;
  callOutcome: string | null;
}

export interface Issue {
  /** Canonical issue text (raw, untruncated). */
  text: string;
  /** Where this issue was extracted from. */
  source: IssueSource;
  /** Optional severity, when the source provides one. */
  severity?: "critical" | "high" | "medium" | "low";
  /** For L3_node issues — which node the finding came from. */
  nodeLabel?: string;
  count: number;
  /** Per-occurrence run pointers, capped at MAX_OCCURRENCES_PER_ISSUE. */
  occurrences: IssueOccurrence[];
  /** Total run count where this issue appeared (may exceed occurrences.length when capped). */
  occurrencesTruncated: boolean;
  firstSeen: string | null;
  lastSeen: string | null;
}

const MAX_OCCURRENCES_PER_ISSUE = 50;

// Normalize text for cross-side issue matching. Keeps content but strips
// formatting noise so "Agent stuck on ID." and "Agent stuck on ID" map to
// the same key.
function normalizeIssueKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")  // strip punctuation (Unicode-aware)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Pull all COMPLETE runs in the window with their layered eval detail and
 * walk the JSON to extract criticalIssues + per-node findings. Returns
 * one Issue row per unique normalized text, with the runs that hit it.
 */
export async function getIssuesForRange(spec: WindowSpec): Promise<Issue[]> {
  const fromDate = isValidIsoDate(spec.from) ? new Date(spec.from + "T00:00:00Z") : null;
  const toDate   = isValidIsoDate(spec.to)   ? new Date(spec.to   + "T23:59:59.999Z") : null;

  // Pull runs with their LAYERED_EVALUATION detail.
  // We need: run id, conversationId, callDate, callOutcome, and the eval JSON.
  const runs = await prisma.run.findMany({
    where: {
      projectId: spec.projectId,
      status: "COMPLETE",
      ...(fromDate || toDate
        ? { callDate: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } }
        : {}),
    },
    orderBy: { callDate: "asc" },
    select: {
      id: true,
      conversationId: true,
      callDate: true,
      callOutcome: true,
      evalResults: {
        where: { criterion: { type: "LAYERED_EVALUATION" } },
        select: { detail: true },
      },
    },
  });

  // Bucket by normalized text. Same text from different sources gets separate
  // entries so the UI can distinguish ("Agent stuck" from L4 vs from L3 has
  // different signal value).
  type Bucket = {
    key: string;
    text: string;
    source: IssueSource;
    severity?: Issue["severity"];
    nodeLabel?: string;
    occurrences: IssueOccurrence[];
    totalCount: number;
  };
  const buckets = new Map<string, Bucket>();

  function addOccurrence(
    text: string,
    source: IssueSource,
    occ: IssueOccurrence,
    extras: { severity?: Issue["severity"]; nodeLabel?: string } = {},
  ) {
    const cleanText = text.trim().slice(0, 500);
    if (!cleanText) return;
    const norm = normalizeIssueKey(cleanText);
    if (!norm) return;
    // Source is part of the key so the same text from different layers stays separate.
    const fullKey = `${source}::${extras.nodeLabel ?? ""}::${norm}`;
    let b = buckets.get(fullKey);
    if (!b) {
      b = { key: fullKey, text: cleanText, source, severity: extras.severity, nodeLabel: extras.nodeLabel, occurrences: [], totalCount: 0 };
      buckets.set(fullKey, b);
    }
    b.totalCount++;
    if (b.occurrences.length < MAX_OCCURRENCES_PER_ISSUE) b.occurrences.push(occ);
  }

  for (const run of runs) {
    const occ: IssueOccurrence = {
      runId: run.id,
      conversationId: run.conversationId,
      callDate: run.callDate?.toISOString() ?? null,
      callOutcome: run.callOutcome,
    };
    const detailStr = run.evalResults[0]?.detail;
    if (!detailStr) continue;
    let parsed: any;
    try { parsed = typeof detailStr === "string" ? JSON.parse(detailStr) : detailStr; } catch { continue; }

    // (1) Layer 4 criticalIssues — array of strings OR { text, severity? } objects.
    if (Array.isArray(parsed.criticalIssues)) {
      for (const item of parsed.criticalIssues) {
        if (typeof item === "string") {
          addOccurrence(item, "L4_critical", occ);
        } else if (item && typeof item === "object" && typeof item.text === "string") {
          const sev = ["critical", "high", "medium", "low"].includes(item.severity) ? item.severity : undefined;
          addOccurrence(item.text, "L4_critical", occ, { severity: sev });
        }
      }
    }

    // (2) Layer 3 per-node findings — hallucination/stuck/off-topic flags.
    if (Array.isArray(parsed.perNode)) {
      for (const node of parsed.perNode) {
        const nodeLabel = String(node?.nodeLabel ?? node?.label ?? "Unknown").slice(0, 80);
        if (node?.hallucination?.detected) {
          const ev = String(node.hallucination.evidence ?? "Hallucination detected").slice(0, 300);
          addOccurrence(`[${nodeLabel}] Hallucination: ${ev}`, "L3_node", occ, { nodeLabel });
        }
        if (node?.stuck?.detected) {
          const why = String(node.stuck.reasoning ?? "Agent got stuck").slice(0, 300);
          addOccurrence(`[${nodeLabel}] Stuck: ${why}`, "L3_node", occ, { nodeLabel });
        }
        if (node?.offTopic?.detected) {
          const topics = Array.isArray(node.offTopic.topics) ? node.offTopic.topics.slice(0, 3).join(", ") : "(unspecified)";
          addOccurrence(`[${nodeLabel}] Off-topic: ${topics}`, "L3_node", occ, { nodeLabel });
        }
      }
    }
  }

  // Convert buckets to Issue[]. Compute firstSeen / lastSeen from occurrences.
  const issues: Issue[] = [];
  for (const b of buckets.values()) {
    const datesIso = b.occurrences.map(o => o.callDate).filter((d): d is string => !!d).sort();
    issues.push({
      text: b.text,
      source: b.source,
      severity: b.severity,
      nodeLabel: b.nodeLabel,
      count: b.totalCount,
      occurrences: b.occurrences,
      occurrencesTruncated: b.totalCount > b.occurrences.length,
      firstSeen: datesIso[0] ?? null,
      lastSeen:  datesIso[datesIso.length - 1] ?? null,
    });
  }
  // Sort by count desc, then by recency.
  issues.sort((a, b) => b.count - a.count || (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""));
  return issues;
}

// ── Compare two windows ──────────────────────────────────────────────────────

export interface IssueComparisonEntry {
  text: string;
  source: IssueSource;
  severity?: Issue["severity"];
  nodeLabel?: string;
  leftCount: number;
  rightCount: number;
  leftOccurrences: IssueOccurrence[];
  rightOccurrences: IssueOccurrence[];
  /** Derived status — how the issue evolved from left → right. */
  status: "only_left" | "only_right" | "resolved" | "reduced" | "worsened" | "unchanged";
}

export interface ComparisonReport {
  left:  { window: WindowSpec; kpis: KpiSnapshot; issues: Issue[] };
  right: { window: WindowSpec; kpis: KpiSnapshot; issues: Issue[] };
  deltas: {
    /** absolute change (right - left), positive = increased on right */
    successRate: number | null;
    dropOffRate: number | null;
    escalationRate: number | null;
    overallPassRate: number | null;
    objectiveAchievedRate: number | null;
    avgDurationSec: number | null;
    avgTurnsPerCall: number | null;
    totalRuns: number;
  };
  issueComparison: {
    onlyOnLeft:  IssueComparisonEntry[];
    onlyOnRight: IssueComparisonEntry[];
    shared:      IssueComparisonEntry[];
  };
  /** Whether left.projectId === right.projectId — affects what "resolution" means. */
  sameProject: boolean;
}

function entryKey(i: Issue): string {
  // Same canonical form as in buckets — keeps left/right matching consistent.
  return `${i.source}::${i.nodeLabel ?? ""}::${normalizeIssueKey(i.text)}`;
}

function deriveStatus(leftCount: number, rightCount: number): IssueComparisonEntry["status"] {
  if (leftCount === 0 && rightCount > 0) return "only_right";
  if (leftCount > 0 && rightCount === 0) return "resolved"; // appeared in left, gone in right
  if (rightCount < leftCount) return "reduced";
  if (rightCount > leftCount) return "worsened";
  return "unchanged";
}

export async function compareReports(
  left: WindowSpec,
  right: WindowSpec,
): Promise<ComparisonReport> {
  const [leftKpis, rightKpis, leftIssues, rightIssues] = await Promise.all([
    getKpisForRange(left),
    getKpisForRange(right),
    getIssuesForRange(left),
    getIssuesForRange(right),
  ]);

  // Diff issues by normalized key.
  const leftByKey  = new Map<string, Issue>();
  const rightByKey = new Map<string, Issue>();
  for (const i of leftIssues)  leftByKey.set(entryKey(i), i);
  for (const i of rightIssues) rightByKey.set(entryKey(i), i);

  const onlyOnLeft:  IssueComparisonEntry[] = [];
  const onlyOnRight: IssueComparisonEntry[] = [];
  const shared:      IssueComparisonEntry[] = [];

  const seen = new Set<string>();
  for (const [k, l] of leftByKey) {
    seen.add(k);
    const r = rightByKey.get(k);
    if (!r) {
      onlyOnLeft.push({
        text: l.text, source: l.source, severity: l.severity, nodeLabel: l.nodeLabel,
        leftCount: l.count, rightCount: 0,
        leftOccurrences: l.occurrences, rightOccurrences: [],
        status: "resolved",
      });
    } else {
      shared.push({
        text: l.text, source: l.source, severity: l.severity ?? r.severity, nodeLabel: l.nodeLabel ?? r.nodeLabel,
        leftCount: l.count, rightCount: r.count,
        leftOccurrences: l.occurrences, rightOccurrences: r.occurrences,
        status: deriveStatus(l.count, r.count),
      });
    }
  }
  for (const [k, r] of rightByKey) {
    if (seen.has(k)) continue;
    onlyOnRight.push({
      text: r.text, source: r.source, severity: r.severity, nodeLabel: r.nodeLabel,
      leftCount: 0, rightCount: r.count,
      leftOccurrences: [], rightOccurrences: r.occurrences,
      status: "only_right",
    });
  }

  // Sort each section by impact: count desc (using whichever side's count is larger).
  const byImpact = (a: IssueComparisonEntry, b: IssueComparisonEntry) =>
    Math.max(b.leftCount, b.rightCount) - Math.max(a.leftCount, a.rightCount);
  onlyOnLeft.sort(byImpact);
  onlyOnRight.sort(byImpact);
  shared.sort(byImpact);

  const round1 = (n: number) => parseFloat(n.toFixed(1));
  const deltaNullable = (l: number | null, r: number | null) =>
    l == null || r == null ? null : round1(r - l);

  return {
    left:  { window: left,  kpis: leftKpis,  issues: leftIssues },
    right: { window: right, kpis: rightKpis, issues: rightIssues },
    deltas: {
      successRate:           round1(rightKpis.successRate - leftKpis.successRate),
      dropOffRate:           round1(rightKpis.dropOffRate - leftKpis.dropOffRate),
      escalationRate:        round1(rightKpis.escalationRate - leftKpis.escalationRate),
      overallPassRate:       deltaNullable(leftKpis.overallPassRate, rightKpis.overallPassRate),
      objectiveAchievedRate: deltaNullable(leftKpis.objectiveAchievedRate, rightKpis.objectiveAchievedRate),
      avgDurationSec:        deltaNullable(leftKpis.avgDurationSec, rightKpis.avgDurationSec),
      avgTurnsPerCall:       deltaNullable(leftKpis.avgTurnsPerCall, rightKpis.avgTurnsPerCall),
      totalRuns:             rightKpis.totalRuns - leftKpis.totalRuns,
    },
    issueComparison: { onlyOnLeft, onlyOnRight, shared },
    sameProject: left.projectId === right.projectId,
  };
}
