import { useEffect, useState, useMemo, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, BarChart, Bar,
} from "recharts";
import { getProjectDashboard } from "../api/client";
import T from "../theme";

interface DashData {
  totalRuns: number;
  sentiment: Record<string, number>;
  objectiveRate: number | null;
  nodePerformance: Array<{ label: string; avg: number; count: number }>;
  topIssues: Array<{ text: string; severity: string; count: number; runIds: string[] }>;
}

interface Props {
  project: any;
}

const OUTCOME_COLORS: Record<string, string> = {
  appointment_booked: "#17B26A",
  booked: "#17B26A",
  completed: "#17B26A",
  transferred: "#3b82f6",
  out_of_scope: "#a78bfa",
  oos: "#a78bfa",
  timeout: "#f59e0b",
  stuck: "#ef4444",
};

const OUTCOME_SKIP_KEYS = ["default_params", "summary", "language", "call_outcome"];

const CARD_STYLE: React.CSSProperties = {
  background: T.card,
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  padding: "18px 20px",
  boxShadow: T.shadow,
};

const SECTION_LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: T.textMuted,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  marginBottom: 10,
};

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function rollingAvg(data: number[], window: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < window - 1) return null;
    const slice = data.slice(i - window + 1, i + 1);
    return Math.round((slice.reduce((a, b) => a + b, 0) / slice.length) * 10) / 10;
  });
}

function scoreColor(score: number): string {
  if (score >= 70) return "#17B26A";
  if (score >= 50) return "#f59e0b";
  return "#ef4444";
}

function SeverityBadge({ severity }: { severity: string }) {
  const color = severity === "critical" ? "#ef4444" : severity === "warning" ? "#f59e0b" : "#9ca3af";
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, color, background: color + "22",
      borderRadius: 4, padding: "1px 5px", textTransform: "uppercase", letterSpacing: 0.4,
    }}>
      {severity}
    </span>
  );
}

function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        style={{
          background: "none", border: "none", cursor: "pointer", padding: "0 0 0 4px",
          fontSize: 11, color: T.textMuted, lineHeight: 1, display: "inline-flex", alignItems: "center",
        }}
        aria-label="More information"
      >
        ⓘ
      </button>
      {show && (
        <span style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
          background: "#1f2937", color: "#f9fafb", fontSize: 11, lineHeight: 1.5,
          borderRadius: 6, padding: "6px 10px", whiteSpace: "normal", width: 220,
          boxShadow: "0 4px 12px rgba(0,0,0,0.18)", zIndex: 100, pointerEvents: "none",
        }}>
          {text}
          <span style={{
            position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)",
            borderLeft: "5px solid transparent", borderRight: "5px solid transparent",
            borderTop: "5px solid #1f2937", width: 0, height: 0,
          }} />
        </span>
      )}
    </span>
  );
}

function ScorePill({ score }: { score: number }) {
  const color = score >= 7 ? "#17B26A" : score >= 5 ? "#f59e0b" : "#ef4444";
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, color, background: color + "22",
      borderRadius: 5, padding: "2px 7px", minWidth: 32, display: "inline-block", textAlign: "center",
    }}>
      {score.toFixed(1)}
    </span>
  );
}

