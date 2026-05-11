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
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  listProjects, compareReports, explainComparisonResolution,
  type ComparisonWindow,
} from "../api/client";
import T from "../theme";

// ─── Types mirrored from backend (kept loose; we cast `any` where needed) ────

type IssueSource = "L4_critical" | "L3_node" | "intel_failure";
type IssueStatus = "only_left" | "only_right" | "resolved" | "reduced" | "worsened" | "unchanged";

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

  const canRun = leftProj && rightProj && !running;

  async function run() {
    setRunning(true);
    setError(null);
    setReport(null);
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
          style={{
            background: canRun ? T.primary : T.card, color: canRun ? "#fff" : T.textMuted,
            border: "none", padding: "10px 18px", borderRadius: 6, fontSize: 14, fontWeight: 600,
            cursor: canRun ? "pointer" : "default",
          }}
        >
          {running ? "Comparing…" : "Generate comparison"}
        </button>
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

function ComparisonResult({ report }: { report: any }) {
  const leftName  = report.left?.projectName  ?? "Left";
  const rightName = report.right?.projectName ?? "Right";
  const lk = report.left?.kpis  ?? {};
  const rk = report.right?.kpis ?? {};
  const d  = report.deltas      ?? {};

  return (
    <div style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 18, marginBottom: 12 }}>KPIs</h2>
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
            {kpiRow("Total runs",            lk.totalRuns, rk.totalRuns, d.totalRuns, false, (v: any) => v ?? 0)}
            {kpiRow("Success rate",          lk.successRate,           rk.successRate,           d.successRate, false, formatPct)}
            {kpiRow("Drop-off rate",         lk.dropOffRate,           rk.dropOffRate,           d.dropOffRate, true,  formatPct)}
            {kpiRow("Escalation rate",       lk.escalationRate,        rk.escalationRate,        d.escalationRate, true, formatPct)}
            {kpiRow("Overall pass rate",     lk.overallPassRate,       rk.overallPassRate,       d.overallPassRate, false, formatPct)}
            {kpiRow("Objective achieved",    lk.objectiveAchievedRate, rk.objectiveAchievedRate, d.objectiveAchievedRate, false, formatPct)}
            {kpiRow("Avg duration",          lk.avgDurationSec,        rk.avgDurationSec,        d.avgDurationSec, true,  formatDur)}
            {kpiRow("Avg turns/call",        lk.avgTurnsPerCall,       rk.avgTurnsPerCall,       d.avgTurnsPerCall, true,  (v: any) => v == null ? "—" : String(v))}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: 18, margin: "28px 0 12px" }}>
        Issues
        <span style={{ fontSize: 12, color: T.textMuted, fontWeight: 400, marginLeft: 8 }}>
          (compared by normalized text + source + node)
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

function kpiRow(label: string, l: any, r: any, delta: number | null | undefined, lowerIsBetter: boolean, fmt: (v: any) => string) {
  return (
    <tr key={label}>
      <td style={{ ...cellTD, color: T.textSecondary }}>{label}</td>
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
            style={{
              fontSize: 11, padding: "3px 8px", borderRadius: 4,
              background: T.input, color: T.link, border: `1px solid ${T.border}`, textDecoration: "none",
              fontFamily: "monospace",
            }}
            title={`${o.callDate ?? "no date"} · outcome=${o.callOutcome ?? "?"}`}
          >
            {o.conversationId ? o.conversationId.slice(0, 8) : o.runId.slice(0, 8)}
          </Link>
        ))}
      </div>
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
