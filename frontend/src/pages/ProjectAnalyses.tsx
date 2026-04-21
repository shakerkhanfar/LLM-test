import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { listProjectAnalyses, runProjectAnalysis, deleteProjectAnalysis } from "../api/client";

// ─── Types ────────────────────────────────────────────────────────

type DateFilterType = "CALL_DATE" | "EVAL_DATE";

interface Evidence {
  run_id:    string;
  call_date: string;
  quote:     string;
}

interface BestPart {
  area:     string;
  detail:   string;
  evidence: Evidence[];
}

interface CriticalFailure {
  area:            string;
  frequency:       string;
  root_cause:      string;
  detail:          string;
  prompt_location: string | null;
  suggested_fix:   string;
  evidence:        Evidence[];
}

interface EdgeCase {
  scenario:           string;
  frequency:          string;
  impact:             string;
  suggested_handling: string;
  evidence:           Evidence[];
}

interface PromptIssue {
  location:      string;
  issue:         string;
  suggested_fix: string;
}

interface Analysis {
  overall_health:    "Good" | "Fair" | "Poor";
  health_score:      number;
  executive_summary: string;
  best_parts:        BestPart[];
  critical_failures: CriticalFailure[];
  missing_edge_cases: EdgeCase[];
  prompt_issues:     PromptIssue[];
  priority_actions:  string[];
}

interface Comparison {
  improvements:     { area: string; detail: string }[];
  regressions:      { area: string; detail: string }[];
  unchanged_issues: { area: string; detail: string }[];
  new_issues:       { area: string; detail: string }[];
  summary:          string;
}

interface ProjectAnalysis {
  id:                string;
  version:           number;
  runsIncluded:      number;
  runIds:            string[];
  dateFilterType:    string | null;
  filterFrom:        string | null;
  filterTo:          string | null;
  analysis:          Analysis;
  healthScore:       number | null;
  comparedToVersion: number | null;
  comparison:        Comparison | null;
  analysisCost:      number | null;
  createdAt:         string;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Extract the server's `error` field from "API error NNN: {...}" strings. */
function extractApiError(err: unknown): string {
  const raw = (err as Error).message ?? String(err);
  // Try to parse the JSON body embedded in the thrown Error message
  const bodyStart = raw.indexOf("{");
  if (bodyStart !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(bodyStart));
      if (typeof parsed.error === "string") return parsed.error;
    } catch { /* fall through */ }
  }
  return raw;
}

function healthColor(health: string | undefined): string {
  if (health === "Good") return "#22c55e";
  if (health === "Fair") return "#f59e0b";
  return "#ef4444";
}

