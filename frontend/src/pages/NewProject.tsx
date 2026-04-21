import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { createProject, fetchAgentPreview, importHistory } from "../api/client";

const DEFAULT_CRITERIA = [
  { key: "language_switching", label: "Language Switching", type: "LLM_JUDGE", expectedValue: { rule: "Evaluate language consistency: The agent should maintain the primary language chosen by the user throughout the conversation. If the user speaks Arabic, the agent should respond in Arabic even if the user mixes in English words (like plate numbers, names, etc). Mixing in technical terms or data in English is NOT an error. Only flag if the agent switches its primary response language without being asked to, or if the user explicitly requests a language switch and the agent fails to comply. If no language switch was requested and the agent stayed consistent, return passed=null and score=null (not applicable)." }, weight: 1 },
  { key: "gender_detection", label: "Gender Detection", type: "LLM_JUDGE", expectedValue: { rule: "Agent must use gender-appropriate Arabic grammar matching the detected customer gender" }, weight: 1 },
  { key: "tool_calls", label: "Tool Calls", type: "DETERMINISTIC", expectedValue: { requiredTools: [] }, weight: 1 },
  { key: "node_transitions", label: "Node Transitions", type: "STRUCTURAL", expectedValue: { expectedSequence: [] }, weight: 1 },
  { key: "word_accuracy", label: "Word Accuracy", type: "WORD_ACCURACY", expectedValue: { threshold: 0.95 }, weight: 1 },
  { key: "latency", label: "Latency", type: "LATENCY", expectedValue: { maxToolLatencyMs: 3000 }, weight: 0.5 },
  { key: "flow_progression", label: "Flow Progression", type: "FLOW_PROGRESSION", expectedValue: { minNodesVisited: 3, expectedVariables: ["user_name", "plate_number"], expectedToolCalls: 1 }, weight: 1.5 },
];

