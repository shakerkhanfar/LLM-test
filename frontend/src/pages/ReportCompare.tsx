/**
 * Compare two report windows side-by-side. A window is (project, optional from-date, optional to-date).
 *
 * Sections:
 *   1. Window pickers  — pick project + dates on each side
 *   2. KPI delta table — success/dropoff/escalation/pass-rate/etc., with Δ
 *   3. Issue diffs     — Only-on-Left / Only-on-Right / Shared. Each entry shows
 *      run IDs (linked to the run page) and a per-issue "Explain resolution"
 *      button that fires the LLM narrative endpoint on demand.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  listProjects, compareReports, explainComparisonResolution,
  type ComparisonWindow,
} from "../api/client";
import T from "../theme";

// ─── Types mirrored from backend (kept loose; we cast `any` where needed) ────

type IssueSource = "L4_critical" | "L3_node" | "intel_failure";
type IssueStatus = "only_left" | "only_right" | "resolved" | "reduced" | "worsened" | "unchanged";

interface ClusteredVariant { text: string; count: number; nodeLabel?: string; source: IssueSource; }
interface ClusteredIssue {
  canonicalText: string;
  variants: ClusteredVariant[];
  totalCount: number;
  source: IssueSource;
  severity?: "critical" | "high" | "medium" | "low";
  nodeLabels: string[];
  occurrences: Occurrence[];
  occurrencesTruncated: boolean;
  firstSeen: string | null;
  lastSeen: string | null;
}
interface ClusteredPair {
  left: ClusteredIssue;
  right: ClusteredIssue;
  similarity: number;
  countDelta: number;
  deltaPercent: number | null;
  status: "reduced" | "worsened" | "unchanged";
}
interface ClusteredComparison {
  resolved: ClusteredIssue[];
  newIssues: ClusteredIssue[];
  persisting: ClusteredPair[];
  stats: { resolvedClusters: number; newClusters: number; persistingClusters: number; leftClusterCount: number; rightClusterCount: number };
}

interface Occurrence { runId: string; conversationId: string | null; callDate: string | null; callOutcome: string | null; }

interface IssueEntry {
  text: string;
  source: IssueSource;
  severity?: "critical" | "high" | "medium" | "low";
  nodeLabel?: string;
  leftCount: number;
  rightCount: number;
  leftOccurrences: Occurrence[];
  rightOccurrences: Occurrence[];
  status: IssueStatus;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<IssueSource, string> = {
  L4_critical:    "Layer 4 critical",
  L3_node:        "Layer 3 node",
  intel_failure:  "Intelligence",
};
const SOURCE_COLOR: Record<IssueSource, string> = {
  L4_critical:   "#ef4444",
  L3_node:       "#f59e0b",
  intel_failure: "#a855f7",
};
const SEVERITY_COLOR: Record<NonNullable<IssueEntry["severity"]>, string> = {
  critical: "#dc2626",
  high:     "#ef4444",
  medium:   "#f59e0b",
  low:      "#84cc16",
};

function deltaBadge(delta: number | null, lowerIsBetter: boolean) {
  if (delta == null) return <span style={{ color: T.textMuted, fontSize: 12 }}>—</span>;
  if (delta === 0)   return <span style={{ color: T.textMuted, fontSize: 12 }}>0</span>;
  const positive = delta > 0;
  const isGood   = lowerIsBetter ? !positive : positive;
  const color    = isGood ? "#22c55e" : "#ef4444";
  const arrow    = positive ? "▲" : "▼";
  return (
    <span style={{ color, fontSize: 12, fontWeight: 600 }}>
      {arrow} {Math.abs(delta).toFixed(1)}
    </span>
  );
}

function formatPct(v: number | null): string {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}
function formatDur(v: number | null): string {
  if (v == null) return "—";
  const m = Math.floor(v / 60);
  const s = v % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ─── The page ────────────────────────────────────────────────────────────────

export default function ReportCompare() {
  const navigate = useNavigate();
  const [search] = useSearchParams();

  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading]   = useState(true);

  // URL-driven initial selection so the page is shareable.
  const [leftProj, setLeftProj]   = useState(search.get("leftProj") ?? "");
  const [leftFrom, setLeftFrom]   = useState(search.get("leftFrom") ?? "");
  const [leftTo, setLeftTo]       = useState(search.get("leftTo")   ?? "");
  const [rightProj, setRightProj] = useState(search.get("rightProj") ?? "");
  const [rightFrom, setRightFrom] = useState(search.get("rightFrom") ?? "");
  const [rightTo, setRightTo]     = useState(search.get("rightTo")   ?? "");

  const [running, setRunning] = useState(false);
  const [report, setReport]   = useState<any>(null);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .finally(() => setLoading(false));
  }, []);

  // Returns an error string if a side's from > to, else null. Browser-native
  // date inputs produce empty strings when blank, which we treat as "no filter".
  function rangeError(side: string, from: string, to: string): string | null {
    if (!from || !to) return null;
    if (from > to) return `${side}: 'from' (${from}) must be on or before 'to' (${to}).`;
    return null;
  }
  const sideAEqualsB = !!leftProj && leftProj === rightProj
    && leftFrom === rightFrom && leftTo === rightTo;
  const leftRangeErr  = rangeError("Side A", leftFrom, leftTo);
  const rightRangeErr = rangeError("Side B", rightFrom, rightTo);
  const inputError = leftRangeErr || rightRangeErr
    || (sideAEqualsB ? "Side A and Side B are identical — comparison would be empty." : null);
  const canRun = !!leftProj && !!rightProj && !running && !inputError;

  async function run() {
    setRunning(true);
    setError(null);
    setReport(null);  // clear stale result immediately so user sees the request is live
    try {
      const left:  ComparisonWindow = { projectId: leftProj,  from: leftFrom  || undefined, to: leftTo  || undefined };
      const right: ComparisonWindow = { projectId: rightProj, from: rightFrom || undefined, to: rightTo || undefined };
      const r = await compareReports(left, right);
      setReport(r);
      // Persist in URL so the comparison is shareable.
      const q = new URLSearchParams();
      q.set("leftProj", leftProj);
      if (leftFrom) q.set("leftFrom", leftFrom);
      if (leftTo)   q.set("leftTo",   leftTo);
      q.set("rightProj", rightProj);
      if (rightFrom) q.set("rightFrom", rightFrom);
      if (rightTo)   q.set("rightTo",   rightTo);
      navigate(`/report/compare?${q.toString()}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <p>Loading projects...</p>;

  return (
    <div>
      <Link to="/" style={{ color: T.textSecondary, textDecoration: "none", fontSize: 14 }}>
        ← Back to projects
      </Link>
      <h1 style={{ margin: "12px 0 4px" }}>Compare reports</h1>
      <p style={{ color: T.textSecondary, fontSize: 13, marginTop: 0 }}>
        Compare KPIs and issues between two projects, or two date windows of the same project.
      </p>

      {/* Side pickers */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 20 }}>
        <SidePicker
          label="A (Left)"
          projects={projects}
          project={leftProj} setProject={setLeftProj}
          from={leftFrom} setFrom={setLeftFrom}
          to={leftTo} setTo={setLeftTo}
        />
        <SidePicker
          label="B (Right)"
          projects={projects}
          project={rightProj} setProject={setRightProj}
          from={rightFrom} setFrom={setRightFrom}
          to={rightTo} setTo={setRightTo}
        />
      </div>

      <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
        <button
          onClick={run}
          disabled={!canRun}
          title={inputError ?? ""}
          style={{
            background: canRun ? T.primary : T.card, color: canRun ? "#fff" : T.textMuted,
            border: "none", padding: "10px 18px", borderRadius: 6, fontSize: 14, fontWeight: 600,
            cursor: canRun ? "pointer" : "default",
          }}
        >
          {running ? "Comparing…" : "Generate comparison"}
        </button>
        {inputError && !error && <span style={{ color: "#f59e0b", fontSize: 12 }}>{inputError}</span>}
        {error && <span style={{ color: "#ef4444", fontSize: 12 }}>{error}</span>}
      </div>

      {report && <ComparisonResult report={report} />}
    </div>
  );
}

