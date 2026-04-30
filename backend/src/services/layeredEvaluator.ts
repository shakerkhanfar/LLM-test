/**
 * Layered Micro-Evaluation System
 *
 * Instead of one monolithic "evaluate this call" prompt, breaks evaluation into
 * focused layers:
 *
 * Layer 2: Node Navigation (structural, mostly deterministic)
 *   Input: Structured log only (node name, duration, turns, exit reason) + graph
 *   Checks: Stuck detection, wrong transitions, skipped nodes, loops, backward jumps
 *
 * Layer 3: Per-Node Behavior (focused LLM calls)
 *   Input: Only the visited nodes, each evaluated independently
 *   Each packet: node instructions, allowed transitions, 3-6 transcript turns, transition taken
 *   Checks: Instruction adherence, off-topic, hallucination, correct transition
 *
 * Layer 4: Overall Quality (aggregation)
 *   Input: Summaries from layers 2-3 (not raw data)
 *   Checks: Objective achieved, caller sentiment, efficiency, compliance
 */

import { evaluateWithLLMJudge } from "./llmJudge";

/** Truncate text at the last sentence boundary or newline within the limit */
function safeTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastBreak = Math.max(truncated.lastIndexOf("\n"), truncated.lastIndexOf(". "));
  return lastBreak > maxLen * 0.4 ? truncated.slice(0, lastBreak + 1) : truncated;
}

/** Safely coerce an LLM response value to a number, with fallback.
 *  Handles string scores ("8"), null, undefined, NaN. */