const QUICK_PRESETS = [
  { label: "Today", days: 0 },
  { label: "Yesterday", days: 1 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

function toDateString(d: Date) {
  return d.toISOString().slice(0, 10);
}

function getPresetRange(days: number) {
  const end = new Date();
  const start = new Date();
  if (days === 0) {
    // today
    return { start: toDateString(start), end: toDateString(end) };
  }
  if (days === 1) {
    // yesterday
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
    return { start: toDateString(start), end: toDateString(end) };
  }
  start.setDate(start.getDate() - days);
  return { start: toDateString(start), end: toDateString(end) };
}

export default function NewProject() {
  const navigate = useNavigate();
  const [projectType, setProjectType] = useState<"LIVE" | "HISTORY" | "WEBHOOK">("WEBHOOK");

  // Common fields
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [hamsaApiKey, setHamsaApiKey] = useState("");
  const [description, setDescription] = useState("");
  const [useCriteria, setUseCriteria] = useState(true);

  // Import fields (shown for HISTORY type)
  const today = toDateString(new Date());
  const thirtyDaysAgo = toDateString(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const [startDate, setStartDate] = useState(thirtyDaysAgo);
  const [endDate, setEndDate] = useState(today);
  const [importLimit, setImportLimit] = useState(50);
  const [activePreset, setActivePreset] = useState<number | null>(30); // "Last 30 days" active by default

  // Agent preview state
  const [agentPreview, setAgentPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameAutoFilled = useRef(false);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingStage, setSavingStage] = useState("");

  // UUID format: 8-4-4-4-12 hex chars
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Auto-fetch agent preview when agentId matches UUID format
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    setAgentPreview(null);
    setPreviewError("");

    if (UUID_RE.test(agentId.trim())) {
      previewTimer.current = setTimeout(async () => {
        setPreviewLoading(true);
        try {
          const preview = await fetchAgentPreview(agentId.trim(), hamsaApiKey.trim() || undefined);
          setAgentPreview(preview);
          if (preview.name && (!name || nameAutoFilled.current)) {
            setName(preview.name + " Evaluation");
            nameAutoFilled.current = true;
          }
        } catch {
          setPreviewError("Could not load agent — check ID and API key");
        } finally {
          setPreviewLoading(false);
        }
      }, 600);
    }

    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, hamsaApiKey]);

  function applyPreset(days: number) {
    const range = getPresetRange(days);
    setStartDate(range.start);
    setEndDate(range.end);
    setActivePreset(days);
  }

  // Clear active preset if dates are manually changed
  function handleStartDate(val: string) {
    setStartDate(val);
    setActivePreset(null);
  }
  function handleEndDate(val: string) {
    setEndDate(val);
    setActivePreset(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (projectType === "HISTORY") {
      if (!startDate || !endDate) {
        setError("Both start and end dates are required");
        return;
      }
      if (startDate > endDate) {
        setError("Start date must be before end date");
        return;
      }
    }

    setSaving(true);
    setSavingStage("Creating project…");
    try {
      const payload: Parameters<typeof createProject>[0] = {
        name,
        agentId,
        hamsaApiKey,
        description,
        projectType,
        criteria: useCriteria
          ? (projectType === "WEBHOOK"
            ? DEFAULT_CRITERIA.filter(c => !["DETERMINISTIC", "STRUCTURAL", "LATENCY", "ACTION_CONSISTENCY"].includes(c.type))
            : DEFAULT_CRITERIA)
          : [],
        ...(projectType === "HISTORY" && startDate ? { historyStartDate: startDate } : {}),
        ...(projectType === "HISTORY" && endDate ? { historyEndDate: endDate } : {}),
      };

      const project = await createProject(payload);

      // Auto-trigger import for HISTORY projects
      if (projectType === "HISTORY" && startDate && endDate) {
        setSavingStage("Starting import…");
        try {
          const importResult = await importHistory(project.id, {
            period: "CUSTOM",
            startDate,
            endDate,
            limit: importLimit,
          });
          if (importResult?.imported === 0) {
            // No conversations found — navigate anyway but surface the warning
            // as a URL param so the project page can show it
            navigate(`/projects/${project.id}?importWarning=noCalls`);
            return;
          }
        } catch (importErr) {
          // Import failure is non-fatal — user can retry from project page
          console.warn("Auto-import failed:", importErr);
        }
      }

      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
      setSavingStage("");
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    background: "#1a1a1a",
    border: "1px solid #333",
    borderRadius: 6,
    color: "#e0e0e0",
    fontSize: 14,
    boxSizing: "border-box",
  };

  return (
    <div style={{ maxWidth: 600 }}>
      <h1>New Project</h1>

      {/* Project type toggle */}
      <div style={{ display: "flex", gap: 0, marginBottom: 24, borderRadius: 8, overflow: "hidden", border: "1px solid #333" }}>
        {(["WEBHOOK", "HISTORY", "LIVE"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setProjectType(t)}
            style={{
              flex: 1,
              padding: "10px 16px",
              background: projectType === t ? "#2563eb" : "#111",
              color: projectType === t ? "#fff" : "#888",
              border: "none",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: projectType === t ? 600 : 400,
              transition: "all 0.15s",
            }}
          >
            {t === "WEBHOOK" ? "Webhook Evaluation" : t === "LIVE" ? "Live Call Evaluation" : "Historical Call Evaluation"}
          </button>
        ))}
      </div>

      <p style={{ fontSize: 13, color: "#666", margin: "-16px 0 20px" }}>
        {projectType === "WEBHOOK"
          ? "Connect your agent's webhook and automatically evaluate every call."
          : projectType === "LIVE"
            ? "Make live test calls and evaluate each one in real time."
            : "Import and evaluate past calls from this agent's history."}
      </p>

      <form onSubmit={handleSubmit}>
        {/* Agent ID */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Hamsa Agent ID</label>
          <input
            style={inputStyle}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            required
            placeholder="f5ed8b37-d24e-47dc-aa40-538c7852eb8f"
          />
        </div>

        {/* API Key */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Hamsa API Key</label>
          <input
            style={inputStyle}
            type="password"
            value={hamsaApiKey}
            onChange={(e) => setHamsaApiKey(e.target.value)}
            placeholder="Your Hamsa API key"
          />
        </div>

        {/* Agent preview card */}
        {(previewLoading || agentPreview || previewError) && (
          <div style={{
            marginBottom: 16,
            padding: "10px 14px",
            background: agentPreview ? "#0a1628" : "#1a1a1a",
            border: `1px solid ${agentPreview ? "#1e40af" : "#333"}`,
            borderRadius: 6,
            fontSize: 13,
          }}>
            {previewLoading && <span style={{ color: "#888" }}>Fetching agent details...</span>}
            {previewError && <span style={{ color: "#ef4444" }}>{previewError}</span>}
            {agentPreview && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <span style={{ color: "#60a5fa", fontWeight: 600 }}>{agentPreview.name}</span>
                    <span style={{ color: "#666", marginLeft: 8 }}>{agentPreview.type}</span>
                  </div>
                  <span style={{ color: "#22c55e", fontSize: 11 }}>Agent found</span>
                </div>
                <div style={{ marginTop: 6, display: "flex", gap: 12, color: "#888", fontSize: 12 }}>
                  {agentPreview.language && <span>Language: {agentPreview.language}</span>}
                  {agentPreview.llm?.model && <span>Model: {agentPreview.llm.model}</span>}
                  {agentPreview.nodeCount > 0 && <span>{agentPreview.nodeCount} flow nodes</span>}
                  {agentPreview.toolCount > 0 && <span>{agentPreview.toolCount} tools</span>}
                </div>
                {agentPreview.preamble && (
                  <div style={{ marginTop: 8, color: "#555", fontSize: 11, fontStyle: "italic", borderTop: "1px solid #1e293b", paddingTop: 8 }}>
                    <span style={{ color: "#4b5563" }}>Instructions: </span>
                    {agentPreview.preamble.slice(0, 150)}{agentPreview.preamble.length > 150 ? "…" : ""}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Project Name */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Project Name</label>
          <input
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="e.g. Al-Fardan V4 Evaluation"
          />
        </div>

        {/* Description */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Description (optional)</label>
          <input
            style={inputStyle}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What are we evaluating?"
          />
        </div>

        {/* History import options */}
        {projectType === "HISTORY" && (
          <div style={{ marginBottom: 20, padding: "16px", background: "#0f1626", border: "1px solid #1e3a5f", borderRadius: 8 }}>
            <div style={{ fontSize: 13, color: "#93c5fd", fontWeight: 600, marginBottom: 12 }}>
              Initial Import
            </div>

            {/* Quick presets */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {QUICK_PRESETS.map((p) => (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => applyPreset(p.days)}
                  style={{
                    padding: "4px 10px",
                    background: activePreset === p.days ? "#1d4ed8" : "#1a1a2e",
                    color: activePreset === p.days ? "#fff" : "#888",
                    border: `1px solid ${activePreset === p.days ? "#3b82f6" : "#333"}`,
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 12,
                    transition: "all 0.1s",
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Date range */}
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ ...labelStyle, fontSize: 12, marginBottom: 4 }}>From</label>
                <input
                  type="date"
                  style={inputStyle}
                  value={startDate}
                  max={endDate || today}
                  onChange={(e) => handleStartDate(e.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ ...labelStyle, fontSize: 12, marginBottom: 4 }}>To</label>
                <input
                  type="date"
                  style={inputStyle}
                  value={endDate}
                  min={startDate}
                  max={today}
                  onChange={(e) => handleEndDate(e.target.value)}
                />
              </div>
              <div style={{ width: 90 }}>
                <label style={{ ...labelStyle, fontSize: 12, marginBottom: 4 }}>Max calls</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={importLimit}
                  min={1}
                  max={500}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    setImportLimit(Number.isNaN(v) ? 50 : Math.max(1, Math.min(500, v)));
                  }}
                />
              </div>
            </div>

            <p style={{ fontSize: 11, color: "#4b6a8f", margin: 0 }}>
              Pulls the oldest {importLimit} call{importLimit !== 1 ? "s" : ""} in the selected range. Import runs in the background — you'll see progress on the project page.
            </p>
          </div>
        )}

        {/* Default criteria toggle */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ fontSize: 14, color: "#aaa", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={useCriteria}
              onChange={(e) => setUseCriteria(e.target.checked)}
              style={{ marginRight: 8 }}
            />
            Add default evaluation criteria
          </label>
        </div>

        {error && <p style={{ color: "#ef4444", fontSize: 14 }}>{error}</p>}

        <button
          type="submit"
          disabled={saving}
          style={{
            background: "#2563eb",
            color: "#fff",
            padding: "10px 20px",
            borderRadius: 6,
            border: "none",
            cursor: saving ? "not-allowed" : "pointer",
            fontSize: 14,
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? savingStage || "Creating…" : projectType === "HISTORY" ? "Create & Start Import" : projectType === "WEBHOOK" ? "Create Webhook Project" : "Create Project"}
        </button>
      </form>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: 4,
  fontSize: 14,
  color: "#aaa",
};
