import { useMemo, useCallback, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
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
}

// ─── Colors ────────────────────────────────────────────────────────

const NODE_TYPE_COLORS: Record<string, string> = {
  start: "#22c55e",
  conversation: "#3b82f6",
  tool: "#f59e0b",
  router: "#a855f7",
  end_call: "#ef4444",
  end: "#ef4444",
};

// ─── Custom Node Component ─────────────────────────────────────────

function AgentNode({ data }: NodeProps) {
  const color = NODE_TYPE_COLORS[data.nodeType as string] || "#888";
  const visited = data.visited as boolean;
  const stuck = data.stuck as boolean;

  return (
    <div
      style={{
        background: stuck ? "#1c0808" : visited ? "#081c0a" : "#141414",
        border: `1.5px solid ${stuck ? "#ef4444" : visited ? "#22c55e88" : "#333"}`,
        borderRadius: 8,
        padding: "8px 12px",
        minWidth: 160,
        maxWidth: 220,
        boxShadow: stuck
          ? "0 0 12px #ef444444"
          : visited
          ? "0 0 8px #22c55e22"
          : "none",
        transition: "all 0.2s ease",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: "#444", border: "none", width: 6, height: 6 }} />

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        {/* Status dot */}
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            flexShrink: 0,
            background: stuck ? "#ef4444" : visited ? "#22c55e" : `${color}66`,
          }}
        />
        {/* Label */}
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: stuck ? "#fca5a5" : visited ? "#e5e7eb" : "#9ca3af",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {(data.label as string) || (data.nodeType as string)}
        </div>
      </div>

      {/* Type badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 9,
            padding: "1px 5px",
            borderRadius: 3,
            background: visited || stuck ? `${color}22` : `${color}11`,
            color: visited || stuck ? color : `${color}aa`,
            border: `1px solid ${visited || stuck ? `${color}44` : `${color}22`}`,
          }}
        >
          {data.nodeType as string}
        </span>
        {stuck && (
          <span
            style={{
              fontSize: 9,
              padding: "1px 5px",
              borderRadius: 3,
              background: "#ef444422",
              color: "#ef4444",
              border: "1px solid #ef444444",
            }}
          >
            STUCK
          </span>
        )}
        {/* Extracted vars */}
        {(data.extractedVarNames as string[])?.length > 0 && visited && (
          <span style={{ fontSize: 9, color: "#22c55e88" }}>
            {(data.extractedVarNames as string[]).length} vars
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} style={{ background: "#333", border: "none", width: 6, height: 6 }} />
    </div>
  );
}

const nodeTypes = { agentNode: AgentNode };

// ─── Inner component (needs ReactFlowProvider) ────────────────────

