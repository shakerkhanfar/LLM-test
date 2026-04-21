import { useEffect, useState, useCallback } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  getProject, createRun, deleteRun, triggerEvaluation, switchModel,
  attachCallLog, attachTranscript, importHistory, refreshAgent,
} from "../api/client";
import CallAgent from "../components/CallAgent";

const AVAILABLE_MODELS = [
  { provider: "OpenAI", models: [
    { value: "openai/gpt-5", label: "GPT-5", desc: "Best for complex, high-accuracy conversations." },
    { value: "openai/gpt-5-mini", label: "GPT-5 Mini", desc: "Smart + fast; great for real-time support." },
    { value: "openai/gpt-5-nano", label: "GPT-5 Nano", desc: "Ultra-fast, low-cost; ideal for FAQs & scale." },
    { value: "openai/gpt-4.1", label: "GPT-4.1", desc: "Reliable and balanced for most agents." },
    { value: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", desc: "Quicker responses with solid quality." },
    { value: "openai/gpt-4.1-nano", label: "GPT-4.1 Nano", desc: "Lightweight; perfect for simple, repetitive tasks." },
    { value: "openai/gpt-4o", label: "GPT-4o", desc: "Most natural, human-like conversations." },
    { value: "openai/gpt-4o-mini", label: "GPT-4o Mini", desc: "Fast, smooth chat for customer-facing agents." },
  ]},
  { provider: "Groq", models: [
    { value: "groq/gpt-120-oss", label: "GPT-120-OSS", desc: "Groq-powered open source model with 120B parameters." },
    { value: "groq/gpt-20-oss", label: "GPT-20-OSS", desc: "Groq-powered lightweight open source model with 20B parameters." },
  ]},
];

const STATUS_COLORS: Record<string, string> = {
  PENDING: "#888",
  RUNNING: "#f59e0b",
  AWAITING_DATA: "#f59e0b",
  EVALUATING: "#3b82f6",
  COMPLETE: "#22c55e",
  FAILED: "#ef4444",
};

// Quick-fill presets — compute the date range they correspond to
function getPresetRange(preset: string): { start: string; end: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const today = fmt(now);
  const yesterday = fmt(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

  switch (preset) {
    case "LAST_HOUR":
    case "TODAY":
      return { start: today, end: today };
    case "YESTERDAY":
      return { start: yesterday, end: yesterday };
    case "THIS_WEEK": {
      const day = now.getDay(); // 0=Sun
      const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((day + 6) % 7));
      return { start: fmt(mon), end: today };
    }
    case "THIS_MONTH": {
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: fmt(firstOfMonth), end: today };
    }
    case "LAST_MONTH": {
      const firstOfLast = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastOfLast = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: fmt(firstOfLast), end: fmt(lastOfLast) };
    }
    default:
      return { start: "", end: "" };
  }
}

