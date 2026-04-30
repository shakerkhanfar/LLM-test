import { useEffect, useState, useMemo } from "react";
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
  topIssues: Array<{ text: string; severity: string; count: number }>;
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
  const sentimentData = useMemo(() => {
    if (!dashData) return [];
    const colors: Record<string, string> = { positive: "#22c55e", neutral: "#9ca3af", negative: "#ef4444" };
    return Object.entries(dashData.sentiment)
      .filter(([, v]) => v > 0)
      .map(([name, value]) => ({ name, value, color: colors[name] || "#9ca3af" }));
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
    const sorted = [...((project.runs ?? []) as any[])].sort(
      (a, b) => new Date(b.callDate || b.createdAt).getTime() - new Date(a.callDate || a.createdAt).getTime()
    );
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
  }, [project.runs, tableSearch, outcomeColumns]);

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
        {[
          { label: "Total Runs", value: totalRuns, color: T.text },
          { label: "Avg Score", value: avgScore != null ? `${avgScore}%` : "—", color: "#17B26A" },
          { label: "Pass Rate", value: passRate != null ? `${passRate}%` : "—", color: "#17B26A" },
          { label: "Objective Achieved", value: dashData?.objectiveRate != null ? `${Math.round(dashData.objectiveRate * 100)}%` : "—", color: T.text },
          { label: "Avg Duration", value: avgDuration ?? "—", color: T.text },
        ].map(({ label, value, color }) => (
          <div key={label} style={CARD_STYLE}>
            <div style={SECTION_LABEL_STYLE}>{label}</div>
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
          <div style={SECTION_LABEL_STYLE}>Score Over Time</div>
          {trendData.length < 2 ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>Not enough data</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <XAxis dataKey="idx" tick={{ fontSize: 10, fill: T.textMuted }} tickLine={false} axisLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: T.textMuted }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 11 }}
                  formatter={(value: number | null, name: string) => {
                    if (value == null) return [null, null];
                    if (name === "score") return [`${value}%`, "Score"];
                    if (name === "rolling") return [`${value}%`, "7-run avg"];
                    return [value, name];
                  }}
                  labelFormatter={(label: number) => {
                    const d = trendData[label - 1];
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
              <PieChart width={110} height={110}>
                <Pie data={outcomeCounts} cx={50} cy={50} innerRadius={35} outerRadius={55} dataKey="value" paddingAngle={2}>
                  {outcomeCounts.map((entry, idx) => (
                    <Cell key={idx} fill={getOutcomeColor(entry.name)} />
                  ))}
                </Pie>
              </PieChart>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
                {outcomeCounts.map((entry, idx) => (
                  <div key={idx} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: getOutcomeColor(entry.name), flexShrink: 0 }} />
                    <span style={{ color: T.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                      {entry.name}
                    </span>
                    <span style={{ color: T.text, fontWeight: 600, flexShrink: 0 }}>
                      {Math.round((entry.value / totalRuns) * 100)}%
                    </span>
                  </div>
                ))}
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
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <PieChart width={110} height={110}>
                <Pie data={sentimentData} cx={50} cy={50} innerRadius={35} outerRadius={55} dataKey="value" paddingAngle={2}>
                  {sentimentData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.color} />
                  ))}
                </Pie>
              </PieChart>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
                {sentimentData.map((entry, idx) => {
                  const total = sentimentData.reduce((s, e) => s + e.value, 0);
                  return (
                    <div key={idx} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: entry.color, flexShrink: 0 }} />
                      <span style={{ color: T.textSecondary, flex: 1, textTransform: "capitalize" }}>{entry.name}</span>
                      <span style={{ color: T.text, fontWeight: 600, flexShrink: 0 }}>
                        {Math.round((entry.value / total) * 100)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Diagnostics Row */}
      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr 1fr", gap: 12 }}>
        {/* Most Common Issues */}
        <div style={CARD_STYLE}>
          <div style={SECTION_LABEL_STYLE}>Most Common Issues</div>
          {!dashData ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>Loading...</div>
          ) : dashData.topIssues.length === 0 ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>No issues found</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {dashData.topIssues.map((issue, idx) => (
                <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 }}>
                  <SeverityBadge severity={issue.severity} />
                  <span style={{ flex: 1, color: T.text, lineHeight: 1.3 }}>{issue.text}</span>
                  <span style={{
                    flexShrink: 0, fontSize: 11, fontWeight: 700, color: T.textMuted,
                    background: T.cardAlt, borderRadius: 10, padding: "1px 7px",
                  }}>
                    {issue.count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Score Distribution */}
        <div style={CARD_STYLE}>
          <div style={SECTION_LABEL_STYLE}>Score Distribution</div>
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
                    formatter={(value: number) => [value, "Runs"]}
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
          <div style={SECTION_LABEL_STYLE}>Node Performance</div>
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
      <div style={CARD_STYLE}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <div style={SECTION_LABEL_STYLE}>Call Outcomes</div>
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
                {["Conv ID", "Date", "Call Outcome", "Score", "Duration", ...outcomeColumns].map((col) => (
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
              {tableRuns.map((run: any) => (
                <tr key={run.id} style={{ borderBottom: `1px solid ${T.borderLight}` }}>
                  <td style={{ padding: "6px 10px", color: T.textMuted, fontFamily: "monospace", fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {run.conversationId ? run.conversationId.slice(0, 16) + (run.conversationId.length > 16 ? "…" : "") : "—"}
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
                </tr>
              ))}
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
