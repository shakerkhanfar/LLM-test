import { lazy, Suspense, useState } from "react";
import { REAL_WORKFLOW_NODES, REAL_WORKFLOW_EDGES } from "./previewData";

const WorkflowCanvas = lazy(() => import("../components/WorkflowCanvas"));

// ─── Mock Data ─────────────────────────────────────────────────────

const MOCK_LAYERED_EVAL = {
  summary: "The call failed to achieve its objective due to the agent answering out-of-scope questions and getting stuck in a loop. The agent handled the greeting well but skipped patient identification, mentioned the year (prohibited), and did not transition to the appointment slot selection node. Two critical node transition failures were observed.",
  overallScore: 3.8,
  objectiveAchieved: false,
  callerSentiment: "neutral",
  navigation: {
    score: 7,
    issues: [
      { type: "stuck", nodeLabel: "Specialty Selection", detail: "Agent spent 4 unnecessary turns on this node asking about doctor preference instead of transitioning.", severity: "critical" },
      { type: "dead_end", nodeLabel: "Doctor Selection", detail: "Call ended on this node without reaching the end_call node.", severity: "warning" },
      { type: "loop", nodeLabel: "Conversation", detail: "Node was visited twice — may indicate a retry or correction.", severity: "info" },
    ],
  },
  perNode: [
    {
      nodeLabel: "Start Node (Greeting)",
      nodeType: "start",
      instructionAdherence: {
        score: 3,
        followed: ["Greeted the caller with the exact required phrase"],
        violated: ["Did not transition immediately after user response", "Answered out-of-scope question about hospital location", "Collected information not allowed at this node"],
        evidence: "Agent provided hospital address and operating hours instead of routing.",
      },
      transitionCorrectness: { score: 2, correct: false, reasoning: "Should have transitioned to booking flow immediately but stayed and answered location questions." },
      offTopic: { detected: true, turns: ["Agent provided hospital location, hours, and directions — all out of scope."] },
      hallucination: { detected: true, evidence: "Provided specific hospital address, neighborhood, and operating hours not present in instructions." },
      stuck: { detected: true, unnecessaryTurns: 2, reasoning: "Agent should have transitioned after user's first response." },
      overallNodeScore: 2,
    },
    {
      nodeLabel: "Specialty Selection",
      nodeType: "conversation",
      instructionAdherence: {
        score: 6,
        followed: ["Asked about doctor preference", "Used correct specialty mapping"],
        violated: ["Asked follow-up questions after user answered", "Did not transition immediately after specialty confirmation"],
        evidence: "Agent asked about doctor preference multiple times.",
      },
      transitionCorrectness: { score: 5, correct: false, reasoning: "Transition was delayed by unnecessary follow-up questions." },
      offTopic: { detected: false, turns: [] },
      hallucination: { detected: false, evidence: "" },
      stuck: { detected: true, unnecessaryTurns: 1, reasoning: "Asked doctor preference twice." },
      overallNodeScore: 5,
    },
    {
      nodeLabel: "Doctor Selection",
      nodeType: "conversation",
      instructionAdherence: {
        score: 7,
        followed: ["Used physicians from the API response", "Offered to book with first available"],
        violated: ["Mentioned the year 2026 to the user (prohibited)"],
        evidence: "Agent said 'اثنين وعشرين أبريل ألفين وستة وعشرين' — year should not be mentioned.",
      },
      transitionCorrectness: { score: 3, correct: false, reasoning: "Should have transitioned to appointment slot node but call ended." },
      offTopic: { detected: false, turns: [] },
      hallucination: { detected: false, evidence: "" },
      stuck: { detected: false, unnecessaryTurns: 0, reasoning: "" },
      overallNodeScore: 6,
    },
    {
      nodeLabel: "Get Specialties",
      nodeType: "tool",
      instructionAdherence: {
        score: 10,
        followed: ["Tool called correctly with proper parameters"],
        violated: [],
        evidence: "API returned 32 specialties successfully.",
      },
      transitionCorrectness: { score: 10, correct: true, reasoning: "Transitioned correctly on success." },
      offTopic: { detected: false, turns: [] },
      hallucination: { detected: false, evidence: "" },
      stuck: { detected: false, unnecessaryTurns: 0, reasoning: "" },
      overallNodeScore: 10,
    },
    {
      nodeLabel: "Get Physicians",
      nodeType: "tool",
      instructionAdherence: {
        score: 10,
        followed: ["Tool called with correct specialty ID (130)"],
        violated: [],
        evidence: "API returned 13 physicians for General Surgery.",
      },
      transitionCorrectness: { score: 10, correct: true, reasoning: "Transitioned correctly on success." },
      offTopic: { detected: false, turns: [] },
      hallucination: { detected: false, evidence: "" },
      stuck: { detected: false, unnecessaryTurns: 0, reasoning: "" },
      overallNodeScore: 10,
    },
  ],
  efficiency: { score: 3, reasoning: "The call was inefficient with unnecessary turns, out-of-scope answers, and repeated questions. Agent got stuck without completing the booking." },
  criticalIssues: [
    "Agent answered out-of-scope questions (hospital location, hours, directions)",
    "Skipped required patient identification step before discussing appointments",
    "Mentioned the year 2026 to the user, violating instructions",
    "Call ended without reaching an end node — dead end",
  ],
  improvements: [
    "Strictly adhere to the flow: transition immediately after user responds at the greeting node",
    "Never answer questions about hospital details — redirect to the booking flow",
    "Always verify patient identity (ID/phone) before discussing appointment options",
    "Never mention the year when reading dates to the user",
    "Ensure conversation reaches a proper end_call node",
  ],
};

