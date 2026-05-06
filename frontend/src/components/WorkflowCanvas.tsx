import { useMemo, useCallback, useState } from "react";
import T from "../theme";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// ─── Types ─────────────────────────────────────────────────────────

interface WorkflowCanvasProps {
  workflowNodes: any[];
  workflowEdges: any[];
  visitedNodeIds: Set<string>;
  stuckNodeId?: string;
  extractedVars: Array<{ name: string; value: string }>;
  toolCalls: Array<{ name: string; nodeId: string }>;
  /** ID of the node currently active during audio playback. Null when not playing. */
  activeNodeId?: string | null;
  /** True while the call recording is playing — triggers playback-mode highlighting. */
  isPlaying?: boolean;
}

// ─── Node type config ───────────────────────────────────────────────

const NODE_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  start: {
    color: "#22c55e",
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="5 3 19 12 5 21 5 3" />
      </svg>
    ),
  },
  conversation: {
    // Hamsa uses indigo for conversation nodes
    color: "#6366f1",
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
      </svg>
    ),
  },
  tool: {
    // Hamsa uses orange for tool nodes
    color: "#f97316",
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
    ),
  },
  router: {
    // Hamsa uses violet/purple for router nodes
    color: "#8b5cf6",
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 3h5v5" /><path d="M8 3H3v5" /><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" /><path d="m15 9 6-6" />
      </svg>
    ),
  },
  end_call: {
    color: "#ef4444",
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A2 2 0 0 1 10 17" />
        <path d="m22 2-10 10" /><path d="M2 2l20 20" />
      </svg>
    ),
  },
  end: {
    color: "#ef4444",
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6" /><path d="M9 9l6 6" />
      </svg>
    ),
  },
  set_local_variables: {
    color: "#6b7280",
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" /><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
      </svg>
    ),
  },
};

const FALLBACK_CONFIG = {
  color: "#9ca3af",
  icon: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="white" strokeWidth="2"><circle cx="12" cy="12" r="10" /></svg>,
};

const SparkleIcon = () => (
  <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
  </svg>
);

// ─── Custom Node ────────────────────────────────────────────────────