export default function ProjectDashboard({ project }: Props) {
  const [dashData, setDashData] = useState<DashData | null>(null);
  const [dashError, setDashError] = useState<string | null>(null);
  const [tableSearch, setTableSearch] = useState("");
  const [expandedIssue, setExpandedIssue] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedOutcome, setSelectedOutcome] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  function selectOutcome(name: string) {
    setSelectedOutcome(prev => prev === name ? null : name);
    setTableSearch("");
    setTimeout(() => tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(key);
      setTimeout(() => setCopiedId(prev => prev === key ? null : prev), 1500);
    });
  }

  useEffect(() => {
    getProjectDashboard(project.id)
      .then((data: DashData) => setDashData(data))
      .catch((err: Error) => setDashError(err.message));
  }, [project.id]);

  const completeRuns = useMemo(
    () => ((project.runs ?? []) as any[]).filter((r: any) => r.status === "COMPLETE"),
    [project.runs]
  );

  // KPI computations
  const totalRuns = completeRuns.length;
  const avgScore = totalRuns === 0
    ? null
    : Math.round((completeRuns.reduce((s: number, r: any) => s + (r.overallScore ?? 0), 0) / totalRuns) * 100 * 10) / 10;
  const passRate = totalRuns === 0
    ? null
    : Math.round((completeRuns.filter((r: any) => (r.overallScore ?? 0) >= 0.7).length / totalRuns) * 100);
  const avgDuration = (() => {
    const withDur = completeRuns.filter((r: any) => r.callDuration != null);
    if (!withDur.length) return null;
    const avg = withDur.reduce((s: number, r: any) => s + r.callDuration, 0) / withDur.length;
    return fmtDuration(avg);
  })();

  // Score trend data
  const trendRuns = useMemo(() => {
    return [...completeRuns]
      .sort((a: any, b: any) => new Date(a.callDate || a.createdAt).getTime() - new Date(b.callDate || b.createdAt).getTime())
      .map((r: any, i: number) => ({
        idx: i + 1,
        score: r.overallScore != null ? Math.round(r.overallScore * 100) : null,
        date: r.callDate ? new Date(r.callDate).toLocaleDateString() : "",
      }));
  }, [completeRuns]);

  const rawScores = trendRuns.map((r) => r.score ?? 0);
  const rolling = rollingAvg(rawScores, 7);

  const trendData = trendRuns.map((r, i) => ({
    idx: r.idx,
    score: r.score,
    rolling: rolling[i],
    date: r.date,
  }));

  // Outcome donut
  const outcomeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of completeRuns) {
      const key = r.callOutcome || "unknown";
      counts[key] = (counts[key] || 0) + 1;
    }
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [completeRuns]);

  // Sentiment donut
  const SENTIMENT_COLORS: Record<string, string> = {
    positive: "#17B26A",
    neutral:  "#3b82f6",
    negative: "#ef4444",
    unknown:  "#d1d5db",
  };
  const SENTIMENT_ORDER = ["positive", "neutral", "negative", "unknown"];
  const sentimentData = useMemo(() => {
    if (!dashData) return [];
    return SENTIMENT_ORDER
      .filter(k => (dashData.sentiment[k] ?? 0) > 0)
      .map(k => ({ name: k, value: dashData.sentiment[k], color: SENTIMENT_COLORS[k] }));
  }, [dashData]);

  // Score distribution
  const scoreDistData = useMemo(() => {
    const bins = Array.from({ length: 10 }, (_, i) => ({
      range: `${i * 10}-${i * 10 + 10}`,
      count: 0,
      fill: i * 10 >= 70 ? "#17B26A" : i * 10 >= 50 ? "#f59e0b" : "#ef4444",
    }));
    for (const r of completeRuns) {
      if (r.overallScore == null) continue;
      const pct = Math.min(r.overallScore * 100, 99.99);
      const bin = Math.floor(pct / 10);
      bins[bin].count++;
    }
    return bins;
  }, [completeRuns]);

  // Only count runs that actually have a score (COMPLETE runs without score are still in-progress evals)
  const scoredRuns = completeRuns.filter((r: any) => r.overallScore != null);
  const passCount = scoredRuns.filter((r: any) => r.overallScore >= 0.7).length;
  const warnCount = scoredRuns.filter((r: any) => r.overallScore >= 0.5 && r.overallScore < 0.7).length;
  const failCount = scoredRuns.filter((r: any) => r.overallScore < 0.5).length;

  // Call outcomes table
  const outcomeColumns = useMemo(() => {
    const keys = new Set<string>();
    for (const r of ((project.runs ?? []) as any[])) {
      if (r.outcomeResult && typeof r.outcomeResult === "object") {
        for (const k of Object.keys(r.outcomeResult)) {
          if (!OUTCOME_SKIP_KEYS.includes(k)) keys.add(k);
        }
      }
    }
    return [...keys];
  }, [project.runs]);

  const tableRuns = useMemo(() => {
    let sorted = [...((project.runs ?? []) as any[])].sort(
      (a, b) => new Date(b.callDate || b.createdAt).getTime() - new Date(a.callDate || a.createdAt).getTime()
    );
    if (selectedOutcome) {
      sorted = sorted.filter((r: any) => (r.callOutcome || "unknown") === selectedOutcome);
    }
    if (!tableSearch.trim()) return sorted;
    const q = tableSearch.toLowerCase();
    return sorted.filter((r: any) => {
      const score = r.overallScore != null ? String(Math.round(r.overallScore * 100)) : "";
      const dur = r.callDuration ? fmtDuration(r.callDuration) : "";
      return (
        (r.conversationId || "").toLowerCase().includes(q) ||
        (r.callOutcome || "").toLowerCase().includes(q) ||
        score.includes(q) ||
        dur.includes(q) ||
        outcomeColumns.some((k) => String((r.outcomeResult || {})[k] || "").toLowerCase().includes(q))
      );
    });
  }, [project.runs, tableSearch, outcomeColumns, selectedOutcome]);

  function exportCsv() {
    const headers = ["Conv ID", "Date", "Call Outcome", "Score", "Duration", ...outcomeColumns];
    const rows = tableRuns.map((r: any) => {
      const base = [
        r.conversationId || "",
        r.callDate ? new Date(r.callDate).toLocaleDateString() : "",
        r.callOutcome || "",
        r.overallScore != null ? Math.round(r.overallScore * 100) + "%" : "",
        r.callDuration ? fmtDuration(r.callDuration) : "",
      ];
      const dyn = outcomeColumns.map((k) => {
        const val = (r.outcomeResult || {})[k];
        if (val == null) return "";
        if (typeof val === "object") return JSON.stringify(val);
        return String(val);
      });
      return [...base, ...dyn];
    });
    const esc = (v: string) => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const csv = [headers, ...rows].map((row) => row.map(String).map(esc).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(project.name || "project").replace(/[^a-zA-Z0-9]/g, "_")}_outcomes.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function getOutcomeColor(outcome: string): string {
    const key = (outcome || "").toLowerCase();
    for (const [k, v] of Object.entries(OUTCOME_COLORS)) {
      if (key === k || key.includes(k)) return v;
    }
    return "#9ca3af";
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* KPI Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
        {([
          { label: "Total Runs", value: totalRuns, color: T.text,
            tip: "Total number of evaluated calls in this project, including all statuses." },
          { label: "Avg Score", value: avgScore != null ? `${avgScore}%` : "—", color: "#17B26A",
            tip: "Weighted average evaluation score across all completed calls. 70%+ is passing. Combines structural flow (30%), per-node LLM scoring (50%), and overall call quality (20%)." },
          { label: "Pass Rate", value: passRate != null ? `${passRate}%` : "—", color: "#17B26A",
            tip: "Percentage of completed calls that scored 70% or above. A call passes when the agent handled the conversation correctly end-to-end." },
          { label: "Objective Achieved", value: dashData?.objectiveRate != null ? `${Math.round(dashData.objectiveRate * 100)}%` : "—", color: T.text,
            tip: "Percentage of calls where the main call objective was met (e.g., appointment booked, request resolved). Out-of-scope calls handled with a correct transfer are counted as objective achieved." },
          { label: "Avg Duration", value: avgDuration ?? "—", color: T.text,
            tip: "Average call duration across completed calls. Unusually long calls may indicate the agent got stuck or the user was unresponsive." },
        ] as const).map(({ label, value, color, tip }) => (
          <div key={label} style={CARD_STYLE}>
            <div style={{ ...SECTION_LABEL_STYLE, display: "flex", alignItems: "center", marginBottom: 8 }}>
              {label}<InfoTip text={tip} />
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Loading indicator */}
      {!dashData && !dashError && (
        <div style={{ ...CARD_STYLE, color: T.textMuted, fontSize: 13, textAlign: "center", padding: 24 }}>
          Loading dashboard data...
        </div>
      )}
      {dashError && (
        <div style={{ ...CARD_STYLE, color: T.error, fontSize: 13, padding: 24 }}>
          Dashboard error: {dashError}
        </div>
      )}

      {/* Charts Row */}
      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr", gap: 12 }}>
        {/* Score Over Time */}
        <div style={CARD_STYLE}>
          <div style={{ ...SECTION_LABEL_STYLE, display: "flex", alignItems: "center" }}>Score Over Time<InfoTip text="Each dot is one call's overall score (0–100%). The green line is a 7-call rolling average, smoothing out individual outliers to show the trend." /></div>
          {trendData.length < 2 ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>Not enough data</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <XAxis dataKey="idx" tick={{ fontSize: 10, fill: T.textMuted }} tickLine={false} axisLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: T.textMuted }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 11 }}
                  formatter={(value: any, name: any) => {
                    if (value == null) return ["—", name];
                    if (name === "score") return [`${value}%`, "Score"];
                    if (name === "rolling") return [`${value}%`, "7-run avg"];
                    return [`${value}`, name];
                  }}
                  labelFormatter={(label: any) => {
                    const d = trendData[(label as number) - 1];
                    return d?.date || `Run ${label}`;
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="none"
                  dot={(props: any) => {
                    const { cx, cy, payload } = props;
                    if (payload.score == null) return <g key={`dot-${cx}-${cy}`} />;
                    return (
                      <circle
                        key={`dot-${cx}-${cy}`}
                        cx={cx} cy={cy} r={3}
                        fill={scoreColor(payload.score)}
                        stroke="none"
                      />
                    );
                  }}
                  activeDot={{ r: 5 }}
                  connectNulls={false}
                />
                <Line
                  type="monotone"
                  dataKey="rolling"
                  stroke="#17B26A"
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  strokeDasharray="4 2"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Call Outcomes Donut */}
        <div style={CARD_STYLE}>
          <div style={SECTION_LABEL_STYLE}>Call Outcomes</div>
          {outcomeCounts.length === 0 ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>Not enough data</div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <PieChart width={110} height={110} style={{ cursor: "pointer" }}>
                <Pie
                  data={outcomeCounts}
                  cx={50} cy={50}
                  innerRadius={35} outerRadius={55}
                  dataKey="value"
                  paddingAngle={2}
                  onClick={(data: any) => selectOutcome(data.name)}
                >
                  {outcomeCounts.map((entry, idx) => {
                    const isSelected = selectedOutcome === entry.name;
                    const isDimmed = selectedOutcome && !isSelected;
                    return (
                      <Cell
                        key={idx}
                        fill={getOutcomeColor(entry.name)}
                        opacity={isDimmed ? 0.3 : 1}
                        stroke={isSelected ? "#111827" : "none"}
                        strokeWidth={isSelected ? 2 : 0}
                      />
                    );
                  })}
                </Pie>
              </PieChart>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
                {outcomeCounts.map((entry, idx) => {
                  const isSelected = selectedOutcome === entry.name;
                  const isDimmed = selectedOutcome && !isSelected;
                  return (
                    <div
                      key={idx}
                      onClick={() => selectOutcome(entry.name)}
                      style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, cursor: "pointer", opacity: isDimmed ? 0.4 : 1, borderRadius: 4, padding: "1px 3px", background: isSelected ? getOutcomeColor(entry.name) + "18" : "none" }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: getOutcomeColor(entry.name), flexShrink: 0 }} />
                      <span style={{ color: isSelected ? T.text : T.textSecondary, fontWeight: isSelected ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        {entry.name}
                      </span>
                      <span style={{ color: T.text, fontWeight: 600, flexShrink: 0 }}>
                        {Math.round((entry.value / totalRuns) * 100)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Caller Sentiment Donut */}
        <div style={CARD_STYLE}>
          <div style={SECTION_LABEL_STYLE}>Caller Sentiment</div>
          {!dashData ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>Loading...</div>
          ) : sentimentData.length === 0 ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>Not enough data</div>
          ) : (() => {
            const total = sentimentData.reduce((s, e) => s + e.value, 0);
            const knownTotal = sentimentData.filter(e => e.name !== "unknown").reduce((s, e) => s + e.value, 0);
            const posCount = dashData.sentiment.positive ?? 0;
            const negCount = dashData.sentiment.negative ?? 0;
            const neuCount = dashData.sentiment.neutral ?? 0;
            const unknownPct = total > 0 ? Math.round(((dashData.sentiment.unknown ?? 0) / total) * 100) : 0;
            const insight = (() => {
              if (knownTotal === 0) return "No sentiment data yet — calls haven't been evaluated.";
              const posPct = Math.round((posCount / knownTotal) * 100);
              const negPct = Math.round((negCount / knownTotal) * 100);
              const neuPct = Math.round((neuCount / knownTotal) * 100);
              if (posPct >= 60) return `${posPct}% of callers felt positive — strong experience.`;
              if (negPct >= 40) return `${negPct}% of callers felt negative — review failed calls.`;
              if (neuPct >= 60) return `Most callers felt neutral (${neuPct}%) — limited emotional signal.`;
              return `Mixed sentiment: ${posPct}% positive, ${neuPct}% neutral, ${negPct}% negative.`;
            })();
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <PieChart width={110} height={110}>
                    <Pie data={sentimentData} cx={50} cy={50} innerRadius={35} outerRadius={55} dataKey="value" paddingAngle={2}>
                      {sentimentData.map((entry, idx) => (
                        <Cell key={idx} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1, minWidth: 0 }}>
                    {sentimentData.map((entry, idx) => (
                      <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                        <span style={{ width: 9, height: 9, borderRadius: "50%", background: entry.color, flexShrink: 0, border: entry.name === "unknown" ? `1px solid ${T.border}` : "none" }} />
                        <span style={{ color: T.textSecondary, flex: 1, textTransform: "capitalize" }}>
                          {entry.name === "unknown" ? "Not analysed" : entry.name}
                        </span>
                        <span style={{ color: entry.name === "unknown" ? T.textMuted : T.text, fontWeight: entry.name === "unknown" ? 400 : 600, flexShrink: 0 }}>
                          {Math.round((entry.value / total) * 100)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: T.textSecondary, lineHeight: 1.4, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                  {insight}
                  {unknownPct > 30 && (
                    <span style={{ color: T.textMuted }}> ({unknownPct}% of calls were not scored by the LLM judge.)</span>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Diagnostics Row */}
      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr 1fr", gap: 12 }}>
        {/* Most Common Issues */}
        <div style={CARD_STYLE}>
          <div style={{ ...SECTION_LABEL_STYLE, display: "flex", alignItems: "center" }}>Most Common Issues<InfoTip text="Issues identified by the LLM judge across all calls, deduplicated and counted. Click the number to see which calls had each issue." /></div>
          {!dashData ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>Loading...</div>
          ) : dashData.topIssues.length === 0 ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>No issues found</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {dashData.topIssues.map((issue, idx) => {
                const isOpen = expandedIssue === idx;
                const affectedRuns = (project.runs ?? []).filter((r: any) => issue.runIds.includes(r.id));
                return (
                  <div key={idx}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, padding: "4px 0" }}>
                      <SeverityBadge severity={issue.severity} />
                      <span style={{ flex: 1, color: T.text, lineHeight: 1.4 }}>{issue.text}</span>
                      <button
                        onClick={() => setExpandedIssue(isOpen ? null : idx)}
                        title="View affected calls"
                        style={{
                          flexShrink: 0, fontSize: 11, fontWeight: 700,
                          color: isOpen ? "#fff" : T.primary,
                          background: isOpen ? T.primary : T.primary + "18",
                          border: "none", borderRadius: 10, padding: "1px 9px",
                          cursor: "pointer", lineHeight: "20px",
                        }}
                      >
                        {issue.count}
                      </button>
                    </div>
                    {isOpen && (
                      <div style={{
                        margin: "2px 0 6px 0", borderRadius: 7,
                        border: `1px solid ${T.border}`, overflow: "hidden",
                      }}>
                        {affectedRuns.length === 0 ? (
                          <div style={{ padding: "8px 12px", fontSize: 12, color: T.textMuted }}>
                            Run details not available in current view.
                          </div>
                        ) : (
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                            <thead>
                              <tr style={{ background: T.cardAlt }}>
                                {["Conv ID", "Date", "Score", "Outcome"].map(h => (
                                  <th key={h} style={{ padding: "5px 10px", textAlign: "left", fontWeight: 600, color: T.textMuted, letterSpacing: 0.3 }}>{h}</th>
                                ))}
                                <th style={{ padding: "5px 10px" }} />
                              </tr>
                            </thead>
                            <tbody>
                              {affectedRuns.map((r: any, ri: number) => (
                                <tr key={r.id} style={{ borderTop: ri > 0 ? `1px solid ${T.border}` : "none" }}>
                                  <td style={{ padding: "6px 10px", fontFamily: "monospace", color: T.textMuted }}>
                                    {(r.conversationId || r.id || "—").slice(0, 13)}
                                  </td>
                                  <td style={{ padding: "6px 10px", color: T.textSecondary }}>
                                    {r.callDate ? new Date(r.callDate).toLocaleDateString() : "—"}
                                  </td>
                                  <td style={{ padding: "6px 10px" }}>
                                    {r.overallScore != null
                                      ? <ScorePill score={r.overallScore * 10} />
                                      : <span style={{ color: T.textMuted }}>—</span>}
                                  </td>
                                  <td style={{ padding: "6px 10px", color: T.textSecondary, textTransform: "capitalize" }}>
                                    {(r.callOutcome || "—").replace(/_/g, " ")}
                                  </td>
                                  <td style={{ padding: "6px 10px", textAlign: "right" }}>
                                    <a
                                      href={`/projects/${project.id}/runs/${r.id}`}
                                      style={{ color: T.primary, fontSize: 11, fontWeight: 500, textDecoration: "none" }}
                                    >
                                      View →
                                    </a>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Score Distribution */}
        <div style={CARD_STYLE}>
          <div style={{ ...SECTION_LABEL_STYLE, display: "flex", alignItems: "center" }}>Score Distribution<InfoTip text="How calls are spread across score buckets. Green = passed (≥70%), amber = warning (50–69%), red = failed (<50%). A healthy agent has most calls in the 70–100% range." /></div>
          {completeRuns.length < 2 ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>Not enough data</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={150}>
                <BarChart data={scoreDistData} margin={{ top: 4, right: 0, bottom: 0, left: -28 }} barCategoryGap="20%">
                  <XAxis dataKey="range" tick={{ fontSize: 9, fill: T.textMuted }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: T.textMuted }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 11 }}
                    formatter={(value: any) => [value, "Runs"]}
                  />
                  <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                    {scoreDistData.map((entry, idx) => (
                      <Cell key={idx} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                {[
                  { label: "Pass ≥70%", count: passCount, color: "#17B26A" },
                  { label: "Warn 50-69%", count: warnCount, color: "#f59e0b" },
                  { label: "Fail <50%", count: failCount, color: "#ef4444" },
                ].map(({ label, count, color }) => (
                  <div key={label} style={{
                    flex: 1, background: color + "18", borderRadius: 6, padding: "6px 8px", textAlign: "center",
                    border: `1px solid ${color}44`,
                  }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color }}>{count}</div>
                    <div style={{ fontSize: 10, color, fontWeight: 600 }}>{label}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Node Performance */}
        <div style={CARD_STYLE}>
          <div style={{ ...SECTION_LABEL_STYLE, display: "flex", alignItems: "center" }}>Node Performance<InfoTip text="Average LLM score (0–10) per workflow node, across all evaluated calls. Low-scoring nodes are where the agent most often fails to follow instructions or gets stuck. ×N = number of times the node was visited." /></div>
          {!dashData ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>Loading...</div>
          ) : dashData.nodePerformance.length === 0 ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>No node data</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7, maxHeight: 220, overflowY: "auto" }}>
              {dashData.nodePerformance.map((node, idx) => (
                <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>
                      {node.label}
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: T.cardAlt, overflow: "hidden" }}>
                      <div style={{
                        height: "100%",
                        width: `${Math.min((node.avg / 10) * 100, 100)}%`,
                        background: node.avg >= 7 ? "#17B26A" : node.avg >= 5 ? "#f59e0b" : "#ef4444",
                        borderRadius: 2,
                        transition: "width 0.3s",
                      }} />
                    </div>
                  </div>
                  <ScorePill score={node.avg} />
                  <span style={{ fontSize: 10, color: T.textMuted, flexShrink: 0 }}>×{node.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Call Outcomes Table */}
      <div ref={tableRef} style={{ ...CARD_STYLE, scrollMarginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={SECTION_LABEL_STYLE}>Call Outcomes</div>
            {selectedOutcome && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                fontSize: 11, fontWeight: 600,
                color: getOutcomeColor(selectedOutcome),
                background: getOutcomeColor(selectedOutcome) + "18",
                border: `1px solid ${getOutcomeColor(selectedOutcome)}44`,
                borderRadius: 20, padding: "2px 10px",
              }}>
                {selectedOutcome}
                <button onClick={() => setSelectedOutcome(null)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 12, color: "inherit", lineHeight: 1 }}>×</button>
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              placeholder="Search..."
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              style={{
                padding: "5px 10px",
                background: T.input,
                border: `1px solid ${T.borderDark}`,
                borderRadius: 4,
                color: T.text,
                fontSize: 12,
                width: 200,
              }}
            />
            <button
              onClick={exportCsv}
              style={{
                padding: "5px 12px",
                background: T.primary,
                color: "#fff",
                border: "none",
                borderRadius: 5,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Export CSV
            </button>
          </div>
        </div>
        <div style={{ maxHeight: 400, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {["Conv ID", "Date", "Call Outcome", "Score", "Duration", ...outcomeColumns, ""].map((col) => (
                  <th key={col} style={{
                    padding: "6px 10px", textAlign: "left", fontWeight: 600,
                    color: T.textMuted, fontSize: 11, whiteSpace: "nowrap",
                    position: "sticky", top: 0, background: T.card,
                  }}>
                    {col.replace(/_/g, " ")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRuns.map((run: any) => {
                const rowKey = `row-${run.id}`;
                const convKey = `conv-${run.id}`;
                const rowCopied = copiedId === rowKey;
                const convCopied = copiedId === convKey;

                function copyRow() {
                  const vals = [
                    run.conversationId || "",
                    run.callDate ? new Date(run.callDate).toLocaleDateString() : "",
                    run.callOutcome || "",
                    run.overallScore != null ? Math.round(run.overallScore * 100) + "%" : "",
                    run.callDuration ? fmtDuration(run.callDuration) : "",
                    ...outcomeColumns.map(k => {
                      const v = (run.outcomeResult || {})[k];
                      return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
                    }),
                  ];
                  copyToClipboard(vals.join("\t"), rowKey);
                }

                return (
                <tr key={run.id} style={{ borderBottom: `1px solid ${T.borderLight}` }}>
                  <td style={{ padding: "6px 10px", fontFamily: "monospace", fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <span
                      onClick={() => run.conversationId && copyToClipboard(run.conversationId, convKey)}
                      title={run.conversationId ? (convCopied ? "Copied!" : "Click to copy full ID") : undefined}
                      style={{ color: convCopied ? T.primary : T.textMuted, cursor: run.conversationId ? "pointer" : "default" }}
                    >
                      {convCopied ? "✓ Copied" : (run.conversationId ? run.conversationId.slice(0, 16) + (run.conversationId.length > 16 ? "…" : "") : "—")}
                    </span>
                  </td>
                  <td style={{ padding: "6px 10px", color: T.textSecondary, whiteSpace: "nowrap" }}>
                    {run.callDate ? new Date(run.callDate).toLocaleDateString() : "—"}
                  </td>
                  <td style={{ padding: "6px 10px" }}>
                    {run.callOutcome ? (
                      <span style={{
                        fontSize: 11, fontWeight: 600,
                        color: getOutcomeColor(run.callOutcome),
                        background: getOutcomeColor(run.callOutcome) + "22",
                        borderRadius: 4, padding: "2px 6px",
                      }}>
                        {run.callOutcome}
                      </span>
                    ) : "—"}
                  </td>
                  <td style={{ padding: "6px 10px", fontWeight: 600, color: run.overallScore != null ? scoreColor(Math.round(run.overallScore * 100)) : T.textMuted }}>
                    {run.overallScore != null ? `${Math.round(run.overallScore * 100)}%` : "—"}
                  </td>
                  <td style={{ padding: "6px 10px", color: T.textMuted, whiteSpace: "nowrap" }}>
                    {run.callDuration ? fmtDuration(run.callDuration) : "—"}
                  </td>
                  {outcomeColumns.map((key) => (
                    <td key={key} style={{ padding: "6px 10px", color: T.textSecondary, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {String((run.outcomeResult || {})[key] ?? "—")}
                    </td>
                  ))}
                  <td style={{ padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      onClick={copyRow}
                      title="Copy row as tab-separated values"
                      style={{
                        background: "none", border: "none", cursor: "pointer", padding: "2px 6px",
                        fontSize: 11, color: rowCopied ? T.primary : T.textMuted,
                        borderRadius: 4,
                      }}
                    >
                      {rowCopied ? "✓" : "⎘"}
                    </button>
                    <a href={`/projects/${project.id}/runs/${run.id}`} style={{ color: T.primary, fontSize: 11, fontWeight: 500, textDecoration: "none", marginLeft: 4 }}>→</a>
                  </td>
                </tr>
                );
              })}
              {tableRuns.length === 0 && (
                <tr>
                  <td colSpan={5 + outcomeColumns.length} style={{ padding: "20px 10px", textAlign: "center", color: T.textMuted }}>
                    No results
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
