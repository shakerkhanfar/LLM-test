import { useEffect, useState } from "react";
import { useParams, Link, useLocation } from "react-router-dom";
import { listProjectAnalyses, compareProjectAnalyses } from "../api/client";

// ─── Types ────────────────────────────────────────────────────────

interface ProjectAnalysis {
  id:           string;
  version:      number;
  runsIncluded: number;
  healthScore:  number | null;
  analysis:     any;
  createdAt:    string;
  dateFilterType: string | null;
  filterFrom:     string | null;
  filterTo:       string | null;
}

interface CompareResult {
  analyses:  ProjectAnalysis[];
  summaries: any[];
  comparison: {
    overall_trajectory:    "Improving" | "Declining" | "Mixed" | "Stable";
    summary:               string;
    persistent_issues:     { area: string; detail: string; severity: "High" | "Medium" | "Low" }[];
    resolved_issues:       { area: string; fixed_in: string; detail: string }[];
    regressions:           { area: string; appeared_in: string; detail: string }[];
    improvements:          { area: string; detail: string }[];
    version_by_version:    { from: string; to: string; key_changes: string[] }[];
    top_remaining_priorities: string[];
  };
  cost: number;
}

// ─── Helpers ──────────────────────────────────────────────────────

function extractApiError(err: unknown): string {
  const raw = (err as Error).message ?? String(err);
  const bodyStart = raw.indexOf("{");
  if (bodyStart !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(bodyStart));
      if (typeof parsed.error === "string") return parsed.error;
    } catch { /* fall through */ }
  }
  return raw;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function healthColor(h: string | undefined) {
  if (h === "Good")    return "#22c55e";
  if (h === "Fair")    return "#f59e0b";
  if (h === "Poor")    return "#ef4444";
  return "#888";
}

function trajectoryColor(t: string | undefined) {
  if (t === "Improving") return "#22c55e";
  if (t === "Declining") return "#ef4444";
  if (t === "Mixed")     return "#f59e0b";
  return "#888";
}

function severityColor(s: string) {
  if (s === "High")   return "#ef4444";
  if (s === "Medium") return "#f59e0b";
  return "#888";
}

function ScoreBar({ score }: { score: number | null }) {
  if (score == null) return <span style={{ color: "#555", fontSize: 12 }}>N/A</span>;
  const pct = Math.round(score * 100);
  const color = score >= 0.7 ? "#22c55e" : score >= 0.5 ? "#f59e0b" : "#ef4444";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: "#1a1a1a", borderRadius: 3, minWidth: 80 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 12, color, fontWeight: 700, minWidth: 32 }}>{pct}%</span>
    </div>
  );
}

// ─── Side-by-side version summary card ────────────────────────────