function num(val: unknown, fallback: number): number {
  if (typeof val === "number" && !isNaN(val)) return val;
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

// ─── Types ────────────────────────────────────────────────────────

export interface NodeVisit {
  index: number;                    // Order in which this node was visited (0-based)
  nodeId: string;                   // Node ID from agent structure
  nodeLabel: string;                // Human-readable name
  nodeType: string;                 // start, conversation, tool, router, end_call, etc.
  nodeInstructions: string;         // The node's prompt/message
  allowedTransitions: Array<{       // Edges from this node
    targetLabel: string;
    condition: string;
  }>;
  transitionTaken: string;          // What transition was actually taken (next node label)
  transcriptTurns: Array<{          // Only the turns that happened during this node
    speaker: "Agent" | "User";
    text: string;
    gender?: string;
  }>;
  turnsSpent: number;               // Number of conversation turns
  variablesExtracted: string[];     // Variables collected at this node
  toolsCalled: string[];            // Tools executed at this node
  toolResults: Array<{              // Tool execution details
    toolName: string;
    success: boolean;
    request?: any;                  // Parameters sent to the tool
    response?: any;                 // Response from the tool
  }>;
  durationMs: number;               // Time spent on this node
  entryTimestamp: string;
  exitTimestamp: string;
}

export interface Layer2Result {
  score: number;                    // 0-10
  issues: Array<{
    type: "stuck" | "loop" | "wrong_transition" | "skipped_node" | "backward_jump" | "dead_end";
    nodeLabel: string;
    detail: string;
    severity: "critical" | "warning" | "info";
  }>;
  summary: string;
  nodeSequence: string[];           // Labels of visited nodes in order
  totalNodes: number;               // Total nodes in agent graph
  visitedNodes: number;             // Nodes actually visited
}

export interface Layer3NodeResult {
  nodeLabel: string;
  nodeType: string;
  instructionAdherence: { score: number; followed: string[]; violated: string[]; evidence: string };
  transitionCorrectness: { score: number; correct: boolean; reasoning: string };
  offTopic: { detected: boolean; turns: string[]; topics: string[] };
  hallucination: { detected: boolean; evidence: string };
  stuck: { detected: boolean; unnecessaryTurns: number; reasoning: string };
  contextSummary: string;           // What was happening at this node — user intent, agent behavior, outcome
  overallNodeScore: number;         // 0-10
}

export interface Layer4Result {
  overallScore: number;             // 0-10
  objectiveAchieved: boolean | null;
  callerSentiment: string;
  outOfScopeHandled: boolean | null;
  outOfScopeTopics: string[];
  efficiency: { score: number; reasoning: string };
  criticalIssues: string[];
  improvements: string[];
  summary: string;
}

export interface LayeredEvalResult {
  layer2: Layer2Result;
  layer3: Layer3NodeResult[];
  layer4: Layer4Result;
  totalCostUsd: number;
}

// ─── Node-Turn Mapper ─────────────────────────────────────────────

/**
 * Maps call log events and transcript turns to specific nodes in the agent graph.
 * This is the foundation — everything else depends on this mapping being correct.
 *
 * Algorithm:
 * 1. Walk through callLog chronologically
 * 2. Each "Node moved" event marks a transition
 * 3. "Playing message" events contain the prompt text — match against node definitions
 * 4. Map transcript turns to nodes by chronological ordering between node transitions
 */
export function mapNodeVisits(
  callLog: any[],
  transcript: any[],
  nodes: any[],
  edges: any[]
): NodeVisit[] {
  if (!callLog?.length || !nodes?.length) return [];

  // Build a lookup: normalize node message → node definition
  const nodeByMessage = new Map<string, any>();
  const nodeById = new Map<string, any>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
    if (node.message) {
      // Normalize: trim, collapse whitespace, use full message as key
      const key = node.message.trim().replace(/\s+/g, " ").toLowerCase();
      nodeByMessage.set(key, node);
    }
  }

  // Step 1: Two-pass approach to handle unordered events within the same timestamp.
  //
  // Pass 1: Scan ALL events to build a timeline of node transitions.
  //   - TRANSITION events contain "next_node" IDs (most reliable)
  //   - "Playing message" events contain the prompt text
  //   - node_movement events mark boundaries
  //
  // Pass 2: Group events into segments and assign node definitions.

  interface NodeSegment {
    node: any | null;
    entryIdx: number;
    exitIdx: number;
    entryTimestamp: string;
    exitTimestamp: string;
    promptMessage: string;
    variablesExtracted: string[];
    toolsCalled: string[];
    toolResults: Array<{ toolName: string; success: boolean; request?: any; response?: any }>;
  }

  // Pass 1: Find all transition targets (TRANSITION.Tool result events with next_node)
  const transitionTargets: Array<{ timestamp: string; nodeId: string; idx: number }> = [];
  for (let i = 0; i < callLog.length; i++) {
    const e = callLog[i];
    if (e.category === "TRANSITION" && e.payload?.next_node) {
      transitionTargets.push({ timestamp: e.timestamp, nodeId: e.payload.next_node, idx: i });
    }
  }

  // Pass 2: Group events by unique timestamps to form segments
  // Each unique timestamp group after a node_movement represents one node visit
  const segments: NodeSegment[] = [];
  let currentSegment: NodeSegment | null = null;

  for (let i = 0; i < callLog.length; i++) {
    const event = callLog[i];

    if (event.category === "node_movement" && event.message === "Node moved") {
      if (currentSegment) {
        currentSegment.exitIdx = i - 1;
        currentSegment.exitTimestamp = callLog[i - 1]?.timestamp || event.timestamp;
        segments.push(currentSegment);
      }
      currentSegment = {
        node: null, entryIdx: i, exitIdx: i,
        entryTimestamp: event.timestamp, exitTimestamp: event.timestamp,
        promptMessage: "", variablesExtracted: [], toolsCalled: [], toolResults: [],
      };
    }

    if (!currentSegment) continue;

    // Collect all data for this segment regardless of event order
    if (event.category === "CONVERSATION" && event.message?.startsWith("Playing message")) {
      currentSegment.promptMessage = event.payload?.message || "";
    }
    if (event.category === "VARIABLE_EXTRACTION" && event.payload?.variables) {
      currentSegment.variablesExtracted.push(...event.payload.variables);
    }
    if (event.category === "VARIABLE_EXTRACTION" && event.message?.includes("Updated variable")) {
      const varName = event.message.replace("Updated variable from LLM tool call: ", "");
      if (varName) currentSegment.variablesExtracted.push(varName);
    }
    if (event.category === "TOOLS" && event.message === "Executing Tool") {
      const toolName = event.payload?.toolName || "unknown";
      currentSegment.toolsCalled.push(toolName);
      currentSegment.toolResults.push({
        toolName, success: false,
        request: event.payload?.request || event.payload?.params || event.payload,
      });
    }
    if (event.category === "TOOLS" && (event.message === "Tool Success" || event.message === "Tool API call completed")) {
      const last = currentSegment.toolResults[currentSegment.toolResults.length - 1];
      if (last) { last.success = event.message === "Tool Success" || event.payload?.response?.ok !== false; last.response = event.payload?.response || event.payload; }
    }
    if (event.category === "TOOLS" && (event.message === "Tool Error" || event.message === "Tool Failed")) {
      const last = currentSegment.toolResults[currentSegment.toolResults.length - 1];
      if (last) { last.success = false; last.response = event.payload; }
    }
  }
  if (currentSegment) {
    currentSegment.exitIdx = callLog.length - 1;
    currentSegment.exitTimestamp = callLog[callLog.length - 1]?.timestamp || "";
    segments.push(currentSegment);
  }

  // Fallback: if no node_movement events were found, create segments from TRANSITION events
  if (segments.length === 0 && transitionTargets.length > 0) {
    let prevIdx = 0;
    for (const tt of transitionTargets) {
      const node = nodeById.get(tt.nodeId);
      segments.push({
        node: node || null,
        entryIdx: prevIdx, exitIdx: tt.idx,
        entryTimestamp: callLog[prevIdx]?.timestamp || "",
        exitTimestamp: callLog[tt.idx]?.timestamp || "",
        promptMessage: "", variablesExtracted: [], toolsCalled: [], toolResults: [],
      });
      prevIdx = tt.idx + 1;
    }
    // Add final segment after last transition
    if (prevIdx < callLog.length) {
      segments.push({
        node: null, entryIdx: prevIdx, exitIdx: callLog.length - 1,
        entryTimestamp: callLog[prevIdx]?.timestamp || "",
        exitTimestamp: callLog[callLog.length - 1]?.timestamp || "",
        promptMessage: "", variablesExtracted: [], toolsCalled: [], toolResults: [],
      });
    }
  }

  // Pass 3: Identify which node each segment belongs to.
  // KEY PRINCIPLE: Nodes CAN be revisited (loops are common). Don't exclude already-matched IDs.
  // Priority: TRANSITION events > exact message match > graph traversal > fuzzy match > start node.

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (seg.node) continue;

    // Strategy 1: TRANSITION event — find transitions that happened IN THE GAP
    // between the previous segment and this one. The TRANSITION's next_node
    // tells us what THIS segment should be (the destination).
    const prevEntryIdx = si > 0 ? segments[si - 1].entryIdx : -1;
    const transitionsInGap = transitionTargets.filter(
      (tt) => tt.idx > prevEntryIdx && tt.idx <= seg.entryIdx
    );
    // Use the LAST transition in the gap (closest to this segment's start)
    if (transitionsInGap.length > 0) {
      const lastTT = transitionsInGap[transitionsInGap.length - 1];
      const targetNode = nodeById.get(lastTT.nodeId);
      if (targetNode) { seg.node = targetNode; continue; }
    }

    // Strategy 2: Start node — first segment is always the start node
    if (si === 0) {
      const startNode = nodes.find((n: any) => n.type === "start");
      if (startNode) { seg.node = startNode; continue; }
    }

    // Strategy 3: Exact message match (node prompt text matches played message)
    if (seg.promptMessage) {
      const key = seg.promptMessage.trim().replace(/\s+/g, " ").toLowerCase();
      if (nodeByMessage.has(key)) { seg.node = nodeByMessage.get(key); continue; }
    }

    // Strategy 4: Graph traversal from previous matched node
    // Follow edges from the previous node. Allow revisiting the same node (loops).
    if (si > 0) {
      const prevNode = segments[si - 1]?.node;
      if (prevNode) {
        // Get all reachable nodes (including self-loops back to the same node)
        const reachable = edges
          .filter((e: any) => e.source === prevNode.id)
          .map((e: any) => nodeById.get(e.target))
          .filter((n: any) => n);

        if (reachable.length === 1) {
          seg.node = reachable[0];
        } else if (reachable.length > 1) {
          // Try to narrow by type: tool segment → tool node, prompt segment → conversation node
          let match: any = null;
          if (seg.toolsCalled.length > 0) {
            match = reachable.find((n: any) => n.type === "tool");
          } else if (seg.promptMessage) {
            // Fuzzy match the prompt against reachable conversation nodes
            const msgLower = seg.promptMessage.trim().replace(/\s+/g, " ").toLowerCase();
            let bestScore = 0;
            for (const node of reachable) {
              if (!node.message) continue;
              const template = node.message.replace(/\{\{[^}]+\}\}/g, "").trim().replace(/\s+/g, " ").toLowerCase();
              const staticWords = template.slice(0, 300).split(/\s+/).filter((w: string) => w.length > 2);
              if (staticWords.length < 2) continue;
              const matchCount = staticWords.filter((w: string) => msgLower.includes(w)).length;
              const ratio = matchCount / staticWords.length;
              if (ratio > bestScore && ratio >= 0.45) { bestScore = ratio; match = node; }
            }
            // If no fuzzy match, try conversation type among reachable
            if (!match) match = reachable.find((n: any) => n.type === "conversation");
          }
          if (match) seg.node = match;
        }
        if (seg.node) continue;
      }
    }

    // Strategy 5: Fuzzy match against ALL nodes (no exclusion of already-visited)
    if (seg.promptMessage && !seg.node) {
      let bestMatch: any = null;
      let bestScore = 0;
      const msgLower = seg.promptMessage.trim().replace(/\s+/g, " ").toLowerCase();

      for (const node of nodes) {
        if (!node.message) continue;
        const template = node.message.replace(/\{\{[^}]+\}\}/g, "").trim().replace(/\s+/g, " ").toLowerCase();
        if (template.length < 10) continue;
        const staticWords = template.slice(0, 300).split(/\s+/).filter((w: string) => w.length > 2);
        if (staticWords.length < 2) continue;
        const matchCount = staticWords.filter((w: string) => msgLower.includes(w)).length;
        const ratio = matchCount / staticWords.length;
        if (ratio > bestScore && ratio >= 0.45) { bestScore = ratio; bestMatch = node; }
      }
      if (bestMatch) { seg.node = bestMatch; continue; }
    }
  }

  // Step 2: Map transcript turns to segments by timestamp ordering
  // Agent turns don't have timestamps, User turns have metadata.created_at (epoch seconds)
  // Strategy: assign turns to the segment that was active at the time
  const turnTimestamps: Array<{ turn: any; epochMs: number | null; index: number }> = [];
  for (let i = 0; i < transcript.length; i++) {
    const t = transcript[i];
    const createdAt = t.metadata?.created_at;
    const epochMs = typeof createdAt === "number" ? createdAt * 1000 : null;
    turnTimestamps.push({ turn: t, epochMs, index: i });
  }

  // Assign turns to segments: for each segment, find turns whose timestamps fall within its time range
  // For turns without timestamps (Agent turns), assign based on position relative to User turns
  const segmentTurns: Array<Array<{ speaker: "Agent" | "User"; text: string; gender?: string }>> =
    segments.map(() => []);

  let currentTurnIdx = 0;
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const segEndMs = si < segments.length - 1
      ? new Date(segments[si + 1].entryTimestamp).getTime()
      : Infinity;

    // Only assign turns to conversation nodes (not router/tool/variable nodes)
    const isConversationNode = seg.node?.type === "conversation" || seg.node?.type === "start" || seg.promptMessage;

    if (!isConversationNode) continue;

    while (currentTurnIdx < turnTimestamps.length) {
      const tt = turnTimestamps[currentTurnIdx];
      const turnMs = tt.epochMs;

      // If turn has a timestamp, check if it falls in this segment
      if (turnMs !== null) {
        if (turnMs < segEndMs) {
          // This turn belongs to this segment
          segmentTurns[si].push({
            speaker: tt.turn.Agent ? "Agent" : "User",
            text: tt.turn.Agent || tt.turn.User || "",
            gender: tt.turn.metadata?.gender,
          });
          currentTurnIdx++;
        } else {
          break; // This turn belongs to a later segment
        }
      } else {
        // No timestamp (Agent turn) — assign to current segment if we haven't passed it
        segmentTurns[si].push({
          speaker: "Agent",
          text: tt.turn.Agent || "",
        });
        currentTurnIdx++;
      }
    }
  }

  // Assign any remaining turns to the last conversation segment
  if (currentTurnIdx < turnTimestamps.length) {
    const lastConvIdx = segmentTurns.map((_, i) => i).reverse()
      .find(i => segments[i] && (segments[i].node?.type === "conversation" || segments[i].node?.type === "start" || segments[i].promptMessage));
    if (lastConvIdx !== undefined) {
      while (currentTurnIdx < turnTimestamps.length) {
        const tt = turnTimestamps[currentTurnIdx];
        segmentTurns[lastConvIdx].push({
          speaker: tt.turn.Agent ? "Agent" : "User",
          text: tt.turn.Agent || tt.turn.User || "",
          gender: tt.turn.metadata?.gender,
        });
        currentTurnIdx++;
      }
    }
  }

  // Step 3: Build NodeVisit objects
  const visits: NodeVisit[] = [];
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];

    // Skip non-conversation nodes (router, set_local_variables) for Layer 3 evaluation
    // but include them in the sequence for Layer 2
    const nodeLabel = seg.node?.label || seg.node?.type || `unknown-${si}`;
    const nodeType = seg.node?.type || "unknown";

    // Get allowed transitions from edges
    const outEdges = seg.node ? edges.filter((e: any) => e.source === seg.node.id) : [];
    const allowedTransitions = outEdges.map((e: any) => {
      const target = nodeById.get(e.target);
      return {
        targetLabel: target?.label || e.target,
        condition: e.data?.condition?.description || e.data?.condition?.prompt || "default",
      };
    });

    // Determine what transition was taken
    const nextSeg = segments[si + 1];
    const transitionTaken = nextSeg?.node?.label || nextSeg?.node?.type || "end_of_call";

    const entryMs = seg.entryTimestamp ? new Date(seg.entryTimestamp).getTime() : 0;
    const exitMs = seg.exitTimestamp ? new Date(seg.exitTimestamp).getTime() : entryMs;

    visits.push({
      index: si,
      nodeId: seg.node?.id || `segment-${si}`,
      nodeLabel,
      nodeType,
      nodeInstructions: seg.node?.message || seg.promptMessage || "",
      allowedTransitions,
      transitionTaken,
      transcriptTurns: segmentTurns[si],
      turnsSpent: segmentTurns[si].length,
      variablesExtracted: [...new Set(seg.variablesExtracted)],
      toolsCalled: seg.toolsCalled,
      toolResults: seg.toolResults,
      durationMs: exitMs - entryMs,
      entryTimestamp: seg.entryTimestamp,
      exitTimestamp: seg.exitTimestamp,
    });
  }

  return visits;
}