function healthBg(health: string | undefined): string {
  if (health === "Good") return "#052e1644";
  if (health === "Fair") return "#451a0344";
  return "#450a0a44";
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ─── Sub-components ───────────────────────────────────────────────

function EvidenceList({ evidence, projectId }: { evidence: Evidence[]; projectId: string }) {
  if (!evidence || evidence.length === 0) return null;
  return (
    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
      {evidence.map((ev, i) => (
        <div key={i} style={{
          background: "#0a0a0a", border: "1px solid #1e293b", borderRadius: 6,
          padding: "8px 12px", fontSize: 12,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <Link
              to={`/projects/${projectId}/runs/${ev.run_id}`}
              style={{
                color: "#3b82f6", textDecoration: "none", fontSize: 11,
                padding: "1px 8px", border: "1px solid #1d4ed8",
                borderRadius: 4, background: "#1e3a5f44", whiteSpace: "nowrap",
              }}
            >
              ↗ View call {ev.call_date ? `(${ev.call_date})` : ""}
            </Link>
          </div>
          {ev.quote && (
            <div style={{ color: "#94a3b8", fontStyle: "italic", lineHeight: 1.5 }}>
              "{ev.quote}"
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Collapsible({ title, children, defaultOpen = false, accent = "#3b82f6" }: {
  title: string; children: React.ReactNode; defaultOpen?: boolean; accent?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 8 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%", textAlign: "left", background: "none", border: "none",
          cursor: "pointer", padding: "8px 0", display: "flex",
          alignItems: "center", gap: 8, color: accent, fontSize: 13, fontWeight: 600,
        }}
      >
        <span style={{ fontSize: 10 }}>{open ? "▼" : "▶"}</span>
        {title}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

function AnalysisVersionCard({
  av, projectId, onDelete, isNewest,
}: {
  av: ProjectAnalysis; projectId: string; onDelete: (id: string) => void; isNewest: boolean;
}) {
  const [expanded, setExpanded] = useState(isNewest);
  const a = av.analysis;
  const hColor = healthColor(a?.overall_health);
  const hBg    = healthBg(a?.overall_health);

  return (
    <div style={{
      background: "#111", border: "1px solid #222", borderRadius: 10,
      marginBottom: 16, overflow: "hidden",
    }}>
      {/* Version header — always visible */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: "14px 18px", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
          borderBottom: expanded ? "1px solid #1a1a1a" : "none",
        }}
      >
        {/* Version badge */}
        <div style={{
          fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 6,
          background: "#1e3a5f", color: "#60a5fa", border: "1px solid #1d4ed8",
          whiteSpace: "nowrap",
        }}>
          v{av.version}
        </div>

        {/* Health badge */}
        {a?.overall_health && (
          <div style={{
            fontSize: 13, fontWeight: 700, padding: "3px 12px", borderRadius: 6,
            background: hBg, color: hColor,
            border: `1px solid ${hColor}44`,
          }}>
            {a.overall_health} · {a.health_score != null ? `${(a.health_score * 100).toFixed(0)}%` : ""}
          </div>
        )}

        {/* Meta */}
        <div style={{ fontSize: 12, color: "#555" }}>
          {av.runsIncluded} runs analyzed
          {av.dateFilterType && (
            <span> · filtered by {av.dateFilterType === "CALL_DATE" ? "call date" : "eval date"}
              {av.filterFrom && ` from ${av.filterFrom.slice(0, 10)}`}
              {av.filterTo   && ` to ${av.filterTo.slice(0, 10)}`}
            </span>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {/* Compared to */}
        {av.comparedToVersion != null && (
          <div style={{ fontSize: 11, color: "#666" }}>compared to v{av.comparedToVersion}</div>
        )}

        {/* Cost */}
        {av.analysisCost != null && av.analysisCost > 0 && (
          <div style={{ fontSize: 11, color: "#4b5563" }}>
            ${av.analysisCost < 0.01 ? av.analysisCost.toFixed(4) : av.analysisCost.toFixed(3)}
          </div>
        )}

        {/* Date */}
        <div style={{ fontSize: 11, color: "#444", whiteSpace: "nowrap" }}>
          {fmtDate(av.createdAt)}
        </div>

        {/* Delete */}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(av.id); }}
          style={{
            background: "none", border: "none", color: "#444", cursor: "pointer",
            fontSize: 13, padding: "2px 6px",
          }}
          title="Delete this version"
        >
          ✕
        </button>

        <span style={{ color: "#333", fontSize: 10 }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {!expanded ? null : (
        <div style={{ padding: "18px 18px 20px" }}>

          {/* Executive summary */}
          {a?.executive_summary && (
            <div style={{
              padding: "12px 16px", borderRadius: 8, marginBottom: 20,
              background: hBg, border: `1px solid ${hColor}44`,
              fontSize: 14, color: "#ccc", lineHeight: 1.6,
            }}>
              {a.executive_summary}
            </div>
          )}

          {/* Comparison with previous version */}
          {av.comparison && (
            <div style={{
              marginBottom: 24, padding: 14, borderRadius: 8,
              background: "#0a0f1a", border: "1px solid #1e3a5f",
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#60a5fa", marginBottom: 10 }}>
                Changes vs v{av.comparedToVersion}
              </div>
              {av.comparison.summary && (
                <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12, lineHeight: 1.5 }}>
                  {av.comparison.summary}
                </div>
              )}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {[
                  { key: "improvements",     label: "Improved",      color: "#22c55e" },
                  { key: "regressions",      label: "Regressed",     color: "#ef4444" },
                  { key: "unchanged_issues", label: "Still broken",  color: "#f59e0b" },
                  { key: "new_issues",       label: "New issues",    color: "#a855f7" },
                ].map(({ key, label, color }) => {
                  const items = (av.comparison as any)[key] as { area: string; detail: string }[];
                  if (!items?.length) return null;
                  return (
                    <div key={key} style={{ flex: "1 1 220px" }}>
                      <div style={{ fontSize: 11, color, marginBottom: 6, fontWeight: 600 }}>
                        {label} ({items.length})
                      </div>
                      {items.map((item, i) => (
                        <div key={i} style={{
                          fontSize: 12, padding: "6px 10px", borderRadius: 4, marginBottom: 4,
                          background: `${color}11`, border: `1px solid ${color}33`,
                        }}>
                          <div style={{ color, fontWeight: 600 }}>{item.area}</div>
                          <div style={{ color: "#94a3b8", marginTop: 2 }}>{item.detail}</div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Priority actions */}
          {a?.priority_actions?.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#e5e7eb", marginBottom: 10 }}>
                Priority Actions
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {a.priority_actions.map((action, i) => (
                  <div key={i} style={{
                    display: "flex", gap: 12, alignItems: "flex-start",
                    padding: "10px 14px", background: "#0a0a0a",
                    borderRadius: 6, border: "1px solid #1a1a1a",
                  }}>
                    <span style={{
                      color: "#2563eb", fontWeight: 800, fontSize: 14,
                      minWidth: 24, textAlign: "center",
                    }}>
                      #{i + 1}
                    </span>
                    <span style={{ fontSize: 13, color: "#d1d5db", lineHeight: 1.5 }}>{action}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Critical failures */}
          {a?.critical_failures?.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#ef4444", marginBottom: 10 }}>
                Critical Failures ({a.critical_failures.length})
              </div>
              {a.critical_failures.map((f, i) => (
                <div key={i} style={{
                  background: "#0a0a0a", border: "1px solid #ef444433",
                  borderLeft: "3px solid #ef4444",
                  borderRadius: 6, padding: "12px 14px", marginBottom: 10,
                }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#fca5a5" }}>{f.area}</span>
                    <span style={{ fontSize: 11, color: "#888" }}>{f.frequency}</span>
                    {f.prompt_location && (
                      <span style={{
                        fontSize: 10, padding: "1px 7px", borderRadius: 3,
                        background: "#1e3a5f44", color: "#60a5fa", border: "1px solid #1d4ed844",
                      }}>
                        {f.prompt_location}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 8, lineHeight: 1.5 }}>
                    {f.detail}
                  </div>
                  {f.root_cause && (
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>
                      Root cause: <span style={{ color: "#a78bfa" }}>{f.root_cause}</span>
                    </div>
                  )}
                  {f.suggested_fix && (
                    <div style={{
                      fontSize: 12, padding: "8px 12px",
                      background: "#22c55e0a", border: "1px solid #22c55e22",
                      borderRadius: 4, color: "#86efac", lineHeight: 1.5,
                    }}>
                      Fix: {f.suggested_fix}
                    </div>
                  )}
                  <EvidenceList evidence={f.evidence} projectId={projectId} />
                </div>
              ))}
            </div>
          )}

          {/* Missing edge cases */}
          {a?.missing_edge_cases?.length > 0 && (
            <Collapsible title={`Missing Edge Cases (${a.missing_edge_cases.length})`} accent="#f59e0b">
              {a.missing_edge_cases.map((ec, i) => (
                <div key={i} style={{
                  background: "#0a0a0a", border: "1px solid #f59e0b33",
                  borderLeft: "3px solid #f59e0b",
                  borderRadius: 6, padding: "12px 14px", marginBottom: 10,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#fcd34d", marginBottom: 4 }}>
                    {ec.scenario}
                    {ec.frequency && (
                      <span style={{ fontSize: 11, color: "#888", marginLeft: 10 }}>{ec.frequency}</span>
                    )}
                  </div>
                  {ec.impact && (
                    <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 6 }}>
                      Impact: {ec.impact}
                    </div>
                  )}
                  {ec.suggested_handling && (
                    <div style={{
                      fontSize: 12, padding: "8px 12px",
                      background: "#22c55e0a", border: "1px solid #22c55e22",
                      borderRadius: 4, color: "#86efac", lineHeight: 1.5,
                    }}>
                      Suggested: {ec.suggested_handling}
                    </div>
                  )}
                  <EvidenceList evidence={ec.evidence} projectId={projectId} />
                </div>
              ))}
            </Collapsible>
          )}

          {/* Prompt / node issues */}
          {a?.prompt_issues?.length > 0 && (
            <Collapsible title={`Prompt & Node Issues (${a.prompt_issues.length})`} accent="#a855f7">
              {a.prompt_issues.map((pi, i) => (
                <div key={i} style={{
                  background: "#0a0a0a", border: "1px solid #a855f733",
                  borderLeft: "3px solid #a855f7",
                  borderRadius: 6, padding: "12px 14px", marginBottom: 10,
                }}>
                  <div style={{
                    fontSize: 11, color: "#c4b5fd", marginBottom: 6,
                    padding: "2px 8px", background: "#4c1d9522", borderRadius: 3,
                    display: "inline-block", border: "1px solid #7c3aed44",
                  }}>
                    {pi.location}
                  </div>
                  <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 8, lineHeight: 1.5 }}>
                    {pi.issue}
                  </div>
                  {pi.suggested_fix && (
                    <div style={{
                      fontSize: 12, padding: "8px 12px",
                      background: "#22c55e0a", border: "1px solid #22c55e22",
                      borderRadius: 4, color: "#86efac", lineHeight: 1.5,
                    }}>
                      Fix: {pi.suggested_fix}
                    </div>
                  )}
                </div>
              ))}
            </Collapsible>
          )}

          {/* Best parts */}
          {a?.best_parts?.length > 0 && (
            <Collapsible title={`What's Working Well (${a.best_parts.length})`} accent="#22c55e">
              {a.best_parts.map((bp, i) => (
                <div key={i} style={{
                  background: "#0a0a0a", border: "1px solid #22c55e33",
                  borderLeft: "3px solid #22c55e",
                  borderRadius: 6, padding: "12px 14px", marginBottom: 10,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#86efac", marginBottom: 4 }}>
                    {bp.area}
                  </div>
                  <div style={{ fontSize: 13, color: "#9ca3af", lineHeight: 1.5 }}>{bp.detail}</div>
                  <EvidenceList evidence={bp.evidence} projectId={projectId} />
                </div>
              ))}
            </Collapsible>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────

export default function ProjectAnalyses() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [analyses, setAnalyses]         = useState<ProjectAnalysis[]>([]);
  const [loading, setLoading]           = useState(true);
  const [running, setRunning]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [selected, setSelected]         = useState<Set<string>>(new Set());

  function toggleSelect(analysisId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(analysisId)) next.delete(analysisId);
      else if (next.size < 6)   next.add(analysisId);
      return next;
    });
  }

  // Filter state
  const [dateFilterType, setDateFilterType] = useState<DateFilterType | "">("");
  const [from, setFrom]                     = useState("");
  const [to, setTo]                         = useState("");

  const load = () => {
    listProjectAnalyses(id!)
      .then(setAnalyses)
      .catch((err) => setError(`Failed to load analyses: ${extractApiError(err)}`))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [id]);

  async function handleRunAnalysis() {
    setRunning(true);
    setError(null);
    try {
      await runProjectAnalysis(id!, {
        dateFilterType: dateFilterType || undefined,
        from: from || undefined,
        to:   to   || undefined,
      });
      load();
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete(analysisId: string) {
    if (!window.confirm("Delete this analysis version? This cannot be undone.")) return;
    try {
      await deleteProjectAnalysis(id!, analysisId);
      setAnalyses((prev) => prev.filter((a) => a.id !== analysisId));
      // Also remove from selection so the count and compare button stay accurate
      setSelected((prev) => {
        if (!prev.has(analysisId)) return prev;
        const next = new Set(prev);
        next.delete(analysisId);
        return next;
      });
    } catch (err) {
      setError(`Failed to delete: ${extractApiError(err)}`);
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <Link to={`/projects/${id}`} style={{ color: "#888", textDecoration: "none", fontSize: 14 }}>
          ← Back to project
        </Link>
        <h1 style={{ margin: "8px 0 4px", fontSize: 22 }}>Project Analysis</h1>
        <p style={{ color: "#666", fontSize: 13, margin: 0 }}>
          Each run generates a new versioned analysis. Versions are compared automatically.
        </p>
      </div>

      {/* Run new analysis panel */}
      <div style={{
        background: "#111", border: "1px solid #222", borderRadius: 10,
        padding: "18px 20px", marginBottom: 28,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#e5e7eb", marginBottom: 14 }}>
          Run New Analysis
        </div>

        {/* Date filter type selector */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: "#888", display: "block", marginBottom: 6 }}>
            Filter runs by
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            {([["", "All runs (no filter)"], ["CALL_DATE", "Call date"], ["EVAL_DATE", "Evaluated at date"]] as const).map(
              ([val, label]) => (
                <button
                  key={val}
                  onClick={() => { setDateFilterType(val as DateFilterType | ""); setFrom(""); setTo(""); }}
                  style={{
                    padding: "5px 14px", borderRadius: 5, cursor: "pointer", fontSize: 12,
                    background: dateFilterType === val ? "#2563eb" : "#1a1a1a",
                    color: dateFilterType === val ? "#fff" : "#888",
                    border: `1px solid ${dateFilterType === val ? "#3b82f6" : "#333"}`,
                  }}
                >
                  {label}
                </button>
              )
            )}
          </div>
        </div>

        {/* Date range — only shown when a filter type is selected */}
        {dateFilterType && (
          <div style={{ display: "flex", gap: 10, marginBottom: 12, alignItems: "flex-end" }}>
            <div>
              <label style={{ fontSize: 11, color: "#666", display: "block", marginBottom: 4 }}>
                From
              </label>
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                style={{
                  background: "#0a0a0a", border: "1px solid #333", borderRadius: 4,
                  color: "#e0e0e0", padding: "6px 10px", fontSize: 12,
                }}
              />
            </div>
            <div style={{ color: "#444", paddingBottom: 6 }}>→</div>
            <div>
              <label style={{ fontSize: 11, color: "#666", display: "block", marginBottom: 4 }}>
                To
              </label>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                style={{
                  background: "#0a0a0a", border: "1px solid #333", borderRadius: 4,
                  color: "#e0e0e0", padding: "6px 10px", fontSize: 12,
                }}
              />
            </div>
          </div>
        )}

        {/* Info text */}
        <p style={{ fontSize: 12, color: "#4b5563", margin: "0 0 14px" }}>
          Requires at least 3 evaluated runs. Analysis uses GPT-4.1 and costs ~$0.03–0.06.
        </p>

        {/* Warn when a date filter is selected but no dates are provided */}
        {dateFilterType && !from && !to && (
          <div style={{
            padding: "8px 12px", borderRadius: 6, marginBottom: 12,
            background: "#1a130a", border: "1px solid #78350f", color: "#fbbf24", fontSize: 12,
          }}>
            Enter at least one date to filter by {dateFilterType === "CALL_DATE" ? "call date" : "evaluated-at date"},
            or switch to "All runs" to include everything.
          </div>
        )}

        {error && (
          <div style={{
            padding: "8px 12px", borderRadius: 6, marginBottom: 12,
            background: "#2d0a0a", border: "1px solid #7f1d1d", color: "#ef4444", fontSize: 13,
          }}>
            {error}
          </div>
        )}

        <button
          onClick={handleRunAnalysis}
          disabled={running || (!!dateFilterType && !from && !to)}
          style={{
            background: running ? "#1e3a5f" : (!!dateFilterType && !from && !to) ? "#1a1a1a" : "#2563eb",
            color: (!!dateFilterType && !from && !to) ? "#555" : "#fff",
            border: "none", borderRadius: 6,
            padding: "8px 20px", fontSize: 13, fontWeight: 600,
            cursor: running || (!!dateFilterType && !from && !to) ? "default" : "pointer",
          }}
        >
          {running ? "Analyzing… (this may take 20–40 seconds)" : "Run Analysis"}
        </button>
      </div>

      {/* Version history */}
      {loading ? (
        <p style={{ color: "#555" }}>Loading…</p>
      ) : analyses.length === 0 ? (
        <div style={{
          padding: "32px", textAlign: "center", color: "#555",
          border: "1px dashed #222", borderRadius: 10,
        }}>
          No analyses yet. Run your first analysis above.
        </div>
      ) : (
        <div>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            marginBottom: 14, flexWrap: "wrap", gap: 10,
          }}>
            <div style={{ fontSize: 13, color: "#666" }}>
              {analyses.length} version{analyses.length !== 1 ? "s" : ""} — newest first
              {selected.size > 0 && (
                <span style={{ color: "#60a5fa", marginLeft: 10 }}>
                  {selected.size} selected
                </span>
              )}
            </div>
            {analyses.length >= 2 && (
              <button
                onClick={() => navigate(`/projects/${id}/analyses/compare`, {
                  state: { selectedIds: [...selected] },
                })}
                style={{
                  background: selected.size >= 2 ? "#4c1d95" : "#1a1a1a",
                  color: selected.size >= 2 ? "#e9d5ff" : "#555",
                  border: `1px solid ${selected.size >= 2 ? "#7c3aed" : "#333"}`,
                  borderRadius: 6, padding: "6px 16px",
                  fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}
              >
                {selected.size >= 2 ? `Compare ${selected.size} versions` : "Compare versions"}
              </button>
            )}
          </div>
          {analyses.map((av, idx) => (
            <div key={av.id} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              {/* Selection checkbox */}
              {analyses.length >= 2 && (
                <div
                  onClick={() => toggleSelect(av.id)}
                  style={{
                    marginTop: 16, width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                    border: `2px solid ${selected.has(av.id) ? "#3b82f6" : "#333"}`,
                    background: selected.has(av.id) ? "#2563eb" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer",
                  }}
                >
                  {selected.has(av.id) && (
                    <span style={{ color: "#fff", fontSize: 10, fontWeight: 900 }}>✓</span>
                  )}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <AnalysisVersionCard
                  av={av}
                  projectId={id!}
                  onDelete={handleDelete}
                  isNewest={idx === 0}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
