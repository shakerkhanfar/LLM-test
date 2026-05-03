import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import T from "../theme";
import { getProjectReport, generateIntelligenceReport, getProject } from "../api/client";

// ─── Mini Bar Chart (pure SVG, no deps) ─────────────────────────────────────

function MiniBarChart({
  values,
  labels,
  color,
  height = 60,
}: {
  values: number[];
  labels: string[];
  color: string;
  height?: number;
}) {
  const max = Math.max(...values, 1);
  const w = 32;
  const gap = 6;
  const totalW = values.length * (w + gap) - gap;

  return (
    <svg width={totalW} height={height + 20} style={{ overflow: "visible" }}>
      {values.map((v, i) => {
        const barH = Math.max((v / max) * height, 2);
        const x = i * (w + gap);
        const y = height - barH;
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={barH} rx={3} fill={color} opacity={0.85} />
            <text x={x + w / 2} y={height + 14} textAnchor="middle" fontSize={9} fill={T.textMuted}>
              {labels[i]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── KPI Card ────────────────────────────────────────────────────────────────

function KpiCard({
  title,
  value,
  subtitle,
  trend,
  weekLabels,
  barColor,
  valueColor,
}: {
  title: string;
  value: string;
  subtitle: string;
  trend: number[];
  weekLabels: string[];
  barColor: string;
  valueColor: string;
}) {
  return (
    <div style={{
      background: T.card,
      border: `1px solid ${T.border}`,
      borderRadius: 12,
      padding: "24px 24px 20px",
      flex: 1,
      minWidth: 0,
      display: "flex",
      flexDirection: "column",
      gap: 6,
      boxShadow: T.shadowMd,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, letterSpacing: 1, textTransform: "uppercase" }}>
        {title}
      </div>
      <div style={{ fontSize: 42, fontWeight: 800, color: valueColor, lineHeight: 1.1, fontFamily: "system-ui, sans-serif" }}>
        {value}<span style={{ fontSize: 22, fontWeight: 700 }}>%</span>
      </div>
      <div style={{ fontSize: 13, color: T.textSecondary, marginBottom: 16 }}>{subtitle}</div>
      {trend.length > 0 && (
        <div style={{ marginTop: "auto" }}>
          <MiniBarChart values={trend} labels={weekLabels} color={barColor} />
        </div>
      )}
    </div>
  );
}

// ─── Printable metric table ──────────────────────────────────────────────────

function MetricTable({
  title,
  headerColor,
  rows,
}: {
  title: string;
  headerColor: string;
  rows: Array<{ label: string; value: string | null; highlight?: "green" | "amber" | "normal" | "muted"; italic?: boolean }>;
}) {
  return (
    <div style={{ marginBottom: 28 }}>
      {title && <h3 style={{ fontSize: 16, fontWeight: 700, color: "#1a5276", marginBottom: 8 }}>{title}</h3>}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ background: headerColor, color: "#fff", padding: "8px 12px", textAlign: "left", fontWeight: 600, width: "65%" }}>Metric</th>
            <th style={{ background: headerColor, color: "#fff", padding: "8px 12px", textAlign: "left", fontWeight: 600 }}>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const bg = i % 2 === 0 ? "#ffffff" : "#f0f4f8";
            const valColor = row.highlight === "green"  ? "#27ae60"
                           : row.highlight === "amber"  ? "#e67e22"
                           : row.highlight === "muted"  ? "#888"
                           : T.text;
            return (
              <tr key={i}>
                <td style={{ padding: "7px 12px", background: bg, fontStyle: row.italic ? "italic" : "normal", color: row.italic ? "#666" : T.text }}>
                  {row.label}
                </td>
                <td style={{ padding: "7px 12px", background: bg, color: valColor, fontWeight: row.highlight && row.highlight !== "muted" ? 700 : 400 }}>
                  {row.value ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")} min`;
}

function pct(n: number | null, suffix = "%"): string {
  if (n == null) return "—";
  return `${n.toFixed(1)}${suffix}`;
}

// L2 fix: null → "muted" so missing metrics don't appear highlighted in tables
function scoreHighlight(n: number | null): "green" | "amber" | "normal" | "muted" {
  if (n == null) return "muted";
  return n >= 85 ? "green" : n >= 65 ? "amber" : "normal";
}

// Clamp a % value to [0, 100] to prevent display glitches from float arithmetic
function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function ProjectReport() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject]     = useState<any>(null);
  const [report, setReport]       = useState<any>(null);
  const [reportLoading, setReportLoading] = useState(true);
  const [reportError,   setReportError]   = useState<string | null>(null);

  const [intel,        setIntel]        = useState<any>(null);
  const [intelLoading, setIntelLoading] = useState(false);
  const [intelError,   setIntelError]   = useState<string | null>(null);

  const [weeks, setWeeks] = useState(7);
  const printRef = useRef<HTMLDivElement>(null);

  // H1 fix: track latest report request to discard stale responses when weeks changes
  const reqRef = useRef(0);
  // H2 fix: track whether component is still mounted for intelligence request
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadReport = useCallback(async () => {
    if (!id) return;
    const req = ++reqRef.current;
    setReportLoading(true);
    setReportError(null);
    setReport(null);
    try {
      const [proj, rep] = await Promise.all([getProject(id), getProjectReport(id, weeks)]);
      if (req !== reqRef.current) return; // stale — newer request superseded this
      setProject(proj);
      setReport(rep);
    } catch (err) {
      if (req !== reqRef.current) return;
      setReportError((err as Error).message);
    } finally {
      if (req === reqRef.current) setReportLoading(false);
    }
  }, [id, weeks]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const handleGenerateIntel = async () => {
    if (!id) return;
    setIntelLoading(true);
    setIntelError(null);
    // Preserve previous intel while loading — only replace on success, keep on error
    try {
      // C2 fix: use UTC dates so window aligns with the backend's UTC-midnight bucketing
      const toDate   = new Date();
      const fromDate = new Date();
      fromDate.setUTCDate(fromDate.getUTCDate() - weeks * 7);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const result = await generateIntelligenceReport(id, { from: fmt(fromDate), to: fmt(toDate) });
      if (!mountedRef.current) return; // H2 fix: ignore if unmounted
      setIntel(result);
    } catch (err) {
      if (!mountedRef.current) return;
      // Parse error message — API client throws "API error NNN: {json body}"
      const raw = (err as Error).message ?? "";
      let msg = raw.replace(/^API error \d+:\s*/, "");
      // Try to unwrap JSON error body: {"error":"..."}
      try {
        const parsed = JSON.parse(msg);
        if (typeof parsed?.error === "string") msg = parsed.error;
      } catch { /* not JSON, use as-is */ }
      // M3 fix: friendlier message for known cases
      if (msg.includes("At least 3 evaluated runs") || msg.includes("Not enough")) {
        msg = "Not enough evaluated calls in this window. Try a wider date range.";
      }
      setIntelError(msg);
      // Intel is preserved (not cleared) — user still sees previous report with error overlay
    } finally {
      if (mountedRef.current) setIntelLoading(false);
    }
  };

  // M4 fix: only print when report is loaded and print section exists
  const handlePrint = () => {
    if (!report || !printRef.current) return;
    window.print();
  };

  // ── Render ───────────────────────────────────────────────────────

  if (reportLoading) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: T.textMuted }}>
        Loading report…
      </div>
    );
  }

  if (reportError) {
    return (
      <div style={{ padding: 40 }}>
        <div style={{ color: T.error, marginBottom: 12 }}>Failed to load report: {reportError}</div>
        <button onClick={loadReport} style={{ padding: "6px 14px", background: T.primary, color: "#fff", border: "none", borderRadius: T.radiusSm, cursor: "pointer" }}>
          Retry
        </button>
      </div>
    );
  }

  const doc          = report?.doc  ?? {};
  const kpis         = report?.kpis ?? {};
  const weekLabels: string[] = report?.weekLabels ?? [];
  const criterionRows: any[] = report?.criterionRows ?? [];

  const successRate    = clampPct(kpis.successRate?.current    ?? 0);
  const dropOffRate    = clampPct(kpis.dropOffRate?.current    ?? 0);
  const escalationRate = clampPct(kpis.escalationRate?.current ?? 0);
  const naturalCompRate = clampPct(100 - dropOffRate - escalationRate);

  // Exceptional (≥85%) and needs attention (<65%)
  const excRows  = criterionRows.filter(r => (r.passRate ?? 0) >= 85).slice(0, 5);
  const poorRows = criterionRows.filter(r => r.passRate != null && r.passRate < 65).slice(0, 5);
  const moreExc  = criterionRows.filter(r => (r.passRate ?? 0) >= 85).length - excRows.length;
  const morePoor = criterionRows.filter(r => r.passRate != null && r.passRate < 65).length - poorRows.length;

  return (
    <>
      {/* ── Print styles injected into <head> via a style tag ── */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #print-report, #print-report * { visibility: visible !important; }
          #print-report { position: fixed; left: 0; top: 0; width: 100%; padding: 24px; box-sizing: border-box; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div style={{ maxWidth: 1100, margin: "0 auto" }}>

        {/* ── Breadcrumb + controls ── */}
        <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
          <Link to={`/projects/${id}`} style={{ color: T.link, fontSize: 13, textDecoration: "none" }}>
            ← {project?.name ?? "Project"}
          </Link>
          <span style={{ color: T.textMuted, fontSize: 13 }}>/</span>
          <span style={{ fontSize: 13, color: T.text }}>Report</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {/* H1 fix: disable selector while loading to prevent race condition */}
            <select
              value={weeks}
              disabled={reportLoading}
              onChange={(e) => setWeeks(Number(e.target.value))}
              style={{
                fontSize: 12, padding: "4px 8px",
                border: `1px solid ${T.borderDark}`,
                borderRadius: T.radiusSm,
                background: T.card, color: T.text,
                opacity: reportLoading ? 0.5 : 1,
              }}
            >
              {[4, 7, 12, 26].map((w) => (
                <option key={w} value={w}>Last {w} weeks</option>
              ))}
            </select>
            <button
              onClick={handlePrint}
              disabled={!report}
              style={{
                padding: "6px 14px", background: T.card,
                border: `1px solid ${T.border}`,
                borderRadius: T.radiusSm, cursor: report ? "pointer" : "default",
                fontSize: 13, color: T.textSecondary,
                opacity: report ? 1 : 0.4,
              }}
            >
              Export / Print
            </button>
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════
            SECTION 1: MONITORING DASHBOARD
        ═══════════════════════════════════════════════════════ */}
        <div className="no-print" style={{ marginBottom: 48 }}>
          <div style={{ display: "inline-block", background: T.primary, color: "#fff", fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 20, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>
            Monitoring Dashboard
          </div>
          <h2 style={{ fontSize: 26, fontWeight: 800, color: T.text, margin: "0 0 24px" }}>
            Performance Overview
          </h2>

          {/* H7 fix: null-date warning above charts so user understands the data before reading bars */}
          {report?.nullDateRuns > 0 && (
            <div style={{ marginBottom: 12, padding: "8px 14px", background: "#fffbeb", border: "1px solid #fbbf24", borderRadius: 8, fontSize: 12, color: "#92400e" }}>
              ⚠ {report.nullDateRuns} of {report.totalRuns} calls have no date — included in KPI totals above but excluded from weekly trend bars.
            </div>
          )}

          {report?.totalRuns === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: T.textMuted, background: T.card, borderRadius: 12, border: `1px solid ${T.border}` }}>
              No completed calls found. Import or run calls to see data here.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                <KpiCard
                  title="Success Rate"
                  value={successRate.toFixed(1)}
                  subtitle="Calls resolved without escalation or drop-off"
                  trend={kpis.successRate?.trend ?? []}
                  weekLabels={weekLabels}
                  barColor={T.primary}
                  valueColor={T.text}
                />
                <KpiCard
                  title="Drop-Off Rate"
                  value={dropOffRate.toFixed(1)}
                  subtitle="Sessions abandoned before completion"
                  trend={kpis.dropOffRate?.trend ?? []}
                  weekLabels={weekLabels}
                  barColor="#1e2d3a"
                  valueColor={T.text}
                />
                <KpiCard
                  title="Escalation Rate"
                  value={escalationRate.toFixed(1)}
                  subtitle="Transferred to human agents"
                  trend={kpis.escalationRate?.trend ?? []}
                  weekLabels={weekLabels}
                  barColor="#b8d4b0"
                  valueColor={T.text}
                />
              </div>
              {/* Window empty note: runs exist but none fall in the selected time window */}
              {(() => {
                const hasWindowData = (kpis.successRate?.trend ?? []).some((v: number) => v > 0) ||
                                      (kpis.dropOffRate?.trend ?? []).some((v: number) => v > 0) ||
                                      (kpis.escalationRate?.trend ?? []).some((v: number) => v > 0);
                return !hasWindowData ? (
                  <div style={{ marginTop: 12, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>
                    No calls with dates fall within the last {weeks} weeks — trend bars show no data. KPI totals above include all-time calls.
                  </div>
                ) : null;
              })()}
            </>
          )}

          {/* Totals row */}
          {report?.totalRuns > 0 && (
            <div style={{ marginTop: 16, display: "flex", gap: 24, fontSize: 12, color: T.textMuted, flexWrap: "wrap" }}>
              <span><strong style={{ color: T.text }}>{report.totalRuns}</strong> completed calls</span>
              {doc.avgDurationSec != null && (
                <span>avg duration <strong style={{ color: T.text }}>{fmtDuration(doc.avgDurationSec)}</strong></span>
              )}
              {doc.avgTurnsPerCall != null && (
                <span>avg <strong style={{ color: T.text }}>{doc.avgTurnsPerCall}</strong> user turns/call</span>
              )}
            </div>
          )}
        </div>

        {/* ═══════════════════════════════════════════════════════
            SECTION 2: INTELLIGENCE REPORT
        ═══════════════════════════════════════════════════════ */}
        <div className="no-print" style={{ marginBottom: 48 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
            <div>
              <div style={{ display: "inline-block", background: T.primaryLight, color: T.primary, fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 20, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8, border: `1px solid ${T.primary}` }}>
                Expert Services
              </div>
              <h2 style={{ fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>
                Operational Intelligence
              </h2>
            </div>
            <div style={{ marginLeft: "auto" }}>
              {!intel && !intelLoading && (
                <button
                  onClick={handleGenerateIntel}
                  disabled={report?.totalRuns === 0}
                  style={{ padding: "10px 20px", background: T.primary, color: "#fff", border: "none", borderRadius: T.radiusSm, cursor: report?.totalRuns > 0 ? "pointer" : "default", fontSize: 14, fontWeight: 600, opacity: report?.totalRuns > 0 ? 1 : 0.4 }}
                >
                  Generate Report
                </button>
              )}
              {intelLoading && (
                <span style={{ fontSize: 13, color: T.textMuted }}>Analyzing calls…</span>
              )}
              {intel && !intelLoading && (
                <button
                  onClick={handleGenerateIntel}
                  style={{ padding: "6px 14px", background: T.card, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, cursor: "pointer", fontSize: 12, color: T.textSecondary }}
                >
                  Regenerate
                </button>
              )}
            </div>
          </div>

          {/* Error shown as overlay banner — existing intel preserved below if present */}
          {intelError && (
            <div style={{ padding: 12, background: T.errorBg, border: `1px solid #fca5a5`, borderRadius: T.radius, color: T.error, fontSize: 13, marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <span>{intelError}</span>
              <button onClick={() => setIntelError(null)} style={{ background: "none", border: "none", color: T.error, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>
            </div>
          )}

          {!intel && !intelLoading && !intelError && (
            <div style={{ padding: 40, textAlign: "center", background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, color: T.textMuted, fontSize: 14 }}>
              Click "Generate Report" to get AI-powered insights, failure analysis, and recommendations.
            </div>
          )}

          {/* Loading state: show spinner card when no previous intel, or overlay indicator when refreshing */}
          {intelLoading && !intel && (
            <div style={{ padding: 40, textAlign: "center", background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, color: T.textMuted, fontSize: 14 }}>
              Analyzing calls — this may take 15–30 seconds…
            </div>
          )}
          {intelLoading && intel && (
            <div style={{ padding: "8px 14px", background: T.cardAlt, border: `1px solid ${T.border}`, borderRadius: 8, color: T.textMuted, fontSize: 12, marginBottom: 12 }}>
              Regenerating intelligence report — this may take 15–30 seconds…
            </div>
          )}

          {intel && !intelLoading && (
            <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, borderRadius: 12, overflow: "hidden", border: `1px solid ${T.border}`, boxShadow: T.shadowMd }}>

              {/* Insights — dark card */}
              <div style={{ background: "#1a2332", color: "#fff", padding: "24px 20px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <div style={{ width: 28, height: 28, background: "rgba(255,255,255,0.1)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>◎</div>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>Insights</span>
                </div>
                {(intel.insights.topIntents?.length ?? 0) > 0 && (
                  <>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Top performing intents</div>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.9)", marginBottom: 14 }}>
                      {intel.insights.topIntents.join(", ")}
                    </div>
                  </>
                )}
                {intel.insights.peakWindows && (
                  <>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Peak usage windows</div>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.9)", marginBottom: 14 }}>{intel.insights.peakWindows}</div>
                  </>
                )}
                {(intel.insights.patterns?.length ?? 0) > 0 && intel.insights.patterns.map((p: string, i: number) => (
                  <div key={i} style={{ fontSize: 12, color: "rgba(255,255,255,0.75)", marginBottom: 6, display: "flex", gap: 6 }}>
                    <span style={{ color: T.primary, flexShrink: 0 }}>→</span>
                    <span>{p}</span>
                  </div>
                ))}
                {intel.runsAnalyzed != null && (
                  <div style={{ marginTop: 16, fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
                    Based on {intel.runsAnalyzed} calls
                  </div>
                )}
              </div>

              {/* Failures — white card */}
              <div style={{ background: T.card, padding: "24px 20px", borderLeft: `1px solid ${T.border}`, borderRight: `1px solid ${T.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <div style={{ width: 28, height: 28, background: T.cardAlt, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>✕</div>
                  <span style={{ fontWeight: 700, fontSize: 15, color: T.text }}>Failures</span>
                </div>
                {intel.failures.length === 0 ? (
                  <div style={{ fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>No significant failure patterns detected.</div>
                ) : intel.failures.map((f: any, i: number) => {
                  // Determine recency status based on lastSeen date
                  const lastSeenMs  = f.lastSeen  ? new Date(f.lastSeen).getTime()  : null;
                  const firstSeenMs = f.firstSeen ? new Date(f.firstSeen).getTime() : null;
                  const nowMs = Date.now();
                  const daysSinceLast = lastSeenMs ? Math.floor((nowMs - lastSeenMs) / 86_400_000) : null;
                  const isRecent   = daysSinceLast != null && daysSinceLast <= 7;
                  const isResolved = daysSinceLast != null && daysSinceLast > 30;
                  const statusColor = isRecent ? "#dc2626" : isResolved ? "#16a34a" : "#d97706";
                  const statusLabel = isRecent ? "Active" : isResolved ? "Possibly resolved" : "Recent";

                  return (
                    <div key={i} style={{ marginBottom: 16, paddingBottom: 14, borderBottom: i < intel.failures.length - 1 ? `1px solid ${T.border}` : "none" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: T.text, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        {typeof f.pct === "number" && (
                          <span style={{ fontSize: 11, background: "#fef2f2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>
                            {f.pct}%
                          </span>
                        )}
                        {daysSinceLast != null && (
                          <span style={{ fontSize: 10, background: isRecent ? "#fef2f2" : isResolved ? "#f0fdf4" : "#fffbeb", color: statusColor, border: `1px solid ${isRecent ? "#fca5a5" : isResolved ? "#86efac" : "#fcd34d"}`, borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>
                            {statusLabel}
                          </span>
                        )}
                        {f.title}
                      </div>
                      <div style={{ fontSize: 12, color: T.textSecondary, marginTop: 3 }}>{f.detail}</div>
                      {(f.lastSeen || f.firstSeen) && (
                        <div style={{ marginTop: 5, fontSize: 11, color: T.textMuted, display: "flex", gap: 12 }}>
                          {f.firstSeen && <span>First seen: <strong style={{ color: T.text }}>{f.firstSeen}</strong></span>}
                          {f.lastSeen  && <span>Last seen: <strong style={{ color: statusColor }}>{f.lastSeen}</strong></span>}
                          {firstSeenMs && lastSeenMs && firstSeenMs < lastSeenMs && (
                            <span style={{ color: T.textMuted }}>({Math.floor((lastSeenMs - firstSeenMs) / 86_400_000)}d span)</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Recommendations — green card */}
              <div style={{ background: T.primaryLight, padding: "24px 20px", border: `1px solid ${T.primary}20` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <div style={{ width: 28, height: 28, background: T.primary, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: "#fff" }}>☑</div>
                  <span style={{ fontWeight: 700, fontSize: 15, color: T.text }}>Recommendations</span>
                </div>
                {intel.recommendations.length === 0 ? (
                  <div style={{ fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>No recommendations at this time.</div>
                ) : intel.recommendations.map((r: any, i: number) => (
                  <div key={i} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{r.title}</div>
                    <div style={{ fontSize: 12, color: T.textSecondary, marginTop: 2 }}>{r.description}</div>
                  </div>
                ))}
                {intel.cost != null && (
                  <div style={{ marginTop: 16, fontSize: 10, color: T.textMuted }}>
                    Generated for ${intel.cost.toFixed(4)}
                  </div>
                )}
              </div>
            </div>

            {/* Optimization Roadmap — below the 3-column grid, full width */}
            {(intel?.roadmap?.length ?? 0) > 0 && (
              <div style={{ marginTop: 20, background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "28px 32px", boxShadow: T.shadowMd }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
                  <div style={{ width: 28, height: 28, background: T.primary, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#fff" }}>↗</div>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, letterSpacing: 1, textTransform: "uppercase" }}>
                      {project?.name ?? "Agent"} | Optimization Roadmap
                    </div>
                    <div style={{ fontSize: 17, fontWeight: 700, color: T.text, marginTop: 2 }}>
                      Enhancement Opportunities
                    </div>
                  </div>
                </div>

                {intel.roadmap.map((cat: any, ci: number) => (
                  <div key={ci} style={{ marginBottom: ci < intel.roadmap.length - 1 ? 28 : 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{ci + 1}. {cat.category}</span>
                      {cat.currentStatus && (
                        <span style={{ fontSize: 12, color: T.textSecondary }}>— {cat.currentStatus}</span>
                      )}
                    </div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr>
                          <th style={{ background: "#1a2332", color: "#fff", padding: "7px 14px", textAlign: "left", fontWeight: 600, width: "45%", fontSize: 12 }}>Enhancement Opportunity</th>
                          <th style={{ background: "#1a2332", color: "#fff", padding: "7px 14px", textAlign: "left", fontWeight: 600, fontSize: 12 }}>Planned Improvement</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cat.items.map((item: any, ii: number) => (
                          <tr key={ii} style={{ background: ii % 2 === 0 ? T.cardAlt : T.card }}>
                            <td style={{ padding: "9px 14px", borderBottom: `1px solid ${T.border}`, verticalAlign: "top" }}>
                              <div style={{ fontWeight: 600, color: T.text }}>{item.opportunity}</div>
                              {item.description && <div style={{ fontSize: 12, color: T.textSecondary, marginTop: 2 }}>{item.description}</div>}
                            </td>
                            <td style={{ padding: "9px 14px", borderBottom: `1px solid ${T.border}`, color: T.textSecondary, verticalAlign: "top" }}>
                              {item.improvement}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
            </>
          )}
        </div>

        {/* ═══════════════════════════════════════════════════════
            SECTION 3: PRINTABLE DOCUMENT REPORT
        ═══════════════════════════════════════════════════════ */}
        <div id="print-report" ref={printRef} style={{ background: "#fff", border: `1px solid ${T.border}`, borderRadius: 12, padding: "40px 48px", boxShadow: T.shadowLg }}>

          {/* Document header */}
          <div style={{ borderBottom: "2px solid #2980b9", paddingBottom: 12, marginBottom: 32, display: "flex", alignItems: "center", gap: 12 }}>
            <img src="/hamsa-logo.png" alt="Hamsa" style={{ height: 22 }} />
            <span style={{ color: "#666", fontSize: 13 }}>| Voice Agent Performance Report</span>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "#999" }}>{project?.name}</span>
          </div>

          {/* Executive Summary */}
          <h2 style={{ fontSize: 22, fontWeight: 800, color: "#1a5276", marginBottom: 12 }}>
            Executive Summary
          </h2>
          <p style={{ fontSize: 13, color: "#333", lineHeight: 1.7, marginBottom: 24, maxWidth: 700 }}>
            {intel?.executiveSummary
              ? intel.executiveSummary
              : `This report evaluates voice agent performance across ${report?.totalRuns ?? 0} calls, examining call success rates, drop-off patterns, and technical quality metrics.`}
          </p>

          <MetricTable
            title=""
            headerColor="#2980b9"
            rows={[
              { label: "Total Calls Analyzed",  value: `${report?.totalRuns ?? 0} calls`, highlight: "normal" },
              { label: "Average Call Duration",  value: fmtDuration(doc.avgDurationSec),   highlight: "normal" },
              // These two match the dashboard definitions exactly:
              ...(doc.overallPassRate != null ? [{
                label: `Pass Rate (score ≥ 70%, ${doc.overallPassRateScored} scored calls)`,
                value: pct(doc.overallPassRate),
                highlight: scoreHighlight(doc.overallPassRate) as any,
              }] : []),
              ...(doc.objectiveAchievedRate != null ? [{
                label: `Objective Achieved (${doc.objectiveAchievedTotal} evaluated calls)`,
                value: pct(doc.objectiveAchievedRate),
                highlight: scoreHighlight(doc.objectiveAchievedRate) as any,
              }] : []),
              { label: "Call Completion Rate",  value: pct(successRate),    highlight: scoreHighlight(successRate)    },
              { label: "Escalation Rate",       value: pct(escalationRate), highlight: escalationRate <= 5 ? "green" : "amber" },
              { label: "Drop-Off Rate",         value: pct(dropOffRate),    highlight: dropOffRate    <= 5 ? "green" : "amber" },
            ]}
          />

          {/* Conversation Metrics */}
          <h2 style={{ fontSize: 22, fontWeight: 800, color: "#1a5276", margin: "32px 0 12px" }}>
            Conversation Metrics
          </h2>
          <MetricTable
            title=""
            headerColor="#2980b9"
            rows={[
              { label: "Average User Turns per Call",   value: doc.avgTurnsPerCall != null ? `${doc.avgTurnsPerCall}` : "—", highlight: "normal" },
              { label: "Total Conversation Turns",      value: doc.totalTurns > 0 ? doc.totalTurns.toLocaleString() : "—", highlight: "normal" },
              { label: "Call Completion Rate (not dropped/escalated)", value: pct(successRate),     highlight: scoreHighlight(successRate)     },
              { label: "Natural Completion Rate (no dropoff/escalation)",  value: pct(naturalCompRate), highlight: scoreHighlight(naturalCompRate) },
            ]}
          />

          {/* Technical Performance — driven entirely by this project's criteria */}
          {criterionRows.length > 0 && (
            <>
              <h2 style={{ fontSize: 22, fontWeight: 800, color: "#1a5276", margin: "32px 0 4px" }}>
                Evaluation Criteria Performance
              </h2>
              <MetricTable
                title=""
                headerColor="#5dade2"
                rows={criterionRows.map((r) => ({
                  label:     r.label,
                  value:     r.passRate != null ? pct(r.passRate) : (r.avgScore != null ? `${r.avgScore.toFixed(1)}% avg score` : "—"),
                  highlight: scoreHighlight(r.passRate ?? r.avgScore),
                }))}
              />
            </>
          )}

          {/* Word label quality — only shown if this project has word labels */}
          {doc.wordLabelCoverage > 0 && (doc.genderAccuracy != null || doc.asrAccuracy != null || doc.ttsAccuracy != null) && (
            <>
              <h2 style={{ fontSize: 22, fontWeight: 800, color: "#1a5276", margin: "32px 0 4px" }}>
                Word-Level Quality
              </h2>
              {doc.wordLabelCoverage < 20 && (
                <div style={{ fontSize: 11, color: "#888", fontStyle: "italic", marginBottom: 8 }}>
                  Note: Word-level labels available for {doc.wordLabelCoverage.toFixed(1)}% of calls — metrics below may not be representative.
                </div>
              )}
              <MetricTable
                title=""
                headerColor="#5dade2"
                rows={([
                  doc.genderAccuracy  != null ? { label: "Gender Recognition Accuracy",         value: pct(doc.genderAccuracy),  highlight: scoreHighlight(doc.genderAccuracy)  } : null,
                  doc.genderErrorRate != null ? { label: "Gender Error Rate (per total calls)",  value: pct(doc.genderErrorRate), highlight: "muted" as const, italic: true      } : null,
                  doc.asrAccuracy     != null ? { label: "ASR Accuracy",                        value: pct(doc.asrAccuracy),     highlight: scoreHighlight(doc.asrAccuracy)     } : null,
                  doc.ttsAccuracy     != null ? { label: "TTS Pronunciation Accuracy",           value: pct(doc.ttsAccuracy),     highlight: scoreHighlight(doc.ttsAccuracy)     } : null,
                ] as const).filter(Boolean) as any}
              />
            </>
          )}

          {/* Performance Summary */}
          {(excRows.length > 0 || poorRows.length > 0 || (intel?.failures?.length ?? 0) > 0) && (
            <>
              <h2 style={{ fontSize: 22, fontWeight: 800, color: "#1a5276", margin: "32px 0 12px" }}>
                Performance Summary &amp; Insights
              </h2>

              {excRows.length > 0 && (
                <>
                  <h3 style={{ fontSize: 15, fontWeight: 700, color: "#1a5276", marginBottom: 8 }}>
                    Exceptional Performance Areas
                  </h3>
                  {excRows.map((r, i) => (
                    <div key={i} style={{ marginBottom: 8, fontSize: 13, lineHeight: 1.6 }}>
                      <span style={{ color: "#27ae60", fontWeight: 700 }}>✓ {r.label} ({r.passRate ?? r.avgScore}%): </span>
                      <span style={{ color: "#333" }}>Pass rate above 85% across evaluated calls.</span>
                    </div>
                  ))}
                  {moreExc > 0 && <div style={{ fontSize: 12, color: "#888", fontStyle: "italic", marginBottom: 8 }}>…and {moreExc} more criteria above threshold.</div>}
                </>
              )}

              {(poorRows.length > 0 || (intel?.failures?.length ?? 0) > 0) && (
                <>
                  <h3 style={{ fontSize: 15, fontWeight: 700, color: "#1a5276", margin: "20px 0 8px" }}>
                    Areas Requiring Attention
                  </h3>
                  {poorRows.map((r, i) => (
                    <div key={i} style={{ marginBottom: 8, fontSize: 13, lineHeight: 1.6 }}>
                      <span style={{ color: "#e67e22", fontWeight: 700 }}>⚠ {r.label} ({r.passRate ?? r.avgScore}%): </span>
                      <span style={{ color: "#333" }}>Below 65% — review and address.</span>
                    </div>
                  ))}
                  {morePoor > 0 && <div style={{ fontSize: 12, color: "#888", fontStyle: "italic", marginBottom: 8 }}>…and {morePoor} more criteria below threshold.</div>}
                  {intel?.failures?.map((f: any, i: number) => (
                    <div key={`f${i}`} style={{ marginBottom: 10, fontSize: 13, lineHeight: 1.6 }}>
                      <div>
                        <span style={{ color: "#c0392b", fontWeight: 700 }}>✗ {f.title}{typeof f.pct === "number" ? ` (${f.pct}%)` : ""}: </span>
                        <span style={{ color: "#333" }}>{f.detail}</span>
                      </div>
                      {(f.firstSeen || f.lastSeen) && (
                        <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
                          {f.firstSeen && <>First seen: {f.firstSeen}</>}
                          {f.firstSeen && f.lastSeen && " · "}
                          {f.lastSeen  && <>Last seen: <strong style={{ color: f.lastSeen === f.firstSeen ? "#888" : "#c0392b" }}>{f.lastSeen}</strong></>}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}

              {(intel?.recommendations?.length ?? 0) > 0 && (
                <>
                  <h3 style={{ fontSize: 15, fontWeight: 700, color: "#1a5276", margin: "20px 0 8px" }}>
                    Recommendations
                  </h3>
                  {intel.recommendations.map((r: any, i: number) => (
                    <div key={i} style={{ marginBottom: 8, fontSize: 13, lineHeight: 1.6 }}>
                      <span style={{ color: "#27ae60", fontWeight: 700 }}>{i + 1}. {r.title}: </span>
                      <span style={{ color: "#333" }}>{r.description}</span>
                    </div>
                  ))}
                </>
              )}
            </>
          )}

          {/* Optimization Roadmap — printable version */}
          {(intel?.roadmap?.length ?? 0) > 0 && (
            <>
              <h2 style={{ fontSize: 22, fontWeight: 800, color: "#1a5276", margin: "40px 0 4px" }}>
                Optimization Roadmap
              </h2>
              <p style={{ fontSize: 12, color: "#666", marginBottom: 20, fontStyle: "italic" }}>
                {project?.name} — AI-generated enhancement opportunities based on call analysis
              </p>
              {intel.roadmap.map((cat: any, ci: number) => (
                <div key={ci} style={{ marginBottom: 24 }}>
                  <h3 style={{ fontSize: 15, fontWeight: 700, color: "#1a5276", marginBottom: 4 }}>
                    {ci + 1}. {cat.category}
                  </h3>
                  {cat.currentStatus && (
                    <div style={{ fontSize: 12, color: "#555", fontStyle: "italic", marginBottom: 8 }}>
                      Current Status: {cat.currentStatus}
                    </div>
                  )}
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr>
                        <th style={{ background: "#1a2332", color: "#fff", padding: "7px 12px", textAlign: "left", fontWeight: 600, width: "45%", fontSize: 12 }}>Enhancement Opportunity</th>
                        <th style={{ background: "#1a2332", color: "#fff", padding: "7px 12px", textAlign: "left", fontWeight: 600, fontSize: 12 }}>Planned Improvement</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cat.items.map((item: any, ii: number) => (
                        <tr key={ii} style={{ background: ii % 2 === 0 ? "#ffffff" : "#f0f4f8" }}>
                          <td style={{ padding: "8px 12px", borderBottom: "1px solid #e5e7eb", verticalAlign: "top" }}>
                            <div style={{ fontWeight: 600, color: "#111827" }}>{item.opportunity}</div>
                            {item.description && <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>{item.description}</div>}
                          </td>
                          <td style={{ padding: "8px 12px", borderBottom: "1px solid #e5e7eb", color: "#374151", verticalAlign: "top" }}>
                            {item.improvement}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          )}

          {/* Footer — M2 fix: use ISO date (UTC) so it matches server-side generation date */}
          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 40, paddingTop: 14, display: "flex", justifyContent: "space-between", fontSize: 11, color: "#aaa" }}>
            <span>Hamsa Eval — {project?.name}</span>
            <span>Generated {new Date().toISOString().slice(0, 10)}</span>
          </div>
        </div>
      </div>
    </>
  );
}