const QUICK_PRESETS = [
  { value: "TODAY", label: "Today" },
  { value: "YESTERDAY", label: "Yesterday" },
  { value: "THIS_WEEK", label: "This Week" },
  { value: "THIS_MONTH", label: "This Month" },
  { value: "LAST_MONTH", label: "Last Month" },
];

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const importWarning = searchParams.get("importWarning");
  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showNewRun, setShowNewRun] = useState(false);
  const [modelInput, setModelInput] = useState("openai/gpt-4.1");
  const [showUpload, setShowUpload] = useState<string | null>(null);
  const [callingRunId, setCallingRunId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"evaluation" | "outcomes">("evaluation");
  const [searchQuery, setSearchQuery] = useState("");

  // History import state — always use date range (CUSTOM period)
  const [showHistoryImport, setShowHistoryImport] = useState(false);
  const [historyStartDate, setHistoryStartDate] = useState(() => getPresetRange("THIS_MONTH").start);
  const [historyEndDate, setHistoryEndDate] = useState(() => getPresetRange("THIS_MONTH").end);
  const [historyLimit, setHistoryLimit] = useState(50);
  const [historyImporting, setHistoryImporting] = useState(false);
  const [historyResult, setHistoryResult] = useState<any>(null);

  const isHistory = project?.projectType === "HISTORY";
  const isWebhook = project?.projectType === "WEBHOOK";

  const load = useCallback(() => {
    getProject(id!)
      .then(setProject)
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Poll while there are in-progress runs OR for WEBHOOK projects (always listen for new calls)
  useEffect(() => {
    if (!project) return;
    const hasActive = project.runs?.some((r: any) =>
      ["PENDING", "AWAITING_DATA", "EVALUATING"].includes(r.status)
    );
    const isWebhookProject = project.projectType === "WEBHOOK";
    if (!hasActive && !isWebhookProject) return;
    // Poll faster when runs are in-progress, slower for idle webhook polling
    const interval = hasActive ? 4000 : 10000;
    const timer = setTimeout(load, interval);
    return () => clearTimeout(timer);
  }, [project, load]);

  if (loading) return <p>Loading...</p>;
  if (!project) return <p>Project not found</p>;

  async function handleCreateRun() {
    const run = await createRun({ projectId: project.id, modelUsed: modelInput });
    setShowNewRun(false);
    try { await switchModel(run.id); } catch { /* allow manual call */ }
    load();
    setCallingRunId(run.id);
  }

  async function handleHistoryImport() {
    if (!historyStartDate || !historyEndDate) {
      setHistoryResult({ error: "Please select both a start and end date." });
      return;
    }
    if (historyStartDate > historyEndDate) {
      setHistoryResult({ error: "Start date must be on or before end date." });
      return;
    }
    setHistoryImporting(true);
    setHistoryResult(null);
    try {
      const result = await importHistory(project.id, {
        period: "CUSTOM",
        startDate: historyStartDate,
        endDate: historyEndDate,
        limit: historyLimit,
      });
      setHistoryResult(result);
      load();
    } catch (err) {
      setHistoryResult({ error: (err as Error).message });
    } finally {
      setHistoryImporting(false);
    }
  }

  async function handleUploadData(runId: string, type: "callLog" | "transcript", jsonStr: string) {
    try {
      const data = JSON.parse(jsonStr);
      if (type === "callLog") {
        await attachCallLog(runId, data);
      } else {
        const transcript = data.data?.transcription || data.transcription || data;
        await attachTranscript(runId, transcript, data);
      }
      setShowUpload(null);
      load();
    } catch (err) {
      alert("Invalid JSON: " + (err as Error).message);
    }
  }

  // Compute total eval cost across all runs
  const totalEvalCost = (project.runs ?? []).reduce((sum: number, r: any) => sum + (r.evalCost ?? 0), 0);

  // Find best and worst run
  const completedRuns = project.runs?.filter((r: any) => r.status === "COMPLETE" && r.overallScore != null) || [];
  const bestRun = completedRuns.length > 0
    ? completedRuns.reduce((a: any, b: any) => (a.overallScore > b.overallScore ? a : b))
    : null;
  const worstRun = completedRuns.length > 1
    ? completedRuns.reduce((a: any, b: any) => (a.overallScore < b.overallScore ? a : b))
    : null;

  // Dynamic outcome columns — collect all unique keys from outcomeResult across all runs
  const OUTCOME_SKIP_KEYS = new Set(["default_params"]);
  const outcomeColumns: string[] = [];
  if (isWebhook || isHistory) {
    const seen = new Set<string>();
    for (const r of (project.runs ?? [])) {
      const outcome = r.outcomeResult;
      if (outcome && typeof outcome === "object") {
        for (const key of Object.keys(outcome)) {
          if (!seen.has(key) && !OUTCOME_SKIP_KEYS.has(key)) {
            seen.add(key);
            outcomeColumns.push(key);
          }
        }
      }
    }
  }

  const agentStruct = project.agentStructure as any;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <Link to="/" style={{ color: "#888", textDecoration: "none", fontSize: 14 }}>
          &larr; Projects
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "8px 0 4px" }}>
          <h1 style={{ margin: 0 }}>{project.name}</h1>
          <span style={{
            fontSize: 11, padding: "2px 8px", borderRadius: 4,
            background: isWebhook ? "#4c1d95" : isHistory ? "#1e3a5f" : "#14532d",
            color: isWebhook ? "#c084fc" : isHistory ? "#60a5fa" : "#4ade80",
            border: `1px solid ${isWebhook ? "#7c3aed" : isHistory ? "#1d4ed8" : "#16a34a"}`,
          }}>
            {isWebhook ? "Webhook" : isHistory ? "History" : "Live"}
          </span>
        </div>
        {project.description && <p style={{ color: "#888", margin: 0 }}>{project.description}</p>}
        {isWebhook && <WebhookUrlBar url={`${window.location.origin}/api/webhooks/hamsa/${project.id}`} />}
        {!isWebhook && project.hamsaApiKey && !isHistory && <WebhookUrlBar url={`${window.location.origin}/api/webhooks/hamsa`} />}

        {/* Agent info strip */}
        {agentStruct && (
          <div style={{ marginTop: 8, display: "flex", gap: 16, fontSize: 12, color: "#555", alignItems: "center" }}>
            <span style={{ color: "#666" }}>Agent: <span style={{ color: "#888" }}>{agentStruct.name || project.agentId}</span></span>
            {agentStruct.type && <span style={{ color: "#444" }}>{agentStruct.type}</span>}
            {agentStruct.voice?.lang && <span>Lang: {agentStruct.voice.lang}</span>}
            {agentStruct.llm?.model && <span>LLM: {agentStruct.llm.model}</span>}
            <RefreshAgentButton projectId={project.id} onSuccess={load} />
          </div>
        )}
      </div>

      {/* Import warning — shown when auto-import found 0 conversations */}
      {importWarning === "noCalls" && !isWebhook && (
        <div style={{
          padding: "12px 16px", borderRadius: 8, marginBottom: 20,
          background: "#1a130a", border: "1px solid #78350f", color: "#fbbf24",
          fontSize: 13, lineHeight: 1.6,
        }}>
          <strong>No calls found</strong> for the selected date range. The agent may not have any calls in that period,
          or the date range may not match the agent's timezone. Try a wider range using the{" "}
          <button
            onClick={() => { setShowHistoryImport(true); navigate(`/projects/${id}`, { replace: true }); }}
            style={{ color: "#fbbf24", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", fontSize: 13, padding: 0 }}
          >
            Import History
          </button>{" "}panel below.
        </div>
      )}

      {/* Agent intelligence panel — what the system understood from the import */}
      {(agentStruct || project.agentSummary) && (
        <AgentIntelligencePanel agentStruct={agentStruct} agentSummary={project.agentSummary} />
      )}

      {/* Summary cards */}
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <Card label={isWebhook ? "Total Calls" : "Total Runs"} value={project.runs?.length ?? 0} />
        <Card label="Criteria" value={project.criteria?.length ?? 0} />
        {bestRun && <Card label={(isHistory || isWebhook) ? "Best Call" : "Best Model"} value={`${(isHistory || isWebhook) ? formatDate(bestRun.callDate) : bestRun.modelUsed} (${(bestRun.overallScore * 100).toFixed(0)}%)`} href={`/projects/${id}/runs/${bestRun.id}`} />}
        {worstRun && worstRun.id !== bestRun?.id && (
          <Card label={(isHistory || isWebhook) ? "Worst Call" : "Worst Model"} value={`${(isHistory || isWebhook) ? formatDate(worstRun.callDate) : worstRun.modelUsed} (${(worstRun.overallScore * 100).toFixed(0)}%)`} href={`/projects/${id}/runs/${worstRun.id}`} />
        )}
        {(isHistory || isWebhook) && completedRuns.length > 0 && (
          <Card
            label="Avg Score"
            value={`${(completedRuns.reduce((s: number, r: any) => s + r.overallScore, 0) / completedRuns.length * 100).toFixed(0)}%`}
          />
        )}
        {(isHistory || isWebhook) && (() => {
          const failedCalls = (project.runs ?? []).filter((r: any) => r.callStatus === "FAILED" || r.callStatus === "NO_ANSWER");
          const completedCalls = (project.runs ?? []).filter((r: any) => r.callStatus === "COMPLETED");
          if (completedCalls.length + failedCalls.length === 0) return null;
          return (
            <Card
              label="Call Outcomes"
              value={`${completedCalls.length} ok · ${failedCalls.length} failed`}
            />
          );
        })()}
        {totalEvalCost > 0 && (
          <Card label="Eval Cost" value={`$${totalEvalCost < 0.01 ? totalEvalCost.toFixed(4) : totalEvalCost.toFixed(3)}`} />
        )}
      </div>

      {/* Webhook status — auto-polling indicator */}
      {isWebhook && (
        <div style={{
          padding: "10px 16px", borderRadius: 8, marginBottom: 16,
          background: "#1a0a2e", border: "1px solid #7c3aed", color: "#c084fc",
          fontSize: 13, display: "flex", alignItems: "center", gap: 10,
        }}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#22c55e", animation: "pulse 2s infinite" }} />
          Listening for incoming calls via webhook. Each call is automatically evaluated against {project.criteria?.length ?? 0} criteria.
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        {!isHistory && !isWebhook && (
          <button onClick={() => setShowNewRun(true)} style={btnStyle}>
            + New Run
          </button>
        )}
        {/* Import History — not shown for WEBHOOK projects (they get data via webhook) */}
        {!isWebhook && (
          <button
            onClick={() => { setShowHistoryImport(!showHistoryImport); setHistoryResult(null); }}
            style={{ ...btnStyle, background: showHistoryImport ? "#1e3a5f" : "#1d4ed8" }}
          >
            {showHistoryImport ? "Close Import" : "Import History"}
          </button>
        )}
        {completedRuns.length >= 2 && (
          <button onClick={() => navigate(`/projects/${id}/compare`)} style={{ ...btnStyle, background: "#374151" }}>
            Compare Runs
          </button>
        )}
        {completedRuns.length >= 3 && (
          <button onClick={() => navigate(`/projects/${id}/analyses`)} style={{ ...btnStyle, background: "#4c1d95" }}>
            Analyze Project
          </button>
        )}
      </div>

      {/* History import panel */}
      {showHistoryImport && !isWebhook && (
        <div style={{ background: "#0f1626", padding: 16, borderRadius: 8, marginBottom: 16, border: "1px solid #1e3a5f" }}>
          <h3 style={{ margin: "0 0 14px", fontSize: 14, color: "#60a5fa" }}>Import Call History</h3>

          {/* Quick preset buttons — fill the date range */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ ...labelStyle, marginBottom: 6 }}>Quick select</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {QUICK_PRESETS.map((p) => {
                const range = getPresetRange(p.value);
                const isActive = historyStartDate === range.start && historyEndDate === range.end;
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => { setHistoryStartDate(range.start); setHistoryEndDate(range.end); }}
                    style={{
                      padding: "4px 12px",
                      background: isActive ? "#1d4ed8" : "#1a1a2e",
                      color: isActive ? "#fff" : "#888",
                      border: `1px solid ${isActive ? "#3b82f6" : "#333"}`,
                      borderRadius: 4, cursor: "pointer", fontSize: 12,
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Always-visible date range pickers */}
          <div style={{ display: "flex", gap: 10, marginBottom: 12, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <label style={{ ...labelStyle, fontSize: 12 }}>From</label>
              <input
                type="date"
                style={inputStyle}
                value={historyStartDate}
                max={historyEndDate || undefined}
                onChange={(e) => setHistoryStartDate(e.target.value)}
              />
            </div>
            <div style={{ color: "#444", paddingBottom: 8, fontSize: 18, userSelect: "none" }}>→</div>
            <div style={{ flex: 1 }}>
              <label style={{ ...labelStyle, fontSize: 12 }}>To</label>
              <input
                type="date"
                style={inputStyle}
                value={historyEndDate}
                min={historyStartDate || undefined}
                onChange={(e) => setHistoryEndDate(e.target.value)}
              />
            </div>
            <div style={{ flex: "0 0 110px" }}>
              <label style={{ ...labelStyle, fontSize: 12 }}>Max calls</label>
              <input
                type="number"
                style={inputStyle}
                value={historyLimit}
                min={1}
                max={500}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  setHistoryLimit(Number.isNaN(v) ? 50 : Math.max(1, v));
                }}
              />
            </div>
          </div>

          <p style={{ fontSize: 11, color: "#4b6a8f", margin: "0 0 12px" }}>
            Imports the oldest <strong style={{ color: "#60a5fa" }}>{historyLimit}</strong> calls in the range first. Already-imported conversations are skipped.
          </p>

          {historyResult && !historyResult.error && (
            <div style={{ padding: "8px 12px", background: "#0a2818", border: "1px solid #166534", borderRadius: 6, marginBottom: 12, fontSize: 13, color: "#4ade80" }}>
              Started import of {historyResult.imported} new call{historyResult.imported !== 1 ? "s" : ""}
              {historyResult.alreadyImported > 0 && ` (${historyResult.alreadyImported} already imported, skipped)`}
              {historyResult.total > historyResult.processed && ` — ${historyResult.total} total found, limited to ${historyResult.processed}`}
              {historyResult.errors?.length > 0 && (
                <span style={{ color: "#f59e0b" }}> · {historyResult.errors.length} failed to fetch</span>
              )}
            </div>
          )}
          {historyResult?.error && (
            <div style={{ padding: "8px 12px", background: "#2d0a0a", border: "1px solid #7f1d1d", borderRadius: 6, marginBottom: 12, fontSize: 13, color: "#ef4444" }}>
              {historyResult.error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={handleHistoryImport} disabled={historyImporting || !historyStartDate || !historyEndDate} style={btnStyle}>
              {historyImporting ? "Importing…" : "Import"}
            </button>
            <button
              onClick={() => { setShowHistoryImport(false); setHistoryResult(null); }}
              style={{ ...btnStyle, background: "#374151" }}
            >
              Close
            </button>
            {historyResult?.started && !historyResult.error && (
              <span style={{ fontSize: 12, color: "#64748b" }}>
                You can run another pull with a different date range at any time.
              </span>
            )}
          </div>
        </div>
      )}

      {/* New live run modal */}
      {!isHistory && showNewRun && (
        <div style={{ background: "#1a1a1a", padding: 16, borderRadius: 8, marginBottom: 16, border: "1px solid #333" }}>
          <label style={{ fontSize: 14, color: "#aaa", marginBottom: 8, display: "block" }}>Select Model</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {AVAILABLE_MODELS.map((group) => (
              <div key={group.provider}>
                <div style={{ fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, marginTop: 4 }}>
                  {group.provider}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {group.models.map((m) => {
                    const isSelected = modelInput === m.value;
                    const alreadyRun = project.runs?.some((r: any) => r.modelUsed === m.value);
                    return (
                      <button
                        key={m.value}
                        onClick={() => setModelInput(m.value)}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "10px 14px",
                          background: isSelected ? "#2563eb22" : "#0a0a0a",
                          border: `1px solid ${isSelected ? "#2563eb" : "#222"}`,
                          borderRadius: 6, cursor: "pointer", textAlign: "left", color: "#e0e0e0",
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>
                            {m.label}
                            {alreadyRun && <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: 8 }}>already tested</span>}
                          </div>
                          <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{m.desc}</div>
                        </div>
                        {isSelected && <span style={{ color: "#2563eb", fontSize: 18 }}>&#10003;</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleCreateRun} style={btnStyle} disabled={!modelInput}>Create Run</button>
            <button onClick={() => setShowNewRun(false)} style={{ ...btnStyle, background: "#374151" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Criteria */}
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>Criteria</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
        {project.criteria?.map((c: any) => (
          <span key={c.id} style={{ background: "#1a1a1a", padding: "4px 10px", borderRadius: 4, fontSize: 12, border: "1px solid #333" }}>
            {c.label || c.key} ({c.type})
          </span>
        ))}
      </div>

      {/* Import progress banner */}
      <ImportProgressBanner runs={project.runs ?? []} />

      {/* Runs table */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>
          {isWebhook ? "Incoming Calls" : isHistory ? "Imported Calls" : "Runs"}
          {project.runs?.length > 0 && (
            <span style={{ fontSize: 12, color: "#666", fontWeight: 400, marginLeft: 8 }}>
              ({project.runs.length} total{(isHistory || isWebhook) ? ", latest first" : ""})
            </span>
          )}
        </h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            placeholder="Search by call ID, conv ID, outcome..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              padding: "5px 10px",
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: 4,
              color: "#e0e0e0",
              fontSize: 12,
              width: 260,
            }}
          />
        </div>
        {outcomeColumns.length > 0 && (
          <div style={{ display: "flex", gap: 0, borderRadius: 6, overflow: "hidden", border: "1px solid #333" }}>
            {(["evaluation", "outcomes"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: "5px 14px",
                  background: activeTab === tab ? "#2563eb" : "#111",
                  color: activeTab === tab ? "#fff" : "#888",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: activeTab === tab ? 600 : 400,
                }}
              >
                {tab === "evaluation" ? "Evaluation" : `Outcomes (${outcomeColumns.length})`}
              </button>
            ))}
          </div>
        )}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #333", textAlign: "left" }}>
            {(isHistory || isWebhook) ? (
              <>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Duration</th>
                <th style={thStyle}>Call Status</th>
                <th style={thStyle}>Call Outcome</th>
                <th style={{ ...thStyle, minWidth: 220 }}>Conversation ID</th>
              </>
            ) : (
              <th style={thStyle}>Model</th>
            )}
            {activeTab === "evaluation" ? (
              <>
                <th style={thStyle}>Goal</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Score</th>
                <th style={{ ...thStyle, fontSize: 11 }}>Cost</th>
                {project.criteria?.map((c: any) => (
                  <th key={c.id} style={{ ...thStyle, fontSize: 11 }}>{c.label || c.key}</th>
                ))}
              </>
            ) : (
              <>
                {outcomeColumns.map((key) => (
                  <th key={`oc-${key}`} style={{ ...thStyle, fontSize: 11, color: "#9333ea" }}>
                    {key.replace(/_/g, " ")}
                  </th>
                ))}
              </>
            )}
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {/* History/webhook runs sorted latest-first for display; live runs keep server order (newest first) */}
          {((isHistory || isWebhook)
            ? [...(project.runs ?? [])].sort((a: any, b: any) => {
                const da = new Date(a.callDate || a.createdAt).getTime();
                const db = new Date(b.callDate || b.createdAt).getTime();
                return db - da;   // newest → oldest
              })
            : (project.runs ?? [])
          ).filter((run: any) => {
            if (!searchQuery.trim()) return true;
            const q = searchQuery.toLowerCase();
            return (
              (run.hamsaCallId || "").toLowerCase().includes(q) ||
              (run.conversationId || "").toLowerCase().includes(q) ||
              (run.callOutcome || "").toLowerCase().includes(q) ||
              (run.callStatus || "").toLowerCase().includes(q) ||
              (run.modelUsed || "").toLowerCase().includes(q)
            );
          }).map((run: any) => (
            <tr key={run.id} style={{ borderBottom: "1px solid #1a1a1a" }}>
              {(isHistory || isWebhook) ? (
                <>
                  <td style={tdStyle}>
                    <Link to={`/projects/${id}/runs/${run.id}`} style={{ color: "#60a5fa", textDecoration: "none", whiteSpace: "nowrap" }}>
                      {formatDate(run.callDate || run.createdAt)}
                    </Link>
                  </td>
                  <td style={{ ...tdStyle, color: "#666", fontSize: 12, whiteSpace: "nowrap" }}>
                    {run.callDuration ? `${run.callDuration}s` : "—"}
                  </td>
                  <td style={tdStyle}>
                    <CallStatusBadge status={run.callStatus} />
                  </td>
                  <td style={tdStyle}>
                    <OutcomeBadge outcome={run.callOutcome} />
                  </td>
                  <td style={tdStyle}>
                    <CopyableId id={run.conversationId} label="conv" />
                  </td>
                </>
              ) : (
                <td style={tdStyle}>
                  <Link to={`/projects/${id}/runs/${run.id}`} style={{ color: "#60a5fa", textDecoration: "none" }}>
                    {run.modelUsed}
                  </Link>
                </td>
              )}
              {activeTab === "evaluation" ? (
                <>
                  <td style={tdStyle}><GoalBadge run={run} /></td>
                  <td style={tdStyle}>
                    <span style={{ color: STATUS_COLORS[run.status] || "#888", display: "flex", alignItems: "center", gap: 4 }}>
                      {["RUNNING", "AWAITING_DATA", "EVALUATING"].includes(run.status) && (
                        <span style={{ display: "inline-block", width: 10, height: 10, border: "2px solid currentColor", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                      )}
                      {run.status}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    {run.overallScore != null ? (
                      <span style={{ color: run.overallScore >= 0.8 ? "#22c55e" : run.overallScore >= 0.5 ? "#f59e0b" : "#ef4444" }}>
                        {(run.overallScore * 100).toFixed(0)}%
                      </span>
                    ) : "—"}
                  </td>
                  <td style={{ ...tdStyle, fontSize: 11, color: "#555" }}>
                    {run.evalCost != null && run.evalCost > 0
                      ? `$${run.evalCost < 0.01 ? run.evalCost.toFixed(4) : run.evalCost.toFixed(3)}`
                      : "—"}
                  </td>
                  {project.criteria?.map((c: any) => {
                    const er = run.evalResults?.find((r: any) => r.criterionId === c.id);
                    return (
                      <td key={c.id} style={{ ...tdStyle, fontSize: 12 }}>
                        {er?.score != null ? (
                          <span style={{ color: er.passed ? "#22c55e" : "#ef4444" }}>
                            {(er.score * 100).toFixed(0)}%
                          </span>
                        ) : "—"}
                      </td>
                    );
                  })}
                </>
              ) : (
                <>
                  {outcomeColumns.map((key) => {
                    const val = run.outcomeResult?.[key];
                    const display = val == null || val === "" ? "—" : (typeof val === "object" ? JSON.stringify(val) : String(val));
                    return (
                      <td key={`oc-${key}`} style={{ ...tdStyle, fontSize: 11, color: "#a78bfa", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={display}>
                        {display}
                      </td>
                    );
                  })}
                </>
              )}
              <td style={tdStyle}>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                  {/* Live runs: Call button */}
                  {!isHistory && !isWebhook && (run.status === "PENDING" || run.status === "RUNNING") && project.hamsaApiKey && (
                    <button
                      onClick={() => setCallingRunId(run.id)}
                      style={{ ...smallBtnStyle, background: "#22c55e33", color: "#22c55e", border: "1px solid #22c55e44" }}
                    >
                      Call
                    </button>
                  )}
                  {/* Manual data upload for live runs */}
                  {!isHistory && !isWebhook && ["PENDING", "RUNNING", "AWAITING_DATA", "FAILED"].includes(run.status) && (
                    <button
                      onClick={() => setShowUpload(showUpload === run.id ? null : run.id)}
                      style={smallBtnStyle}
                    >
                      Upload Data
                    </button>
                  )}
                  {/* Re-evaluate */}
                  {(run.callLog || run.transcript) && run.status !== "COMPLETE" && (
                    <button
                      onClick={async () => { await triggerEvaluation(run.id); load(); }}
                      style={smallBtnStyle}
                    >
                      Evaluate
                    </button>
                  )}
                  <button
                    onClick={async () => { await deleteRun(run.id); load(); }}
                    style={{ ...smallBtnStyle, color: "#666" }}
                  >
                    Del
                  </button>
                </div>
                {/* Copyable IDs — always visible so the call can be looked up in Hamsa */}
                <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
                  {run.hamsaCallId && (
                    <CopyableId id={run.hamsaCallId} label="job" />
                  )}
                  {!isHistory && !isWebhook && run.conversationId && (
                    <CopyableId id={run.conversationId} label="conv" />
                  )}
                </div>
                {showUpload === run.id && (
                  <UploadPanel runId={run.id} onUpload={handleUploadData} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
      `}</style>

      {/* Call Agent dialog (live only) */}
      {callingRunId && project.hamsaApiKey && (
        <CallAgent
          runId={callingRunId}
          agentId={project.agentId}
          apiKey={project.hamsaApiKey}
          webhookUrl={`${window.location.origin}/api/webhooks/hamsa`}
          onCallEnded={() => { setTimeout(load, 2000); }}
          onClose={() => { setCallingRunId(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── Goal Achievement ──────────────────────────────────────────────

type GoalStatus = "SUCCESSFUL" | "FAILED" | "PARTIAL";

function computeGoal(run: any): { status: GoalStatus; reason: string } | null {
  if (run.status !== "COMPLETE") return null;

  const callStatus = (run.callStatus || "").toUpperCase();
  const outcome = (run.callOutcome || "").toLowerCase();
  const score: number | null = run.overallScore ?? null;
  const summary: string = run.outcomeResult?.summary || "";
  const evalResults: any[] = run.evalResults || [];

  // Call never connected — goal is impossible to achieve
  if (["NO_ANSWER", "BUSY", "VOICEMAIL"].includes(callStatus)) {
    const why = callStatus === "NO_ANSWER" ? "Call was not answered."
              : callStatus === "BUSY"      ? "Line was busy."
              : "Reached voicemail — no live conversation.";
    return { status: "FAILED", reason: why };
  }
  if (callStatus === "FAILED") {
    return { status: "FAILED", reason: "Call failed before completing." };
  }

  // Names of criteria that clearly failed (score < 0.5)
  const failedCriteria = evalResults
    .filter((er: any) => er.score != null && er.score < 0.5)
    .map((er: any) => er.criterion?.label || er.criterion?.key)
    .filter(Boolean) as string[];
  const failedStr = failedCriteria.length ? ` Issues: ${failedCriteria.join(", ")}.` : "";

  // Check objective_met from outcomeResult — this is the most reliable signal
  const objectiveMet = (run.outcomeResult?.objective_met || "").toLowerCase();

  // Classify call outcome string
  // Check negative BEFORE positive — "not_interested" ⊃ "interested"
  const isNegative = outcome.includes("not_interested") || outcome.includes("rejected")
                  || outcome.includes("refused")        || outcome.includes("declined")
                  || outcome.includes("hangup")         || outcome.includes("hang_up")
                  || objectiveMet === "no";
  const isPositive = !isNegative && (
    outcome.includes("interested") || outcome.includes("success")  ||
    outcome.includes("booked")     || outcome.includes("converted") ||
    outcome.includes("completed")  || outcome.includes("agreed")
    || objectiveMet === "yes"
  );
  const isFollowup = !isNegative && !isPositive && (
    outcome.includes("followup") || outcome.includes("callback")
    || outcome.includes("pending")   || outcome.includes("later")
    || objectiveMet === "partial"
  );

  if (isNegative) {
    // Customer said no — goal failed regardless of agent quality.
    // Partial only if agent itself performed well (score ≥ 0.7) — agent did its job
    // but couldn't convert.
    const status: GoalStatus = (score != null && score >= 0.7) ? "PARTIAL" : "FAILED";
    const reason = summary
      || (status === "PARTIAL"
        ? `Customer declined, but the agent performed correctly (${(score! * 100).toFixed(0)}% quality).`
        : `Customer was not interested.${failedStr}`);
    return { status, reason };
  }

  if (isPositive) {
    if (score == null || score >= 0.7) {
      return {
        status: "SUCCESSFUL",
        reason: summary || `Call goal achieved.${failedStr}`,
      };
    }
    return {
      status: "PARTIAL",
      reason: summary
        || `Positive outcome but agent quality was below target (${(score * 100).toFixed(0)}%).${failedStr}`,
    };
  }

  if (isFollowup) {
    return {
      status: "PARTIAL",
      reason: summary || `Call resulted in a follow-up, no definitive outcome yet.${failedStr}`,
    };
  }

  // No outcome signal — judge by quality score alone
  if (score == null) return null;
  if (score >= 0.8) return { status: "SUCCESSFUL", reason: summary || `Agent performed well (${(score * 100).toFixed(0)}% quality score).` };
  if (score >= 0.5) return { status: "PARTIAL",    reason: summary || `Agent partially met the call goal (${(score * 100).toFixed(0)}% quality).${failedStr}` };
  return              { status: "FAILED",           reason: summary || `Agent did not meet the call goal (${(score * 100).toFixed(0)}% quality).${failedStr}` };
}

const GOAL_STYLE: Record<GoalStatus, { color: string; bg: string; border: string; label: string }> = {
  SUCCESSFUL: { color: "#22c55e", bg: "#14532d22", border: "#22c55e44", label: "Successful" },
  PARTIAL:    { color: "#f59e0b", bg: "#78350f22", border: "#f59e0b44", label: "Partial"    },
  FAILED:     { color: "#ef4444", bg: "#7f1d1d22", border: "#ef444444", label: "Failed"     },
};

function GoalBadge({ run }: { run: any }) {
  const goal = computeGoal(run);
  if (!goal) return <span style={{ color: "#444", fontSize: 11 }}>—</span>;
  const s = GOAL_STYLE[goal.status];
  return (
    <span
      title={goal.reason}
      style={{
        fontSize: 11, padding: "2px 8px", borderRadius: 10,
        background: s.bg, color: s.color, border: `1px solid ${s.border}`,
        whiteSpace: "nowrap", cursor: "default",
      }}
    >
      {s.label}
    </span>
  );
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function UploadPanel({ runId, onUpload }: { runId: string; onUpload: (runId: string, type: "callLog" | "transcript", json: string) => void }) {
  const [callLogJson, setCallLogJson] = useState("");
  const [transcriptJson, setTranscriptJson] = useState("");
  const textareaStyle: React.CSSProperties = {
    width: "100%", height: 80, background: "#0a0a0a", border: "1px solid #333",
    borderRadius: 4, color: "#e0e0e0", fontFamily: "monospace", fontSize: 11, padding: 8,
  };
  return (
    <div style={{ marginTop: 8, background: "#111", padding: 12, borderRadius: 6, border: "1px solid #222" }}>
      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: "#aaa" }}>Call Log JSON</label>
        <textarea style={textareaStyle} value={callLogJson} onChange={(e) => setCallLogJson(e.target.value)} placeholder="Paste call log array..." />
        <button onClick={() => onUpload(runId, "callLog", callLogJson)} style={smallBtnStyle} disabled={!callLogJson.trim()}>
          Upload Call Log
        </button>
      </div>
      <div>
        <label style={{ fontSize: 12, color: "#aaa" }}>Webhook/Transcript JSON</label>
        <textarea style={textareaStyle} value={transcriptJson} onChange={(e) => setTranscriptJson(e.target.value)} placeholder="Paste webhook payload..." />
        <button onClick={() => onUpload(runId, "transcript", transcriptJson)} style={smallBtnStyle} disabled={!transcriptJson.trim()}>
          Upload Transcript
        </button>
      </div>
    </div>
  );
}

const CALL_STATUS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  COMPLETED:  { color: "#22c55e", bg: "#14532d22", label: "Completed" },
  FAILED:     { color: "#ef4444", bg: "#7f1d1d22", label: "Failed" },
  NO_ANSWER:  { color: "#f59e0b", bg: "#78350f22", label: "No Answer" },
  IN_PROGRESS:{ color: "#3b82f6", bg: "#1e3a5f22", label: "In Progress" },
  PENDING:    { color: "#888",    bg: "#1a1a1a",   label: "Pending" },
};

function CallStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span style={{ color: "#444", fontSize: 12 }}>—</span>;
  const s = CALL_STATUS_STYLE[status.toUpperCase()] ?? { color: "#888", bg: "#1a1a1a", label: status };
  return (
    <span style={{
      fontSize: 11, padding: "2px 8px", borderRadius: 10,
      background: s.bg, color: s.color,
      border: `1px solid ${s.color}44`,
      whiteSpace: "nowrap",
    }}>
      {s.label}
    </span>
  );
}

// Formats a snake_case outcome key into a readable label, e.g. "interested_followup" → "Interested Followup"
function formatOutcome(outcome: string): string {
  return outcome.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Color map for common outcome patterns — anything not matched gets a neutral style
function outcomeStyle(outcome: string): { color: string; bg: string } {
  const lower = outcome.toLowerCase();
  // Check negative BEFORE positive — "not_interested" contains "interested"
  if (lower.includes("not_interested") || lower.includes("rejected") || lower.includes("declined") || lower.includes("refused") || lower.includes("hangup") || lower.includes("hang_up"))
    return { color: "#ef4444", bg: "#7f1d1d22" };
  if (lower.includes("interested") || lower.includes("success") || lower.includes("converted") || lower.includes("booked"))
    return { color: "#22c55e", bg: "#14532d22" };
  if (lower.includes("followup") || lower.includes("callback") || lower.includes("pending") || lower.includes("later"))
    return { color: "#f59e0b", bg: "#78350f22" };
  if (lower.includes("no_answer") || lower.includes("busy") || lower.includes("voicemail"))
    return { color: "#6b7280", bg: "#1a1a1a" };
  return { color: "#a78bfa", bg: "#2e1065aa" }; // unknown outcomes get purple
}

function OutcomeBadge({ outcome }: { outcome: string | null | undefined }) {
  if (!outcome) return <span style={{ color: "#444", fontSize: 12 }}>—</span>;
  const { color, bg } = outcomeStyle(outcome);
  return (
    <span style={{
      fontSize: 11, padding: "2px 8px", borderRadius: 10,
      background: bg, color,
      border: `1px solid ${color}44`,
      whiteSpace: "nowrap",
    }}>
      {formatOutcome(outcome)}
    </span>
  );
}


function ImportProgressBanner({ runs }: { runs: any[] }) {
  const total = runs.length;
  if (total === 0) return null;

  const counts = {
    PENDING: 0, AWAITING_DATA: 0, EVALUATING: 0,
    COMPLETE: 0, FAILED: 0,
  };
  for (const r of runs) {
    if (r.status in counts) counts[r.status as keyof typeof counts]++;
  }

  const active = counts.PENDING + counts.AWAITING_DATA + counts.EVALUATING;
  if (active === 0) return null;

  const done = counts.COMPLETE + counts.FAILED;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const pills: { label: string; count: number; color: string }[] = [
    { label: "Fetching data", count: counts.PENDING + counts.AWAITING_DATA, color: "#f59e0b" },
    { label: "Evaluating", count: counts.EVALUATING, color: "#3b82f6" },
    { label: "Done", count: counts.COMPLETE, color: "#22c55e" },
    { label: "Failed", count: counts.FAILED, color: "#ef4444" },
  ].filter((p) => p.count > 0);

  return (
    <div style={{
      background: "#0a1628",
      border: "1px solid #1e3a5f",
      borderRadius: 8,
      padding: "12px 16px",
      marginBottom: 20,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            display: "inline-block", width: 10, height: 10,
            border: "2px solid #3b82f6", borderTopColor: "transparent",
            borderRadius: "50%", animation: "spin 1s linear infinite", flexShrink: 0,
          }} />
          <span style={{ fontSize: 13, color: "#93c5fd", fontWeight: 600 }}>
            Evaluating {active} call{active !== 1 ? "s" : ""}…
          </span>
        </div>
        <span style={{ fontSize: 11, color: "#475569" }}>
          {done} / {total} complete · auto-refreshing
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ background: "#1e293b", borderRadius: 4, height: 6, marginBottom: 10, overflow: "hidden" }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: counts.FAILED > 0 ? "#ef444488" : "#3b82f6",
          borderRadius: 4,
          transition: "width 0.4s ease",
        }} />
      </div>

      {/* Status pills */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {pills.map((p) => (
          <span key={p.label} style={{
            fontSize: 11, padding: "2px 8px", borderRadius: 12,
            background: p.color + "22", color: p.color,
            border: `1px solid ${p.color}44`,
          }}>
            {p.count} {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Card({ label, value, href }: { label: string; value: string | number; href?: string }) {
  const inner = (
    <div style={{
      background: "#1a1a1a", padding: "12px 16px", borderRadius: 8, border: "1px solid #222", minWidth: 120,
      ...(href ? { cursor: "pointer", transition: "border-color 0.15s" } : {}),
    }}
      onMouseEnter={href ? (e) => (e.currentTarget.style.borderColor = "#444") : undefined}
      onMouseLeave={href ? (e) => (e.currentTarget.style.borderColor = "#222") : undefined}
    >
      <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
  if (href) return <Link to={href} style={{ textDecoration: "none", color: "inherit" }}>{inner}</Link>;
  return inner;
}

const btnStyle: React.CSSProperties = {
  background: "#2563eb", color: "#fff", padding: "8px 16px", borderRadius: 6,
  border: "none", cursor: "pointer", fontSize: 14,
};
const smallBtnStyle: React.CSSProperties = {
  background: "#1e293b", color: "#94a3b8", padding: "4px 8px", borderRadius: 4,
  border: "none", cursor: "pointer", fontSize: 11,
};
const thStyle: React.CSSProperties = { padding: "8px 12px", fontSize: 13 };
const tdStyle: React.CSSProperties = { padding: "8px 12px" };
const labelStyle: React.CSSProperties = { display: "block", marginBottom: 4, fontSize: 13, color: "#aaa" };
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "6px 10px", background: "#1a1a1a", border: "1px solid #333",
  borderRadius: 4, color: "#e0e0e0", fontSize: 13, boxSizing: "border-box",
};

/**
 * Shows a truncated ID with a clipboard icon to copy the full ID.
 * Hovering the code shows the full UUID as a native tooltip.
 */
function CopyableId({ id, label }: { id: string | null | undefined; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!id) return <span style={{ color: "#444", fontSize: 12 }}>—</span>;

  const short = id.slice(0, 8) + "…" + id.slice(-4);

  function copy() {
    navigator.clipboard.writeText(id!).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {label && (
        <span style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {label}
        </span>
      )}
      <code
        title={id}
        style={{
          fontSize: 11, color: "#64748b", fontFamily: "monospace",
          background: "#0f172a", padding: "2px 6px", borderRadius: 3,
          border: "1px solid #1e293b", letterSpacing: "0.02em", whiteSpace: "nowrap",
          cursor: "default",
        }}
      >
        {short}
      </code>
      <button
        onClick={copy}
        title={copied ? "Copied!" : `Copy: ${id}`}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          background: "none", border: "none", padding: "2px", cursor: "pointer",
          color: copied ? "#22c55e" : "#475569",
          transition: "color 0.15s",
          lineHeight: 1,
        }}
      >
        {copied ? (
          // Checkmark
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M3 8l4 4 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        ) : (
          // Clipboard icon
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <rect x="5" y="1" width="6" height="2.5" rx="1" stroke="currentColor" strokeWidth="1.4"/>
            <rect x="2.5" y="2.5" width="11" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
            <line x1="5" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <line x1="5" y1="10" x2="9" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        )}
      </button>
    </span>
  );
}

function AgentIntelligencePanel({ agentStruct, agentSummary }: { agentStruct: any; agentSummary?: string | null }) {
  const [open, setOpen] = useState(false);

  const nodes: any[]  = agentStruct?.workflow?.nodes ?? [];
  const tools: any[]  = agentStruct?.tools ?? [];
  const preamble: string = agentStruct?.conversation?.preamble ?? "";
  const greeting: string = agentStruct?.conversation?.greetingMessage ?? "";

  return (
    <div style={{
      background: "#0d1117", border: "1px solid #1e3a5f", borderRadius: 10,
      marginBottom: 24, overflow: "hidden",
    }}>
      {/* Toggle header */}
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: "12px 18px", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 12,
          borderBottom: open ? "1px solid #1e293b" : "none",
        }}
      >
        <span style={{ fontSize: 11, color: "#3b82f6" }}>{open ? "▼" : "▶"}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#60a5fa" }}>What the system understood from this agent</span>
        <span style={{ fontSize: 11, color: "#444", marginLeft: 4 }}>
          {nodes.length > 0 && `${nodes.length} nodes`}
          {tools.length > 0 && ` · ${tools.length} tools`}
          {preamble && " · has instructions"}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "#4b5563" }}>
          {open ? "collapse" : "show details"}
        </span>
      </div>

      {open && (
        <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 20 }}>

          {/* LLM-generated summary */}
          {agentSummary ? (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#60a5fa", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
                LLM Understanding
              </div>
              <div style={{
                background: "#0a0f1a", border: "1px solid #1e3a5f", borderRadius: 8,
                padding: "14px 16px", fontSize: 13, color: "#cbd5e1",
                lineHeight: 1.7, whiteSpace: "pre-wrap", fontFamily: "inherit",
              }}>
                {agentSummary}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#4b5563" }}>
              LLM summary not yet generated. Use "Refresh Agent" to regenerate.
            </div>
          )}

          {/* Preamble / instructions */}
          {preamble && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
                Agent Instructions (Preamble)
              </div>
              <div style={{
                background: "#0a0a0a", border: "1px solid #2d1b69", borderRadius: 8,
                padding: "14px 16px", fontSize: 12, color: "#c4b5fd",
                lineHeight: 1.7, whiteSpace: "pre-wrap", fontFamily: "inherit",
                maxHeight: 320, overflowY: "auto",
              }}>
                {preamble}
              </div>
            </div>
          )}

          {/* Greeting */}
          {greeting && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#34d399", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>
                Opening Greeting
              </div>
              <div style={{
                background: "#0a0a0a", border: "1px solid #065f46", borderRadius: 8,
                padding: "10px 14px", fontSize: 13, color: "#a7f3d0", lineHeight: 1.6,
              }}>
                {greeting}
              </div>
            </div>
          )}

          {/* Flow nodes */}
          {nodes.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#fbbf24", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
                Workflow Nodes ({nodes.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {nodes.map((node: any, i: number) => {
                  const transitions: any[] = node.transitions ?? [];
                  const vars: string[] = (node.extractVariables?.variables ?? []).map((v: any) => v.name);
                  return (
                    <div key={i} style={{
                      background: "#0a0a0a", border: "1px solid #292524",
                      borderLeft: "3px solid #f59e0b", borderRadius: 6, padding: "10px 14px",
                    }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#fcd34d" }}>{node.label || `Node ${i + 1}`}</span>
                        <span style={{ fontSize: 10, color: "#555", padding: "1px 6px", background: "#1a1a1a", borderRadius: 3 }}>{node.type}</span>
                        {vars.length > 0 && (
                          <span style={{ fontSize: 10, color: "#60a5fa" }}>Collects: {vars.join(", ")}</span>
                        )}
                      </div>
                      {node.message && (
                        <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 6, lineHeight: 1.5 }}>
                          {node.message.slice(0, 300)}{node.message.length > 300 ? "…" : ""}
                        </div>
                      )}
                      {transitions.length > 0 && (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {transitions.map((t: any, j: number) => {
                            const cond = t.condition?.description || t.condition?.prompt || "auto";
                            return (
                              <span key={j} style={{
                                fontSize: 10, color: "#94a3b8",
                                padding: "1px 8px", background: "#0f172a",
                                border: "1px solid #1e3a5f", borderRadius: 3,
                              }}>
                                → {cond.slice(0, 60)}{cond.length > 60 ? "…" : ""}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tools */}
          {tools.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#f472b6", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
                Tools ({tools.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {tools.map((t: any, i: number) => (
                  <div key={i} style={{
                    background: "#0a0a0a", border: "1px solid #831843",
                    borderLeft: "3px solid #f472b6", borderRadius: 6, padding: "8px 12px",
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#f9a8d4", marginBottom: 2 }}>
                      {t.name || t.id}
                    </div>
                    {t.description && (
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>{t.description}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Raw config hint */}
          {!preamble && nodes.length === 0 && !agentSummary && (
            <div style={{ fontSize: 12, color: "#4b5563" }}>
              No detailed config found. Click "Refresh Agent" in the header strip to re-import the latest agent structure from Hamsa.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RefreshAgentButton({ projectId, onSuccess }: { projectId: string; onSuccess: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleRefresh() {
    setLoading(true);
    setError("");
    try {
      await refreshAgent(projectId);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <span>
      <button
        onClick={handleRefresh}
        disabled={loading}
        style={{ background: "none", border: "none", color: loading ? "#555" : "#3b82f6", cursor: loading ? "default" : "pointer", fontSize: 11, padding: 0 }}
      >
        {loading ? "Refreshing…" : "Refresh Agent"}
      </button>
      {error && <span style={{ color: "#ef4444", fontSize: 11, marginLeft: 8 }}>{error}</span>}
    </span>
  );
}

function WebhookUrlBar({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{
      marginTop: 8, padding: "6px 12px", background: "#0a0a0a", borderRadius: 6,
      border: "1px solid #222", display: "flex", alignItems: "center", gap: 8,
    }}>
      <span style={{ fontSize: 11, color: "#666" }}>Webhook URL:</span>
      <code style={{ fontSize: 11, color: "#888", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {url}
      </code>
      <button
        onClick={() => { navigator.clipboard.writeText(url).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        style={{
          background: copied ? "#22c55e22" : "#1a1a1a",
          border: `1px solid ${copied ? "#22c55e44" : "#333"}`,
          color: copied ? "#22c55e" : "#888",
          padding: "2px 10px", borderRadius: 3, cursor: "pointer", fontSize: 11,
        }}
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}