// ─── Layer 2: Node Navigation (Structural) ────────────────────────

export function evaluateNavigation(visits: NodeVisit[], totalNodesInGraph: number): Layer2Result {
  const issues: Layer2Result["issues"] = [];
  const nodeSequence = visits.map(v => v.nodeLabel);

  // Check 1: Stuck detection — too many turns on a single node
  // Important: distinguish between the AGENT being stuck (repeating same prompt, not progressing)
  // and the USER causing extra turns (giving info piecemeal, correcting themselves, asking clarifications).
  // Only flag as stuck when the agent is genuinely not making progress.
  for (const v of visits) {
    if (v.nodeType === "conversation" || v.nodeType === "start") {
      // Analyze transcript to detect user-caused vs agent-caused repetition
      const agentTurns = v.transcriptTurns.filter(t => t.speaker === "Agent").map(t => t.text.trim().toLowerCase());
      const userTurns = v.transcriptTurns.filter(t => t.speaker === "User").map(t => t.text.trim().toLowerCase());

      // Check if agent is repeating itself (same/similar prompt multiple times)
      let agentRepeats = 0;
      for (let i = 1; i < agentTurns.length; i++) {
        // Simple similarity: if >60% of words overlap, it's a repeat
        const prev = new Set(agentTurns[i - 1].split(/\s+/).filter(w => w.length > 2));
        const curr = agentTurns[i].split(/\s+/).filter(w => w.length > 2);
        if (prev.size > 0 && curr.length > 0) {
          const overlap = curr.filter(w => prev.has(w)).length / Math.max(curr.length, 1);
          if (overlap > 0.6) agentRepeats++;
        }
      }

      // User giving piecemeal input: short user turns (1-3 non-empty words each) indicate
      // the user is providing data incrementally, not the agent failing.
      // Filter out empty/whitespace-only turns before counting.
      const nonEmptyUserTurns = userTurns.filter(t => t.trim().length > 0);
      const shortUserTurns = nonEmptyUserTurns.filter(t => t.trim().split(/\s+/).filter(Boolean).length <= 3).length;
      const userCausingDelay = nonEmptyUserTurns.length > 0 && shortUserTurns > nonEmptyUserTurns.length * 0.5;

      // Adjust thresholds based on who's causing the extra turns
      const effectiveTurns = userCausingDelay ? Math.ceil(v.turnsSpent * 0.6) : v.turnsSpent;

      if (agentRepeats >= 3 && effectiveTurns > 6) {
        issues.push({
          type: "stuck",
          nodeLabel: v.nodeLabel,
          detail: `Agent repeated itself ${agentRepeats} times over ${v.turnsSpent} turns on "${v.nodeLabel}" — likely stuck.`,
          severity: "critical",
        });
      } else if (effectiveTurns > 10) {
        issues.push({
          type: "stuck",
          nodeLabel: v.nodeLabel,
          detail: `Agent spent ${v.turnsSpent} turns on "${v.nodeLabel}" — may be over-asking.${userCausingDelay ? " (Note: user was providing input piecemeal, which inflated turn count)" : ""}`,
          severity: "warning",
        });
      } else if (effectiveTurns > 7 && !userCausingDelay) {
        issues.push({
          type: "stuck",
          nodeLabel: v.nodeLabel,
          detail: `Agent spent ${v.turnsSpent} turns on "${v.nodeLabel}" — may be over-asking.`,
          severity: "warning",
        });
      }
    }
  }

  // Check 2: Loop detection — same node visited more than once
  // Note: Revisiting a node is normal in many workflows (e.g., user corrects input,
  // agent asks for confirmation then returns to collection). Only flag as a loop when
  // the revisit pattern is excessive (>3 times) or clearly unproductive.
  const visitCounts = new Map<string, number>();
  for (const v of visits) {
    visitCounts.set(v.nodeLabel, (visitCounts.get(v.nodeLabel) || 0) + 1);
  }
  for (const [label, count] of visitCounts) {
    if (count > 3) {
      issues.push({
        type: "loop",
        nodeLabel: label,
        detail: `Node "${label}" was visited ${count} times — likely an unproductive loop.`,
        severity: "critical",
      });
    } else if (count === 3) {
      issues.push({
        type: "loop",
        nodeLabel: label,
        detail: `Node "${label}" was visited 3 times — may indicate a retry loop.`,
        severity: "warning",
      });
    } else if (count === 2) {
      issues.push({
        type: "loop",
        nodeLabel: label,
        detail: `Node "${label}" was visited twice — likely a retry or correction flow.`,
        severity: "info",
      });
    }
  }

  // Check 3: Backward jumps — visiting a node that was already visited earlier
  // Skip nodes already flagged as loops to avoid double-penalizing
  const loopNodes = new Set(issues.filter(i => i.type === "loop").map(i => i.nodeLabel));
  const visitedOrder = new Map<string, number>();
  for (const v of visits) {
    if (visitedOrder.has(v.nodeLabel) && v.nodeType !== "router" && !loopNodes.has(v.nodeLabel)) {
      issues.push({
        type: "backward_jump",
        nodeLabel: v.nodeLabel,
        detail: `Agent went back to "${v.nodeLabel}" after previously leaving it.`,
        severity: "warning",
      });
    }
    if (!visitedOrder.has(v.nodeLabel)) {
      visitedOrder.set(v.nodeLabel, v.index);
    }
  }

  // Check 4: Dead end — last node is not an end_call node and call ended
  const lastVisit = visits[visits.length - 1];
  if (lastVisit && lastVisit.nodeType !== "end_call" && lastVisit.transitionTaken === "end_of_call") {
    issues.push({
      type: "dead_end",
      nodeLabel: lastVisit.nodeLabel,
      detail: `Call ended on "${lastVisit.nodeLabel}" without reaching an end node.`,
      severity: "warning",
    });
  }

  // Compute score — info issues don't deduct, warnings deduct 1, critical deducts 2
  const criticalCount = issues.filter(i => i.severity === "critical").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;
  let score = Math.max(0, 10 - criticalCount * 2 - warningCount * 1);
  // No node visits at all = navigation failed completely
  if (visits.length === 0) score = 0;

  const conversationVisits = visits.filter(v => v.nodeType === "conversation" || v.nodeType === "start");
  const summary = `Visited ${conversationVisits.length} conversation nodes out of ${totalNodesInGraph} total. ` +
    `${issues.length === 0 ? "No structural issues detected." : `Found ${criticalCount} critical and ${warningCount} warning issues.`}`;

  return { score, issues, summary, nodeSequence, totalNodes: totalNodesInGraph, visitedNodes: conversationVisits.length };
}

