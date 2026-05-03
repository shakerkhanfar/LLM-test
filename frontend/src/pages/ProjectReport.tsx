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
      <h3 style={{ fontSize: 16, fontWeight: 700, color: "#1a5276", marginBottom: 8 }}>{title}</h3>
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
            const valColor = row.highlight === "green" ? "#27ae60"
              : row.highlight === "amber" ? "#e67e22"
              : row.highlight === "muted" ? "#888"
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
  return `${n.toFixed(2)}${suffix}`;
}

function scoreHighlight(n: number | null): "green" | "amber" | "normal" {
  if (n == null) return "normal";
  return n >= 85 ? "green" : n >= 65 ? "amber" : "normal";
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
  // Tracks the latest in-flight report request to discard stale responses
  const reqRef = useRef(0);

  const loadReport = useCallback(async () => {
    if (!id) return;
    const req = ++reqRef.current;
    setReportLoading(true);
    setReportError(null);
    setReport(null);
    try {
      const [proj, rep] = await Promise.all([getProject(id), getProjectReport(id, weeks)]);
      if (req !== reqRef.current) return; // stale — a newer request superseded this one
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
    try {
      // Pass the same date window used by the KPI report
      const to = new Date();
      const from = new Date();
      from.setUTCDate(from.getUTCDate() - weeks * 7);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const result = await generateIntelligenceReport(id, { from: fmt(from), to: fmt(to) });
      setIntel(result);
    } catch (err) {
      setIntelError((err as Error).message);
    } finally {
      setIntelLoading(false);
    }
  };

  const handlePrint = () => window.print();

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

  const doc = report?.doc ?? {};
  const kpis = report?.kpis ?? {};
  const weekLabels: string[] = report?.weekLabels ?? [];
  const criterionRows: any[] = report?.criterionRows ?? [];

  // doc metrics helpers
  const successRate    = kpis.successRate?.current    ?? 0;
  const dropOffRate    = kpis.dropOffRate?.current    ?? 0;
  const escalationRate = kpis.escalationRate?.current ?? 0;

  // ── Exceptional & Needs Improvement buckets ──
  const excRows = criterionRows.filter((r) => (r.passRate ?? 0) >= 85).slice(0, 5);
  const poorRows = criterionRows.filter((r) => r.passRate != null && r.passRate < 65).slice(0, 5);

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
            <select
              value={weeks}
              onChange={(e) => setWeeks(Number(e.target.value))}
              style={{ fontSize: 12, padding: "4px 8px", border: `1px solid ${T.borderDark}`, borderRadius: T.radiusSm, background: T.card, color: T.text }}
            >
              {[4, 7, 12, 26].map((w) => (
                <option key={w} value={w}>Last {w} weeks</option>
              ))}
            </select>
            <button
              onClick={handlePrint}
              style={{ padding: "6px 14px", background: T.card, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, cursor: "pointer", fontSize: 13, color: T.textSecondary }}
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

          {report?.totalRuns === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: T.textMuted, background: T.card, borderRadius: 12, border: `1px solid ${T.border}` }}>
              No completed calls found in this window. Try extending the date range.
            </div>
          ) : (
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
          )}

          {/* Totals bar */}
          {report?.totalRuns > 0 && (
            <div style={{ marginTop: 16, display: "flex", gap: 24, fontSize: 12, color: T.textMuted }}>
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
                  style={{ padding: "10px 20px", background: T.primary, color: "#fff", border: "none", borderRadius: T.radiusSm, cursor: "pointer", fontSize: 14, fontWeight: 600 }}
                >
                  Generate Report
                </button>
              )}
              {intelLoading && (
                <span style={{ fontSize: 13, color: T.textMuted }}>Analyzing calls…</span>
              )}
              {intel && (
                <button
                  onClick={handleGenerateIntel}
                  disabled={intelLoading}
                  style={{ padding: "6px 14px", background: T.card, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, cursor: "pointer", fontSize: 12, color: T.textSecondary }}
                >
                  Regenerate
                </button>
              )}
            </div>
          </div>

          {intelError && (
            <div style={{ padding: 16, background: T.errorBg, border: `1px solid #fca5a5`, borderRadius: T.radius, color: T.error, fontSize: 13, marginBottom: 16 }}>
              {intelError}
            </div>
          )}

          {!intel && !intelLoading && !intelError && (
            <div style={{ padding: 40, textAlign: "center", background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, color: T.textMuted, fontSize: 14 }}>
              Click "Generate Report" to get AI-powered insights, failure analysis, and recommendations.
            </div>
          )}

          {intel && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, borderRadius: 12, overflow: "hidden", border: `1px solid ${T.border}`, boxShadow: T.shadowMd }}>
              {/* Insights — dark card */}
              <div style={{ background: "#1a2332", color: "#fff", padding: "24px 20px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <div style={{ width: 28, height: 28, background: "rgba(255,255,255,0.1)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
                    ◎
                  </div>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>Insights</span>
                </div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Top performing intents
                </div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.9)", marginBottom: 14 }}>
                  {(intel.insights.topIntents?.length ?? 0) > 0 ? intel.insights.topIntents.join(", ") : "—"}
                </div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Peak usage windows
                </div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.9)", marginBottom: 14 }}>
                  {intel.insights.peakWindows || "—"}
                </div>
                {intel.insights.patterns?.map((p: string, i: number) => (
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
                  <div style={{ width: 28, height: 28, background: T.cardAlt, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
                    ✕
                  </div>
                  <span style={{ fontWeight: 700, fontSize: 15, color: T.text }}>Failures</span>
                </div>
                {intel.failures.length === 0 ? (
                  <div style={{ fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>No significant failure patterns detected.</div>
                ) : intel.failures.map((f: any, i: number) => (
                  <div key={i} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text, display: "flex", alignItems: "center", gap: 8 }}>
                      {f.pct != null && (
                        <span style={{ fontSize: 11, background: "#fef2f2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>
                          {f.pct}%
                        </span>
                      )}
                      {f.title}
                    </div>
                    <div style={{ fontSize: 12, color: T.textSecondary, marginTop: 2 }}>{f.detail}</div>
                  </div>
                ))}
              </div>

              {/* Recommendations — green card */}
              <div style={{ background: T.primaryLight, padding: "24px 20px", border: `1px solid ${T.primary}20` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <div style={{ width: 28, height: 28, background: T.primary, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: "#fff" }}>
                    ☑
                  </div>
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
              { label: "Total Calls Analyzed", value: `${report?.totalRuns ?? 0} calls`, highlight: "normal" },
              { label: "Average Call Duration", value: fmtDuration(doc.avgDurationSec), highlight: "normal" },
              { label: "Call Success Rate", value: pct(successRate), highlight: scoreHighlight(successRate) },
              { label: "Escalation Rate", value: pct(escalationRate), highlight: escalationRate <= 5 ? "green" : "amber" },
              { label: "Drop-Off Rate", value: pct(dropOffRate), highlight: dropOffRate <= 5 ? "green" : "amber" },
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
              { label: "Average User Turns per Call", value: doc.avgTurnsPerCall != null ? `${doc.avgTurnsPerCall}` : "—", highlight: "normal" },
              { label: "Total Conversation Turns", value: doc.totalTurns > 0 ? doc.totalTurns.toLocaleString() : "—", highlight: "normal" },
              { label: "Call Objective Success Rate", value: pct(successRate), highlight: scoreHighlight(successRate) },
              { label: "Natural Completion Rate", value: pct(Math.max(0, 100 - dropOffRate - escalationRate)), highlight: scoreHighlight(Math.max(0, 100 - dropOffRate - escalationRate)) },
            ]}
          />

          {/* Technical Performance */}
          <h2 style={{ fontSize: 22, fontWeight: 800, color: "#1a5276", margin: "32px 0 4px" }}>
            Technical Performance Analysis
          </h2>

          {(doc.llmPassRate != null || doc.latencyPassRate != null || doc.genderAccuracy != null) && (
            <MetricTable
              title="Language Model Performance"
              headerColor="#5dade2"
              rows={([
                doc.llmPassRate    != null ? { label: "LLM Pass Rate",                              value: pct(doc.llmPassRate),    highlight: scoreHighlight(doc.llmPassRate)    } : null,
                doc.latencyPassRate != null ? { label: "Latency (Response Time)",                   value: pct(doc.latencyPassRate), highlight: scoreHighlight(doc.latencyPassRate) } : null,
                doc.genderAccuracy  != null ? { label: "Gender Recognition Accuracy",               value: pct(doc.genderAccuracy),  highlight: scoreHighlight(doc.genderAccuracy) } : null,
                doc.genderErrorRate != null ? { label: "Gender Error Rate (mistakes per turn)",     value: pct(doc.genderErrorRate), highlight: "muted" as const, italic: true } : null,
              ] as const).filter(Boolean) as any}
            />
          )}

          {(doc.asrAccuracy != null || doc.ttsAccuracy != null) && (
            <MetricTable
              title="Speech Recognition & Synthesis"
              headerColor="#5dade2"
              rows={([
                doc.asrAccuracy != null ? { label: "ASR Accuracy",              value: pct(doc.asrAccuracy),  highlight: scoreHighlight(doc.asrAccuracy)  } : null,
                doc.ttsAccuracy != null ? { label: "TTS Pronunciation Accuracy", value: pct(doc.ttsAccuracy), highlight: scoreHighlight(doc.ttsAccuracy) } : null,
              ] as const).filter(Boolean) as any}
            />
          )}

          {/* Low word-label coverage note */}
          {doc.wordLabelCoverage != null && doc.wordLabelCoverage < 20 && (
            <div style={{ fontSize: 11, color: "#888", fontStyle: "italic", marginBottom: 12 }}>
              Note: Word-level labels (gender, ASR, TTS) are available for only {doc.wordLabelCoverage.toFixed(1)}% of calls — accuracy metrics may not be representative.
            </div>
          )}

          {/* Criterion breakdown (always shown) */}
          {criterionRows.length > 0 && (
            <MetricTable
              title="Evaluation Criteria Performance"
              headerColor="#5dade2"
              rows={criterionRows.map((r) => ({
                label: r.label,
                value: r.passRate != null ? pct(r.passRate) : (r.avgScore != null ? `${r.avgScore}% avg score` : "—"),
                highlight: scoreHighlight(r.passRate ?? r.avgScore),
              }))}
            />
          )}

          {/* Performance Summary */}
          {(excRows.length > 0 || poorRows.length > 0 || intel?.failures?.length > 0) && (
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
                </>
              )}

              {(poorRows.length > 0 || intel?.failures?.length > 0) && (
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
                  {intel?.failures?.map((f: any, i: number) => (
                    <div key={`f${i}`} style={{ marginBottom: 8, fontSize: 13, lineHeight: 1.6 }}>
                      <span style={{ color: "#c0392b", fontWeight: 700 }}>✗ {f.title}{f.pct != null ? ` (${f.pct}%)` : ""}: </span>
                      <span style={{ color: "#333" }}>{f.detail}</span>
                    </div>
                  ))}
                </>
              )}

              {intel?.recommendations?.length > 0 && (
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

          {/* Footer */}
          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 40, paddingTop: 14, display: "flex", justifyContent: "space-between", fontSize: 11, color: "#aaa" }}>
            <span>Hamsa Eval — {project?.name}</span>
            <span>Generated {new Date().toLocaleDateString()}</span>
          </div>
        </div>
      </div>
    </>
  );
}