// ─── Side picker ────────────────────────────────────────────────────────────

function SidePicker(props: {
  label: string;
  projects: Array<{ id: string; name: string }>;
  project: string; setProject: (v: string) => void;
  from: string; setFrom: (v: string) => void;
  to: string; setTo: (v: string) => void;
}) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: T.textMuted, marginBottom: 8 }}>
        {props.label}
      </div>
      <label style={{ display: "block", fontSize: 12, color: T.textSecondary, marginBottom: 4 }}>Project</label>
      <select
        value={props.project}
        onChange={e => props.setProject(e.target.value)}
        style={{ width: "100%", padding: "8px", background: T.input, border: `1px solid ${T.borderDark}`, borderRadius: 6, color: T.text, fontSize: 13 }}
      >
        <option value="">— select project —</option>
        {props.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
        <div>
          <label style={{ display: "block", fontSize: 12, color: T.textSecondary, marginBottom: 4 }}>From</label>
          <input
            type="date" value={props.from} onChange={e => props.setFrom(e.target.value)}
            style={{ width: "100%", padding: "8px", background: T.input, border: `1px solid ${T.borderDark}`, borderRadius: 6, color: T.text, fontSize: 13 }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontSize: 12, color: T.textSecondary, marginBottom: 4 }}>To</label>
          <input
            type="date" value={props.to} onChange={e => props.setTo(e.target.value)}
            style={{ width: "100%", padding: "8px", background: T.input, border: `1px solid ${T.borderDark}`, borderRadius: 6, color: T.text, fontSize: 13 }}
          />
        </div>
      </div>
      <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>Leave dates blank to include the project's full history.</div>
    </div>
  );
}

// ─── Comparison result ───────────────────────────────────────────────────────