// ─── Layer 3: Per-Node Behavior ───────────────────────────────────

/**
 * Evaluate a tool node: check if the parameters sent to the tool were correctly
 * extracted from the preceding conversation, and if the tool response was handled properly.
 */
async function evaluateToolNode(
  visit: NodeVisit,
  precedingTurns: Array<{ speaker: string; text: string }>
): Promise<{ result: Layer3NodeResult; costUsd: number }> {
  // Check programmatically first: did the tool succeed?
  const allSucceeded = visit.toolResults.every(t => t.success);
  const failedTools = visit.toolResults.filter(t => !t.success);

  // Build a compact view of what the tool did
  const toolDetails = visit.toolResults.map(t => {
    const reqStr = t.request ? JSON.stringify(t.request).slice(0, 300) : "no request data";
    const resStr = t.response ? JSON.stringify(t.response).slice(0, 300) : "no response data";
    return `Tool: ${t.toolName}\n  Success: ${t.success}\n  Request: ${reqStr}\n  Response: ${resStr}`;
  }).join("\n\n");

  // Build the recent conversation context (last 6 turns before this tool node)
  const contextText = precedingTurns.slice(-6).map(t => `[${t.speaker}]: ${t.text}`).join("\n");

  const prompt = `You are evaluating a TOOL execution node in a voice AI agent call. Check if the tool was called with correct parameters based on what the user said.

CONVERSATION BEFORE THIS TOOL CALL (the context from which parameters were extracted):
${contextText || "(no preceding conversation)"}

VARIABLES EXTRACTED AND SENT TO TOOL: ${visit.variablesExtracted.join(", ") || "none"}

TOOL EXECUTION DETAILS:
${toolDetails}

TRANSITION TAKEN AFTER TOOL: → "${visit.transitionTaken}"

Evaluate:
1. Were the parameters correctly extracted from the conversation? (e.g., if user said ID "1234", was "1234" sent to the tool?)
2. Did the tool succeed or fail? If failed, was it due to bad parameters or a server error?
3. Was the transition after the tool result correct?

Respond with JSON:
{
  "instruction_adherence": {
    "score": 0-10,
    "followed": ["parameters correctly extracted"],
    "violated": ["any mismatched parameters"],
    "evidence": "quote what user said vs what was sent"
  },
  "transition_correctness": {
    "score": 0-10,
    "correct": true/false,
    "reasoning": "was the post-tool transition appropriate?"
  },
  "off_topic": { "detected": false, "turns": [] },
  "hallucination": {
    "detected": true/false,
    "evidence": "any parameter that wasn't mentioned in the conversation"
  },
  "stuck": { "detected": false, "unnecessary_turns": 0, "reasoning": "" },
  "overall_node_score": 0-10
}`;

  const { detail, costUsd } = await evaluateWithLLMJudge(prompt, "", true);

  try {
    const parsed = typeof detail === "string" ? JSON.parse(detail) : detail;
    return {
      result: {
        nodeLabel: visit.nodeLabel,
        nodeType: visit.nodeType,
        instructionAdherence: {
          score: num(parsed.instruction_adherence?.score, allSucceeded ? 8 : 3),
          followed: parsed.instruction_adherence?.followed ?? [],
          violated: parsed.instruction_adherence?.violated ?? (failedTools.length ? [`Tool failed: ${failedTools.map(t=>t.toolName).join(", ")}`] : []),
          evidence: parsed.instruction_adherence?.evidence ?? "",
        },
        transitionCorrectness: {
          score: num(parsed.transition_correctness?.score, 5),
          correct: parsed.transition_correctness?.correct ?? true,
          reasoning: parsed.transition_correctness?.reasoning ?? "",
        },
        offTopic: { detected: false, turns: [], topics: [] },
        hallucination: {
          detected: parsed.hallucination?.detected ?? false,
          evidence: parsed.hallucination?.evidence ?? "",
        },
        stuck: { detected: false, unnecessaryTurns: 0, reasoning: "" },
        contextSummary: parsed.context_summary ?? `Tool node: ${visit.toolsCalled.join(", ")} — ${allSucceeded ? "succeeded" : "failed"}`,
        overallNodeScore: num(parsed.overall_node_score, allSucceeded ? 8 : 4),
      },
      costUsd,
    };
  } catch {
    // Fallback: programmatic check only
    return {
      result: {
        nodeLabel: visit.nodeLabel,
        nodeType: visit.nodeType,
        instructionAdherence: {
          score: allSucceeded ? 8 : 3,
          followed: allSucceeded ? ["Tool executed successfully"] : [],
          violated: failedTools.map(t => `Tool ${t.toolName} failed`),
          evidence: "",
        },
        transitionCorrectness: { score: 5, correct: true, reasoning: "" },
        offTopic: { detected: false, turns: [], topics: [] },
        hallucination: { detected: false, evidence: "" },
        stuck: { detected: false, unnecessaryTurns: 0, reasoning: "" },
        contextSummary: `Tool node: ${visit.toolsCalled.join(", ")} — ${allSucceeded ? "succeeded" : "failed"}`,
        overallNodeScore: allSucceeded ? 8 : 4,
      },
      costUsd,
    };
  }
}