function AgentNode({ id: nodeId, data }: NodeProps) {
  const cfg = NODE_CONFIG[data.nodeType as string] ?? FALLBACK_CONFIG;
  const visited = data.visited as boolean;
  const stuck = data.stuck as boolean;
  const isActive = data.isActive as boolean;   // currently playing node
  const isPlaying = data.isPlaying as boolean; // audio is playing
  const transitions = (data.transitions as any[]) ?? [];
  const varNames = (data.extractedVarNames as string[]) ?? [];
  const message = (data.message as string) ?? "";
  const tools = (data.tools as any[]) ?? [];
  const nodeType = data.nodeType as string;

  const isToolNode = nodeType === "tool";
  const hasPrompt = !!message && !isToolNode;
  const truncatedMsg = message.slice(0, 160) + (message.length > 160 ? "…" : "");

  // During playback: active node gets a pulsing colored border; others dim.
  // When not playing: revert to visited/stuck/default coloring.
  const borderColor = isActive
    ? cfg.color
    : stuck ? "#ef4444"
    : visited ? "#22c55e"
    : "#e5e7eb";

  const cardShadow = isActive
    ? `0 0 0 2.5px ${cfg.color}, 0 4px 20px ${cfg.color}44`
    : stuck
    ? "0 0 0 2px #fecaca, 0 4px 16px rgba(239,68,68,0.12)"
    : visited
    ? "0 0 0 1.5px #bbf7d0, 0 4px 16px rgba(34,197,94,0.08)"
    : "0 1px 3px rgba(0,0,0,0.07), 0 4px 12px rgba(0,0,0,0.05)";

  // Dim non-active nodes during playback
  const nodeOpacity = isPlaying && !isActive ? 0.4 : 1;

  return (
    <div
      style={{
        background: "#ffffff",
        border: `1.5px solid ${borderColor}`,
        borderRadius: 14,
        width: 310,
        boxShadow: cardShadow,
        overflow: "visible", // important: handles need to bleed outside
        fontFamily: "system-ui, -apple-system, sans-serif",
        opacity: nodeOpacity,
        transition: "opacity 0.3s ease, box-shadow 0.3s ease, border-color 0.3s ease",
        animation: isActive ? "node-pulse 1.8s ease-in-out infinite" : "none",
      }}
    >
      {/* Target handle — ID must match edge targetHandle format: "target-handle-{nodeId}" */}
      <Handle
        type="target"
        id={`target-handle-${nodeId}`}
        position={Position.Left}
        style={{ background: "#d1d5db", border: "2px solid #fff", width: 10, height: 10, left: -5 }}
      />

      {/* ── Header — pure white, matches Hamsa exactly ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 12px 9px",
        borderBottom: "1px solid #f3f4f6",
        background: "#ffffff",
        borderRadius: "14px 14px 0 0",
      }}>
        {/* Colored icon pill — matches Hamsa's rounded square icon */}
        <div style={{
          width: 30, height: 30, borderRadius: 9, flexShrink: 0,
          background: cfg.color,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: `0 2px 8px ${cfg.color}44`,
        }}>
          {cfg.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Title: capitalize like Hamsa ("Conversation", "Tool", "Router") */}
          <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.3 }}>
            {(data.label as string) || nodeType.charAt(0).toUpperCase() + nodeType.slice(1).replace(/_/g, " ")}
          </div>
          <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 1 }}>
            {nodeType.replace(/_/g, " ")}
          </div>
        </div>
        {/* Status indicator — right side */}
        {isActive ? (
          <span style={{
            fontSize: 9, padding: "2px 7px", borderRadius: 4, fontWeight: 700,
            background: cfg.color + "22", color: cfg.color,
            border: `1px solid ${cfg.color}66`, flexShrink: 0, letterSpacing: "0.04em",
          }}>
            ● NOW
          </span>
        ) : stuck ? (
          <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 4, fontWeight: 700, background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca", flexShrink: 0, letterSpacing: "0.04em" }}>
            STUCK
          </span>
        ) : visited ? (
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 0 2.5px #dcfce7", flexShrink: 0 }} />
        ) : (
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#e2e8f0", flexShrink: 0 }} />
        )}
      </div>

      {/* ── Body ── */}
      <div style={{ padding: "9px 12px 10px" }}>

        {/* Tool node: tool name + FUNCTION badge — matches Hamsa's green pill */}
        {isToolNode && (
          <div style={{ marginBottom: 8 }}>
            {tools.length > 0 ? tools.map((tool: any, i: number) => (
              <div key={i} style={{ marginBottom: i < tools.length - 1 ? 8 : 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a", marginBottom: 4 }}>
                  {tool.name || tool.displayName || tool.functionName || "Tool"}
                </div>
                {/* Hamsa shows the tool name again in smaller text before the badge */}
                <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>
                  {tool.name || tool.displayName || tool.functionName || ""}
                </div>
                <span style={{
                  display: "inline-block",
                  fontSize: 10, padding: "2px 8px", borderRadius: 5,
                  background: "#4ade8022", color: "#16a34a",
                  border: "1px solid #4ade8066", fontWeight: 700,
                  letterSpacing: "0.03em",
                }}>
                  FUNCTION
                </span>
              </div>
            )) : (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a", marginBottom: 4 }}>Tool</div>
                <span style={{ display: "inline-block", fontSize: 10, padding: "2px 8px", borderRadius: 5, background: "#4ade8022", color: "#16a34a", border: "1px solid #4ade8066", fontWeight: 700 }}>
                  FUNCTION
                </span>
              </div>
            )}
          </div>
        )}

        {/* Router node: show description text like Hamsa */}
        {nodeType === "router" && !isToolNode && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10.5, color: "#64748b", lineHeight: 1.5 }}>
              {message || (data.description as string) || "Logic splitting node with conditional routing"}
            </div>
          </div>
        )}

        {/* Prompt preview */}
        {hasPrompt && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 9, color: "#9ca3af", marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 4 }}>
              <svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m18 16 4-4-4-4" /><path d="m6 8-4 4 4 4" /><path d="m14.5 4-5 16" />
              </svg>
              Prompt
              <span style={{ fontWeight: 400, color: "#d1d5db", fontSize: 9 }}>
                {message.includes("{%") || message.includes("{{") ? "· Advanced Template" : "· Static"}
              </span>
            </div>
            <div style={{
              fontSize: 9.5, color: "#6b7280", lineHeight: 1.55,
              background: "#f9fafb", border: "1px solid #f3f4f6",
              borderRadius: 6, padding: "5px 8px",
              fontFamily: "ui-monospace, 'Cascadia Code', monospace",
              overflow: "hidden", maxHeight: 64,
              whiteSpace: "pre-wrap", wordBreak: "break-word",
              display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical",
            }}>
              {truncatedMsg}
            </div>
          </div>
        )}

        {/* Extracting vars */}
        {varNames.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 9, color: "#9ca3af", marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Extracting:
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
              {varNames.map((v: string) => (
                <span key={v} style={{
                  fontSize: 9, padding: "1px 6px", borderRadius: 4,
                  background: "#eff6ff", color: "#3b82f6",
                  border: "1px solid #bfdbfe", fontWeight: 500,
                }}>
                  {v}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Transitions — each row has its own source handle */}
        {transitions.length > 0 && (
          <div>
            <div style={{ fontSize: 9, color: "#9ca3af", marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Transitions
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {transitions.map((t: any, i: number) => {
                const label = t.condition?.description || t.condition?.prompt || t.condition?.type || "auto";
                // Issue #14: only render a handle when t.id is present — index fallback
                // would never match any edge's "transition-{uuid}" sourceHandle.
                const handleId = t.id ? `transition-${t.id}` : null;
                return (
                  <div key={i} style={{ position: "relative", marginRight: 14 }}>
                    <div style={{
                      display: "flex", alignItems: "flex-start", gap: 5,
                      padding: "4px 7px",
                      borderRadius: 6,
                      background: "#f9fafb", border: "1px solid #f3f4f6",
                    }}>
                      <SparkleIcon />
                      <span style={{ fontSize: 10, color: "#374151", flex: 1, lineHeight: 1.45, wordBreak: "break-word" }}>
                        {label}
                      </span>
                    </div>
                    {/* Source handle positioned at the right edge — React Flow measures
                        its DOM position relative to the node bounding box.
                        Only render when handleId is known; without an id, React Flow
                        cannot match this handle to any edge's sourceHandle. */}
                    {handleId && (
                      <Handle
                        type="source"
                        id={handleId}
                        position={Position.Right}
                        style={{
                          width: 9, height: 9,
                          background: cfg.color,
                          border: "2px solid #fff",
                          boxShadow: `0 0 0 1.5px ${cfg.color}`,
                          right: -18,
                          top: "50%",
                          transform: "translateY(-50%)",
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Fallback source handle for nodes with no transitions (issue #13).
            Uses id="source-default" so edges whose sourceHandle is absent/null
            can still connect — the edge mapper nulls out sourceHandle for these nodes. */}
        {transitions.length === 0 && (
          <Handle
            type="source"
            id="source-default"
            position={Position.Right}
            style={{ background: cfg.color, border: "2px solid #fff", width: 10, height: 10, right: -5 }}
          />
        )}
      </div>
    </div>
  );
}

const nodeTypes = { agentNode: AgentNode };

// ─── Inner component ──────────────────────────────────────────────

function WorkflowCanvasInner({
  workflowNodes,
  workflowEdges,
  visitedNodeIds,
  stuckNodeId,
  extractedVars,
  toolCalls,
  activeNodeId,
  isPlaying,
}: WorkflowCanvasProps) {
  const [selectedNode, setSelectedNode] = useState<any>(null);

  const rfNodes: Node[] = useMemo(() => {
    return workflowNodes.map((n: any) => ({
      id: n.id,
      type: "agentNode",
      position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
      data: {
        label: n.label || n.type,
        nodeType: n.type,
        visited: visitedNodeIds.has(n.id),
        stuck: n.id === stuckNodeId,
        extractedVarNames: n.extractVariables?.variables?.map((v: any) => v.name) || [],
        message: n.message || "",
        transitions: n.transitions || [],
        tools: n.tools || [],
        // Playback-mode highlighting
        isActive: isPlaying && activeNodeId === n.id,
        isPlaying: !!isPlaying,
      },
    }));
  }, [workflowNodes, visitedNodeIds, stuckNodeId, activeNodeId, isPlaying]);

  const rfEdges: Edge[] = useMemo(() => {
    // Build a set of node IDs that have no transitions — their fallback handle
    // uses id="source-default" so we must not pass a sourceHandle (issue #13).
    const noTransitionNodeIds = new Set(
      workflowNodes.filter((n: any) => !n.transitions?.length).map((n: any) => n.id)
    );

    return workflowEdges.map((e: any) => {
      const sourceVisited = visitedNodeIds.has(e.source);
      const targetVisited = visitedNodeIds.has(e.target);
      const isActive = sourceVisited && targetVisited;

      // If the source node has no per-transition handles, don't specify a sourceHandle
      // so React Flow uses the single default source handle on that node.
      const sourceHandle = noTransitionNodeIds.has(e.source)
        ? undefined
        : (e.sourceHandle ?? undefined);

      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle,
        targetHandle: e.targetHandle ?? undefined,
        type: "smoothstep",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: isActive ? "#16a34a" : "#475569",
        },
        style: {
          stroke: isActive ? "#16a34a" : "#475569",
          strokeWidth: isActive ? 3 : 2,
        },
        animated: isActive,
      };
    });
  }, [workflowEdges, visitedNodeIds]);

  const onNodeClick = useCallback((_: any, node: Node) => {
    const original = workflowNodes.find((n: any) => n.id === node.id);
    setSelectedNode(original);
  }, [workflowNodes]);

  const onPaneClick = useCallback(() => setSelectedNode(null), []);

  const selectedNodeVars = useMemo(() => {
    if (!selectedNode) return [];
    const nodeVarNames = selectedNode.extractVariables?.variables?.map((v: any) => v.name) || [];
    return extractedVars.filter((v) => nodeVarNames.includes(v.name));
  }, [selectedNode, extractedVars]);

  const selectedNodeTools = useMemo(() => {
    if (!selectedNode) return [];
    return toolCalls.filter((t) => t.nodeId === selectedNode.id);
  }, [selectedNode, toolCalls]);

  const panelCfg = selectedNode ? (NODE_CONFIG[selectedNode.type] ?? FALLBACK_CONFIG) : FALLBACK_CONFIG;

  return (
    <div
      style={{ position: "relative", width: "100%", height: 520, borderRadius: 10, overflow: "hidden", border: `1px solid ${T.border}` }}
      className="light-flow"
    >
      <style>{`
        .light-flow .react-flow__controls { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .light-flow .react-flow__controls button { background: #fff; border-bottom: 1px solid #f3f4f6; color: #6b7280; fill: #6b7280; }
        .light-flow .react-flow__controls button:hover { background: #f9fafb; }
        .light-flow .react-flow__minimap { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .light-flow .react-flow__edge-path { transition: stroke 0.2s ease, stroke-width 0.2s ease; }
        .light-flow .react-flow__edge:hover .react-flow__edge-path { stroke-width: 4 !important; }
        .light-flow .react-flow__handle { cursor: default !important; }
        .light-flow .react-flow__edge-interaction { stroke-width: 14; }
        .light-flow .react-flow__node { overflow: visible !important; }
        @keyframes node-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.015); }
        }
      `}</style>

      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.02}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        style={{ background: "#f8f9fa" }}
      >
        <Background color="#e5e7eb" gap={40} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(node) => {
            if (node.data?.stuck) return "#ef4444";
            if (node.data?.visited) return "#22c55e";
            return "#e5e7eb";
          }}
          maskColor="rgba(248,249,250,0.7)"
          style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8 }}
        />
      </ReactFlow>

      {/* ── Node detail panel ── */}
      {selectedNode && (
        <div
          style={{
            position: "absolute", top: 12, right: 12,
            width: 300, maxHeight: 490, overflow: "auto",
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            borderRadius: 12, zIndex: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          }}
        >
          {/* Panel header */}
          <div style={{
            display: "flex", alignItems: "center", gap: 9,
            padding: "10px 12px",
            borderBottom: "1px solid #f3f4f6",
            background: "#fafafa",
            borderRadius: "12px 12px 0 0",
          }}>
            <div style={{
              width: 26, height: 26, borderRadius: 7, flexShrink: 0,
              background: panelCfg.color,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {panelCfg.icon}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selectedNode.label || selectedNode.type}
              </div>
              <div style={{ fontSize: 10, color: panelCfg.color, fontWeight: 500 }}>
                {(selectedNode.type as string).replace(/_/g, " ")}
              </div>
            </div>
            <button
              onClick={() => setSelectedNode(null)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", padding: 4, borderRadius: 6, lineHeight: 1, fontSize: 16 }}
            >
              ×
            </button>
          </div>

          <div style={{ padding: "12px 14px" }}>
            {/* Status */}
            <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
              {visitedNodeIds.has(selectedNode.id) && (
                <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "#f0fdf4", color: "#22c55e", border: "1px solid #bbf7d0" }}>Visited</span>
              )}
              {selectedNode.id === stuckNodeId && (
                <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca", fontWeight: 600 }}>Stuck Here</span>
              )}
            </div>

            {/* Extracted vars with values */}
            {selectedNodeVars.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Extracted Variables</div>
                {selectedNodeVars.map((v, i) => (
                  <div key={i} style={{ display: "flex", gap: 6, fontSize: 11, marginBottom: 3, padding: "3px 8px", borderRadius: 5, background: "#f0fdf4", border: "1px solid #dcfce7" }}>
                    <span style={{ color: "#16a34a", fontWeight: 600 }}>{v.name}</span>
                    <span style={{ color: "#9ca3af" }}>=</span>
                    <span style={{ color: "#374151" }}>"{v.value}"</span>
                  </div>
                ))}
              </div>
            )}

            {/* Tool calls */}
            {selectedNodeTools.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Tool Calls</div>
                {selectedNodeTools.map((t, i) => (
                  <div key={i} style={{ fontSize: 11, color: "#92400e", padding: "3px 8px", borderRadius: 5, background: "#fffbeb", border: "1px solid #fde68a", marginBottom: 3 }}>
                    {t.name}
                  </div>
                ))}
              </div>
            )}

            {/* Transitions */}
            {selectedNode.transitions?.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Transitions ({selectedNode.transitions.length})
                </div>
                {selectedNode.transitions.map((t: any, i: number) => (
                  <div key={i} style={{ fontSize: 11, color: "#374151", padding: "4px 8px", borderRadius: 6, background: "#f9fafb", border: "1px solid #f3f4f6", marginBottom: 3, lineHeight: 1.4 }}>
                    {t.condition?.description || t.condition?.prompt || t.condition?.type || "auto"}
                  </div>
                ))}
              </div>
            )}

            {/* Full prompt */}
            {selectedNode.message && (
              <div>
                <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Prompt</div>
                <div style={{
                  fontSize: 10, color: "#6b7280", lineHeight: 1.6,
                  maxHeight: 180, overflow: "auto",
                  background: "#f9fafb", padding: "8px 10px",
                  borderRadius: 6, border: "1px solid #f3f4f6",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  fontFamily: "ui-monospace, monospace",
                }}>
                  {(selectedNode.message as string).slice(0, 800)}
                  {(selectedNode.message as string).length > 800 ? "\n…" : ""}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