function VersionSummaryCard({ summary }: { summary: any }) {
  const hColor = healthColor(summary.overall_health);
  return (
    <div style={{
      flex: "1 1 200px", minWidth: 0,
      background: "#111", border: "1px solid #222", borderRadius: 8,
      padding: "14px 16px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <div style={{
          fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
          background: "#1e3a5f", color: "#60a5fa", border: "1px solid #1d4ed8",
        }}>
          v{summary.version}
        </div>
        <div style={{ fontSize: 11, color: hColor, fontWeight: 700 }}>
          {summary.overall_health}
        </div>
      </div>

      <ScoreBar score={summary.healthScore} />

      <div style={{ fontSize: 11, color: "#555", marginTop: 8, marginBottom: 10 }}>
        {summary.runsIncluded} runs · {fmtDate(summary.createdAt)}
      </div>

      {summary.executive_summary && (
        <div style={{ fontSize: 12, color: "#9ca3af", lineHeight: 1.5, marginBottom: 10 }}>
          {summary.executive_summary}
        </div>
      )}

      {summary.priority_actions?.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: "#555", marginBottom: 4 }}>Top priorities</div>
          {summary.priority_actions.slice(0, 3).map((a: string, i: number) => (
            <div key={i} style={{ fontSize: 11, color: "#d1d5db", marginBottom: 3, display: "flex", gap: 6 }}>
              <span style={{ color: "#3b82f6", fontWeight: 700 }}>#{i + 1}</span>
              <span>{a}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────

export default function AnalysisCompare() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();

  // Pre-select versions passed via navigate state
  const preSelected: string[] = (location.state as any)?.selectedIds ?? [];

  const [analyses, setAnalyses]     = useState<ProjectAnalysis[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selected, setSelected]     = useState<Set<string>>(new Set(preSelected));
  const [loadError, setLoadError]   = useState<string | null>(null);
  const [comparing, setComparing]   = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [result, setResult]         = useState<CompareResult | null>(null);

  useEffect(() => {
    listProjectAnalyses(id!)
      .then((data) => {
        setAnalyses(data);
        // Prune any preSelected IDs that don't exist (deleted since navigation)
        const validIds = new Set(data.map((a) => a.id));
        setSelected((prev) => {
          const pruned = new Set([...prev].filter((sid) => validIds.has(sid)));
          return pruned.size === prev.size ? prev : pruned; // avoid re-render if unchanged
        });
      })
      .catch((err) => setLoadError(extractApiError(err)))
      .finally(() => setLoadingList(false));
  }, [id]);

  function toggleSelect(analysisId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(analysisId)) next.delete(analysisId);
      else if (next.size < 6)   next.add(analysisId);
      return next;
    });
    // Clear stale result when selection changes
    setResult(null);
    setCompareError(null);
  }

  async function handleCompare() {
    if (selected.size < 2) return;
    setComparing(true);
    setCompareError(null);
    setResult(null);
    try {
      const data = await compareProjectAnalyses(id!, [...selected]);
      setResult(data);
    } catch (err) {
      setCompareError(extractApiError(err));
    } finally {
      setComparing(false);
    }
  }

  const canCompare = selected.size >= 2 && !comparing;

  // Ordered selected summaries (ascending version)
  const selectedAnalyses = analyses
    .filter((av) => selected.has(av.id))
    .sort((a, b) => a.version - b.version);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <Link to={`/projects/${id}/analyses`} style={{ color: "#888", textDecoration: "none", fontSize: 14 }}>
          ← Back to analyses
        </Link>
        <h1 style={{ margin: "8px 0 4px", fontSize: 22 }}>Compare Versions</h1>
        <p style={{ color: "#666", fontSize: 13, margin: 0 }}>
          Select 2–6 versions, then press Compare to get an LLM-powered breakdown of what changed.
        </p>
      </div>

      {loadError && (
        <div style={{
          padding: "10px 14px", borderRadius: 6, marginBottom: 16,
          background: "#2d0a0a", border: "1px solid #7f1d1d", color: "#ef4444", fontSize: 13,
        }}>
          {loadError}
        </div>
      )}

      {/* Version picker */}
      <div style={{
        background: "#111", border: "1px solid #222", borderRadius: 10,
        padding: "18px 20px", marginBottom: 24,
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14,
          flexWrap: "wrap", gap: 10,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#e5e7eb" }}>
            Select versions to compare
            <span style={{ fontSize: 12, color: "#555", fontWeight: 400, marginLeft: 10 }}>
              ({selected.size} selected · max 6)
            </span>
          </div>
          <button
            onClick={handleCompare}
            disabled={!canCompare}
            style={{
              background: canCompare ? "#2563eb" : "#1a1a1a",
              color: canCompare ? "#fff" : "#555",
              border: "none", borderRadius: 6, padding: "8px 20px",
              fontSize: 13, fontWeight: 600,
              cursor: canCompare ? "pointer" : "default",
            }}
          >
            {comparing ? "Comparing…" : `Compare ${selected.size >= 2 ? `(${selected.size} versions)` : ""}`}
          </button>
        </div>

        {loadingList ? (
          <p style={{ color: "#555", fontSize: 13 }}>Loading…</p>
        ) : analyses.length === 0 ? (
          <p style={{ color: "#555", fontSize: 13 }}>No analyses found for this project.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {analyses.map((av) => {
              const a = av.analysis;
              const isSelected = selected.has(av.id);
              const hColor = healthColor(a?.overall_health);
              return (
                <div
                  key={av.id}
                  onClick={() => toggleSelect(av.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 14, padding: "10px 14px",
                    borderRadius: 7, cursor: "pointer",
                    background: isSelected ? "#0f1f3d" : "#0a0a0a",
                    border: `1px solid ${isSelected ? "#2563eb" : "#1a1a1a"}`,
                    transition: "border-color 0.15s, background 0.15s",
                  }}
                >
                  {/* Checkbox */}
                  <div style={{
                    width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                    border: `2px solid ${isSelected ? "#3b82f6" : "#333"}`,
                    background: isSelected ? "#2563eb" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {isSelected && <span style={{ color: "#fff", fontSize: 10, fontWeight: 900 }}>✓</span>}
                  </div>

                  {/* Version badge */}
                  <div style={{
                    fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                    background: "#1e3a5f", color: "#60a5fa", border: "1px solid #1d4ed8",
                    whiteSpace: "nowrap",
                  }}>
                    v{av.version}
                  </div>

                  {/* Health */}
                  {a?.overall_health && (
                    <div style={{ fontSize: 12, color: hColor, fontWeight: 600, whiteSpace: "nowrap" }}>
                      {a.overall_health}
                      {av.healthScore != null && ` · ${Math.round(av.healthScore * 100)}%`}
                    </div>
                  )}

                  {/* Runs & date */}
                  <div style={{ fontSize: 12, color: "#555" }}>
                    {av.runsIncluded} runs
                    {av.dateFilterType && (
                      <span> · {av.dateFilterType === "CALL_DATE" ? "call date" : "eval date"}
                        {av.filterFrom && ` from ${av.filterFrom.slice(0, 10)}`}
                        {av.filterTo   && ` to ${av.filterTo.slice(0, 10)}`}
                      </span>
                    )}
                  </div>

                  <div style={{ flex: 1 }} />
                  <div style={{ fontSize: 11, color: "#444", whiteSpace: "nowrap" }}>
                    {fmtDate(av.createdAt)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Side-by-side preview of selected */}
      {selectedAnalyses.length >= 2 && !result && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>Preview</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {selectedAnalyses.map((av) => (
              <VersionSummaryCard
                key={av.id}
                summary={{
                  version:           av.version,
                  runsIncluded:      av.runsIncluded,
                  healthScore:       av.healthScore,
                  overall_health:    av.analysis?.overall_health,
                  createdAt:         av.createdAt,
                  executive_summary: av.analysis?.executive_summary,
                  priority_actions:  av.analysis?.priority_actions,
                }}
              />
            ))}
          </div>
        </div>
      )}

      {compareError && (
        <div style={{
          padding: "10px 14px", borderRadius: 6, marginBottom: 20,
          background: "#2d0a0a", border: "1px solid #7f1d1d", color: "#ef4444", fontSize: 13,
        }}>
          {compareError}
        </div>
      )}

      {comparing && (
        <div style={{ color: "#555", fontSize: 13, marginBottom: 20 }}>
          Comparing {selected.size} versions with GPT-4.1… (this may take 20–30 seconds)
        </div>
      )}

      {/* ─── Comparison result ─────────────────────────────────── */}
      {result && (
        <div>
          {/* Trajectory + cost header */}
          <div style={{
            display: "flex", alignItems: "center", gap: 16, marginBottom: 24, flexWrap: "wrap",
          }}>
            <div style={{
              fontSize: 16, fontWeight: 700,
              color: trajectoryColor(result.comparison.overall_trajectory),
              padding: "6px 16px", borderRadius: 8,
              background: `${trajectoryColor(result.comparison.overall_trajectory)}18`,
              border: `1px solid ${trajectoryColor(result.comparison.overall_trajectory)}44`,
            }}>
              {result.comparison.overall_trajectory === "Improving" && "↗ "}
              {result.comparison.overall_trajectory === "Declining" && "↘ "}
              {result.comparison.overall_trajectory === "Mixed"     && "↕ "}
              {result.comparison.overall_trajectory === "Stable"    && "→ "}
              {result.comparison.overall_trajectory}
            </div>
            {result.cost > 0 && (
              <div style={{ fontSize: 12, color: "#4b5563" }}>
                Cost: ${result.cost < 0.01 ? result.cost.toFixed(4) : result.cost.toFixed(3)}
              </div>
            )}
          </div>

          {/* Side-by-side version cards */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#e5e7eb", marginBottom: 12 }}>
              Versions compared
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {result.summaries.map((s) => (
                <VersionSummaryCard key={s.version} summary={s} />
              ))}
            </div>
          </div>

          {/* Overall summary */}
          <div style={{
            padding: "14px 18px", borderRadius: 8, marginBottom: 24,
            background: "#0a0f1a", border: "1px solid #1e3a5f",
            fontSize: 14, color: "#ccc", lineHeight: 1.6,
          }}>
            {result.comparison.summary}
          </div>

          {/* Version-by-version timeline */}
          {result.comparison.version_by_version?.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#e5e7eb", marginBottom: 12 }}>
                Version-by-version changes
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {result.comparison.version_by_version.map((step, i) => (
                  <div key={i} style={{
                    background: "#0a0a0a", border: "1px solid #1a1a1a",
                    borderLeft: "3px solid #3b82f6",
                    borderRadius: 6, padding: "12px 14px",
                  }}>
                    <div style={{ fontSize: 12, color: "#60a5fa", fontWeight: 700, marginBottom: 8 }}>
                      {step.from} → {step.to}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {(step.key_changes ?? []).map((c: string, j: number) => (
                        <div key={j} style={{ fontSize: 12, color: "#9ca3af", display: "flex", gap: 8 }}>
                          <span style={{ color: "#444" }}>·</span>
                          <span>{c}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 4-column improvement grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, marginBottom: 28 }}>

            {/* Improvements */}
            {result.comparison.improvements?.length > 0 && (
              <div style={{
                background: "#0a0a0a", border: "1px solid #22c55e33",
                borderTop: "3px solid #22c55e", borderRadius: 8, padding: "14px 16px",
              }}>
                <div style={{ fontSize: 12, color: "#22c55e", fontWeight: 700, marginBottom: 10 }}>
                  ↑ Improvements ({result.comparison.improvements.length})
                </div>
                {result.comparison.improvements.map((item, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: "#86efac", fontWeight: 600 }}>{item.area}</div>
                    <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.4, marginTop: 2 }}>{item.detail}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Resolved issues */}
            {result.comparison.resolved_issues?.length > 0 && (
              <div style={{
                background: "#0a0a0a", border: "1px solid #3b82f633",
                borderTop: "3px solid #3b82f6", borderRadius: 8, padding: "14px 16px",
              }}>
                <div style={{ fontSize: 12, color: "#3b82f6", fontWeight: 700, marginBottom: 10 }}>
                  ✓ Resolved ({result.comparison.resolved_issues.length})
                </div>
                {result.comparison.resolved_issues.map((item, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                      <span style={{ fontSize: 12, color: "#93c5fd", fontWeight: 600 }}>{item.area}</span>
                      <span style={{ fontSize: 10, color: "#3b82f6", padding: "1px 6px", background: "#1e3a5f44", borderRadius: 3 }}>
                        fixed in {item.fixed_in}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.4, marginTop: 2 }}>{item.detail}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Regressions */}
            {result.comparison.regressions?.length > 0 && (
              <div style={{
                background: "#0a0a0a", border: "1px solid #ef444433",
                borderTop: "3px solid #ef4444", borderRadius: 8, padding: "14px 16px",
              }}>
                <div style={{ fontSize: 12, color: "#ef4444", fontWeight: 700, marginBottom: 10 }}>
                  ↓ Regressions ({result.comparison.regressions.length})
                </div>
                {result.comparison.regressions.map((item, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                      <span style={{ fontSize: 12, color: "#fca5a5", fontWeight: 600 }}>{item.area}</span>
                      <span style={{ fontSize: 10, color: "#ef4444", padding: "1px 6px", background: "#450a0a44", borderRadius: 3 }}>
                        appeared in {item.appeared_in}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.4, marginTop: 2 }}>{item.detail}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Persistent issues */}
            {result.comparison.persistent_issues?.length > 0 && (
              <div style={{
                background: "#0a0a0a", border: "1px solid #f59e0b33",
                borderTop: "3px solid #f59e0b", borderRadius: 8, padding: "14px 16px",
              }}>
                <div style={{ fontSize: 12, color: "#f59e0b", fontWeight: 700, marginBottom: 10 }}>
                  ⚠ Still unresolved ({result.comparison.persistent_issues.length})
                </div>
                {result.comparison.persistent_issues.map((item, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                      <span style={{ fontSize: 12, color: "#fcd34d", fontWeight: 600 }}>{item.area}</span>
                      <span style={{
                        fontSize: 10, color: severityColor(item.severity),
                        padding: "1px 6px", background: `${severityColor(item.severity)}18`,
                        border: `1px solid ${severityColor(item.severity)}44`, borderRadius: 3,
                      }}>
                        {item.severity}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.4, marginTop: 2 }}>{item.detail}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Top remaining priorities */}
          {result.comparison.top_remaining_priorities?.length > 0 && (
            <div style={{
              background: "#0f0a1e", border: "1px solid #4c1d95",
              borderRadius: 8, padding: "14px 18px",
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#a855f7", marginBottom: 12 }}>
                Top remaining priorities
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {result.comparison.top_remaining_priorities.map((p, i) => (
                  <div key={i} style={{
                    display: "flex", gap: 12, alignItems: "flex-start",
                    padding: "8px 12px", background: "#0a0a0a",
                    borderRadius: 6, border: "1px solid #1a1a1a",
                  }}>
                    <span style={{ color: "#7c3aed", fontWeight: 800, fontSize: 13, minWidth: 22 }}>
                      #{i + 1}
                    </span>
                    <span style={{ fontSize: 13, color: "#d1d5db", lineHeight: 1.5 }}>{p}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