export async function evaluateNodeBehavior(
  visit: NodeVisit,
  agentSummary: string,
  /** Recent transcript turns BEFORE this node — for tool nodes to verify parameters */
  precedingTurns: Array<{ speaker: string; text: string }> = [],
  evalContext: string | null = null
): Promise<{ result: Layer3NodeResult; costUsd: number }> {
  // Router/variable nodes — structural only, no LLM needed
  if (["router", "set_local_variables", "end_call"].includes(visit.nodeType)) {
    return {
      result: {
        nodeLabel: visit.nodeLabel,
        nodeType: visit.nodeType,
        instructionAdherence: { score: 10, followed: [], violated: [], evidence: "Non-conversation node — structural only." },
        transitionCorrectness: { score: 10, correct: true, reasoning: "Automatic transition." },
        offTopic: { detected: false, turns: [], topics: [] },
        hallucination: { detected: false, evidence: "" },
        stuck: { detected: false, unnecessaryTurns: 0, reasoning: "" },
        contextSummary: "Non-conversation node — structural only.",
        overallNodeScore: 10,
      },
      costUsd: 0,
    };
  }

  // Tool nodes — check parameters against conversation context
  if (visit.nodeType === "tool" && visit.toolsCalled.length > 0) {
    return evaluateToolNode(visit, precedingTurns);
  }

  // Conversation/start nodes with no transcript — skip
  if (visit.transcriptTurns.length === 0) {
    return {
      result: {
        nodeLabel: visit.nodeLabel,
        nodeType: visit.nodeType,
        instructionAdherence: { score: 10, followed: [], violated: [], evidence: "No transcript turns at this node." },
        transitionCorrectness: { score: 10, correct: true, reasoning: "No interaction." },
        offTopic: { detected: false, turns: [], topics: [] },
        hallucination: { detected: false, evidence: "" },
        stuck: { detected: false, unnecessaryTurns: 0, reasoning: "" },
        contextSummary: "No transcript turns at this node.",
        overallNodeScore: 10,
      },
      costUsd: 0,
    };
  }

  // Build the focused evaluation packet
  const transcriptText = visit.transcriptTurns
    .map(t => `[${t.speaker}${t.gender ? ` (${t.gender})` : ""}]: ${t.text}`)
    .join("\n");

  const transitionsText = visit.allowedTransitions.length > 0
    ? visit.allowedTransitions.map(t => `  → "${t.targetLabel}" when: ${t.condition}`).join("\n")
    : "  (no explicit transitions defined)";

  const evalContextBlock = evalContext?.trim()
    ? `\nPROJECT EVALUATION RULES (always apply these when scoring):\n${evalContext.trim()}\n`
    : "";

  const prompt = `You are evaluating ONE specific node of a voice AI agent call. You see ONLY this node's data — do NOT speculate about other parts of the call.

IMPORTANT EVALUATION GUIDELINES:
- Distinguish between USER-CAUSED delays and AGENT-CAUSED problems. If the user is giving information piecemeal (e.g., dictating a national ID one digit at a time, correcting themselves, asking clarifications), that is NOT the agent being stuck — the agent is correctly waiting for complete input.
- "Stuck" means the agent is repeating the same prompt without making progress despite the user providing the requested information. If the user hasn't provided the info yet, the agent asking again is CORRECT behavior.
- Many turns ≠ stuck. A node with 10+ turns where the user is slowly providing digits is working correctly. A node with 6 turns where the agent asks the same question 3 times despite getting an answer IS stuck.
- Score the AGENT's behavior, not the user's cooperation level.
- AGENT INSTRUCTION ADHERENCE IS PRIMARY: If the agent followed its node instructions correctly, the node should score HIGH — even if the call's overall objective was not met. A correctly-handled out-of-scope transfer, a correct escalation, or a proper "I can't help with that" response are all 9-10/10 scores.${evalContextBlock}

AGENT CONTEXT:
${agentSummary ? safeTruncate(agentSummary, 500) : "No agent summary available."}

NODE BEING EVALUATED: "${visit.nodeLabel}" (type: ${visit.nodeType})

NODE INSTRUCTIONS (what the agent should do at this node):
${visit.nodeInstructions || "(no specific instructions)"}

ALLOWED TRANSITIONS FROM THIS NODE:
${transitionsText}

TRANSITION ACTUALLY TAKEN: → "${visit.transitionTaken}"

TRANSCRIPT DURING THIS NODE (${visit.turnsSpent} turns):
${transcriptText}

VARIABLES EXTRACTED: ${visit.variablesExtracted.length > 0 ? visit.variablesExtracted.join(", ") : "none"}
TOOLS CALLED: ${visit.toolsCalled.length > 0 ? visit.toolsCalled.join(", ") : "none"}

Evaluate this node ONLY. Respond with JSON:
{
  "instruction_adherence": {
    "score": 0-10,
    "followed": ["list of instructions the agent followed"],
    "violated": ["list of instructions the agent violated or ignored"],
    "evidence": "quote the specific words/phrases from the transcript"
  },
  "transition_correctness": {
    "score": 0-10,
    "correct": true/false,
    "reasoning": "did the transition match an allowed condition?"
  },
  "off_topic": {
    "detected": true/false,
    "turns": ["list any turns where the USER asked about something outside the agent's scope"],
    "topics": ["list the specific out-of-scope topics the user brought up, e.g. 'insurance coverage details', 'medical reports', 'billing dispute'"]
  },
  "hallucination": {
    "detected": true/false,
    "evidence": "any info the agent stated that isn't in its instructions or extracted data"
  },
  "stuck": {
    "detected": true/false,
    "unnecessary_turns": 0,
    "reasoning": "could the agent have transitioned earlier?"
  },
  "context_summary": "2-3 sentences describing WHAT was happening at this node — what the user wanted, what the agent did, and why it succeeded or failed. Include specific details from the transcript (e.g., 'User asked for dermatology appointment, agent kept asking for national ID repeatedly without acknowledging the user already provided it'). This should give someone who hasn't read the transcript a clear picture.",
  "overall_node_score": 0-10
}`;

  const { detail, costUsd } = await evaluateWithLLMJudge(prompt, "", true);

  // Parse the JSON response
  try {
    const parsed = typeof detail === "string" ? JSON.parse(detail) : detail;
    return {
      result: {
        nodeLabel: visit.nodeLabel,
        nodeType: visit.nodeType,
        instructionAdherence: {
          score: num(parsed.instruction_adherence?.score, 5),
          followed: parsed.instruction_adherence?.followed ?? [],
          violated: parsed.instruction_adherence?.violated ?? [],
          evidence: parsed.instruction_adherence?.evidence ?? "",
        },
        transitionCorrectness: {
          score: num(parsed.transition_correctness?.score, 5),
          correct: parsed.transition_correctness?.correct ?? true,
          reasoning: parsed.transition_correctness?.reasoning ?? "",
        },
        offTopic: {
          detected: parsed.off_topic?.detected ?? false,
          turns: parsed.off_topic?.turns ?? [],
          topics: parsed.off_topic?.topics ?? [],
        },
        hallucination: {
          detected: parsed.hallucination?.detected ?? false,
          evidence: parsed.hallucination?.evidence ?? "",
        },
        stuck: {
          detected: parsed.stuck?.detected ?? false,
          unnecessaryTurns: parsed.stuck?.unnecessary_turns ?? 0,
          reasoning: parsed.stuck?.reasoning ?? "",
        },
        contextSummary: parsed.context_summary ?? "",
        overallNodeScore: num(parsed.overall_node_score, 5),
      },
      costUsd,
    };
  } catch {
    return {
      result: {
        nodeLabel: visit.nodeLabel,
        nodeType: visit.nodeType,
        instructionAdherence: { score: 5, followed: [], violated: [], evidence: "Failed to parse LLM response" },
        transitionCorrectness: { score: 5, correct: true, reasoning: "" },
        offTopic: { detected: false, turns: [], topics: [] },
        hallucination: { detected: false, evidence: "" },
        stuck: { detected: false, unnecessaryTurns: 0, reasoning: "" },
        contextSummary: "",
        overallNodeScore: 5,
      },
      costUsd,
    };
  }
}

