import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createProject } from "../api/client";

const DEFAULT_CRITERIA = [
  { key: "language_switching", label: "Language Switching", type: "LLM_JUDGE", expectedValue: { rule: "Agent must respond in the same language the user spoke in" }, weight: 1 },
  { key: "gender_detection", label: "Gender Detection", type: "LLM_JUDGE", expectedValue: { rule: "Agent must use gender-appropriate Arabic grammar matching the detected customer gender" }, weight: 1 },
  { key: "tool_calls", label: "Tool Calls", type: "DETERMINISTIC", expectedValue: { requiredTools: [] }, weight: 1 },
  { key: "node_transitions", label: "Node Transitions", type: "STRUCTURAL", expectedValue: { expectedSequence: [] }, weight: 1 },
  { key: "word_accuracy", label: "Word Accuracy", type: "WORD_ACCURACY", expectedValue: { threshold: 0.95 }, weight: 1 },
  { key: "latency", label: "Latency", type: "LATENCY", expectedValue: { maxToolLatencyMs: 3000 }, weight: 0.5 },
];

export default function NewProject() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [hamsaApiKey, setHamsaApiKey] = useState("");
  const [description, setDescription] = useState("");
  const [agentJson, setAgentJson] = useState("");
  const [useCriteria, setUseCriteria] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    try {
      let agentStructure;
      if (agentJson.trim()) {
        agentStructure = JSON.parse(agentJson);
        // If it's wrapped in { data: { ... } }, unwrap
        if (agentStructure.data) agentStructure = agentStructure.data;
      }

      const project = await createProject({
        name,
        agentId,
        hamsaApiKey,
        description,
        agentStructure,
        criteria: useCriteria ? DEFAULT_CRITERIA : [],
      });

      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
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
  };

  return (
    <div style={{ maxWidth: 600 }}>
      <h1>New Project</h1>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: 14, color: "#aaa" }}>
            Project Name
          </label>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Al-Fardan V4 Evaluation" />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: 14, color: "#aaa" }}>
            Hamsa Agent ID
          </label>
          <input style={inputStyle} value={agentId} onChange={(e) => setAgentId(e.target.value)} required placeholder="f5ed8b37-d24e-47dc-aa40-538c7852eb8f" />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: 14, color: "#aaa" }}>
            Hamsa API Key
          </label>
          <input style={inputStyle} type="password" value={hamsaApiKey} onChange={(e) => setHamsaApiKey(e.target.value)} placeholder="Your Hamsa API key" />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: 14, color: "#aaa" }}>
            Description (optional)
          </label>
          <input style={inputStyle} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What are we evaluating?" />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: 14, color: "#aaa" }}>
            Agent Structure JSON (optional — paste full agent JSON)
          </label>
          <textarea
            style={{ ...inputStyle, height: 150, fontFamily: "monospace", fontSize: 12 }}
            value={agentJson}
            onChange={(e) => setAgentJson(e.target.value)}
            placeholder='Paste the agent JSON here...'
          />
        </div>

        <div style={{ marginBottom: 24 }}>
          <label style={{ fontSize: 14, color: "#aaa", cursor: "pointer" }}>
            <input type="checkbox" checked={useCriteria} onChange={(e) => setUseCriteria(e.target.checked)} style={{ marginRight: 8 }} />
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
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          {saving ? "Creating..." : "Create Project"}
        </button>
      </form>
    </div>
  );
}