function WorkflowCanvasInner({
  workflowNodes,
  workflowEdges,
  visitedNodeIds,
  stuckNodeId,
  extractedVars,
  toolCalls,
}: WorkflowCanvasProps) {
  const [selectedNode, setSelectedNode] = useState<any>(null);

  // Build React Flow nodes
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
        message: n.message,
        transitions: n.transitions,
      },
    }));
  }, [workflowNodes, visitedNodeIds, stuckNodeId]);

  // Build React Flow edges
  const rfEdges: Edge[] = useMemo(() => {
    return workflowEdges.map((e: any) => {
      const sourceVisited = visitedNodeIds.has(e.source);
      const targetVisited = visitedNodeIds.has(e.target);
      const isActiveEdge = sourceVisited && targetVisited;

      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        style: {
          stroke: isActiveEdge ? "#22c55e66" : "#333",
          strokeWidth: isActiveEdge ? 2 : 1,
        },
        animated: isActiveEdge,
      };
    });
  }, [workflowEdges, visitedNodeIds]);

  const onNodeClick = useCallback((_: any, node: Node) => {
    const original = workflowNodes.find((n: any) => n.id === node.id);
    setSelectedNode(original);
  }, [workflowNodes]);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // Find vars extracted at selected node
  const selectedNodeVars = useMemo(() => {
    if (!selectedNode) return [];
    const nodeVarNames = selectedNode.extractVariables?.variables?.map((v: any) => v.name) || [];
    return extractedVars.filter((v) => nodeVarNames.includes(v.name));
  }, [selectedNode, extractedVars]);

  const selectedNodeTools = useMemo(() => {
    if (!selectedNode) return [];
    return toolCalls.filter((t) => t.nodeId === selectedNode.id);
  }, [selectedNode, toolCalls]);

  return (
    <div style={{ position: "relative", width: "100%", height: 500, borderRadius: 8, overflow: "hidden", border: "1px solid #222" }} className="dark-flow">
      <style>{`
        .dark-flow .react-flow__controls { background: #111; border: 1px solid #222; border-radius: 6px; }
        .dark-flow .react-flow__controls button { background: #111; border-bottom: 1px solid #222; color: #888; fill: #888; }
        .dark-flow .react-flow__controls button:hover { background: #1a1a1a; }
        .dark-flow .react-flow__minimap { background: #111; border: 1px solid #222; border-radius: 6px; }
        .dark-flow .react-flow__edge-path { transition: stroke 0.2s ease; }
      `}</style>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.02}
        maxZoom={1.5}
        defaultEdgeOptions={{ type: "smoothstep" }}
        proOptions={{ hideAttribution: true }}
        style={{ background: "#0a0a0a" }}
      >
        <Background color="#1a1a1a" gap={50} />
        <Controls
          showInteractive={false}
          style={{ background: "#111", border: "1px solid #222", borderRadius: 6 }}
        />
        <MiniMap
          nodeColor={(node) => {
            if (node.data?.stuck) return "#ef4444";
            if (node.data?.visited) return "#22c55e";
            return "#555";
          }}
          maskColor="#0a0a0a99"
          style={{ background: "#111", border: "1px solid #222", borderRadius: 6 }}
        />
      </ReactFlow>

      {/* Node detail panel */}
      {selectedNode && (
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            width: 320,
            maxHeight: 460,
            overflow: "auto",
            background: "#111",
            border: "1px solid #222",
            borderRadius: 8,
            padding: 14,
            zIndex: 10,
            boxShadow: "0 4px 20px #00000066",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#e5e7eb" }}>
              {selectedNode.label || selectedNode.type}
            </div>
            <button
              onClick={() => setSelectedNode(null)}
              style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 16 }}
            >
              x
            </button>
          </div>

          {/* Type & status */}
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{
              fontSize: 10, padding: "2px 6px", borderRadius: 3,
              background: `${NODE_TYPE_COLORS[selectedNode.type] || "#888"}22`,
              color: NODE_TYPE_COLORS[selectedNode.type] || "#888",
              border: `1px solid ${NODE_TYPE_COLORS[selectedNode.type] || "#888"}44`,
            }}>
              {selectedNode.type}
            </span>
            {visitedNodeIds.has(selectedNode.id) && (
              <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, background: "#22c55e18", color: "#22c55e" }}>
                Visited
              </span>
            )}
            {selectedNode.id === stuckNodeId && (
              <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, background: "#ef444418", color: "#ef4444" }}>
                Stuck Here
              </span>
            )}
          </div>

          {/* Extracted vars */}
          {selectedNodeVars.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Extracted Variables</div>
              {selectedNodeVars.map((v, i) => (
                <div key={i} style={{ fontSize: 11, color: "#22c55e", marginBottom: 2 }}>
                  {v.name} = <span style={{ color: "#aaa" }}>"{v.value}"</span>
                </div>
              ))}
            </div>
          )}

          {/* Tool calls */}
          {selectedNodeTools.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Tool Calls</div>
              {selectedNodeTools.map((t, i) => (
                <div key={i} style={{ fontSize: 11, color: "#f59e0b" }}>{t.name}</div>
              ))}
            </div>
          )}

          {/* Transitions */}
          {selectedNode.transitions?.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
                Transitions ({selectedNode.transitions.length})
              </div>
              {selectedNode.transitions.map((t: any, i: number) => (
                <div key={i} style={{ fontSize: 10, color: "#666", marginBottom: 3, lineHeight: 1.4 }}>
                  {t.condition?.description || t.condition?.prompt || t.condition?.type || "auto"}
                </div>
              ))}
            </div>
          )}

          {/* Message preview */}
          {selectedNode.message && (
            <div>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Prompt (preview)</div>
              <div style={{
                fontSize: 10, color: "#666", lineHeight: 1.5,
                maxHeight: 150, overflow: "auto",
                background: "#0a0a0a", padding: 8, borderRadius: 4, border: "1px solid #1a1a1a",
                whiteSpace: "pre-wrap", wordBreak: "break-word",
              }}>
                {(selectedNode.message as string).slice(0, 500)}
                {(selectedNode.message as string).length > 500 ? "..." : ""}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Wrapper with Provider ─────────────────────────────────────────

export default function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