// ─── Layer 4: Overall Quality (Aggregation) ───────────────────────

export async function evaluateOverall(
  layer2: Layer2Result,
  layer3: Layer3NodeResult[],
  agentSummary: string,
  callOutcome: string | null,
  callDuration: number | null,
  evalContext: string | null = null
): Promise<{ result: Layer4Result; costUsd: number }> {
  // Build summaries from layers 2-3 (NOT raw data)
  const navSummary = `Navigation: ${layer2.summary}` +
    (layer2.issues.length > 0
      ? "\nIssues:\n" + layer2.issues.map(i => `  [${i.severity}] ${i.type}: ${i.detail}`).join("\n")
      : "");

  const nodeSummaries = layer3
    .filter(n => n.nodeType === "conversation" || n.nodeType === "start")
    .map(n => {
      const problems: string[] = [];
      if (n.instructionAdherence.violated.length > 0) problems.push(`violated: ${n.instructionAdherence.violated.join(", ")}`);
      if (n.offTopic.detected) problems.push(`off-topic: ${n.offTopic.turns.join(", ")}`);
      if (n.hallucination.detected) problems.push(`hallucination: ${n.hallucination.evidence}`);
      if (n.stuck.detected) problems.push(`stuck: ${n.stuck.unnecessaryTurns} unnecessary turns`);
      return `  "${n.nodeLabel}": ${n.overallNodeScore}/10${problems.length ? " — " + problems.join("; ").slice(0, 200) : ""}`;
    }).join("\n").slice(0, 2000);

  const evalContextBlock = evalContext?.trim()
    ? `\nPROJECT-SPECIFIC EVALUATION RULES (highest priority — override defaults if they conflict):\n${evalContext.trim()}\n`
    : "";

  const prompt = `You are producing the final evaluation summary for a voice AI agent call. You receive pre-evaluated summaries from structural and per-node analyses — do NOT re-evaluate the raw data.

IMPORTANT SCORING RULES:
- AGENT INSTRUCTION ADHERENCE IS THE PRIMARY METRIC. If the agent followed its prompts correctly at every node, the call scores HIGH — even if the caller's personal objective was not ultimately met. A correctly-handled out-of-scope transfer, escalation, or "I can't help with that" response is a SUCCESSFUL call, not a failure.
- If the user asks about something OUTSIDE the agent's scope and the agent CORRECTLY handles it (politely redirects, transfers to call center, stays on track), this is a SUCCESS — score it HIGH, not low.
- A call should only be scored low if the agent itself made mistakes: hallucinating information, getting stuck in loops, ignoring user input, providing wrong information, or failing to follow its instructions.
- "Stuck" means the agent repeats the same prompt without progress DESPITE the user providing information. If the user is giving data piecemeal (e.g., dictating an ID digit by digit, correcting themselves), the agent correctly waiting is NOT stuck.
- HIGH TURN COUNT ≠ BAD CALL. A call with many turns where the user is slowly cooperating and the agent successfully collects all data is a GOOD call.
- Calls with outcome "stuck" or "timeout" but where the agent properly completed its instructions should be re-assessed — the outcome label may be misleading.
- If the per-node analyses show high scores but the navigation flagged "stuck" or "loops", weigh the per-node analyses more heavily — they have transcript-level detail.${evalContextBlock}

AGENT CONTEXT:
${agentSummary ? safeTruncate(agentSummary, 400) : "No agent summary."}

CALL METADATA:
- Call outcome: ${callOutcome || "unknown"}
- Call duration: ${callDuration ? callDuration + "s" : "unknown"}

NAVIGATION ANALYSIS (structural):
${navSummary}

PER-NODE ANALYSIS:
${nodeSummaries}

Based on these pre-evaluated results, provide a final JSON assessment:
{
  "overall_score": 0-10,
  "objective_achieved": true/false/null,
  "caller_sentiment": "positive" | "neutral" | "negative" | "unknown",
  "out_of_scope_handled": true/false/null,
  "out_of_scope_topics": ["list topics the user asked about that were outside the agent's scope, if any"],
  "efficiency": {
    "score": 0-10,
    "reasoning": "was the call longer than needed? unnecessary turns?"
  },
  "critical_issues": ["list of the most important ACTUAL problems found — do NOT list proper out-of-scope handling as an issue"],
  "improvements": ["specific actionable improvements for the agent"],
  "summary": "2-3 sentence human-readable summary of the call quality. Mention if the agent correctly handled an out-of-scope request."
}`;

  const { detail, costUsd } = await evaluateWithLLMJudge(prompt, "", true);

  try {
    const parsed = typeof detail === "string" ? JSON.parse(detail) : detail;
    return {
      result: {
        overallScore: num(parsed.overall_score, 5),
        objectiveAchieved: parsed.objective_achieved ?? null,
        callerSentiment: parsed.caller_sentiment ?? "unknown",
        outOfScopeHandled: parsed.out_of_scope_handled ?? null,
        outOfScopeTopics: parsed.out_of_scope_topics ?? [],
        efficiency: {
          score: num(parsed.efficiency?.score, 5),
          reasoning: parsed.efficiency?.reasoning ?? "",
        },
        criticalIssues: parsed.critical_issues ?? [],
        improvements: parsed.improvements ?? [],
        summary: parsed.summary ?? "",
      },
      costUsd,
    };
  } catch {
    return {
      result: {
        overallScore: 5,
        objectiveAchieved: null,
        callerSentiment: "unknown",
        outOfScopeHandled: null,
        outOfScopeTopics: [],
        efficiency: { score: 5, reasoning: "" },
        criticalIssues: ["Failed to parse aggregation response"],
        improvements: [],
        summary: "",
      },
      costUsd,
    };
  }
}

