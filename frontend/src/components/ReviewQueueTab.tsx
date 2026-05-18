import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import T from "../theme";
import { listRuns, listTechIssues, completeReview } from "../api/client";
import type { TechIssue } from "../api/client";

interface Run {
  id: string;
  hamsaCallId: string | null;
  callDate: string | null;
  callDuration: number | null;
  status: string;
  transcript: any[] | null;
  callStatus: string | null;
}

interface Props {
  projectId: string;
}

export default function ReviewQueueTab({ projectId }: Props) {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<Run[]>([]);
  const [issues, setIssues] = useState<TechIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Per-run review state
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [payloads, setPayloads] = useState<Record<string, string>>({});
  const [selectedIssues, setSelectedIssues] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [payloadErrors, setPayloadErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Pass status=PENDING_REVIEW so the server filters — avoids fetching 200 runs
      // and silently missing pending reviews beyond the 200-run window.
      const [pendingRuns, allIssues] = await Promise.all([
        listRuns(projectId, 0, 200, "PENDING_REVIEW"),
        listTechIssues(projectId),
      ]);
      setRuns(pendingRuns as any[]);
      setIssues(allIssues);
    } catch {
      setError("Failed to load review queue");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  async function handleComplete(runId: string, skip = false) {
    const payloadStr = payloads[runId]?.trim();
    let apiPayload: any = undefined;
    if (payloadStr) {
      try {
        apiPayload = JSON.parse(payloadStr);
      } catch {
        setPayloadErrors((e) => ({ ...e, [runId]: "Invalid JSON — fix before submitting" }));
        return;
      }
    }
    setPayloadErrors((e) => ({ ...e, [runId]: "" }));
    setSubmitting((s) => ({ ...s, [runId]: true }));
    try {
      await completeReview(runId, {
        note: notes[runId] || undefined,
        issueIds: selectedIssues[runId] || [],
        apiPayload: apiPayload,
        skip,
      });
      setRuns((r) => r.filter((run) => run.id !== runId));
      setExpandedId(null);
    } catch (err: any) {
      // 409 = already reviewed (e.g. submitted from RunDetail simultaneously) — treat as success
      if (err.message?.includes("409") || err.message?.includes("already been reviewed")) {
        setRuns((r) => r.filter((run) => run.id !== runId));
        setExpandedId(null);
      } else {
        setError(err.message || "Failed to submit review");
      }
    } finally {
      setSubmitting((s) => ({ ...s, [runId]: false }));
    }
  }

  function toggleIssue(runId: string, issueId: string) {
    setSelectedIssues((s) => {
      const curr = s[runId] ?? [];
      return {
        ...s,
        [runId]: curr.includes(issueId) ? curr.filter((id) => id !== issueId) : [...curr, issueId],
      };
    });
  }

  function formatDate(d: string | null) {
    if (!d) return "—";
    return new Date(d).toLocaleString();
  }

  function getTranscriptPreview(transcript: any[] | null): string {
    if (!Array.isArray(transcript) || transcript.length === 0) return "(no transcript)";
    return transcript
      .slice(0, 6)
      .map((t: any) => (t.Agent ? `A: ${t.Agent}` : t.User ? `U: ${t.User}` : ""))
      .filter(Boolean)
      .join("\n");
  }

  const btnStyle: React.CSSProperties = {
    background: T.primary, color: T.primaryText, border: "none", borderRadius: 6,
    padding: "7px 14px", fontSize: 13, cursor: "pointer", fontWeight: 500,
  };
  const inputStyle: React.CSSProperties = {
    background: T.input, border: `1px solid ${T.border}`, borderRadius: 6,
    padding: "8px 12px", fontSize: 13, color: T.text, width: "100%", boxSizing: "border-box",
  };

  if (loading) return <div style={{ color: T.textMuted, fontSize: 13, padding: "32px 0" }}>Loading review queue…</div>;
  if (error) return <div style={{ color: T.error, fontSize: 13 }}>{error}</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: T.text }}>
          Review Queue
          {runs.length > 0 && (
            <span style={{ marginLeft: 8, background: T.warning, color: "#fff", borderRadius: 12, padding: "2px 8px", fontSize: 12 }}>
              {runs.length}
            </span>
          )}
        </h3>
        <button style={{ ...btnStyle, fontSize: 12, background: T.cardAlt, color: T.textSecondary, border: `1px solid ${T.border}` }} onClick={load}>Refresh</button>
      </div>

      {runs.length === 0 ? (
        <div style={{ color: T.textMuted, fontSize: 13, textAlign: "center", padding: "32px 0" }}>
          No calls pending review. New calls from this agent will appear here automatically.
        </div>
      ) : (
        <div>
          {runs.map((run) => (
            <div
              key={run.id}
              style={{ background: T.card, border: `1px solid ${expandedId === run.id ? T.primary : T.border}`, borderRadius: 8, marginBottom: 10, overflow: "hidden" }}
            >
              {/* Header row */}
              <div
                style={{ display: "flex", alignItems: "center", padding: "12px 16px", cursor: "pointer", gap: 12 }}
                onClick={() => setExpandedId(expandedId === run.id ? null : run.id)}
              >
                <span style={{ fontSize: 11, background: T.warningBg, color: T.warning, borderRadius: 4, padding: "2px 7px", fontWeight: 600 }}>PENDING REVIEW</span>
                <span style={{ fontSize: 13, color: T.text, flex: 1 }}>{formatDate(run.callDate)}</span>
                {run.callDuration != null && (
                  <span style={{ fontSize: 12, color: T.textMuted }}>{run.callDuration}s</span>
                )}
                <span style={{ fontSize: 12, color: T.primary, cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); navigate(`/runs/${run.id}`); }}>
                  View Call ↗
                </span>
                <span style={{ fontSize: 12, color: T.textSecondary }}>{expandedId === run.id ? "▲" : "▼"}</span>
              </div>

              {/* Expanded review form */}
              {expandedId === run.id && (
                <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${T.border}` }}>
                  {/* Transcript preview */}
                  <div style={{ marginTop: 12, marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: T.textSecondary, marginBottom: 6 }}>Transcript Preview</div>
                    <pre style={{ background: T.cardAlt, borderRadius: 6, padding: "10px 12px", fontSize: 12, color: T.textSecondary, margin: 0, whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>
                      {getTranscriptPreview(run.transcript)}
                    </pre>
                  </div>

                  {/* Context note */}
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: T.textSecondary, display: "block", marginBottom: 4 }}>
                      Reviewer Note (what issue occurred in this call?)
                    </label>
                    <textarea
                      style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
                      value={notes[run.id] ?? ""}
                      onChange={(e) => setNotes((n) => ({ ...n, [run.id]: e.target.value }))}
                      placeholder="e.g. Seat class was extracted as undefined even though API returned BUSINESS"
                    />
                  </div>

                  {/* API Payload */}
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: T.textSecondary, display: "block", marginBottom: 4 }}>
                      API Response Payload (paste raw JSON from flights API)
                    </label>
                    <textarea
                      style={{ ...inputStyle, minHeight: 80, resize: "vertical", fontFamily: "monospace", fontSize: 11 }}
                      value={payloads[run.id] ?? ""}
                      onChange={(e) => {
                        setPayloads((p) => ({ ...p, [run.id]: e.target.value }));
                        setPayloadErrors((e2) => ({ ...e2, [run.id]: "" }));
                      }}
                      placeholder='{"flights": [{"seat_class": "BUSINESS", ...}]}'
                    />
                    {payloadErrors[run.id] && (
                      <div style={{ fontSize: 11, color: T.error, marginTop: 4 }}>{payloadErrors[run.id]}</div>
                    )}
                  </div>

                  {/* Issue linking */}
                  {issues.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.textSecondary, marginBottom: 6 }}>Link to Known Issues</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {issues.filter((i) => i.status !== "RESOLVED" && i.status !== "WONT_FIX").map((issue) => {
                          const selected = (selectedIssues[run.id] ?? []).includes(issue.id);
                          return (
                            <button
                              key={issue.id}
                              onClick={() => toggleIssue(run.id, issue.id)}
                              style={{
                                background: selected ? T.primary : T.cardAlt,
                                color: selected ? T.primaryText : T.textSecondary,
                                border: `1px solid ${selected ? T.primary : T.border}`,
                                borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer",
                              }}
                            >
                              {issue.title}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Action buttons */}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      style={btnStyle}
                      onClick={() => handleComplete(run.id, false)}
                      disabled={submitting[run.id]}
                    >
                      {submitting[run.id] ? "Submitting…" : "Complete Review & Evaluate"}
                    </button>
                    <button
                      style={{ ...btnStyle, background: T.cardAlt, color: T.textSecondary, border: `1px solid ${T.border}` }}
                      onClick={() => handleComplete(run.id, true)}
                      disabled={submitting[run.id]}
                    >
                      Skip (evaluate with no context)
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