const MOCK_METADATA = {
  layer2Score: 7,
  layer3Avg: 6.6,
  layer4Score: 3.8,
  nodesEvaluated: 5,
  navigationIssues: 3,
};

// Real workflow nodes/edges from the Hamsa agent (80 nodes, 128 edges with real positions)
// Simulated visited nodes: the booking flow path that was actually taken in the call
const REAL_VISITED = new Set([
  "bgUbMDsuDRR5uHi5WYYLO", // Start Node
  "4HqTkjaMDrTCVZf26ntTV", // Get Specialties (tool)
  "CBvahOevz1Rqx2cPA2TgQ", // Specialty Selection
  "YYsR_hgqdyBNyQSAUQwva", // Get Physicians (tool)
  "YoxkneazioSIsF-YxVJd9", // Doctor Selection
]);
const REAL_STUCK_NODE = "YoxkneazioSIsF-YxVJd9"; // Stuck at Doctor Selection

const REAL_EXTRACTED_VARS = [
  { name: "language_code", value: "AR" },
  { name: "intention", value: "speciality" },
  { name: "doctor_name", value: "not mentioned" },
  { name: "specialities", value: "[32 specialties]" },
  { name: "speciality_id_extracted", value: "130" },
  { name: "physicians", value: "[13 physicians]" },
];

const REAL_TOOL_CALLS = [
  { name: "Get Specialties", nodeId: "4HqTkjaMDrTCVZf26ntTV" },
  { name: "Get Physicians", nodeId: "YYsR_hgqdyBNyQSAUQwva" },
];

// ─── Reusable Components (copied from RunDetail for preview) ──────

function CollapsibleSection({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "#1a1a1a", border: "1px solid #333", borderRadius: 6,
          padding: "8px 14px", color: "#ccc", cursor: "pointer", fontSize: 13,
          width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between",
        }}
      >
        <span>{title}</span>
        <span style={{ color: "#555" }}>{open ? "\u25B2" : "\u25BC"}</span>
      </button>
      {open && <div style={{ padding: "12px 0" }}>{children}</div>}
    </div>
  );
}

const NODE_TYPE_COLORS: Record<string, string> = {
  start: "#22c55e",
  conversation: "#3b82f6",
  tool: "#f59e0b",
  router: "#a855f7",
  end_call: "#ef4444",
};

// ─── Preview Page ──────────────────────────────────────────────────

