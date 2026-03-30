import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { getProject, createRun, deleteRun, triggerEvaluation, switchModel, attachCallLog, attachTranscript } from "../api/client";
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

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showNewRun, setShowNewRun] = useState(false);
  const [modelInput, setModelInput] = useState("openai/gpt-4.1");
  const [showUpload, setShowUpload] = useState<string | null>(null);
  const [callingRunId, setCallingRunId] = useState<string | null>(null);

  const load = () => {
    getProject(id!)
      .then(setProject)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [id]);

  if (loading) return <p>Loading...</p>;
  if (!project) return <p>Project not found</p>;

  async function handleCreateRun() {
    const run = await createRun({ projectId: project.id, modelUsed: modelInput });
    setShowNewRun(false);

    // Switch model on the agent, then start call
    try {
      await switchModel(run.id);
    } catch {
      // Model switch failed — still allow manual call
    }

    load();

    // Auto-open the call dialog
    setCallingRunId(run.id);
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

  // Find best and worst run
  const completedRuns = project.runs?.filter((r: any) => r.status === "COMPLETE" && r.overallScore != null) || [];
  const bestRun = completedRuns.length > 0
    ? completedRuns.reduce((a: any, b: any) => (a.overallScore > b.overallScore ? a : b))
    : null;
  const worstRun = completedRuns.length > 1
    ? completedRuns.reduce((a: any, b: any) => (a.overallScore < b.overallScore ? a : b))
    : null;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <Link to="/" style={{ color: "#888", textDecoration: "none", fontSize: 14 }}>
          &larr; Projects
        </Link>
        <h1 style={{ margin: "8px 0" }}>{project.name}</h1>
        {project.description && <p style={{ color: "#888", margin: 0 }}>{project.description}</p>}
        {project.hamsaApiKey && <WebhookUrlBar url={`${window.location.origin}/api/webhooks/hamsa`} />}
      </div>

      {/* Summary cards */}
      <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        <Card label="Total Runs" value={project.runs?.length ?? 0} />
        <Card label="Criteria" value={project.criteria?.length ?? 0} />
        {bestRun && <Card label="Best Model" value={`${bestRun.modelUsed} (${(bestRun.overallScore * 100).toFixed(0)}%)`} />}
        {worstRun && worstRun.id !== bestRun?.id && (
          <Card label="Worst Model" value={`${worstRun.modelUsed} (${(worstRun.overallScore * 100).toFixed(0)}%)`} />
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <button onClick={() => setShowNewRun(true)} style={btnStyle}>
          + New Run
        </button>
        {completedRuns.length >= 2 && (
          <button onClick={() => navigate(`/projects/${id}/compare`)} style={{ ...btnStyle, background: "#374151" }}>
            Compare Runs
          </button>
        )}
      </div>

      {/* New run modal */}
      {showNewRun && (
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
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "10px 14px",
                          background: isSelected ? "#2563eb22" : "#0a0a0a",
                          border: `1px solid ${isSelected ? "#2563eb" : "#222"}`,
                          borderRadius: 6,
                          cursor: "pointer",
                          textAlign: "left",
                          color: "#e0e0e0",
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>
                            {m.label}
                            {alreadyRun && (
                              <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: 8 }}>already tested</span>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{m.desc}</div>
                        </div>
                        {isSelected && (
                          <span style={{ color: "#2563eb", fontSize: 18 }}>&#10003;</span>
                        )}
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
          <span
            key={c.id}
            style={{
              background: "#1a1a1a",
              padding: "4px 10px",
              borderRadius: 4,
              fontSize: 12,
              border: "1px solid #333",
            }}
          >
            {c.label || c.key} ({c.type})
          </span>
        ))}
      </div>

      {/* Runs table */}
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>Runs</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #333", textAlign: "left" }}>
            <th style={thStyle}>Model</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Overall Score</th>
            {project.criteria?.map((c: any) => (
              <th key={c.id} style={{ ...thStyle, fontSize: 11 }}>{c.label || c.key}</th>
            ))}
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {project.runs?.map((run: any) => (
            <tr key={run.id} style={{ borderBottom: "1px solid #1a1a1a" }}>
              <td style={tdStyle}>
                <Link to={`/projects/${id}/runs/${run.id}`} style={{ color: "#60a5fa", textDecoration: "none" }}>
                  {run.modelUsed}
                </Link>
              </td>
              <td style={tdStyle}>
                <span style={{ color: STATUS_COLORS[run.status] || "#888", display: "flex", alignItems: "center", gap: 4 }}>
                  {(run.status === "RUNNING" || run.status === "AWAITING_DATA" || run.status === "EVALUATING") && (
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
              <td style={tdStyle}>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {(run.status === "PENDING" || run.status === "RUNNING") && project.hamsaApiKey && (
                    <button
                      onClick={() => setCallingRunId(run.id)}
                      style={{ ...smallBtnStyle, background: "#22c55e33", color: "#22c55e", border: "1px solid #22c55e44" }}
                    >
                      Call
                    </button>
                  )}
                  {(run.status === "PENDING" || run.status === "RUNNING" || run.status === "AWAITING_DATA" || run.status === "FAILED") && (
                    <button
                      onClick={() => setShowUpload(showUpload === run.id ? null : run.id)}
                      style={smallBtnStyle}
                    >
                      Upload Data
                    </button>
                  )}
                  {(run.callLog || run.transcript) && run.status !== "COMPLETE" && (
                    <button
                      onClick={async () => { await triggerEvaluation(run.id); load(); }}
                      style={smallBtnStyle}
                    >
                      Evaluate
                    </button>
                  )}
                  <button
                    onClick={async () => { if (confirm("Delete?")) { await deleteRun(run.id); load(); } }}
                    style={{ ...smallBtnStyle, color: "#666" }}
                  >
                    Del
                  </button>
                </div>
                {showUpload === run.id && (
                  <UploadPanel runId={run.id} onUpload={handleUploadData} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Call Agent dialog */}
      {callingRunId && project.hamsaApiKey && (
        <CallAgent
          runId={callingRunId}
          agentId={project.agentId}
          apiKey={project.hamsaApiKey}
          webhookUrl={`${window.location.origin}/api/webhooks/hamsa`}
          onCallEnded={() => {
            setTimeout(load, 2000);
          }}
          onClose={() => {
            setCallingRunId(null);
            load();
          }}
        />
      )}
    </div>
  );
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

function Card({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: "#1a1a1a", padding: "12px 16px", borderRadius: 8, border: "1px solid #222", minWidth: 120 }}>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
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