// CSV-quote a value: wrap in quotes and escape internal quotes.
function csvQuote(v: any): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, rows: any[][]) {
  const body = rows.map(r => r.map(csvQuote).join(",")).join("\n");
  // BOM so Excel opens UTF-8 correctly (Arabic text in reasons / issues).
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportComparisonCsv(report: any) {
  const leftName  = report.left?.projectName  ?? "A";
  const rightName = report.right?.projectName ?? "B";
  const lk = report.left?.kpis  ?? {};
  const rk = report.right?.kpis ?? {};
  const d  = report.deltas      ?? {};
  const lf = report.left?.objectiveFailures  ?? { totalNotAchieved: 0, reasonGroups: [], failures: [] };
  const rf = report.right?.objectiveFailures ?? { totalNotAchieved: 0, reasonGroups: [], failures: [] };

  const rows: any[][] = [];
  rows.push(["Comparison report"]);
  rows.push(["Generated", new Date().toISOString()]);
  rows.push(["A — project",  leftName,  "from", report.left?.window?.from  ?? "", "to", report.left?.window?.to  ?? ""]);
  rows.push(["B — project",  rightName, "from", report.right?.window?.from ?? "", "to", report.right?.window?.to ?? ""]);
  rows.push([]);
  rows.push(["KPI", `A — ${leftName}`, `B — ${rightName}`, "Δ (B − A)"]);
  const kpiRows: Array<[string, any, any, any]> = [
    ["Complete runs",                       lk.totalRuns,             rk.totalRuns,             d.totalRuns],
    ["Connected & not escalated rate (%)",  lk.successRate,           rk.successRate,           d.successRate],
    ["Drop-off rate (%)",                   lk.dropOffRate,           rk.dropOffRate,           d.dropOffRate],
    ["Escalation rate (%)",   lk.escalationRate,        rk.escalationRate,        d.escalationRate],
    ["Avg quality score (%)", lk.avgQualityScore,       rk.avgQualityScore,       d.avgQualityScore],
    ["Overall pass rate (%)", lk.overallPassRate,       rk.overallPassRate,       d.overallPassRate],
    ["Objective achieved (%)",lk.objectiveAchievedRate, rk.objectiveAchievedRate, d.objectiveAchievedRate],
    ["Avg duration (s)",      lk.avgDurationSec,        rk.avgDurationSec,        d.avgDurationSec],
    ["Avg turns/call",        lk.avgTurnsPerCall,       rk.avgTurnsPerCall,       d.avgTurnsPerCall],
  ];
  for (const r of kpiRows) rows.push(r);

  rows.push([]);
  rows.push(["Issues"]);
  rows.push(["Bucket", "Status", "Source", "Severity", "Node", "Issue text", "Count A", "Count B", "A Run IDs", "B Run IDs"]);
  const sections: Array<[string, any[]]> = [
    ["Only on A", report.issueComparison?.onlyOnLeft  ?? []],
    ["Only on B", report.issueComparison?.onlyOnRight ?? []],
    ["Shared",    report.issueComparison?.shared      ?? []],
  ];
  for (const [bucket, items] of sections) {
    for (const it of items as any[]) {
      rows.push([
        bucket,
        it.status,
        it.source,
        it.severity ?? "",
        it.nodeLabel ?? "",
        it.text,
        it.leftCount,
        it.rightCount,
        (it.leftOccurrences ?? []).map((o: any) => o.runId).join(";"),
        (it.rightOccurrences ?? []).map((o: any) => o.runId).join(";"),
      ]);
    }
  }

  rows.push([]);
  rows.push(["Objective NOT achieved — summary"]);
  rows.push(["", `A — ${leftName}`, `B — ${rightName}`]);
  rows.push(["Total evaluated",     lf.totalEvaluated,    rf.totalEvaluated]);
  rows.push(["Total not achieved",  lf.totalNotAchieved,  rf.totalNotAchieved]);

  rows.push([]);
  rows.push(["Objective NOT achieved — reason groups"]);
  rows.push(["Side", "Reason", "Count", "Run IDs"]);
  for (const g of (lf.reasonGroups ?? [])) rows.push(["A", g.reason, g.count, (g.runIds ?? []).join(";")]);
  for (const g of (rf.reasonGroups ?? [])) rows.push(["B", g.reason, g.count, (g.runIds ?? []).join(";")]);

  rows.push([]);
  rows.push(["Objective NOT achieved — per-call detail"]);
  rows.push(["Side", "Run ID", "Conversation ID", "Call Date", "Outcome", "Reason source", "Reason"]);
  for (const f of (lf.failures ?? [])) rows.push(["A", f.runId, f.conversationId ?? "", f.callDate ?? "", f.callOutcome ?? "", f.reasonSource, f.reason]);
  for (const f of (rf.failures ?? [])) rows.push(["B", f.runId, f.conversationId ?? "", f.callDate ?? "", f.callOutcome ?? "", f.reasonSource, f.reason]);

  const fname = `comparison_${leftName.replace(/\W+/g, "_")}_vs_${rightName.replace(/\W+/g, "_")}_${new Date().toISOString().slice(0,10)}.csv`;
  downloadCsv(fname, rows);
}

function ComparisonResult({ report }: { report: any }) {
  const leftName  = report.left?.projectName  ?? "Left";
  const rightName = report.right?.projectName ?? "Right";
  const lk = report.left?.kpis  ?? {};
  const rk = report.right?.kpis ?? {};
  const d  = report.deltas      ?? {};

  // Truncation banner — surfaced when either side scanned MAX_RUNS_PER_WINDOW
  // so users don't silently take partial aggregates as full-history truths.
  const leftTrunc  = report.left?.windowTruncated;
  const rightTrunc = report.right?.windowTruncated;
  const truncationBanner = (leftTrunc || rightTrunc) ? (
    <div style={{
      background: "#fef3c7", border: "1px solid #fde68a", color: "#92400e",
      fontSize: 12, padding: "8px 12px", borderRadius: 6, marginBottom: 16,
    }}>
      ⚠ Partial scan: {leftTrunc ? `A scanned ${report.left.runsScanned} most-recent runs` : ""}
      {leftTrunc && rightTrunc ? "; " : ""}
      {rightTrunc ? `B scanned ${report.right.runsScanned} most-recent runs` : ""}.
      Aggregates and issue counts reflect only the scanned set. Narrow the date range for a complete view.
    </div>
  ) : null;

  return (
    <div style={{ marginTop: 28 }}>
      {truncationBanner}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>KPIs</h2>
        <button
          onClick={() => exportComparisonCsv(report)}
          style={{
            fontSize: 12, padding: "6px 12px", background: T.card,
            border: `1px solid ${T.border}`, color: T.text, borderRadius: 6, cursor: "pointer",
          }}
        >
          ⬇ Export CSV
        </button>
      </div>
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: T.cardAlt, color: T.textSecondary }}>
              <th style={cellTH}>Metric</th>
              <th style={cellTH}>A — {leftName}</th>
              <th style={cellTH}>B — {rightName}</th>
              <th style={cellTH}>Δ (B − A)</th>
            </tr>
          </thead>
          <tbody>
            {kpiRow("Complete runs",         lk.totalRuns, rk.totalRuns, d.totalRuns, false, (v: any) => v ?? 0, "Runs with status=COMPLETE (excludes no-answer, busy, voicemail, failed)")}
            {kpiRow("Connected & not escalated", lk.successRate, rk.successRate, d.successRate, false, formatPct, "Calls that technically connected (callStatus=COMPLETED) and were not transferred to a human. Does not indicate the agent achieved its goal — use Objective Achieved for that.")}
            {kpiRow("Drop-off rate",         lk.dropOffRate,           rk.dropOffRate,           d.dropOffRate, true,  formatPct, "No-answer + busy + voicemail + failed short calls")}
            {kpiRow("Escalation rate",       lk.escalationRate,        rk.escalationRate,        d.escalationRate, true, formatPct, "Calls transferred to a human agent")}
            {kpiRow("Avg quality score",     lk.avgQualityScore,       rk.avgQualityScore,       d.avgQualityScore, false, formatPct, "Average LLM quality score (0–100%) across runs with ≥2 evaluated criteria. Matches dashboard quality metric.")}
            {kpiRow("Overall pass rate",     lk.overallPassRate,       rk.overallPassRate,       d.overallPassRate, false, formatPct, "% of all complete runs scoring ≥70%. Denominator = all complete runs (including unscored). Matches dashboard pass rate.")}
            {kpiRow("Objective achieved",    lk.objectiveAchievedRate, rk.objectiveAchievedRate, d.objectiveAchievedRate, false, formatPct, "% of Layer 4–evaluated runs where the agent achieved the caller's objective")}
            {kpiRow("Avg duration",          lk.avgDurationSec,        rk.avgDurationSec,        d.avgDurationSec, true,  formatDur)}
            {kpiRow("Avg turns/call",        lk.avgTurnsPerCall,       rk.avgTurnsPerCall,       d.avgTurnsPerCall, true,  (v: any) => v == null ? "—" : String(v))}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: 18, margin: "28px 0 12px" }}>
        Objective not achieved
        <span style={{ fontSize: 12, color: T.textMuted, fontWeight: 400, marginLeft: 8 }}>
          (per side, with reasons)
        </span>
      </h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        <ObjectiveFailuresPanel
          label={`A — ${leftName}`}
          summary={report.left?.objectiveFailures}
          projectId={report.left?.window?.projectId}
        />
        <ObjectiveFailuresPanel
          label={`B — ${rightName}`}
          summary={report.right?.objectiveFailures}
          projectId={report.right?.window?.projectId}
        />
      </div>

      {/* ── Grouped Issues (semantic clustering) ── */}
      {report.clusteredIssueComparison && (
        <ClusteredIssuesSection
          clustered={report.clusteredIssueComparison as ClusteredComparison}
          leftName={leftName}
          rightName={rightName}
          report={report}
        />
      )}

      <h2 style={{ fontSize: 18, margin: "28px 0 12px" }}>
        Issues
        <span style={{ fontSize: 12, color: T.textMuted, fontWeight: 400, marginLeft: 8 }}>
          (exact match by normalized text + source + node)
        </span>
      </h2>

      <IssueSection
        title="Resolved or only on A — present in A, absent in B"
        emptyMsg="No issues unique to A."
        items={report.issueComparison?.onlyOnLeft ?? []}
        report={report}
        sideHint="left"
      />
      <IssueSection
        title="New or only on B — appears in B, absent in A"
        emptyMsg="No issues unique to B."
        items={report.issueComparison?.onlyOnRight ?? []}
        report={report}
        sideHint="right"
      />
      <IssueSection
        title="Shared — appears in both"
        emptyMsg="No issues shared between the two."
        items={report.issueComparison?.shared ?? []}
        report={report}
        sideHint="both"
      />
    </div>
  );
}