// ─── Main Entry Point ─────────────────────────────────────────────

export async function runLayeredEvaluation(
  callLog: any[],
  transcript: any[],
  agentStructure: any,
  agentSummary: string,
  callOutcome: string | null,
  callDuration: number | null,
  evalContext: string | null = null
): Promise<LayeredEvalResult> {
  const nodes = agentStructure?.workflow?.nodes ?? [];
  const edges = agentStructure?.workflow?.edges ?? [];
  let totalCostUsd = 0;

  // Step 1: Map nodes to transcript turns
  const visits = mapNodeVisits(callLog, transcript, nodes, edges);
  console.log(`[LayeredEval] Mapped ${visits.length} node visits (${visits.filter(v => v.turnsSpent > 0).length} with transcript turns)`);

  // Step 2: Layer 2 — structural navigation check (deterministic, no LLM)
  const totalNodesInGraph = nodes.length;
  const layer2 = evaluateNavigation(visits, totalNodesInGraph);
  console.log(`[LayeredEval] Layer 2 score: ${layer2.score}/10, issues: ${layer2.issues.length}`);

  // Step 3: Layer 3 — per-node behavior evaluation (focused LLM calls)
  const layer3: Layer3NodeResult[] = [];
  const evaluableVisits = visits.filter(v =>
    ((v.nodeType === "conversation" || v.nodeType === "start") && v.transcriptTurns.length > 0)
    || (v.nodeType === "tool" && v.toolsCalled.length > 0)
  );

  const allTurnsSoFar: Array<{ speaker: string; text: string }> = [];

  for (const visit of evaluableVisits) {
    const precedingTurns = [...allTurnsSoFar];
    const { result, costUsd } = await evaluateNodeBehavior(visit, agentSummary, precedingTurns, evalContext);
    layer3.push(result);
    totalCostUsd += costUsd;
    console.log(`[LayeredEval] Node "${visit.nodeLabel}" (${visit.nodeType}): ${result.overallNodeScore}/10`);
    for (const t of visit.transcriptTurns) {
      allTurnsSoFar.push({ speaker: t.speaker, text: t.text });
    }
  }

  // Step 4: Layer 4 — overall quality aggregation (one LLM call on summaries only)
  const { result: layer4, costUsd: layer4Cost } = await evaluateOverall(
    layer2, layer3, agentSummary, callOutcome, callDuration, evalContext
  );
  totalCostUsd += layer4Cost;
  console.log(`[LayeredEval] Layer 4 overall: ${layer4.overallScore}/10`);

  return { layer2, layer3, layer4, totalCostUsd };
}