export default function Preview() {
  const parsed = MOCK_LAYERED_EVAL;
  const meta = MOCK_METADATA;
  const navIssues = parsed.navigation.issues;
  const perNode = parsed.perNode;
  const criticalIssues = parsed.criticalIssues;
  const improvements = parsed.improvements;
  const navScore = parsed.navigation.score;
  const layer3Avg = meta.layer3Avg;
  const layer4Score = meta.layer4Score;

  const severityColors: Record<string, string> = { critical: "#ef4444", warning: "#f59e0b", info: "#888" };
  const issueTypeLabels: Record<string, string> = {
    stuck: "Stuck", loop: "Loop", wrong_transition: "Wrong Transition",
    skipped_node: "Skipped Node", backward_jump: "Backward Jump", dead_end: "Dead End",
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 20px", color: "#e5e7eb" }}>
      <h1 style={{ marginBottom: 24 }}>UI Preview — Layered Evaluation + Flow Graph</h1>

      {/* ═══ SECTION 1: Layered Node Evaluation ═══ */}
      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Layered Node Evaluation</h2>

        {/* Summary narrative */}
        <div style={{
          background: "#ef44440a",
          border: "1px solid #ef444433",
          borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13, lineHeight: 1.6, color: "#ccc",
        }}>
          {parsed.summary}
        </div>

        {/* Layer score bars */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
          {[
            { label: "Navigation (Layer 2)", score: navScore, weight: "30%" },
            { label: "Per-Node Behavior (Layer 3)", score: layer3Avg, weight: "50%" },
            { label: "Overall Quality (Layer 4)", score: layer4Score, weight: "20%" },
          ].map((layer) => {
            const pct = layer.score != null ? Math.round((layer.score / 10) * 100) : null;
            const color = pct == null ? "#555" : pct >= 80 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";
            return (
              <div key={layer.label} style={{
                display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                background: "#111", borderRadius: 6, border: "1px solid #222",
              }}>
                <div style={{ width: 200, fontSize: 13, fontWeight: 500 }}>
                  {layer.label}
                  <span style={{ fontSize: 10, color: "#555", marginLeft: 6 }}>{layer.weight}</span>
                </div>
                <div style={{ flex: 1, height: 8, background: "#222", borderRadius: 4, overflow: "hidden" }}>
                  {pct != null && (
                    <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4, transition: "width 0.3s" }} />
                  )}
                </div>
                <div style={{ width: 50, textAlign: "right", fontSize: 14, fontWeight: 700, color }}>
                  {pct != null ? `${pct}%` : "N/A"}
                </div>
              </div>
            );
          })}
        </div>

        {/* Quick stats */}
        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{
            background: "#ef444412",
            padding: "8px 14px", borderRadius: 6,
            border: "1px solid #ef444433", fontSize: 13,
          }}>
            <span style={{ color: "#888" }}>Objective: </span>
            <strong style={{ color: "#ef4444" }}>Not Achieved</strong>
          </div>
          <div style={{ background: "#1a1a1a", padding: "8px 14px", borderRadius: 6, border: "1px solid #222", fontSize: 13 }}>
            <span style={{ color: "#888" }}>Sentiment: </span>
            <strong style={{ color: "#e5e7eb" }}>{parsed.callerSentiment}</strong>
          </div>
          <div style={{ background: "#1a1a1a", padding: "8px 14px", borderRadius: 6, border: "1px solid #222", fontSize: 13 }}>
            <span style={{ color: "#888" }}>Efficiency: </span>
            <strong style={{ color: "#ef4444" }}>{parsed.efficiency.score}/10</strong>
          </div>
          <div style={{ background: "#1a1a1a", padding: "8px 14px", borderRadius: 6, border: "1px solid #222", fontSize: 13 }}>
            <span style={{ color: "#888" }}>Nodes Evaluated: </span>
            <strong>{meta.nodesEvaluated}</strong>
          </div>
        </div>

        {/* Efficiency reasoning */}
        <div style={{
          padding: "10px 14px", background: "#0a0a0a", borderRadius: 6,
          border: "1px solid #1a1a1a", fontSize: 12, color: "#aaa", marginBottom: 16, lineHeight: 1.5,
        }}>
          {parsed.efficiency.reasoning}
        </div>

        {/* Critical Issues */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: "#ef4444", fontWeight: 600, marginBottom: 8 }}>Critical Issues</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {criticalIssues.map((issue, i) => (
              <div key={i} style={{
                padding: "8px 12px", background: "#ef44440a", borderRadius: 6,
                border: "1px solid #ef444422", borderLeft: "3px solid #ef4444",
                fontSize: 13, color: "#ccc", lineHeight: 1.5,
              }}>
                {issue}
              </div>
            ))}
          </div>
        </div>

        {/* Navigation Issues */}
        <CollapsibleSection title={`Navigation Issues (${navIssues.length})`} defaultOpen={true}>
          {navIssues.map((issue: any, i: number) => (
            <div key={i} style={{
              background: "#0a0a0a", padding: 12, borderRadius: 6, marginBottom: 8,
              border: `1px solid ${severityColors[issue.severity] || "#222"}33`,
              borderLeft: `3px solid ${severityColors[issue.severity] || "#888"}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{
                  fontSize: 10, textTransform: "uppercase", fontWeight: 600,
                  color: severityColors[issue.severity],
                  padding: "1px 6px", borderRadius: 3,
                  background: `${severityColors[issue.severity]}18`,
                }}>
                  {issue.severity}
                </span>
                <span style={{
                  fontSize: 11, color: "#888", padding: "1px 6px", borderRadius: 3,
                  background: "#1a1a1a", border: "1px solid #333",
                }}>
                  {issueTypeLabels[issue.type] || issue.type}
                </span>
                <span style={{ fontSize: 13, fontWeight: 500, color: "#e5e7eb" }}>
                  {issue.nodeLabel}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "#aaa", lineHeight: 1.5 }}>
                {issue.detail}
              </div>
            </div>
          ))}
        </CollapsibleSection>

        {/* Per-Node Results */}
        <CollapsibleSection title={`Per-Node Results (${perNode.length} nodes)`} defaultOpen={true}>
          {perNode.map((node: any, i: number) => {
            const nodeScore = node.overallNodeScore;
            const scoreColor = nodeScore >= 8 ? "#22c55e" : nodeScore >= 5 ? "#f59e0b" : "#ef4444";
            const hasIssues = node.offTopic?.detected || node.hallucination?.detected || node.stuck?.detected
              || !node.transitionCorrectness?.correct
              || (node.instructionAdherence?.violated?.length > 0);

            return (
              <div key={i} style={{
                background: "#0a0a0a", borderRadius: 6, marginBottom: 8, overflow: "hidden",
                border: `1px solid ${hasIssues ? "#f59e0b33" : "#1a1a1a"}`,
              }}>
                {/* Node header */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 13, fontWeight: 700,
                    background: `${scoreColor}18`, color: scoreColor,
                    border: `1px solid ${scoreColor}44`,
                  }}>
                    {nodeScore}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#e5e7eb" }}>
                      {node.nodeLabel}
                      <span style={{
                        fontSize: 10, marginLeft: 8, padding: "1px 6px", borderRadius: 3,
                        background: `${NODE_TYPE_COLORS[node.nodeType] || "#888"}22`,
                        color: NODE_TYPE_COLORS[node.nodeType] || "#888",
                        border: `1px solid ${NODE_TYPE_COLORS[node.nodeType] || "#888"}44`,
                      }}>
                        {node.nodeType}
                      </span>
                    </div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: scoreColor }}>
                    {nodeScore}/10
                  </div>
                </div>

                {/* Node details */}
                <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                  {/* Instruction adherence */}
                  {node.instructionAdherence && (
                    <div style={{ fontSize: 12 }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                        <span style={{ color: "#888" }}>Instructions ({node.instructionAdherence.score}/10):</span>
                        {node.instructionAdherence.followed?.length > 0 && (
                          <span style={{ color: "#22c55e" }}>{node.instructionAdherence.followed.length} followed</span>
                        )}
                        {node.instructionAdherence.violated?.length > 0 && (
                          <span style={{ color: "#ef4444" }}>{node.instructionAdherence.violated.length} violated</span>
                        )}
                      </div>
                      {node.instructionAdherence.violated?.length > 0 && (
                        <div style={{ marginLeft: 12 }}>
                          {node.instructionAdherence.violated.map((v: string, vi: number) => (
                            <div key={vi} style={{ color: "#ef4444", fontSize: 11, lineHeight: 1.5 }}>- {v}</div>
                          ))}
                        </div>
                      )}
                      {node.instructionAdherence.evidence && (
                        <div style={{ color: "#666", fontSize: 11, marginTop: 2, fontStyle: "italic" }}>{node.instructionAdherence.evidence}</div>
                      )}
                    </div>
                  )}

                  {/* Transition correctness */}
                  {node.transitionCorrectness && (
                    <div style={{ fontSize: 12 }}>
                      <span style={{ color: "#888" }}>Transition: </span>
                      <span style={{ color: node.transitionCorrectness.correct ? "#22c55e" : "#ef4444" }}>
                        {node.transitionCorrectness.correct ? "Correct" : "Incorrect"}
                      </span>
                      <span style={{ color: "#555", marginLeft: 6 }}>({node.transitionCorrectness.score}/10)</span>
                      {node.transitionCorrectness.reasoning && !node.transitionCorrectness.correct && (
                        <div style={{ color: "#aaa", fontSize: 11, marginTop: 2, marginLeft: 12 }}>{node.transitionCorrectness.reasoning}</div>
                      )}
                    </div>
                  )}

                  {/* Detection flags */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {node.hallucination?.detected && (
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "#ec489922", color: "#ec4899", border: "1px solid #ec489944" }}>
                        Hallucination detected
                      </span>
                    )}
                    {node.offTopic?.detected && (
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "#f59e0b22", color: "#f59e0b", border: "1px solid #f59e0b44" }}>
                        Off-topic ({node.offTopic.turns?.length || 0} turns)
                      </span>
                    )}
                    {node.stuck?.detected && (
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "#ef444422", color: "#ef4444", border: "1px solid #ef444444" }}>
                        Stuck ({node.stuck.unnecessaryTurns} unnecessary turns)
                      </span>
                    )}
                    {!node.hallucination?.detected && !node.offTopic?.detected && !node.stuck?.detected && node.transitionCorrectness?.correct && (
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "#22c55e12", color: "#22c55e", border: "1px solid #22c55e33" }}>
                        Clean
                      </span>
                    )}
                  </div>

                  {node.hallucination?.detected && node.hallucination.evidence && (
                    <div style={{ fontSize: 11, color: "#ec4899", marginLeft: 12, lineHeight: 1.5 }}>{node.hallucination.evidence}</div>
                  )}
                  {node.stuck?.detected && node.stuck.reasoning && (
                    <div style={{ fontSize: 11, color: "#aaa", marginLeft: 12, lineHeight: 1.5 }}>{node.stuck.reasoning}</div>
                  )}
                </div>
              </div>
            );
          })}
        </CollapsibleSection>

        {/* Improvements */}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>Recommendations</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {improvements.map((rec, i) => (
              <div key={i} style={{
                display: "flex", gap: 10, alignItems: "flex-start",
                fontSize: 13, padding: "8px 12px", background: "#0a0a0a",
                borderRadius: 6, border: "1px solid #1a1a1a",
              }}>
                <span style={{ color: "#2563eb", fontWeight: 700, minWidth: 20 }}>#{i + 1}</span>
                <span style={{ color: "#ccc" }}>{rec}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ═══ SECTION 2: Flow Progression Graph ═══ */}
      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Flow Progression (Graph View)</h2>
        <Suspense fallback={<div style={{ height: 500, background: "#0a0a0a", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "#555" }}>Loading...</div>}>
          <WorkflowCanvas
            workflowNodes={REAL_WORKFLOW_NODES}
            workflowEdges={REAL_WORKFLOW_EDGES}
            visitedNodeIds={REAL_VISITED}
            stuckNodeId={REAL_STUCK_NODE}
            extractedVars={REAL_EXTRACTED_VARS}
            toolCalls={REAL_TOOL_CALLS}
          />
        </Suspense>

        {/* Summary bar */}
        <div style={{
          marginTop: 12, padding: "8px 12px", background: "#0a0a0a",
          borderRadius: 6, fontSize: 12, color: "#888",
          display: "flex", gap: 16, flexWrap: "wrap",
        }}>
          <span>Nodes reached: <strong style={{ color: "#fff" }}>{REAL_VISITED.size}/{REAL_WORKFLOW_NODES.length}</strong></span>
          <span>Variables: <strong style={{ color: "#fff" }}>{REAL_EXTRACTED_VARS.length}</strong></span>
          <span>Tools: <strong style={{ color: "#fff" }}>{REAL_TOOL_CALLS.length}</strong></span>
          <span style={{ color: "#ef4444" }}>Stuck at: Doctor Selection</span>
        </div>
      </div>
    </div>
  );
}