const cellTH: React.CSSProperties = { textAlign: "left", padding: "8px 12px", fontWeight: 600, fontSize: 12, borderBottom: `1px solid ${T.border}` };
const cellTD: React.CSSProperties = { padding: "8px 12px", borderBottom: `1px solid ${T.border}` };

function kpiRow(label: string, l: any, r: any, delta: number | null | undefined, lowerIsBetter: boolean, fmt: (v: any) => string, tooltip?: string) {
  return (
    <tr key={label}>
      <td style={{ ...cellTD, color: T.textSecondary }}>
        {tooltip
          ? <span title={tooltip} style={{ borderBottom: `1px dashed ${T.textMuted}`, cursor: "help" }}>{label}</span>
          : label}
      </td>
      <td style={cellTD}>{fmt(l)}</td>
      <td style={cellTD}>{fmt(r)}</td>
      <td style={cellTD}>{deltaBadge(delta ?? null, lowerIsBetter)}</td>
    </tr>
  );
}

// ─── Issue section ──────────────────────────────────────────────────────────

function IssueSection({
  title, emptyMsg, items, report, sideHint,
}: {
  title: string; emptyMsg: string; items: IssueEntry[]; report: any; sideHint: "left" | "right" | "both";
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div style={{ marginBottom: 24 }}>
      <h3
        onClick={() => setExpanded(!expanded)}
        style={{ fontSize: 14, marginBottom: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
      >
        <span style={{ color: T.textSecondary, fontSize: 11 }}>{expanded ? "▼" : "▶"}</span>
        {title}
        <span style={{ color: T.textMuted, fontWeight: 400, fontSize: 12 }}>({items.length})</span>
      </h3>
      {expanded && (items.length === 0
        ? <div style={{ fontSize: 12, color: T.textMuted, padding: "8px 0 16px" }}>{emptyMsg}</div>
        : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((it, idx) => (
              <IssueRow key={`${it.source}|${it.nodeLabel ?? ""}|${idx}`} issue={it} report={report} sideHint={sideHint} />
            ))}
          </div>
      )}
    </div>
  );
}

function IssueRow({ issue, report, sideHint }: { issue: IssueEntry; report: any; sideHint: "left" | "right" | "both" }) {
  const [open, setOpen] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState<{ text: string; confidence: string; costUsd: number } | null>(null);
  const [explainErr, setExplainErr] = useState<string | null>(null);

  const sourceColor = SOURCE_COLOR[issue.source];
  const sevColor    = issue.severity ? SEVERITY_COLOR[issue.severity] : null;
  const showExplain = issue.status === "resolved" || issue.status === "reduced";

  async function fetchExplanation() {
    setExplaining(true);
    setExplainErr(null);
    try {
      const left  = report.left.window;
      const right = report.right.window;
      const r = await explainComparisonResolution({
        left, right,
        issueText: issue.text,
        issueSource: issue.source,
        nodeLabel: issue.nodeLabel,
        leftRunIds: issue.leftOccurrences.slice(0, 3).map(o => o.runId),
        rightRunIds: issue.rightOccurrences.slice(0, 3).map(o => o.runId),
      });
      setExplanation({ text: r.explanation, confidence: r.confidence, costUsd: r.costUsd });
    } catch (e) {
      setExplainErr((e as Error).message);
    } finally {
      setExplaining(false);
    }
  }

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={() => setOpen(!open)}
          style={{ background: "none", border: "none", color: T.textSecondary, cursor: "pointer", padding: 0, fontSize: 11 }}
        >
          {open ? "▼" : "▶"}
        </button>
        <span style={{
          fontSize: 10, fontWeight: 700, color: sourceColor, padding: "2px 6px",
          background: `${sourceColor}22`, borderRadius: 4, textTransform: "uppercase",
        }}>{SOURCE_LABEL[issue.source]}</span>
        {sevColor && (
          <span style={{ fontSize: 10, fontWeight: 700, color: sevColor, padding: "2px 6px", background: `${sevColor}22`, borderRadius: 4, textTransform: "uppercase" }}>
            {issue.severity}
          </span>
        )}
        {issue.nodeLabel && (
          <span style={{ fontSize: 11, color: T.textMuted }}>{issue.nodeLabel}</span>
        )}
        <span style={{ flex: 1, fontSize: 13 }}>{issue.text}</span>
        <span style={{ fontSize: 12, color: T.textMuted, whiteSpace: "nowrap" }}>
          A: <strong style={{ color: issue.leftCount > 0 ? T.text : T.textMuted }}>{issue.leftCount}</strong>
          {" · "}
          B: <strong style={{ color: issue.rightCount > 0 ? T.text : T.textMuted }}>{issue.rightCount}</strong>
        </span>
        <StatusBadge status={issue.status} />
      </div>
      {open && (
        <div style={{ marginTop: 10, paddingLeft: 22 }}>
          {(sideHint === "left" || sideHint === "both") && issue.leftOccurrences.length > 0 && (
            <OccList label={`A — ${issue.leftCount} call(s)`} projectId={report.left.window.projectId} occurrences={issue.leftOccurrences} />
          )}
          {(sideHint === "right" || sideHint === "both") && issue.rightOccurrences.length > 0 && (
            <OccList label={`B — ${issue.rightCount} call(s)`} projectId={report.right.window.projectId} occurrences={issue.rightOccurrences} />
          )}
          {showExplain && (
            <div style={{ marginTop: 12, padding: "10px 12px", background: T.cardAlt, borderRadius: 6 }}>
              {!explanation && !explaining && (
                <button
                  onClick={fetchExplanation}
                  style={{
                    background: T.primary, color: "#fff", border: "none",
                    padding: "6px 12px", borderRadius: 4, fontSize: 12, cursor: "pointer",
                  }}
                >
                  Explain resolution (LLM)
                </button>
              )}
              {explaining && <div style={{ fontSize: 12, color: T.textMuted }}>Analyzing…</div>}
              {explainErr && <div style={{ fontSize: 12, color: "#ef4444" }}>{explainErr}</div>}
              {explanation && (
                <div>
                  <div style={{ fontSize: 12, lineHeight: 1.5, color: T.text }}>{explanation.text}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, marginTop: 6 }}>
                    confidence: {explanation.confidence} · cost: ${explanation.costUsd.toFixed(4)}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OccList({ label, projectId, occurrences }: { label: string; projectId: string; occurrences: Occurrence[] }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {occurrences.map((o) => (
          <Link
            key={o.runId}
            to={`/projects/${projectId}/runs/${o.runId}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 11, padding: "3px 8px", borderRadius: 4,
              background: T.input, color: T.link, border: `1px solid ${T.border}`, textDecoration: "none",
              fontFamily: "monospace",
            }}
            title={`${o.callDate ?? "no date"} · outcome=${o.callOutcome ?? "?"} — opens in new tab`}
          >
            {o.conversationId ? o.conversationId.slice(0, 8) : o.runId.slice(0, 8)}
          </Link>
        ))}
      </div>
    </div>
  );
}

function ObjectiveFailuresPanel({
  label, summary, projectId,
}: {
  label: string;
  summary: any;
  projectId: string;
}) {
  const [showAll, setShowAll] = useState(false);

  if (!summary) return <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14, fontSize: 12, color: T.textMuted }}>No data.</div>;

  const total = summary.totalNotAchieved ?? 0;
  const evaluated = summary.totalEvaluated ?? 0;
  const reasonGroups: Array<{ reason: string; count: number; runIds: string[] }> = summary.reasonGroups ?? [];
  const failures: Array<{ runId: string; conversationId: string | null; callDate: string | null; reason: string; reasonSource: string }> = summary.failures ?? [];

  const failurePct = evaluated > 0 ? ((total / evaluated) * 100).toFixed(1) : null;
  const visibleGroups = showAll ? reasonGroups : reasonGroups.slice(0, 5);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: T.textMuted, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: total > 0 ? "#ef4444" : "#22c55e" }}>{total}</div>
        <div style={{ fontSize: 12, color: T.textSecondary }}>
          out of {evaluated} evaluated{failurePct != null && <> · <strong>{failurePct}%</strong> failure rate</>}
        </div>
      </div>

      {reasonGroups.length === 0 ? (
        <div style={{ fontSize: 12, color: T.textMuted }}>No objective failures recorded.</div>
      ) : (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, marginBottom: 6 }}>Top reasons</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {visibleGroups.map((g, i) => (
              <div key={i} style={{ padding: "8px 10px", background: T.cardAlt, borderRadius: 6, fontSize: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <div style={{ flex: 1 }}>{g.reason.length > 200 ? `${g.reason.slice(0, 200)}…` : g.reason}</div>
                  <strong style={{ color: T.text, whiteSpace: "nowrap" }}>{g.count}</strong>
                </div>
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {g.runIds.slice(0, 12).map(rid => (
                    <Link
                      key={rid}
                      to={`/projects/${projectId}/runs/${rid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open run in new tab"
                      style={{
                        fontSize: 10, padding: "2px 6px", borderRadius: 3,
                        background: T.input, color: T.link, border: `1px solid ${T.border}`,
                        textDecoration: "none", fontFamily: "monospace",
                      }}
                    >
                      {rid.slice(0, 8)}
                    </Link>
                  ))}
                  {g.runIds.length > 12 && (
                    <span style={{ fontSize: 10, color: T.textMuted, alignSelf: "center" }}>
                      +{g.runIds.length - 12} more
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {reasonGroups.length > 5 && (
            <button
              onClick={() => setShowAll(!showAll)}
              style={{
                marginTop: 8, fontSize: 11, padding: "4px 8px",
                background: "none", border: "none", color: T.link, cursor: "pointer",
              }}
            >
              {showAll ? "Show top 5" : `Show all ${reasonGroups.length} reasons`}
            </button>
          )}
        </>
      )}
      {summary.failuresTruncated && (
        <div style={{ fontSize: 10, color: T.textMuted, marginTop: 8 }}>
          ({failures.length} of {total} per-call detail rows shown — capped for performance; CSV export has the full set)
        </div>
      )}
    </div>
  );
}

// ─── Clustered issue section ─────────────────────────────────────────────────

function ClusteredIssuesSection({
  clustered, leftName, rightName, report,
}: {
  clustered: ClusteredComparison;
  leftName: string;
  rightName: string;
  report: any;
}) {
  const { stats } = clustered;
  return (
    <div style={{ marginBottom: 8 }}>
      <h2 style={{ fontSize: 18, margin: "28px 0 4px" }}>
        Grouped issues
        <span style={{ fontSize: 12, color: T.textMuted, fontWeight: 400, marginLeft: 8 }}>
          (semantically clustered · similar phrasing merged into one group)
        </span>
      </h2>
      <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 14 }}>
        A → {stats.leftClusterCount} groups · B → {stats.rightClusterCount} groups ·{" "}
        <span style={{ color: "#22c55e", fontWeight: 600 }}>{stats.resolvedClusters} resolved</span> ·{" "}
        <span style={{ color: "#ef4444", fontWeight: 600 }}>{stats.newClusters} new</span> ·{" "}
        <span style={{ color: T.textSecondary, fontWeight: 600 }}>{stats.persistingClusters} persisting</span>
      </div>

      <ClusteredSection
        title={`Resolved — issue groups absent in B (${stats.resolvedClusters})`}
        items={clustered.resolved.map(c => ({ type: "single" as const, cluster: c }))}
        leftName={leftName} rightName={rightName} report={report}
        emptyMsg="No resolved issue groups."
        defaultExpanded
      />
      <ClusteredSection
        title={`New — issue groups that appeared in B (${stats.newClusters})`}
        items={clustered.newIssues.map(c => ({ type: "single" as const, cluster: c }))}
        leftName={leftName} rightName={rightName} report={report}
        emptyMsg="No new issue groups."
        defaultExpanded={false}
      />
      <ClusteredSection
        title={`Persisting — issue groups present in both (${stats.persistingClusters})`}
        items={clustered.persisting.map(p => ({ type: "pair" as const, pair: p }))}
        leftName={leftName} rightName={rightName} report={report}
        emptyMsg="No shared issue groups."
        defaultExpanded={false}
      />
    </div>
  );
}

type ClusteredItem =
  | { type: "single"; cluster: ClusteredIssue }
  | { type: "pair"; pair: ClusteredPair };

function ClusteredSection({
  title, items, leftName, rightName, report, emptyMsg, defaultExpanded,
}: {
  title: string;
  items: ClusteredItem[];
  leftName: string;
  rightName: string;
  report: any;
  emptyMsg: string;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div style={{ marginBottom: 20 }}>
      <h3
        onClick={() => setExpanded(!expanded)}
        style={{ fontSize: 14, marginBottom: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
      >
        <span style={{ color: T.textSecondary, fontSize: 11 }}>{expanded ? "▼" : "▶"}</span>
        {title}
      </h3>
      {expanded && (items.length === 0
        ? <div style={{ fontSize: 12, color: T.textMuted, padding: "8px 0 8px" }}>{emptyMsg}</div>
        : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((item, idx) =>
              item.type === "single"
                ? <ClusteredIssueRow key={idx} cluster={item.cluster} leftName={leftName} rightName={rightName} report={report} side="left" />
                : <ClusteredPairRow  key={idx} pair={item.pair} leftName={leftName} rightName={rightName} report={report} />
            )}
          </div>
      )}
    </div>
  );
}

function ClusteredIssueRow({
  cluster, leftName, rightName, report, side,
}: {
  cluster: ClusteredIssue;
  leftName: string;
  rightName: string;
  report: any;
  side: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const sourceColor = SOURCE_COLOR[cluster.source];
  const sevColor    = cluster.severity ? SEVERITY_COLOR[cluster.severity] : null;
  const projectId   = side === "left" ? report.left.window.projectId : report.right.window.projectId;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={() => setOpen(!open)}
          style={{ background: "none", border: "none", color: T.textSecondary, cursor: "pointer", padding: 0, fontSize: 11 }}
        >
          {open ? "▼" : "▶"}
        </button>
        <span style={{ fontSize: 10, fontWeight: 700, color: sourceColor, padding: "2px 6px", background: `${sourceColor}22`, borderRadius: 4, textTransform: "uppercase" }}>
          {SOURCE_LABEL[cluster.source]}
        </span>
        {sevColor && (
          <span style={{ fontSize: 10, fontWeight: 700, color: sevColor, padding: "2px 6px", background: `${sevColor}22`, borderRadius: 4, textTransform: "uppercase" }}>
            {cluster.severity}
          </span>
        )}
        {cluster.nodeLabels.length > 0 && (
          <span style={{ fontSize: 11, color: T.textMuted }}>{cluster.nodeLabels.slice(0, 2).join(", ")}{cluster.nodeLabels.length > 2 ? ` +${cluster.nodeLabels.length - 2}` : ""}</span>
        )}
        <span style={{ flex: 1, fontSize: 13 }}>{cluster.canonicalText}</span>
        {cluster.variants.length > 1 && (
          <span style={{ fontSize: 10, color: T.textMuted, padding: "2px 6px", background: T.cardAlt, borderRadius: 4 }}>
            {cluster.variants.length} variants
          </span>
        )}
        <span style={{ fontSize: 12, color: T.textMuted, whiteSpace: "nowrap" }}>
          <strong style={{ color: T.text }}>{cluster.totalCount}</strong> occurrence{cluster.totalCount !== 1 ? "s" : ""}
        </span>
      </div>
      {open && (
        <div style={{ marginTop: 10, paddingLeft: 22 }}>
          {cluster.variants.length > 1 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, marginBottom: 4 }}>Variants merged into this group</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {cluster.variants.map((v, i) => (
                  <div key={i} style={{ fontSize: 12, color: T.text, padding: "4px 8px", background: T.cardAlt, borderRadius: 4, display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ flex: 1 }}>{v.text}</span>
                    <span style={{ color: T.textMuted, whiteSpace: "nowrap" }}>{v.count}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {cluster.occurrences.length > 0 && (
            <OccList
              label={`${side === "left" ? leftName : rightName} — ${cluster.totalCount} call(s)`}
              projectId={projectId}
              occurrences={cluster.occurrences}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ClusteredPairRow({
  pair, leftName, rightName, report,
}: {
  pair: ClusteredPair;
  leftName: string;
  rightName: string;
  report: any;
}) {
  const [open, setOpen] = useState(false);
  const cluster = pair.left;
  const sourceColor = SOURCE_COLOR[cluster.source];
  const sevColor    = cluster.severity ? SEVERITY_COLOR[cluster.severity] : null;

  const STATUS_COLORS: Record<ClusteredPair["status"], { bg: string; fg: string }> = {
    reduced:   { bg: "#d1fae5", fg: "#065f46" },
    worsened:  { bg: "#fee2e2", fg: "#991b1b" },
    unchanged: { bg: "#e5e7eb", fg: "#374151" },
  };
  const sc = STATUS_COLORS[pair.status];

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={() => setOpen(!open)}
          style={{ background: "none", border: "none", color: T.textSecondary, cursor: "pointer", padding: 0, fontSize: 11 }}
        >
          {open ? "▼" : "▶"}
        </button>
        <span style={{ fontSize: 10, fontWeight: 700, color: sourceColor, padding: "2px 6px", background: `${sourceColor}22`, borderRadius: 4, textTransform: "uppercase" }}>
          {SOURCE_LABEL[cluster.source]}
        </span>
        {sevColor && (
          <span style={{ fontSize: 10, fontWeight: 700, color: sevColor, padding: "2px 6px", background: `${sevColor}22`, borderRadius: 4, textTransform: "uppercase" }}>
            {cluster.severity}
          </span>
        )}
        <span style={{ flex: 1, fontSize: 13 }}>{cluster.canonicalText}</span>
        {(pair.left.variants.length > 1 || pair.right.variants.length > 1) && (
          <span style={{ fontSize: 10, color: T.textMuted, padding: "2px 6px", background: T.cardAlt, borderRadius: 4 }}>
            {Math.max(pair.left.variants.length, pair.right.variants.length)} variants
          </span>
        )}
        <span style={{ fontSize: 12, color: T.textMuted, whiteSpace: "nowrap" }}>
          A: <strong style={{ color: T.text }}>{pair.left.totalCount}</strong>
          {" · "}
          B: <strong style={{ color: T.text }}>{pair.right.totalCount}</strong>
          {pair.deltaPercent != null && (
            <span style={{ marginLeft: 6, color: pair.status === "reduced" ? "#22c55e" : pair.status === "worsened" ? "#ef4444" : T.textMuted, fontSize: 11 }}>
              ({pair.deltaPercent > 0 ? "+" : ""}{pair.deltaPercent}%)
            </span>
          )}
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, color: sc.fg, background: sc.bg, padding: "2px 6px", borderRadius: 4, textTransform: "uppercase" }}>
          {pair.status}
        </span>
      </div>
      {open && (
        <div style={{ marginTop: 10, paddingLeft: 22 }}>
          {/* Show variants side by side if they differ */}
          {(pair.left.variants.length > 1 || pair.right.variants.length > 1) && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, marginBottom: 4 }}>A variants</div>
                {pair.left.variants.map((v, i) => (
                  <div key={i} style={{ fontSize: 12, color: T.text, padding: "3px 6px", background: T.cardAlt, borderRadius: 4, marginBottom: 2, display: "flex", justifyContent: "space-between" }}>
                    <span style={{ flex: 1 }}>{v.text.length > 120 ? `${v.text.slice(0, 120)}…` : v.text}</span>
                    <span style={{ color: T.textMuted, marginLeft: 8 }}>{v.count}×</span>
                  </div>
                ))}
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, marginBottom: 4 }}>B variants</div>
                {pair.right.variants.map((v, i) => (
                  <div key={i} style={{ fontSize: 12, color: T.text, padding: "3px 6px", background: T.cardAlt, borderRadius: 4, marginBottom: 2, display: "flex", justifyContent: "space-between" }}>
                    <span style={{ flex: 1 }}>{v.text.length > 120 ? `${v.text.slice(0, 120)}…` : v.text}</span>
                    <span style={{ color: T.textMuted, marginLeft: 8 }}>{v.count}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {pair.left.occurrences.length > 0 && (
              <OccList label={`A — ${leftName}`} projectId={report.left.window.projectId} occurrences={pair.left.occurrences} />
            )}
            {pair.right.occurrences.length > 0 && (
              <OccList label={`B — ${rightName}`} projectId={report.right.window.projectId} occurrences={pair.right.occurrences} />
            )}
          </div>
          <div style={{ fontSize: 10, color: T.textMuted, marginTop: 6 }}>
            Semantic similarity: {(pair.similarity * 100).toFixed(0)}%
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: IssueStatus }) {
  const COLORS: Record<IssueStatus, { bg: string; fg: string; label: string }> = {
    only_left:  { bg: "#fef3c7", fg: "#92400e", label: "only on A" },
    only_right: { bg: "#fee2e2", fg: "#991b1b", label: "new on B" },
    resolved:   { bg: "#dcfce7", fg: "#166534", label: "resolved" },
    reduced:    { bg: "#d1fae5", fg: "#065f46", label: "reduced" },
    worsened:   { bg: "#fee2e2", fg: "#991b1b", label: "worsened" },
    unchanged:  { bg: "#e5e7eb", fg: "#374151", label: "unchanged" },
  };
  const c = COLORS[status];
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: c.fg, background: c.bg, padding: "2px 6px", borderRadius: 4, textTransform: "uppercase" }}>
      {c.label}
    </span>
  );
}
