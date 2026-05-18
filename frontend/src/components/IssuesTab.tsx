import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import T from "../theme";
import {
  listTechIssues,
  createTechIssue,
  updateTechIssue,
  deleteTechIssue,
  applyIssueFix,
} from "../api/client";
import type { TechIssue, IssueType, IssueStatus } from "../api/client";

const ISSUE_TYPES: { value: IssueType; label: string; color: string }[] = [
  { value: "DATA_MISMATCH", label: "Data Mismatch", color: "#3b82f6" },
  { value: "VARIABLE_SETTER", label: "Variable Setter", color: "#f59e0b" },
  { value: "AGENT_BEHAVIOR", label: "Agent Behavior", color: "#a855f7" },
  { value: "BACKEND_FAILURE", label: "Backend Failure", color: "#ef4444" },
  { value: "CONFIGURATION", label: "Configuration", color: "#06b6d4" },
  { value: "OTHER", label: "Other", color: "#9ca3af" },
];

const STATUS_COLORS: Record<IssueStatus, string> = {
  OPEN: T.error,
  IN_PROGRESS: T.warning,
  RESOLVED: T.success,
  WONT_FIX: T.textMuted,
};

interface Props {
  projectId: string;
}

export default function IssuesTab({ projectId }: Props) {
  const navigate = useNavigate();
  const [issues, setIssues] = useState<TechIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [statusFilter, setStatusFilter] = useState<IssueStatus | "ALL">("ALL");
  const [error, setError] = useState<string | null>(null);

  // New issue form
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState<IssueType>("DATA_MISMATCH");
  const [newDesc, setNewDesc] = useState("");
  const [newRootCause, setNewRootCause] = useState("");
  const [newComponent, setNewComponent] = useState("");
  const [saving, setSaving] = useState(false);

  // Apply fix state
  const [fixForms, setFixForms] = useState<Record<string, { desc: string; nodeId: string; newPrompt: string }>>({});
  const [applyingFix, setApplyingFix] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listTechIssues(projectId);
      setIssues(data);
    } catch {
      setError("Failed to load issues");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const filtered = statusFilter === "ALL" ? issues : issues.filter((i) => i.status === statusFilter);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim() || !newDesc.trim()) return;
    setSaving(true);
    try {
      const issue = await createTechIssue(projectId, {
        title: newTitle, issueType: newType, description: newDesc,
        rootCause: newRootCause || undefined, component: newComponent || undefined,
      });
      setIssues((i) => [issue, ...i]);
      setNewTitle(""); setNewDesc(""); setNewRootCause(""); setNewComponent(""); setNewType("DATA_MISMATCH"); setShowNew(false);
    } catch (err: any) {
      setError(err.message || "Failed to create issue");
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(issueId: string, status: IssueStatus) {
    try {
      await updateTechIssue(projectId, issueId, { status });
      setIssues((all) => all.map((i) => i.id === issueId ? { ...i, status } : i));
    } catch (err: any) {
      setError(err.message || "Failed to update");
    }
  }

  async function handleDelete(issueId: string) {
    if (!confirm("Delete this issue and all its fix history?")) return;
    try {
      await deleteTechIssue(projectId, issueId);
      setIssues((all) => all.filter((i) => i.id !== issueId));
    } catch (err: any) {
      setError(err.message || "Failed to delete");
    }
  }

  async function handleApplyFix(issueId: string) {
    const form = fixForms[issueId];
    if (!form?.desc?.trim()) return;
    setApplyingFix((a) => ({ ...a, [issueId]: true }));
    try {
      const result = await applyIssueFix(projectId, issueId, {
        description: form.desc,
        nodeId: form.nodeId || undefined,
        newPrompt: form.newPrompt || undefined,
      });
      setIssues((all) => all.map((i) => i.id === issueId ? { ...i, fixes: [...i.fixes, result.fix], status: i.status === "OPEN" ? "IN_PROGRESS" : i.status } : i));
      setFixForms((f) => ({ ...f, [issueId]: { desc: "", nodeId: "", newPrompt: "" } }));
    } catch (err: any) {
      setError(err.message || "Failed to apply fix");
    } finally {
      setApplyingFix((a) => ({ ...a, [issueId]: false }));
    }
  }

  const btnStyle: React.CSSProperties = {
    background: T.primary, color: T.primaryText, border: "none", borderRadius: 6,
    padding: "7px 14px", fontSize: 13, cursor: "pointer", fontWeight: 500,
  };
  const inputStyle: React.CSSProperties = {
    background: T.input, border: `1px solid ${T.border}`, borderRadius: 6,
    padding: "8px 12px", fontSize: 13, color: T.text, width: "100%", boxSizing: "border-box",
  };

  if (loading) return <div style={{ color: T.textMuted, fontSize: 13, padding: "32px 0" }}>Loading issues…</div>;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: T.text }}>
          Issue Tracker
          {issues.filter((i) => i.status === "OPEN" || i.status === "IN_PROGRESS").length > 0 && (
            <span style={{ marginLeft: 8, background: T.error, color: "#fff", borderRadius: 12, padding: "2px 8px", fontSize: 12 }}>
              {issues.filter((i) => i.status === "OPEN" || i.status === "IN_PROGRESS").length} active
            </span>
          )}
        </h3>
        <button style={{ ...btnStyle, fontSize: 12 }} onClick={() => setShowNew(true)}>+ New Issue</button>
      </div>

      {error && <div style={{ color: T.error, fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {/* Status filter */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {(["ALL", "OPEN", "IN_PROGRESS", "RESOLVED", "WONT_FIX"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            style={{
              background: statusFilter === s ? T.primary : T.cardAlt,
              color: statusFilter === s ? T.primaryText : T.textSecondary,
              border: `1px solid ${statusFilter === s ? T.primary : T.border}`,
              borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer",
            }}
          >
            {s === "ALL" ? "All" : s.replace("_", " ")}
          </button>
        ))}
      </div>

      {/* New issue form */}
      {showNew && (
        <form onSubmit={handleCreate} style={{ background: T.card, border: `1px solid ${T.primary}`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 12 }}>New Issue</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input style={{ ...inputStyle, flex: 1 }} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Issue title" required />
            <select style={{ ...inputStyle, width: "auto" }} value={newType} onChange={(e) => setNewType(e.target.value as IssueType)}>
              {ISSUE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical", marginBottom: 8 }} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Description — what goes wrong?" required />
          <input style={{ ...inputStyle, marginBottom: 8 }} value={newRootCause} onChange={(e) => setNewRootCause(e.target.value)} placeholder="Root cause (optional)" />
          <input style={{ ...inputStyle, marginBottom: 12 }} value={newComponent} onChange={(e) => setNewComponent(e.target.value)} placeholder="Component (e.g. 'seat_class variable setter')" />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" style={btnStyle} disabled={saving}>{saving ? "Saving…" : "Create Issue"}</button>
            <button type="button" style={{ ...btnStyle, background: T.cardAlt, color: T.textSecondary, border: `1px solid ${T.border}` }} onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        </form>
      )}

      {filtered.length === 0 && !showNew && (
        <div style={{ color: T.textMuted, fontSize: 13, textAlign: "center", padding: "32px 0" }}>
          No issues yet. Create one to track a recurring problem and its fix history.
        </div>
      )}

      {filtered.map((issue) => {
        const typeInfo = ISSUE_TYPES.find((t) => t.value === issue.issueType);
        const isExpanded = expandedId === issue.id;
        const fixForm = fixForms[issue.id] ?? { desc: "", nodeId: "", newPrompt: "" };

        return (
          <div key={issue.id} style={{ background: T.card, border: `1px solid ${isExpanded ? T.primary : T.border}`, borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
            {/* Issue header */}
            <div style={{ display: "flex", alignItems: "center", padding: "12px 16px", cursor: "pointer", gap: 10 }} onClick={() => setExpandedId(isExpanded ? null : issue.id)}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_COLORS[issue.status], flexShrink: 0 }} />
              <span style={{ fontWeight: 600, fontSize: 13, color: T.text, flex: 1 }}>{issue.title}</span>
              <span style={{ fontSize: 11, background: typeInfo ? typeInfo.color + "22" : T.cardAlt, color: typeInfo?.color ?? T.textSecondary, borderRadius: 4, padding: "2px 7px", fontWeight: 500 }}>
                {typeInfo?.label ?? issue.issueType}
              </span>
              {issue.component && <span style={{ fontSize: 11, color: T.textMuted }}>{issue.component}</span>}
              <span style={{ fontSize: 11, color: STATUS_COLORS[issue.status], fontWeight: 600 }}>{issue.status.replace("_", " ")}</span>
              <span style={{ fontSize: 11, color: T.textMuted }}>{issue.fixes.length} fix{issue.fixes.length !== 1 ? "es" : ""}</span>
              <span style={{ fontSize: 12, color: T.textSecondary }}>{isExpanded ? "▲" : "▼"}</span>
            </div>

            {isExpanded && (
              <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${T.border}` }}>
                {/* Description + root cause */}
                <div style={{ marginTop: 12, marginBottom: 12 }}>
                  <div style={{ fontSize: 13, color: T.text, marginBottom: 8 }}>{issue.description}</div>
                  {issue.rootCause && (
                    <div style={{ fontSize: 12, color: T.textSecondary, background: T.cardAlt, borderRadius: 6, padding: "8px 12px", marginBottom: 8 }}>
                      <strong>Root cause:</strong> {issue.rootCause}
                    </div>
                  )}
                  {issue.fix && (
                    <div style={{ fontSize: 12, color: T.textSecondary, background: T.primaryLight, borderRadius: 6, padding: "8px 12px", marginBottom: 8 }}>
                      <strong>Known fix:</strong> {issue.fix}
                    </div>
                  )}
                </div>

                {/* Fix history timeline */}
                {issue.fixes.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: T.textSecondary, marginBottom: 8 }}>Fix History</div>
                    {issue.fixes.map((fix, i) => (
                      <div key={fix.id} style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 20 }}>
                          <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.primary, marginTop: 4, flexShrink: 0 }} />
                          {i < issue.fixes.length - 1 && <div style={{ width: 1, flex: 1, background: T.border, marginTop: 2 }} />}
                        </div>
                        <div style={{ flex: 1, background: T.cardAlt, borderRadius: 6, padding: "8px 12px" }}>
                          <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>{new Date(fix.appliedAt).toLocaleString()}</div>
                          <div style={{ fontSize: 12, color: T.text, marginBottom: fix.nodeId ? 4 : 0 }}>{fix.description}</div>
                          {fix.nodeId && <div style={{ fontSize: 11, color: T.textSecondary }}>Node: <code>{fix.nodeId}</code></div>}
                          {fix.newPrompt && (
                            <pre style={{ fontSize: 11, color: T.textSecondary, background: T.input, borderRadius: 4, padding: "6px 8px", margin: "6px 0 0", whiteSpace: "pre-wrap", maxHeight: 100, overflow: "auto" }}>
                              {fix.newPrompt}
                            </pre>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Linked runs */}
                {issue.runs.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: T.textSecondary, marginBottom: 6 }}>Linked Calls ({issue.runs.length})</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {issue.runs.slice(0, 8).map((r) => (
                        <button
                          key={r.id}
                          onClick={() => navigate(`/runs/${r.runId}`)}
                          style={{ background: T.cardAlt, color: T.textSecondary, border: `1px solid ${T.border}`, borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer" }}
                        >
                          {r.run.callDate ? new Date(r.run.callDate).toLocaleDateString() : r.runId.slice(-6)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Apply fix section */}
                {issue.status !== "RESOLVED" && issue.status !== "WONT_FIX" && (
                  <div style={{ background: T.cardAlt, borderRadius: 8, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: T.textSecondary, marginBottom: 8 }}>Apply a Fix</div>
                    <textarea
                      style={{ ...inputStyle, minHeight: 50, resize: "vertical", marginBottom: 8, fontSize: 12 }}
                      value={fixForm.desc}
                      onChange={(e) => setFixForms((f) => ({ ...f, [issue.id]: { ...fixForm, desc: e.target.value } }))}
                      placeholder="Describe what you fixed (e.g. 'Updated variable setter expression from seats.class to seats[0].class')"
                    />
                    <input
                      style={{ ...inputStyle, marginBottom: 8, fontSize: 12 }}
                      value={fixForm.nodeId}
                      onChange={(e) => setFixForms((f) => ({ ...f, [issue.id]: { ...fixForm, nodeId: e.target.value } }))}
                      placeholder="Node ID to patch (optional — leave blank if not patching a node)"
                    />
                    {fixForm.nodeId && (
                      <textarea
                        style={{ ...inputStyle, minHeight: 70, resize: "vertical", marginBottom: 8, fontFamily: "monospace", fontSize: 11 }}
                        value={fixForm.newPrompt}
                        onChange={(e) => setFixForms((f) => ({ ...f, [issue.id]: { ...fixForm, newPrompt: e.target.value } }))}
                        placeholder="New prompt for this node (will be pushed live to the Hamsa agent)"
                      />
                    )}
                    <button
                      style={{ ...btnStyle, fontSize: 12 }}
                      onClick={() => handleApplyFix(issue.id)}
                      disabled={applyingFix[issue.id] || !fixForm.desc.trim()}
                    >
                      {applyingFix[issue.id] ? "Applying…" : fixForm.nodeId && fixForm.newPrompt ? "Apply Fix & Patch Live Agent" : "Log Fix"}
                    </button>
                  </div>
                )}

                {/* Status + delete */}
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select
                    style={{ ...inputStyle, width: "auto", fontSize: 12 }}
                    value={issue.status}
                    onChange={(e) => handleStatusChange(issue.id, e.target.value as IssueStatus)}
                  >
                    <option value="OPEN">Open</option>
                    <option value="IN_PROGRESS">In Progress</option>
                    <option value="RESOLVED">Resolved</option>
                    <option value="WONT_FIX">Won't Fix</option>
                  </select>
                  <button
                    style={{ background: "transparent", color: T.error, border: "none", fontSize: 12, cursor: "pointer", padding: "4px 8px" }}
                    onClick={() => handleDelete(issue.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
