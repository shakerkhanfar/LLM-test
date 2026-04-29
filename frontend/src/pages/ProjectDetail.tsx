import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  getProject, createRun, deleteRun, triggerEvaluation, switchModel,
  attachCallLog, attachTranscript, importHistory, importHistoryCsv, refreshAgent,
  askProject, fetchHamsaProjects, reEvaluateProject, reHydrateProject,
  exportCallIds, importByIds,
} from "../api/client";
import CallAgent from "../components/CallAgent";
import T from "../theme";

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
  PENDING: T.textSecondary,
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
  const [channelFilter, setChannelFilter] = useState<string | null>(null);

  // Ask AI state
  const [askQuery, setAskQuery] = useState("");
  const [askLoading, setAskLoading] = useState(false);
  const [askResult, setAskResult] = useState<any>(null);
  const [askError, setAskError] = useState<string | null>(null);

  // History import state — always use date range (CUSTOM period)
  const [showHistoryImport, setShowHistoryImport] = useState(false);
  const [historyStartDate, setHistoryStartDate] = useState(() => getPresetRange("THIS_MONTH").start);
  const [historyEndDate, setHistoryEndDate] = useState(() => getPresetRange("THIS_MONTH").end);
  const [historyLimit, setHistoryLimit] = useState(50);
  const [historyImporting, setHistoryImporting] = useState(false);
  const [historyResult, setHistoryResult] = useState<any>(null);
  const [hamsaProjectId, setHamsaProjectId] = useState("");
  const [, setHamsaProjects] = useState<any[]>([]);
  const [hamsaProjectsLoaded, setHamsaProjectsLoaded] = useState(false);
  const callIdsRef = useRef<HTMLTextAreaElement>(null);
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sortedRuns = useMemo(() => {
    const runs = [...(project?.runs ?? [])];
    if (sortField) {
      runs.sort((a: any, b: any) => {
        let va: any, vb: any;
        if (sortField === "date") { va = new Date(a.callDate || a.createdAt).getTime(); vb = new Date(b.callDate || b.createdAt).getTime(); }
        else if (sortField === "duration") { va = a.callDuration ?? 0; vb = b.callDuration ?? 0; }
        else if (sortField === "score") { va = a.overallScore ?? -1; vb = b.overallScore ?? -1; }
        else if (sortField === "cost") { va = a.evalCost ?? 0; vb = b.evalCost ?? 0; }
        else if (sortField === "outcome") { va = a.callOutcome || ""; vb = b.callOutcome || ""; }
        else if (sortField === "status") { va = a.status || ""; vb = b.status || ""; }
        else { va = 0; vb = 0; }
        if (typeof va === "string") return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
        return sortDir === "asc" ? va - vb : vb - va;
      });
    } else if (project?.projectType === "HISTORY" || project?.projectType === "WEBHOOK") {
      runs.sort((a: any, b: any) => {
        const da = new Date(a.callDate || a.createdAt).getTime();
        const db = new Date(b.callDate || b.createdAt).getTime();
        return db - da;
      });
    }
    return runs;
  }, [project?.runs, project?.projectType, sortField, sortDir]);

  const isHistory = project?.projectType === "HISTORY";
  const isWebhook = project?.projectType === "WEBHOOK";

  const load = useCallback(() => {
    getProject(id!)
      .then(setProject)
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Track when we first saw this project with 0 runs — stop polling after 2 min
  const emptyHistoryFirstSeenRef = useRef<number | null>(null);

  // Poll while there are in-progress runs, webhook projects, or recently-created
  // history projects (background CSV import may not have created stubs yet).
  useEffect(() => {
    if (!project) return;
    const hasActive = project.runs?.some((r: any) =>
      ["PENDING", "AWAITING_DATA", "EVALUATING"].includes(r.status)
    );
    const isWebhookProject = project.projectType === "WEBHOOK";
    // History projects with 0 runs may have a background import in flight —
    // but stop polling after 2 minutes to avoid infinite spin on failed imports.
    const isEmptyHistory = project.projectType === "HISTORY" && (!project.runs || project.runs.length === 0);
    if (isEmptyHistory) {
      if (emptyHistoryFirstSeenRef.current === null) emptyHistoryFirstSeenRef.current = Date.now();
      const elapsed = Date.now() - emptyHistoryFirstSeenRef.current;
      if (elapsed > 120_000) return; // give up after 2 min
    } else {
      emptyHistoryFirstSeenRef.current = null; // reset if runs appear
    }
    const isHistoryAwaiting = isEmptyHistory;
    if (!hasActive && !isWebhookProject && !isHistoryAwaiting) return;
    // Poll faster when runs are in-progress, slower for idle webhook/history polling
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
      let result;
      if (hamsaProjectId.trim()) {
        // Use the async CSV pipeline (works with dev API)
        result = await importHistoryCsv(project.id, {
          hamsaProjectId: hamsaProjectId.trim(),
          startDate: historyStartDate,
          endDate: historyEndDate,
          limit: historyLimit,
        });
      } else {
        // Use the legacy Excel pipeline (production API)
        result = await importHistory(project.id, {
          period: "CUSTOM",
          startDate: historyStartDate,
          endDate: historyEndDate,
          limit: historyLimit,
        });
      }
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
        <Link to="/" style={{ color: T.textSecondary, textDecoration: "none", fontSize: 14 }}>
          &larr; Projects
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "8px 0 4px" }}>
          <h1 style={{ margin: 0 }}>{project.name}</h1>
          <span style={{
            fontSize: 11, padding: "2px 8px", borderRadius: 4,
            background: isWebhook ? "#f3e8ff" : isHistory ? T.infoBg : T.successBg,
            color: isWebhook ? "#c084fc" : isHistory ? "#60a5fa" : "#4ade80",
            border: `1px solid ${isWebhook ? "#7c3aed" : isHistory ? "#1d4ed8" : "#16a34a"}`,
          }}>
            {isWebhook ? "Webhook" : isHistory ? "History" : "Live"}
          </span>
        </div>
        {project.description && <p style={{ color: T.textSecondary, margin: 0 }}>{project.description}</p>}
        {isWebhook && <WebhookUrlBar url={`${window.location.origin}/api/webhooks/hamsa/${project.id}`} />}
        {!isWebhook && project.hamsaApiKey && !isHistory && <WebhookUrlBar url={`${window.location.origin}/api/webhooks/hamsa`} />}

        {/* Agent info strip */}
        {agentStruct && (
          <div style={{ marginTop: 8, display: "flex", gap: 16, fontSize: 12, color: T.textMuted, alignItems: "center" }}>
            <span style={{ color: T.textMuted }}>Agent: <span style={{ color: T.textSecondary }}>{agentStruct.name || project.agentId}</span></span>
            {agentStruct.type && <span style={{ color: T.textFaint }}>{agentStruct.type}</span>}
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
          background: T.warningBg, border: `1px solid ${T.border}`, color: "#b45309",
          fontSize: 13, lineHeight: 1.6,
        }}>
          <strong>No calls found</strong> for the selected date range. The agent may not have any calls in that period,
          or the date range may not match the agent's timezone. Try a wider range using the{" "}
          <button
            onClick={() => { setShowHistoryImport(true); navigate(`/projects/${id}`, { replace: true }); }}
            style={{ color: "#b45309", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", fontSize: 13, padding: 0 }}
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

      {/* History import progress — shows while runs are being hydrated/evaluated */}
      {isHistory && (() => {
        const runs = project.runs ?? [];
        const pending = runs.filter((r: any) => ["PENDING", "AWAITING_DATA"].includes(r.status)).length;
        const evaluating = runs.filter((r: any) => r.status === "EVALUATING").length;
        const complete = runs.filter((r: any) => r.status === "COMPLETE").length;
        const failed = runs.filter((r: any) => r.status === "FAILED").length;
        const inProgress = pending + evaluating;
        // Show banner if there are in-progress runs OR if the project has 0 runs (import may be starting)
        if (inProgress === 0 && runs.length > 0) return null;
        return (
          <div style={{
            padding: "12px 16px", borderRadius: 8, marginBottom: 16,
            background: T.infoBg, border: `1px solid ${T.info}`, color: T.info,
            fontSize: 13, display: "flex", alignItems: "center", gap: 10,
          }}>
            <svg width="16" height="16" viewBox="0 0 16 16" style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}>
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
            </svg>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            {runs.length === 0
              ? "Importing calls from Hamsa… This may take a minute."
              : (() => {
                  const remaining = pending + evaluating;
                  const estMinLeft = Math.ceil(remaining * 40 / 60);
                  return `Processing: ${complete} evaluated · ${evaluating} evaluating · ${pending} pending${failed ? ` · ${failed} failed` : ""}${remaining > 0 ? ` · ~${estMinLeft} min remaining` : ""}`;
                })()}
          </div>
        );
      })()}

      {/* Webhook status — auto-polling indicator */}
      {isWebhook && (
        <div style={{
          padding: "10px 16px", borderRadius: 8, marginBottom: 16,
          background: "#f3e8ff", border: "1px solid #7c3aed", color: "#7c3aed",
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
            onClick={() => {
              const opening = !showHistoryImport;
              setShowHistoryImport(opening);
              setHistoryResult(null);
              // Auto-resolve the Hamsa project that contains this agent
              if (opening && !hamsaProjectsLoaded && project?.hamsaApiKey) {
                setHamsaProjectsLoaded(true);
                fetchHamsaProjects(project.hamsaApiKey, project.agentId).then((result: any) => {
                  if (result.projectId) setHamsaProjectId(result.projectId);
                  setHamsaProjects(result.projects || []);
                }).catch(() => {});
              }
            }}
            style={{ ...btnStyle, background: showHistoryImport ? "#b8e6cc" : T.primary }}
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
          <button onClick={() => navigate(`/projects/${id}/analyses`)} style={{ ...btnStyle, background: "#7c3aed" }}>
            Analyze Project
          </button>
        )}
        {(project.runs?.length ?? 0) > 0 && (
          <>
            <button
              onClick={async () => {
                const count = project.runs?.length ?? 0;
                const estMinutes = Math.ceil(count * 45 / 60); // ~45s per call (fetch + eval)
                if (!confirm(`Re-fetch and re-evaluate all ${count} calls?\n\nEstimated time: ~${estMinutes} minutes\n(~45 seconds per call: fetch from Hamsa + 8-12 LLM evaluation calls)\n\nThe process runs in the background — you can close this page.`)) return;
                try {
                  const result = await reHydrateProject(project.id);
                  alert(`${result.message}\n\nEstimated completion: ~${estMinutes} minutes.`);
                  load();
                } catch (err) {
                  alert("Failed: " + (err as Error).message);
                }
              }}
              style={{ ...btnStyle, background: T.info }}
            >
              Re-fetch & Evaluate
            </button>
            <button
              onClick={async () => {
                const count = project.runs?.length ?? 0;
                const estMinutes = Math.ceil(count * 35 / 60); // ~35s per call (eval only, no fetch)
                if (!confirm(`Re-evaluate all ${count} calls?\n\nEstimated time: ~${estMinutes} minutes\n(~35 seconds per call: 8-12 LLM evaluation calls)\n\nExisting scores will be cleared. The process runs in the background.`)) return;
                try {
                  const result = await reEvaluateProject(project.id);
                  alert(`Reset ${result.resetCount} calls for re-evaluation.\n\nEstimated completion: ~${estMinutes} minutes.`);
                  load();
                } catch (err) {
                  alert("Failed: " + (err as Error).message);
                }
              }}
              style={{ ...btnStyle, background: T.warning }}
            >
              Re-evaluate All
            </button>
          </>
        )}
        {(project.runs?.length ?? 0) > 0 && (
          <button
            onClick={async () => {
              try { await exportCallIds(project.id, project.name); } catch (err) { alert("Export failed: " + (err as Error).message); }
            }}
            style={{ ...btnStyle, background: T.cardAlt, color: T.textSecondary, border: `1px solid ${T.border}` }}
          >
            Export Call IDs
          </button>
        )}
      </div>

      {/* History import panel */}
      {showHistoryImport && !isWebhook && (
        <div style={{ background: T.infoBg, padding: 16, borderRadius: 8, marginBottom: 16, border: `1px solid ${T.border}` }}>
          <h3 style={{ margin: "0 0 14px", fontSize: 14, color: T.link }}>Import Call History</h3>

          {/* Hamsa Project — auto-resolved */}
          {!hamsaProjectId && hamsaProjectsLoaded && (
            <div style={{ fontSize: 12, color: T.warning, marginBottom: 12 }}>
              Could not resolve Hamsa project for this agent. Enter manually:
              <input type="text" style={{ ...inputStyle, marginTop: 4 }} value={hamsaProjectId} onChange={(e) => setHamsaProjectId(e.target.value)} placeholder="Hamsa Project ID" />
            </div>
          )}
          {!hamsaProjectsLoaded && !hamsaProjectId && (
            <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12 }}>Resolving Hamsa project...</div>
          )}

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
                      background: isActive ? T.primary : "#f3e8ff",
                      color: isActive ? "#fff" : T.textSecondary,
                      border: `1px solid ${isActive ? "#3b82f6" : T.border}`,
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
            <div style={{ color: T.textFaint, paddingBottom: 8, fontSize: 18, userSelect: "none" }}>→</div>
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

          <p style={{ fontSize: 11, color: T.textSecondary, margin: "0 0 12px" }}>
            Imports the oldest <strong style={{ color: T.link }}>{historyLimit}</strong> calls in the range first. Already-imported conversations are skipped.
          </p>

          {historyResult && !historyResult.error && (
            <div style={{ padding: "8px 12px", background: T.successBg, border: `1px solid ${T.border}`, borderRadius: 6, marginBottom: 12, fontSize: 13, color: "#22c55e" }}>
              Started import of {historyResult.imported} new call{historyResult.imported !== 1 ? "s" : ""}
              {historyResult.alreadyImported > 0 && ` (${historyResult.alreadyImported} already imported, skipped)`}
              {historyResult.total > historyResult.processed && ` — ${historyResult.total} total found, limited to ${historyResult.processed}`}
              {historyResult.errors?.length > 0 && (
                <span style={{ color: "#f59e0b" }}> · {historyResult.errors.length} failed to fetch</span>
              )}
            </div>
          )}
          {historyResult?.error && (
            <div style={{ padding: "8px 12px", background: T.errorBg, border: `1px solid ${T.border}`, borderRadius: 6, marginBottom: 12, fontSize: 13, color: "#ef4444" }}>
              {historyResult.error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={handleHistoryImport} disabled={historyImporting || !historyStartDate || !historyEndDate} style={btnStyle}>
              {historyImporting ? "Importing…" : "Import by Date Range"}
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

          {/* Import by Call IDs — CSV upload or paste */}
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
            <h4 style={{ margin: "0 0 8px", fontSize: 13, color: T.textSecondary }}>Or import by Call IDs</h4>
            <p style={{ fontSize: 11, color: T.textMuted, margin: "0 0 8px" }}>
              Paste conversation IDs (one per line) or upload a CSV file.
            </p>
            <textarea
              ref={callIdsRef}
              placeholder={"Paste conversation IDs here, one per line:\ne.g.\n890b0210-a7d4-432f-bdc6-264c7848c5e2\n35c47330-2101-4e8e-bb5d-c0295c9d55f2"}
              style={{ ...inputStyle, height: 100, resize: "vertical", fontFamily: "monospace", fontSize: 11 }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <label style={{ ...btnStyle, background: T.cardAlt, color: T.textSecondary, border: `1px solid ${T.border}`, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
                Upload CSV
                <input
                  type="file"
                  accept=".csv,.txt"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                      const text = ev.target?.result as string;
                      if (callIdsRef.current) callIdsRef.current.value = text;
                    };
                    reader.readAsText(file);
                    e.target.value = ""; // reset for re-upload
                  }}
                />
              </label>
              <button
                onClick={async () => {
                  const text = callIdsRef.current?.value || "";
                  const ids = text.split(/[\n,;\s]+/).map(s => s.trim()).filter(s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s));
                  if (ids.length === 0) { alert("No valid conversation IDs found. Expected UUID format."); return; }
                  const estMin = Math.ceil(ids.length * 45 / 60);
                  if (!confirm(`Import ${ids.length} call(s)?\n\nEstimated time: ~${estMin} minutes\n(~45 seconds per call: fetch + evaluate)\n\nRuns in the background — you can close this page.`)) return;
                  try {
                    const result = await importByIds(project.id, ids);
                    setHistoryResult(result);
                    load();
                  } catch (err) {
                    setHistoryResult({ error: (err as Error).message });
                  }
                }}
                style={btnStyle}
              >
                Import IDs
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New live run modal */}
      {!isHistory && showNewRun && (
        <div style={{ background: T.card, padding: 16, borderRadius: 8, marginBottom: 16, border: `1px solid ${T.border}` }}>
          <label style={{ fontSize: 14, color: T.textSecondary, marginBottom: 8, display: "block" }}>Select Model</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {AVAILABLE_MODELS.map((group) => (
              <div key={group.provider}>
                <div style={{ fontSize: 11, color: T.textMuted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, marginTop: 4 }}>
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
                          background: isSelected ? "#ecfdf3" : T.bg,
                          border: `1px solid ${isSelected ? T.primary : T.border}`,
                          borderRadius: 6, cursor: "pointer", textAlign: "left", color: T.text,
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>
                            {m.label}
                            {alreadyRun && <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: 8 }}>already tested</span>}
                          </div>
                          <div style={{ fontSize: 12, color: T.textSecondary, marginTop: 2 }}>{m.desc}</div>
                        </div>
                        {isSelected && <span style={{ color: T.primary, fontSize: 18 }}>&#10003;</span>}
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
          <span key={c.id} style={{ background: T.card, padding: "4px 10px", borderRadius: 4, fontSize: 12, border: `1px solid ${T.border}` }}>
            {c.label || c.key} ({c.type})
          </span>
        ))}
      </div>

      {/* Import progress banner */}
      <ImportProgressBanner runs={project.runs ?? []} />

      {/* Ask AI */}
      {project.runs?.length >= 3 && (
        <div style={{ marginBottom: 20 }}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!askQuery.trim() || askLoading) return;
              setAskLoading(true);
              setAskError(null);
              setAskResult(null);
              try {
                const result = await askProject(project.id, askQuery.trim());
                setAskResult(result);
              } catch (err) {
                const msg = (err as Error).message;
                // Extract the JSON error message if it's an API error wrapper
                try {
                  const parsed = JSON.parse(msg.replace(/^API error \d+:\s*/, ""));
                  setAskError(parsed.error || msg);
                } catch {
                  setAskError(msg);
                }
              } finally {
                setAskLoading(false);
              }
            }}
            style={{ display: "flex", gap: 8, alignItems: "center" }}
          >
            <input
              type="text"
              placeholder="Ask about your calls... e.g. &quot;Which calls had hallucination issues?&quot;"
              value={askQuery}
              onChange={(e) => setAskQuery(e.target.value)}
              style={{
                flex: 1,
                padding: "8px 12px",
                background: T.input,
                border: `1px solid ${T.borderDark}`,
                borderRadius: 6,
                color: T.text,
                fontSize: 13,
              }}
            />
            <button
              type="submit"
              disabled={askLoading || !askQuery.trim()}
              style={{
                padding: "8px 16px",
                background: askLoading ? "#b8e6cc" : T.primary,
                color: "#fff",
                border: "none",
                borderRadius: 6,
                cursor: askLoading ? "default" : "pointer",
                fontSize: 13,
                fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {askLoading ? "Searching..." : "Ask AI"}
            </button>
            {askResult && (
              <button
                type="button"
                onClick={() => { setAskResult(null); setAskQuery(""); setAskError(null); }}
                style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 16 }}
              >
                x
              </button>
            )}
          </form>

          {askError && (
            <div style={{ marginTop: 8, padding: "8px 12px", background: T.errorBg, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 12, color: "#ef4444" }}>
              {askError}
            </div>
          )}

          {askResult && (
            <div style={{ marginTop: 12 }}>
              {/* Summary */}
              <div style={{
                padding: "10px 14px", background: T.card, border: `1px solid ${T.border}`,
                borderRadius: 6, fontSize: 13, color: T.text, lineHeight: 1.6, marginBottom: 10,
              }}>
                {askResult.summary}
                <span style={{ fontSize: 10, color: T.textMuted, marginLeft: 8 }}>
                  ({askResult.totalMatched} call{askResult.totalMatched !== 1 ? "s" : ""} affected
                  {askResult.costUsd > 0 ? ` / $${askResult.costUsd.toFixed(4)}` : ""})
                </span>
              </div>

              {/* Issues table */}
              {askResult.issues?.length > 0 && (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: `2px solid ${T.border}`, textAlign: "left" }}>
                      <th style={{ padding: "8px 10px", color: T.textSecondary, fontWeight: 600, width: 30 }}>#</th>
                      <th style={{ padding: "8px 10px", color: T.textSecondary, fontWeight: 600, width: 70 }}>Severity</th>
                      <th style={{ padding: "8px 10px", color: T.textSecondary, fontWeight: 600 }}>Issue</th>
                      <th style={{ padding: "8px 10px", color: T.textSecondary, fontWeight: 600, width: 200 }}>Affected Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {askResult.issues.map((issue: any, i: number) => {
                      const sevColor = issue.severity === "critical" ? T.error
                        : issue.severity === "high" ? "#f59e0b"
                        : issue.severity === "medium" ? T.info : T.textMuted;
                      const sevBg = issue.severity === "critical" ? T.errorBg
                        : issue.severity === "high" ? T.warningBg
                        : issue.severity === "medium" ? T.infoBg : T.cardAlt;
                      return (
                        <tr key={i} style={{ borderBottom: `1px solid ${T.borderLight}` }}>
                          <td style={{ padding: "10px 10px", color: T.textMuted, verticalAlign: "top" }}>{i + 1}</td>
                          <td style={{ padding: "10px 10px", verticalAlign: "top" }}>
                            <span style={{
                              fontSize: 10, padding: "2px 8px", borderRadius: 3, fontWeight: 600, textTransform: "uppercase",
                              background: sevBg, color: sevColor, border: `1px solid ${sevColor}33`,
                            }}>
                              {issue.severity}
                            </span>
                          </td>
                          <td style={{ padding: "10px 10px", verticalAlign: "top" }}>
                            <div style={{ fontWeight: 600, color: T.text, marginBottom: 3 }}>{issue.title}</div>
                            <div style={{ color: T.textSecondary, fontSize: 12, lineHeight: 1.5 }}>{issue.description}</div>
                          </td>
                          <td style={{ padding: "10px 10px", verticalAlign: "top" }}>
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {issue.calls?.map((call: any) => (
                                <Link
                                  key={call.id}
                                  to={`/projects/${project.id}/runs/${call.id}`}
                                  style={{
                                    fontSize: 10, padding: "2px 6px", borderRadius: 3, textDecoration: "none",
                                    background: T.cardAlt, color: T.link, border: `1px solid ${T.border}`,
                                    fontFamily: "monospace",
                                  }}
                                  title={`${call.callDate || "?"} · ${call.callOutcome || "?"} · ${call.overallScore != null ? (call.overallScore * 100).toFixed(0) + "%" : "?"}`}
                                >
                                  {call.conversationId?.slice(0, 8) || call.id.slice(0, 8)}
                                </Link>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {/* Fallback: flat run list if no issues returned (filter-only queries) */}
              {(!askResult.issues || askResult.issues.length === 0) && askResult.runs?.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {askResult.runs.map((run: any) => (
                    <Link
                      key={run.id}
                      to={`/projects/${project.id}/runs/${run.id}`}
                      style={{ textDecoration: "none", color: "inherit" }}
                    >
                      <div style={{
                        display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                        background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6,
                        cursor: "pointer", transition: "border-color 0.15s",
                      }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = T.borderDark)}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = T.border)}
                      >
                        <div style={{
                          width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 12, fontWeight: 700,
                          background: run.overallScore == null ? T.cardAlt
                            : run.overallScore >= 0.8 ? T.successBg : run.overallScore >= 0.5 ? T.warningBg : T.errorBg,
                          color: run.overallScore == null ? T.textMuted
                            : run.overallScore >= 0.8 ? "#22c55e" : run.overallScore >= 0.5 ? "#f59e0b" : "#ef4444",
                          border: `1px solid ${run.overallScore == null ? T.border
                            : run.overallScore >= 0.8 ? "#22c55e44" : run.overallScore >= 0.5 ? "#f59e0b44" : "#ef444444"}`,
                        }}>
                          {run.overallScore != null ? `${(run.overallScore * 100).toFixed(0)}%` : "?"}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3 }}>
                            <span style={{ fontSize: 12, color: T.textSecondary }}>{run.callDate || "?"}</span>
                            {run.callOutcome && (
                              <span style={{
                                fontSize: 10, padding: "1px 6px", borderRadius: 3,
                                background: run.callOutcome === "stuck" ? T.errorBg : T.card,
                                color: run.callOutcome === "stuck" ? "#ef4444" : T.textSecondary,
                                border: `1px solid ${run.callOutcome === "stuck" ? "#ef444433" : T.border}`,
                              }}>
                                {run.callOutcome}
                              </span>
                            )}
                            {run.callDuration && (
                              <span style={{ fontSize: 10, color: T.textMuted }}>{run.callDuration}s</span>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: T.primary, lineHeight: 1.5 }}>
                            {run.matchReason}
                          </div>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Runs table */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>
          {isWebhook ? "Incoming Calls" : isHistory ? "Imported Calls" : "Runs"}
          {project.runs?.length > 0 && (
            <span style={{ fontSize: 12, color: T.textMuted, fontWeight: 400, marginLeft: 8 }}>
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
              background: T.input,
              border: `1px solid ${T.borderDark}`,
              borderRadius: 4,
              color: T.text,
              fontSize: 12,
              width: 260,
            }}
          />
          {(isHistory || isWebhook) && (() => {
            const channels = new Set<string>();
            for (const r of (project.runs ?? [])) {
              const ch = getChannel(r.webhookData);
              if (ch) channels.add(ch);
            }
            // Reset filter if the selected channel no longer exists in the data
            if (channelFilter && !channels.has(channelFilter)) {
              setTimeout(() => setChannelFilter(null), 0);
            }
            if (channels.size < 2) return null;
            return (
              <div style={{ display: "flex", gap: 0, borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                <button
                  onClick={() => setChannelFilter(null)}
                  style={{
                    padding: "4px 10px", border: "none", cursor: "pointer", fontSize: 11,
                    background: channelFilter === null ? T.primary : T.card,
                    color: channelFilter === null ? "#fff" : T.textSecondary,
                  }}
                >All</button>
                {[...channels].sort().map((ch) => (
                  <button
                    key={ch}
                    onClick={() => setChannelFilter(channelFilter === ch ? null : ch)}
                    style={{
                      padding: "4px 10px", border: "none", cursor: "pointer", fontSize: 11,
                      background: channelFilter === ch ? T.primary : T.card,
                      color: channelFilter === ch ? "#fff" : T.textSecondary,
                    }}
                  >{ch}</button>
                ))}
              </div>
            );
          })()}
        </div>
        {(isHistory || isWebhook) && (
          <div style={{ display: "flex", gap: 0, borderRadius: 6, overflow: "hidden", border: `1px solid ${T.border}` }}>
            {(["evaluation", "outcomes"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: "5px 14px",
                  background: activeTab === tab ? T.primary : T.card,
                  color: activeTab === tab ? "#fff" : T.textSecondary,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: activeTab === tab ? 600 : 400,
                }}
              >
                {tab === "evaluation" ? "Evaluation" : `Outcomes${outcomeColumns.length ? ` (${outcomeColumns.length})` : ""}`}
              </button>
            ))}
          </div>
        )}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${T.border}`, textAlign: "left" }}>
            {/* Sort headers */}
            {(isHistory || isWebhook) ? (
              <>
                <th style={{ ...thStyle, cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortField === "date") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortField("date"); setSortDir("desc"); } }}>Date {sortField === "date" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                <th style={thStyle}>Channel</th>
                <th style={{ ...thStyle, cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortField === "duration") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortField("duration"); setSortDir("desc"); } }}>Duration {sortField === "duration" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                <th style={thStyle}>Call Status</th>
                <th style={{ ...thStyle, cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortField === "outcome") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortField("outcome"); setSortDir("desc"); } }}>Call Outcome {sortField === "outcome" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                <th style={{ ...thStyle, minWidth: 220 }}>Conversation ID</th>
              </>
            ) : (
              <th style={thStyle}>Model</th>
            )}
            {activeTab === "evaluation" ? (
              <>
                <th style={thStyle}>Goal</th>
                <th style={{ ...thStyle, cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortField === "status") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortField("status"); setSortDir("desc"); } }}>Status {sortField === "status" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                <th style={{ ...thStyle, cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortField === "score") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortField("score"); setSortDir("desc"); } }}>Score {sortField === "score" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                <th style={{ ...thStyle, fontSize: 11, cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortField === "cost") setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortField("cost"); setSortDir("desc"); } }}>Cost {sortField === "cost" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
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
          {sortedRuns.filter((run: any) => {
            // Channel filter
            if (channelFilter) {
              const ch = getChannel(run.webhookData);
              if (!ch || ch.toLowerCase() !== channelFilter.toLowerCase()) return false;
            }
            // Text search
            if (!searchQuery.trim()) return true;
            const q = searchQuery.toLowerCase();
            return (
              (run.hamsaCallId || "").toLowerCase().includes(q) ||
              (run.conversationId || "").toLowerCase().includes(q) ||
              (run.callOutcome || "").toLowerCase().includes(q) ||
              (run.callStatus || "").toLowerCase().includes(q) ||
              (run.modelUsed || "").toLowerCase().includes(q) ||
              (getChannel(run.webhookData) || "").toLowerCase().includes(q)
            );
          }).map((run: any) => (
            <tr key={run.id} style={{ borderBottom: `1px solid ${T.border}` }}>
              {(isHistory || isWebhook) ? (
                <>
                  <td style={tdStyle}>
                    <Link to={`/projects/${id}/runs/${run.id}`} style={{ color: T.link, textDecoration: "none", whiteSpace: "nowrap" }}>
                      {formatDate(run.callDate || run.createdAt)}
                    </Link>
                  </td>
                  <td style={{ ...tdStyle, fontSize: 11 }}>
                    <ChannelBadge webhookData={run.webhookData} />
                  </td>
                  <td style={{ ...tdStyle, color: T.textMuted, fontSize: 12, whiteSpace: "nowrap" }}>
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
                  <Link to={`/projects/${id}/runs/${run.id}`} style={{ color: T.link, textDecoration: "none" }}>
                    {run.modelUsed}
                  </Link>
                </td>
              )}
              {activeTab === "evaluation" ? (
                <>
                  <td style={tdStyle}><GoalBadge run={run} /></td>
                  <td style={tdStyle}>
                    <span style={{ color: STATUS_COLORS[run.status] || T.textSecondary, display: "flex", alignItems: "center", gap: 4 }}>
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
                  <td style={{ ...tdStyle, fontSize: 11, color: T.textMuted }}>
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
                    style={{ ...smallBtnStyle, color: T.textMuted }}
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
      {(searchQuery.trim() || channelFilter) && project.runs?.length > 0 && (() => {
        const filtered = (project.runs ?? []).filter((run: any) => {
          if (channelFilter) {
            const ch = getChannel(run.webhookData);
            if (!ch || ch.toLowerCase() !== channelFilter.toLowerCase()) return false;
          }
          if (!searchQuery.trim()) return true;
          const q = searchQuery.toLowerCase();
          return (
            (run.hamsaCallId || "").toLowerCase().includes(q) ||
            (run.conversationId || "").toLowerCase().includes(q) ||
            (run.callOutcome || "").toLowerCase().includes(q) ||
            (run.callStatus || "").toLowerCase().includes(q) ||
            (run.modelUsed || "").toLowerCase().includes(q) ||
            (getChannel(run.webhookData) || "").toLowerCase().includes(q)
          );
        });
        if (filtered.length === 0) {
          return (
            <p style={{ color: T.textMuted, fontSize: 13, textAlign: "center", padding: "16px 0" }}>
              No calls match the current filter.{" "}
              <button onClick={() => { setSearchQuery(""); setChannelFilter(null); }} style={{ color: T.link, background: "none", border: "none", cursor: "pointer", fontSize: 13 }}>
                Clear filters
              </button>
            </p>
          );
        }
        return null;
      })()}

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
    // Distinguish between: hangup, stuck, and active rejection
    const isIncomplete = outcome.includes("hangup") || outcome.includes("hang_up")
                      || outcome.includes("stuck") || outcome.includes("timeout")
                      || outcome.includes("confused") || outcome.includes("dropped");
    const status: GoalStatus = (score != null && score >= 0.7) ? "PARTIAL" : "FAILED";
    const reason = summary
      || (isIncomplete
        ? (status === "PARTIAL"
          ? `Call ended before objective was met, but agent performed correctly (${(score! * 100).toFixed(0)}% quality).`
          : `Call did not complete — ${outcome.replace(/_/g, " ")}.${failedStr}`)
        : (status === "PARTIAL"
          ? `Customer declined, but the agent performed correctly (${(score! * 100).toFixed(0)}% quality).`
          : `Customer was not interested.${failedStr}`));
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
  SUCCESSFUL: { color: "#22c55e", bg: T.successBg, border: "#22c55e44", label: "Successful" },
  PARTIAL:    { color: "#f59e0b", bg: T.warningBg, border: "#f59e0b44", label: "Partial"    },
  FAILED:     { color: "#ef4444", bg: T.errorBg, border: "#ef444444", label: "Failed"     },
};

function GoalBadge({ run }: { run: any }) {
  const goal = computeGoal(run);
  if (!goal) return <span style={{ color: T.textFaint, fontSize: 11 }}>—</span>;
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
    width: "100%", height: 80, background: T.bg, border: `1px solid ${T.borderDark}`,
    borderRadius: 4, color: T.text, fontFamily: "monospace", fontSize: 11, padding: 8,
  };
  return (
    <div style={{ marginTop: 8, background: T.card, padding: 12, borderRadius: 6, border: `1px solid ${T.border}` }}>
      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: T.textSecondary }}>Call Log JSON</label>
        <textarea style={textareaStyle} value={callLogJson} onChange={(e) => setCallLogJson(e.target.value)} placeholder="Paste call log array..." />
        <button onClick={() => onUpload(runId, "callLog", callLogJson)} style={smallBtnStyle} disabled={!callLogJson.trim()}>
          Upload Call Log
        </button>
      </div>
      <div>
        <label style={{ fontSize: 12, color: T.textSecondary }}>Webhook/Transcript JSON</label>
        <textarea style={textareaStyle} value={transcriptJson} onChange={(e) => setTranscriptJson(e.target.value)} placeholder="Paste webhook payload..." />
        <button onClick={() => onUpload(runId, "transcript", transcriptJson)} style={smallBtnStyle} disabled={!transcriptJson.trim()}>
          Upload Transcript
        </button>
      </div>
    </div>
  );
}

const CALL_STATUS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  COMPLETED:  { color: "#22c55e", bg: T.successBg, label: "Completed" },
  FAILED:     { color: "#ef4444", bg: T.errorBg, label: "Failed" },
  NO_ANSWER:  { color: "#f59e0b", bg: T.warningBg, label: "No Answer" },
  IN_PROGRESS:{ color: "#3b82f6", bg: T.infoBg, label: "In Progress" },
  PENDING:    { color: T.textSecondary, bg: T.card, label: "Pending" },
};

function getChannel(webhookData: any): string | null {
  if (!webhookData) return null;
  return (
    webhookData.caller_info?.call_type ||  // webhook runs: payload.caller_info.call_type
    webhookData.data?.channelType ||       // webhook runs: payload.data.channelType
    webhookData.channelType ||             // history runs: conv.channelType
    webhookData.channel ||                 // history runs: conv.channel
    webhookData.callType ||                // history runs: conv.callType
    null
  );
}

function ChannelBadge({ webhookData }: { webhookData: any }) {
  const channel = getChannel(webhookData);
  if (!channel) return <span style={{ color: T.textFaint, fontSize: 12 }}>—</span>;
  const isWeb = channel.toLowerCase() === "web";
  return (
    <span style={{
      fontSize: 10, padding: "2px 7px", borderRadius: 10,
      background: isWeb ? T.infoBg : T.successBg,
      color: isWeb ? "#3b82f6" : "#22c55e",
      border: `1px solid ${isWeb ? "#60a5fa" : "#4ade80"}44`,
      whiteSpace: "nowrap",
    }}>
      {isWeb ? "Web" : channel}
    </span>
  );
}

function CallStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span style={{ color: T.textFaint, fontSize: 12 }}>—</span>;
  const s = CALL_STATUS_STYLE[status.toUpperCase()] ?? { color: T.textSecondary, bg: T.card, label: status };
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
    return { color: "#ef4444", bg: T.errorBg };
  if (lower.includes("interested") || lower.includes("success") || lower.includes("converted") || lower.includes("booked"))
    return { color: "#22c55e", bg: T.successBg };
  if (lower.includes("followup") || lower.includes("callback") || lower.includes("pending") || lower.includes("later"))
    return { color: "#f59e0b", bg: T.warningBg };
  if (lower.includes("no_answer") || lower.includes("busy") || lower.includes("voicemail"))
    return { color: "#6b7280", bg: T.card };
  return { color: "#a78bfa", bg: "#f3e8ff" }; // unknown outcomes get purple
}

function OutcomeBadge({ outcome }: { outcome: string | null | undefined }) {
  if (!outcome) return <span style={{ color: T.textFaint, fontSize: 12 }}>—</span>;
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
      background: T.infoBg,
      border: `1px solid ${T.border}`,
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
      <div style={{ background: T.cardAlt, borderRadius: 4, height: 6, marginBottom: 10, overflow: "hidden" }}>
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
      background: T.card, padding: "12px 16px", borderRadius: 8, border: `1px solid ${T.border}`, minWidth: 120,
      boxShadow: T.shadow,
      ...(href ? { cursor: "pointer", transition: "border-color 0.15s" } : {}),
    }}
      onMouseEnter={href ? (e) => (e.currentTarget.style.borderColor = T.borderDark) : undefined}
      onMouseLeave={href ? (e) => (e.currentTarget.style.borderColor = T.border) : undefined}
    >
      <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
  if (href) return <Link to={href} style={{ textDecoration: "none", color: "inherit" }}>{inner}</Link>;
  return inner;
}

const btnStyle: React.CSSProperties = {
  background: T.primary, color: "#fff", padding: "8px 16px", borderRadius: 6,
  border: "none", cursor: "pointer", fontSize: 14,
};
const smallBtnStyle: React.CSSProperties = {
  background: T.cardAlt, color: T.textSecondary, padding: "4px 8px", borderRadius: 4,
  border: "none", cursor: "pointer", fontSize: 11,
};
const thStyle: React.CSSProperties = { padding: "8px 12px", fontSize: 13 };
const tdStyle: React.CSSProperties = { padding: "8px 12px" };
const labelStyle: React.CSSProperties = { display: "block", marginBottom: 4, fontSize: 13, color: T.textSecondary };
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "6px 10px", background: T.input, border: `1px solid ${T.borderDark}`,
  borderRadius: 4, color: T.text, fontSize: 13, boxSizing: "border-box",
};

/**
 * Shows a truncated ID with a clipboard icon to copy the full ID.
 * Hovering the code shows the full UUID as a native tooltip.
 */
function CopyableId({ id, label }: { id: string | null | undefined; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!id) return <span style={{ color: T.textFaint, fontSize: 12 }}>—</span>;

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
          background: T.cardAlt, padding: "2px 6px", borderRadius: 3,
          border: `1px solid ${T.border}`, letterSpacing: "0.02em", whiteSpace: "nowrap",
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
      background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, boxShadow: T.shadow,
      marginBottom: 24, overflow: "hidden",
    }}>
      {/* Toggle header */}
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: "12px 18px", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 12,
          borderBottom: open ? `1px solid ${T.border}` : "none",
        }}
      >
        <span style={{ fontSize: 11, color: "#3b82f6" }}>{open ? "▼" : "▶"}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: T.link }}>What the system understood from this agent</span>
        <span style={{ fontSize: 11, color: T.textFaint, marginLeft: 4 }}>
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
                background: T.infoBg, border: `1px solid ${T.border}`, borderRadius: 8,
                padding: "14px 16px", fontSize: 13, color: T.text,
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
                background: "#f3e8ff", border: `1px solid ${T.border}`, borderRadius: 8,
                padding: "14px 16px", fontSize: 12, color: "#7c3aed",
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
                background: T.successBg, border: `1px solid ${T.border}`, borderRadius: 8,
                padding: "10px 14px", fontSize: 13, color: "#166534", lineHeight: 1.6,
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
                      background: T.bg, border: `1px solid ${T.border}`,
                      borderLeft: "3px solid #f59e0b", borderRadius: 6, padding: "10px 14px",
                    }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#fcd34d" }}>{node.label || `Node ${i + 1}`}</span>
                        <span style={{ fontSize: 10, color: T.textMuted, padding: "1px 6px", background: T.card, borderRadius: 3 }}>{node.type}</span>
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
                                fontSize: 10, color: T.textSecondary,
                                padding: "1px 8px", background: T.infoBg,
                                border: `1px solid ${T.border}`, borderRadius: 3,
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
                    background: T.bg, border: `1px solid ${T.border}`,
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
        style={{ background: "none", border: "none", color: loading ? T.textMuted : "#3b82f6", cursor: loading ? "default" : "pointer", fontSize: 11, padding: 0 }}
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
      marginTop: 8, padding: "6px 12px", background: T.bg, borderRadius: 6,
      border: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 8,
    }}>
      <span style={{ fontSize: 11, color: T.textMuted }}>Webhook URL:</span>
      <code style={{ fontSize: 11, color: T.textSecondary, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {url}
      </code>
      <button
        onClick={() => { navigator.clipboard.writeText(url).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        style={{
          background: copied ? T.successBg : T.card,
          border: `1px solid ${copied ? "#22c55e44" : T.border}`,
          color: copied ? "#22c55e" : T.textSecondary,
          padding: "2px 10px", borderRadius: 3, cursor: "pointer", fontSize: 11,
        }}
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}
