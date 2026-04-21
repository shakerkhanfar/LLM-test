import prisma from "../lib/prisma";
import { Criterion } from "@prisma/client";
import { evaluateWithLLMJudge } from "./llmJudge";
import { extractTranscriptFromConversation, extractTranscriptFromCallLog } from "./hamsaApi";
// extractTranscriptFromConversation and extractTranscriptFromCallLog are used inside resolveTranscript

/**
 * Resolve the best available transcript for a run, trying all sources in priority order:
 * 1. run.transcript (stored during hydration / webhook)
 * 2. run.webhookData (full conversation object — transcript may be nested inside)
 * 3. run.callLog (execution logs — transcript may be embedded as conversation events)
 */
function resolveTranscript(run: any): Array<Record<string, string>> | null {
  if (Array.isArray(run.transcript) && run.transcript.length > 0) return run.transcript;
  const fromWebhook = extractTranscriptFromConversation(run.webhookData);
  if (fromWebhook && fromWebhook.length > 0) return fromWebhook;
  const fromCallLog = extractTranscriptFromCallLog(Array.isArray(run.callLog) ? run.callLog : []);
  if (fromCallLog && fromCallLog.length > 0) return fromCallLog;
  return null;
}

// ─── Main dispatcher ───────────────────────────────────────────────

export async function evaluateRun(runId: string) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { project: { include: { criteria: true } }, wordLabels: true },
  });

  if (!run) throw new Error(`Run ${runId} not found`);
  if (!run.callLog && !run.transcript && !run.webhookData) {
    throw new Error(`Run ${runId} has no data to evaluate`);
  }

  const results: Array<{
    criterionId: string;
    passed: boolean | null;
    score: number | null;
    detail: string | null;
    metadata?: Record<string, unknown> | null;
    costUsd?: number;
  }> = [];

  let totalCostUsd = 0;

  for (const criterion of run.project.criteria) {
    try {
      const result = await evaluateCriterion(criterion, run);
      results.push({ criterionId: criterion.id, ...result });
      if ((result as any).costUsd) totalCostUsd += (result as any).costUsd;
    } catch (err) {
      results.push({
        criterionId: criterion.id,
        passed: null,
        score: null,
        detail: `Evaluation error: ${(err as Error).message}`,
      });
    }
  }

  // Upsert results
  for (const r of results) {
    await prisma.evalResult.upsert({
      where: {
        runId_criterionId: { runId: run.id, criterionId: r.criterionId },
      },
      create: {
        runId: run.id,
        criterionId: r.criterionId,
        passed: r.passed,
        score: r.score,
        detail: r.detail,
        metadata: (r.metadata as any) ?? undefined,
      },
      update: {
        passed: r.passed,
        score: r.score,
        detail: r.detail,
        metadata: (r.metadata as any) ?? undefined,
        evaluatedAt: new Date(),
      },
    });
  }

  // Compute overall weighted score
  const criteria = run.project.criteria;
  let totalWeight = 0;
  let weightedSum = 0;
  for (const r of results) {
    if (r.score != null) {
      const criterion = criteria.find((c) => c.id === r.criterionId);
      const weight = criterion?.weight ?? 1;
      weightedSum += r.score * weight;
      totalWeight += weight;
    }
  }
  const overallScore = totalWeight > 0 ? weightedSum / totalWeight : null;

  await prisma.run.update({
    where: { id: runId },
    data: {
      status: "COMPLETE",
      overallScore,
      // Accumulate cost across re-evaluations so the total reflects every
      // LLM call ever made for this run. Use null only when there is truly
      // no cost at all (first eval with no LLM criteria).
      evalCost: (() => {
        const cumulative = (run.evalCost ?? 0) + totalCostUsd;
        return cumulative > 0 ? cumulative : null;
      })(),
      completedAt: new Date(),
    },
  });

  return { runId, overallScore, results };
}

// ─── Criterion router ──────────────────────────────────────────────

async function evaluateCriterion(criterion: Criterion, run: any) {
  switch (criterion.type) {
    case "DETERMINISTIC":
      return evaluateDeterministic(criterion, run);
    case "STRUCTURAL":
      return evaluateStructural(criterion, run);
    case "LLM_JUDGE":
      return evaluateLLMJudge(criterion, run);
    case "WORD_ACCURACY":
      return evaluateWordAccuracy(criterion, run);
    case "LATENCY":
      return evaluateLatency(criterion, run);
    case "FLOW_PROGRESSION":
      return evaluateFlowProgression(criterion, run);
    case "ACTION_CONSISTENCY":
      return evaluateActionConsistency(criterion, run);
    default:
      return { passed: null, score: null, detail: `Unknown type: ${criterion.type}` };
  }
}

// ─── Helpers: extract flow data from call log ──────────────────────

function extractFlowData(callLog: any[]) {
  // Count node movements (each "Node moved" = one node transition)
  // Hamsa logs: { category: "node_movement", message: "Node moved", payload: { action: "move_node" } }
  // NOTE: no node_id in payload — node IDs are not exposed in Hamsa execution logs.
  const nodeMoves = callLog.filter(
    (e: any) => e.category === "node_movement" && e.message === "Node moved"
  );

  // Node visits: use "Conversation Node" events (one per node entered).
  // Each entry has a unique timestamp that serves as an ordered sequence marker.
  // Since no node IDs are available, we use the index as a label (node-1, node-2, …).
  const conversationNodeEvents = callLog.filter(
    (e: any) => e.category === "CONVERSATION" && e.message === "Conversation Node"
  );
  const nodeSequence: string[] = conversationNodeEvents.map((_: any, i: number) => `node-${i + 1}`);
  const visitedNodeIds = new Set<string>(nodeSequence);

  // Extract variables: Hamsa logs "Extracting N variables" with payload.variables = string[]
  // Also handle legacy format: "Updated variable" / "Extracted variable" with payload.variable
  const extractedVars: string[] = [];
  for (const e of callLog) {
    if (e.category !== "VARIABLE_EXTRACTION") continue;
    if (Array.isArray(e.payload?.variables)) {
      extractedVars.push(...e.payload.variables);
    } else if (e.payload?.variable) {
      extractedVars.push(e.payload.variable);
    } else if (e.payload?.name) {
      extractedVars.push(e.payload.name);
    }
  }

  // External tool executions (HTTP tool calls, not internal flow routing tools like "move__xxx")
  // Hamsa logs these as "Executing Tool" / "Tool Success" / "Tool Error" / "Tool Failed"
  const toolExecutions = callLog.filter(
    (e: any) => e.category === "TOOLS" && e.message === "Executing Tool"
  );
  const toolSuccesses = callLog.filter(
    (e: any) => e.category === "TOOLS" && e.message === "Tool Success"
  );

  // Count "Waiting for user input" events (each = a turn where agent paused for response)
  const waitingEvents = callLog.filter(
    (e: any) => e.category === "CONVERSATION" && e.message === "Waiting for user input"
  );

  // Count flow chain starts
  const chainStarts = callLog.filter(
    (e: any) => e.category === "FLOW" && e.message === "Starting node chain execution"
  );

  // Total nodes defined in the flow (from init event)
  const initEvent = callLog.find(
    (e: any) => e.category === "FLOW" && e.message === "Initializing flow runtime"
  );
  const totalNodesInFlow = initEvent?.payload?.total_nodes || 0;

  return {
    nodeMoves: nodeMoves.length,
    uniqueNodesVisited: visitedNodeIds.size,
    nodeSequence,
    extractedVars: [...new Set(extractedVars)],
    toolExecutions: toolExecutions.length,
    toolSuccesses: toolSuccesses.length,
    waitingEvents: waitingEvents.length,
    chainStarts: chainStarts.length,
    totalNodesInFlow,
  };
}

// ─── DETERMINISTIC — Tool Calls ────────────────────────────────────

function evaluateDeterministic(criterion: Criterion, run: any) {
  const expected = criterion.expectedValue as any;
  const callLog = run.callLog;

  if (!Array.isArray(callLog)) {
    return { passed: null, score: null, detail: "No call log available" };
  }

  // Tool calls check
  if (expected.requiredTools) {
    const toolEvents = callLog.filter(
      (e: any) => e.category === "TOOLS" && e.message === "Executing Tool"
    );
    const calledTools = toolEvents.map((e: any) => e.payload?.toolName);

    // Count both HTTP-level failures (Tool Success with ok=false) and error events
    const failedToolEvents = callLog.filter(
      (e: any) =>
        e.category === "TOOLS" && (
          (e.message === "Tool Success" && e.payload?.response?.ok === false) ||
          e.message === "Tool Error" ||
          e.message === "Tool Failed"
        )
    );
    const failedTools = failedToolEvents.map(
      (e: any) => e.payload?.toolName || "unknown"
    );

    const required: string[] = expected.requiredTools;
    const missing = required.filter(
      (t) => !calledTools.some((c: string) => c?.includes(t))
    );

    const score = required.length > 0 ? (required.length - missing.length) / required.length : 1;

    return {
      passed: missing.length === 0 && failedTools.length === 0,
      score,
      detail: `Called: [${calledTools.join(", ")}] | Missing: [${missing.join(", ")}] | Failed: [${failedTools.join(", ")}]`,
    };
  }

  // Variable extraction check
  // Hamsa logs: { category: "VARIABLE_EXTRACTION", message: "Extracting N variables", payload: { variables: string[] } }
  // Legacy format: message: "Updated variable", payload: { variable: string }
  if (expected.requiredVariables) {
    const extractedVars: string[] = [];
    for (const e of callLog) {
      if (e.category !== "VARIABLE_EXTRACTION") continue;
      if (Array.isArray(e.payload?.variables)) extractedVars.push(...e.payload.variables);
      else if (e.payload?.variable) extractedVars.push(e.payload.variable);
      else if (e.payload?.name) extractedVars.push(e.payload.name);
    }
    const required: string[] = expected.requiredVariables;
    const missing = required.filter((v) => !extractedVars.includes(v));
    const score = required.length > 0 ? (required.length - missing.length) / required.length : 1;

    return {
      passed: missing.length === 0,
      score,
      detail: `Extracted: [${[...new Set(extractedVars)].join(", ")}] | Missing: [${missing.join(", ")}]`,
    };
  }

  return { passed: null, score: null, detail: "No expected value defined for DETERMINISTIC" };
}

// ─── STRUCTURAL — Node Transitions ─────────────────────────────────

function evaluateStructural(criterion: Criterion, run: any) {
  const expected = criterion.expectedValue as any;
  const callLog = run.callLog;

  if (!Array.isArray(callLog)) {
    return { passed: null, score: null, detail: "No call log available" };
  }

  if (expected.expectedSequence) {
    // Hamsa logs don't include node IDs on node_movement events.
    // Use count of "Conversation Node" events as a proxy for nodes visited.
    const conversationNodes = callLog.filter(
      (e: any) => e.category === "CONVERSATION" && e.message === "Conversation Node"
    );
    const nodesVisited = conversationNodes.length;
    const expectedSeq: string[] = expected.expectedSequence;
    const expectedCount = expectedSeq.length;

    const score = expectedCount > 0 ? Math.min(nodesVisited / expectedCount, 1) : 1;

    return {
      passed: nodesVisited >= expectedCount,
      score,
      detail: `Visited ${nodesVisited} nodes, expected ${expectedCount}. (Node IDs not available in Hamsa logs — using node count as proxy.)`,
    };
  }

  return { passed: null, score: null, detail: "No expectedSequence defined" };
}

// ─── LLM_JUDGE ─────────────────────────────────────────────────────

async function evaluateLLMJudge(criterion: Criterion, run: any) {
  // Prefer stored transcript; fall back to extracting from the raw conv object (webhookData)
  const transcript: any[] | null =
    resolveTranscript(run);

  const expected = criterion.expectedValue as any;

  if (!transcript || transcript.length === 0) {
    return { passed: null, score: null, detail: "No transcript available" };
  }

  // Build transcript text
  const transcriptText = transcript
    .map((t: any) => {
      if (t.Agent) return `[Agent]: ${t.Agent}`;
      if (t.User) {
        const gender = t.metadata?.gender ? ` (gender: ${t.metadata.gender})` : "";
        return `[User${gender}]: ${t.User}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

  // Add gender context if available
  let genderContext = "";
  const userUtterances = transcript.filter((t: any) => t.User && t.metadata?.gender);
  if (userUtterances.length > 0) {
    genderContext = "\n\nDetected user gender from utterances:\n" +
      userUtterances
        .map((t: any) => `"${t.User}" — detected gender: ${t.metadata.gender}`)
        .join("\n");
  }

  const agentSummary: string = run.project?.agentSummary ?? "";
  const contextPrefix = agentSummary
    ? `AGENT CONTEXT (use this to understand what the agent is designed to do):\n${agentSummary}\n\n`
    : "";

  const rule: string = expected.rule || expected.prompt || "Evaluate this transcript";

  // Gender detection requires understanding Arabic morphology and speaker roles —
  // use gpt-4.1 (not mini) to avoid misattributing agent self-reference as errors.
  const isGenderCriterion = /gender/i.test(rule);
  const modelOverride = isGenderCriterion ? "gpt-4.1" : undefined;

  return evaluateWithLLMJudge(
    rule,
    contextPrefix + transcriptText + genderContext,
    false,
    modelOverride
  );
}

// ─── WORD_ACCURACY ─────────────────────────────────────────────────

function evaluateWordAccuracy(criterion: Criterion, run: any) {
  const transcript: any[] | null =
    resolveTranscript(run);

  const wordLabels = run.wordLabels || [];
  const expected = criterion.expectedValue as any;
  const threshold = expected?.threshold ?? 0.95;

  if (!transcript || transcript.length === 0) {
    return { passed: null, score: null, detail: "No transcript available" };
  }

  // Count total words from Agent utterances only — word labels annotate agent speech
  const allWords: string[] = [];
  for (const utterance of transcript) {
    const text = utterance.Agent || "";
    const words = text.split(/\s+/).filter(Boolean);
    allWords.push(...words);
  }

  const totalWords = allWords.length;
  if (totalWords === 0) {
    return { passed: true, score: 1, detail: "No words in transcript" };
  }

  const wrongWords = wordLabels.filter(
    (l: any) => l.labelType === "WRONG_WORD"
  ).length;
  const wrongLang = wordLabels.filter(
    (l: any) => l.labelType === "WRONG_LANGUAGE"
  ).length;
  const wrongGender = wordLabels.filter(
    (l: any) => l.labelType === "WRONG_GENDER"
  ).length;
  const hallucinated = wordLabels.filter(
    (l: any) => l.labelType === "HALLUCINATED"
  ).length;

  const totalErrors = wrongWords + wrongLang + wrongGender + hallucinated;
  const score = 1 - totalErrors / totalWords;

  return {
    passed: score >= threshold,
    score: Math.max(0, score),
    detail: `${totalErrors} errors out of ${totalWords} words (WER: ${((totalErrors / totalWords) * 100).toFixed(1)}%). Wrong: ${wrongWords}, Wrong language: ${wrongLang}, Wrong gender: ${wrongGender}, Hallucinated: ${hallucinated}`,
    metadata: { wrongWords, wrongLang, wrongGender, hallucinated, totalWords },
  };
}

// ─── LATENCY ───────────────────────────────────────────────────────
// Note: Agent turns don't have timestamps — only User turns have metadata.created_at.
// Latency is measured from call log timestamps: time between "Waiting for user input"
// and next node action, plus tool execution times.

function evaluateLatency(criterion: Criterion, run: any) {
  const callLog = run.callLog;
  const expected = criterion.expectedValue as any;
  const maxToolLatencyMs = expected?.maxToolLatencyMs ?? 3000;

  if (!Array.isArray(callLog)) {
    return { passed: null, score: null, detail: "No call log available" };
  }

  // Measure tool execution times.
  // Key by a composite of node_id + toolName + index to avoid collisions
  // when the same node runs multiple tools or the same tool runs twice.
  const toolStarts = new Map<string, { timestamp: string; tool: string }>();
  const toolLatencies: Array<{ tool: string; durationMs: number }> = [];
  let toolExecIndex = 0;

  for (const event of callLog) {
    if (event.category === "TOOLS" && event.message === "Executing Tool") {
      const key = `${event.node_id ?? ""}:${event.payload?.toolName ?? ""}:${toolExecIndex++}`;
      toolStarts.set(key, {
        timestamp: event.timestamp,
        tool: event.payload?.toolName || event.node_id || "unknown",
      });
    }
    if (
      event.category === "TOOLS" &&
      event.message === "Tool API call completed"
    ) {
      // Match the most recent unresolved start for this node+tool combo
      const matchKey = [...toolStarts.keys()]
        .reverse()
        .find((k) => k.startsWith(`${event.node_id ?? ""}:${event.payload?.toolName ?? ""}:`));
      if (matchKey) {
        const entry = toolStarts.get(matchKey)!;
        const start = new Date(entry.timestamp).getTime();
        const end = new Date(event.timestamp).getTime();
        if (!isNaN(start) && !isNaN(end)) {
          toolLatencies.push({
            tool: entry.tool,
            durationMs: end - start,
          });
        }
        toolStarts.delete(matchKey);
      }
    }
  }

  // Measure node transition times (time between consecutive node_movement events)
  const nodeMoves = callLog.filter(
    (e: any) => e.category === "node_movement"
  );
  const nodeTransitions: Array<{
    from: string;
    to: string;
    durationMs: number;
  }> = [];
  for (let i = 1; i < nodeMoves.length; i++) {
    const prev = new Date(nodeMoves[i - 1].timestamp).getTime();
    const curr = new Date(nodeMoves[i].timestamp).getTime();
    if (!isNaN(prev) && !isNaN(curr)) {
      nodeTransitions.push({
        from: nodeMoves[i - 1].node_id,
        to: nodeMoves[i].node_id,
        durationMs: curr - prev,
      });
    }
  }

  // Total call duration from webhook data — handle both numeric ms and ISO string timestamps
  const webhookData = run.webhookData as any;
  let totalDurationMs: number | null = null;
  if (webhookData?.data?.callEndedAt && webhookData?.data?.callStartedAt) {
    const startRaw = webhookData.data.callStartedAt;
    const endRaw = webhookData.data.callEndedAt;
    const startMs = typeof startRaw === "number" ? startRaw : new Date(startRaw).getTime();
    const endMs = typeof endRaw === "number" ? endRaw : new Date(endRaw).getTime();
    if (!isNaN(startMs) && !isNaN(endMs)) totalDurationMs = endMs - startMs;
  }
  // Fall back to run.callDuration (seconds) if available
  if (totalDurationMs === null && run.callDuration) {
    totalDurationMs = run.callDuration * 1000;
  }

  // Score based on tool latency
  const toolsOverLimit = toolLatencies.filter(
    (t) => t.durationMs > maxToolLatencyMs
  );
  const toolScore =
    toolLatencies.length > 0
      ? (toolLatencies.length - toolsOverLimit.length) / toolLatencies.length
      : 1;

  return {
    passed: toolsOverLimit.length === 0,
    score: toolScore,
    detail: `Tool latencies: ${toolLatencies.map((t) => `${t.tool}: ${t.durationMs}ms`).join(", ")}. Total call: ${totalDurationMs ? `${(totalDurationMs / 1000).toFixed(1)}s` : "N/A"}`,
    metadata: { toolLatencies, nodeTransitions, totalDurationMs },
  };
}

// ─── FLOW_PROGRESSION ──────────────────────────────────────────────
// Sends structured call data + expected flow to GPT-4.1 for deep analysis.
// The LLM evaluates whether the agent progressed correctly, got stuck,
// failed to understand user intent, or missed transitions.

async function evaluateFlowProgression(_criterion: Criterion, run: any) {
  const callLog = Array.isArray(run.callLog) ? run.callLog : null;
  const transcript: any[] | null =
    resolveTranscript(run);
  const agentStructure = run.project?.agentStructure;

  if (!callLog && !transcript) {
    return { passed: null, score: null, detail: "No data available" };
  }

  // Extract flow stats for context
  const flow = callLog ? extractFlowData(callLog) : {
    nodeMoves: 0, uniqueNodesVisited: 0, nodeSequence: [],
    extractedVars: [], toolExecutions: 0, toolSuccesses: 0,
    waitingEvents: 0, chainStarts: 0, totalNodesInFlow: 0,
  };

  // Build the expected flow definition (only nodes the agent should traverse)
  let expectedFlowSection = "";
  if (agentStructure?.workflow?.nodes) {
    const nodes = agentStructure.workflow.nodes as any[];
    const edges = agentStructure.workflow.edges as any[];

    // Build a readable flow description
    expectedFlowSection = "EXPECTED AGENT FLOW (nodes in order):\n";
    for (const node of nodes) {
      const nodeEdges = edges?.filter((e: any) => e.source === node.id) || [];
      const targets = nodeEdges.map((e: any) => e.target).join(", ");
      expectedFlowSection += `- Node "${node.label}" (id: ${node.id}, type: ${node.type})\n`;
      if (node.message) {
        expectedFlowSection += `  Purpose: ${node.message.slice(0, 150)}...\n`;
      }
      if (node.transitions?.length) {
        for (const t of node.transitions) {
          expectedFlowSection += `  Transition: "${t.condition?.description || t.condition?.prompt}"\n`;
        }
      }
      if (node.extractVariables?.variables?.length) {
        expectedFlowSection += `  Extracts: ${node.extractVariables.variables.map((v: any) => v.name).join(", ")}\n`;
      }
      if (targets) {
        expectedFlowSection += `  → Connects to: ${targets}\n`;
      }
      expectedFlowSection += "\n";
    }
  }

  // Build transcript section
  let transcriptSection = "";
  if (transcript) {
    transcriptSection = "CONVERSATION TRANSCRIPT:\n";
    for (const t of transcript) {
      if (t.Agent) transcriptSection += `[Agent]: ${t.Agent}\n`;
      if (t.User) {
        const meta = t.metadata ? ` (gender: ${t.metadata.gender}, time: ${t.metadata.created_at})` : "";
        transcriptSection += `[User${meta}]: ${t.User}\n`;
      }
    }
  }

  // Build call log section — only relevant events, with timestamps
  let callLogSection = "";
  if (callLog) {
    const relevantEvents = callLog.filter((e: any) =>
      e.type === "INFO" || (e.type === "DEBUG" && (
        e.message?.includes("Playing message") ||
        e.message?.includes("Tool Success") ||
        e.message?.includes("Tool API call")
      ))
    );
    callLogSection = "CALL LOG (timestamped events):\n";
    for (const e of relevantEvents) {
      callLogSection += `[${e.timestamp}] ${e.category}: ${e.message}`;
      if (e.payload?.variable) callLogSection += ` → ${e.payload.variable}=${e.payload.new_value || e.payload.value}`;
      if (e.payload?.toolName) callLogSection += ` → tool: ${e.payload.toolName}`;
      if (e.payload?.total_nodes) callLogSection += ` (${e.payload.total_nodes} nodes)`;
      if (e.payload?.action) callLogSection += ` (${e.payload.action})`;
      callLogSection += "\n";
    }
  }

  // Build summary stats
  const statsSection = `FLOW STATISTICS:
- Total nodes in flow: ${flow.totalNodesInFlow}
- Node movements detected: ${flow.nodeMoves}
- Unique nodes visited: ${flow.uniqueNodesVisited}
- Variables extracted: [${flow.extractedVars.join(", ")}]
- Tool executions: ${flow.toolExecutions} (successes: ${flow.toolSuccesses})
- Times agent waited for user input: ${flow.waitingEvents}
- Flow chain starts: ${flow.chainStarts}
`;

  const agentSummary: string = run.project?.agentSummary ?? "";
  const prompt = `You are evaluating a voice AI agent's ability to navigate through a multi-node conversation flow.
${agentSummary ? `\nAGENT CONTEXT:\n${agentSummary}\n` : ""}
${expectedFlowSection}
${statsSection}
${callLogSection}
${transcriptSection}

EVALUATION TASK:
Analyze the call and return structured metrics. For each category, count total requests/attempts AND errors/failures. This lets us calculate success percentages.

CATEGORIES TO EVALUATE:

1. **Language Switching**: Count how many times language switching was requested or needed, and how many times it failed or was incorrect.
2. **Gender Detection**: Count how many utterances required gender-appropriate grammar, and how many had wrong gender inflection.
3. **Tool Calls**: Count tools executed vs tools that failed or returned errors.
4. **Data Reading**: Count data fields successfully retrieved from tools vs fields that were misread or ignored by the agent.
5. **Node Transitions**: Count successful node transitions vs failed transitions (user gave the info needed to move forward but agent stayed stuck). This is CRITICAL — carefully analyze each user turn and determine if the agent should have transitioned but didn't.
6. **Knowledge Base**: Count KB retrieval requests vs errors.
7. **MCP Tools**: Count MCP requests vs errors.
8. **Outcome Fields**: Count outcome fields correctly filled vs wrong values.

For each failed transition, provide:
- What the user said
- What the expected behavior was (which node should it have moved to)
- What the agent actually did
- A brief comment explaining the failure

Respond with JSON only:
{
  "passed": true | false,
  "score": 0.0 to 1.0,
  "metrics": {
    "language_switching": { "total": number, "errors": number, "comment": "brief note if any issues" },
    "gender_detection": { "total": number, "errors": number, "comment": "" },
    "tool_calls": { "total": number, "errors": number, "comment": "" },
    "data_reading": { "total": number, "errors": number, "comment": "" },
    "node_transitions": { "total": number, "errors": number, "comment": "" },
    "kb_retrieval": { "total": number, "errors": number, "comment": "" },
    "mcp_usage": { "total": number, "errors": number, "comment": "" },
    "outcome_fields": { "total": number, "errors": number, "comment": "" }
  },
  "word_count": number,
  "dialect": "Gulf/Egyptian/Levantine/English/None",
  "last_node_reached": "node label",
  "nodes_completed": number,
  "nodes_expected": number,
  "stuck_on_node": "node label if stuck, or null",
  "stuck_turns": number,
  "failed_transitions": [
    {
      "user_said": "what the user said",
      "expected_action": "which node it should have moved to and why",
      "actual_action": "what the agent did instead",
      "comment": "brief explanation of the failure"
    }
  ],
  "variables_extracted": ["list"],
  "variables_missed": ["list"],
  "detail": "2-3 sentence summary: overall flow performance, where it got stuck, key failures, number of transition failures"
}`;

  const result = await evaluateWithLLMJudge(prompt, "", true);

  // Enhance with flow stats in metadata
  return {
    ...result,
    metadata: {
      flow,
      llmAnalysis: result.detail,
    } as any,
  };
}

// ─── ACTION_CONSISTENCY — Logs vs Transcript Cross-Reference ──────
// Compares what the agent said (transcript) against what the system
// logs show it actually did. Identifies mismatches, errors, root causes,
// and actionable fix suggestions.

async function evaluateActionConsistency(_criterion: Criterion, run: any) {
  const callLog = Array.isArray(run.callLog) ? run.callLog : null;
  const transcript: any[] | null =
    resolveTranscript(run);
  const agentStructure = run.project?.agentStructure;

  if (!callLog && !transcript) {
    return { passed: null, score: null, detail: "No data available for consistency check" };
  }
  if (!callLog || (Array.isArray(callLog) && callLog.length === 0)) {
    return { passed: null, score: null, detail: "No call log available — cannot cross-reference actions" };
  }
  if (!transcript || (Array.isArray(transcript) && transcript.length === 0)) {
    return { passed: null, score: null, detail: "No transcript available — cannot cross-reference speech" };
  }

  // ── Build AGENT DEFINITION section ──
  let agentDefSection = "";
  if (agentStructure?.workflow?.nodes) {
    const nodes = agentStructure.workflow.nodes as any[];
    const edges = agentStructure.workflow.edges as any[];
    agentDefSection = "AGENT DEFINITION (what the agent is designed to do):\n";
    for (const node of nodes) {
      agentDefSection += `- Node "${node.label}" (id: ${node.id}, type: ${node.type})\n`;
      if (node.message) {
        agentDefSection += `  Prompt: ${node.message.slice(0, 200)}${node.message.length > 200 ? "..." : ""}\n`;
      }
      if (node.transitions?.length) {
        for (const t of node.transitions) {
          agentDefSection += `  Transition: "${t.condition?.description || t.condition?.prompt || "auto"}"\n`;
        }
      }
      if (node.extractVariables?.variables?.length) {
        agentDefSection += `  Extracts: ${node.extractVariables.variables.map((v: any) => `${v.name} (${v.type || "string"})`).join(", ")}\n`;
      }
      if (node.tools?.length) {
        agentDefSection += `  Tools: ${node.tools.map((t: any) => t.name || t).join(", ")}\n`;
      }
      const nodeEdges = edges?.filter((e: any) => e.source === node.id) || [];
      if (nodeEdges.length) {
        agentDefSection += `  → Connects to: ${nodeEdges.map((e: any) => e.target).join(", ")}\n`;
      }
      agentDefSection += "\n";
    }
  }

  // ── Build CALL LOG section (actions the system recorded) ──
  // Filter to relevant events, cap at 250 to stay within context limits
  const relevantCategories = new Set([
    "node_movement", "CONVERSATION", "TOOLS", "VARIABLE_EXTRACTION",
    "VARIABLE", "FLOW", "ROUTER", "ERROR", "WARNING", "KNOWLEDGE_BASE", "MCP",
  ]);
  const relevantEvents = callLog.filter((e: any) =>
    relevantCategories.has(e.category) ||
    e.type === "ERROR" ||
    e.type === "WARNING"
  );
  const cappedEvents = relevantEvents.slice(0, 250);
  const wasTruncated = relevantEvents.length > 250;

  let callLogSection = "CALL LOG (timestamped system events — what the agent actually did):\n";
  if (wasTruncated) {
    callLogSection += `[NOTE: Log truncated to 250 of ${relevantEvents.length} events]\n`;
  }
  for (const e of cappedEvents) {
    callLogSection += `[${e.timestamp}] ${e.category}: ${e.message}`;
    if (e.payload?.variable) callLogSection += ` → ${e.payload.variable}=${e.payload.new_value || e.payload.value || ""}`;
    if (e.payload?.toolName) callLogSection += ` → tool: ${e.payload.toolName}`;
    if (e.payload?.response?.ok === false) callLogSection += ` [FAILED]`;
    if (e.payload?.error) callLogSection += ` [ERROR: ${e.payload.error}]`;
    if (e.payload?.message && e.category === "CONVERSATION") {
      const msg = String(e.payload.message).slice(0, 120);
      callLogSection += ` → "${msg}${String(e.payload.message).length > 120 ? "..." : ""}"`;
    }
    if (e.payload?.total_nodes) callLogSection += ` (${e.payload.total_nodes} nodes)`;
    if (e.payload?.action) callLogSection += ` (${e.payload.action})`;
    callLogSection += "\n";
  }

  // ── Extract tool results specifically for cross-referencing ──
  const toolResults: string[] = [];
  for (let i = 0; i < callLog.length; i++) {
    const e = callLog[i];
    if (e.category === "TOOLS" && e.message === "Tool Success" && e.payload?.response) {
      const toolName = e.payload.toolName || "unknown";
      const response = JSON.stringify(e.payload.response).slice(0, 300);
      toolResults.push(`Tool "${toolName}" returned: ${response}`);
    }
    if (e.category === "TOOLS" && (e.payload?.response?.ok === false || e.payload?.error)) {
      const toolName = e.payload.toolName || "unknown";
      toolResults.push(`Tool "${toolName}" FAILED: ${e.payload.error || JSON.stringify(e.payload.response).slice(0, 200)}`);
    }
  }
  let toolResultsSection = "";
  if (toolResults.length > 0) {
    toolResultsSection = "TOOL EXECUTION RESULTS:\n" + toolResults.join("\n") + "\n";
  }

  // ── Build TRANSCRIPT section ──
  let transcriptSection = "CONVERSATION TRANSCRIPT (what was said):\n";
  for (const t of transcript) {
    if (t.Agent) transcriptSection += `[Agent]: ${t.Agent}\n`;
    if (t.User) {
      const meta = t.metadata ? ` (gender: ${t.metadata.gender || "unknown"}, time: ${t.metadata.created_at || "?"})` : "";
      transcriptSection += `[User${meta}]: ${t.User}\n`;
    }
  }

  // ── Build the prompt ──
  const agentSummarySection = run.project?.agentSummary
    ? `AGENT CONTEXT (purpose, expected flow, success criteria):\n${run.project?.agentSummary}\n\n`
    : "";

  const prompt = `You are a QA engineer performing a detailed cross-reference analysis between an AI voice agent's CALL LOG (system events) and its TRANSCRIPT (what was said).

Your task is to verify that what the agent SAID matches what it actually DID, identify every discrepancy, analyze the root cause of each error, and suggest specific fixes.

${agentSummarySection}${agentDefSection}
${callLogSection}
${toolResultsSection}
${transcriptSection}

ANALYSIS INSTRUCTIONS:
Go through the conversation turn by turn. For each agent turn in the transcript:
1. Find the corresponding system events in the call log
2. Verify the agent's speech matches what the logs show happened
3. Check these specific categories:

A. **Tool Call Accuracy**: Agent says "I found your balance is X" — does the log show a tool was called? Did the tool return X? Or did the agent misread/hallucinate the data?
B. **Action Execution**: Agent says "I've transferred you" or "I've updated your info" — does the log confirm this action was executed successfully?
C. **Variable Extraction**: Agent confirms a value from the user — does the log show the variable was extracted correctly with the right value?
D. **Error Handling**: When a tool fails or an error occurs in the log, did the agent handle it gracefully or did it pretend the action succeeded?
E. **Node Transition Correctness**: Based on what the user said, did the agent transition to the correct node? Or did it stay stuck / go to the wrong node?
F. **Phantom Actions**: Did the agent claim to do something that has no corresponding event in the logs?
G. **Missed Actions**: Did the logs show an action was needed but the agent never performed it?
H. **Data Accuracy**: When the agent read data from a tool response, did it read ALL fields correctly, or did it skip, misread, or hallucinate values?

For each error found, determine the ROOT CAUSE:
- "LLM_HALLUCINATION" — the LLM generated information not in the tool response
- "LLM_MISREAD" — the LLM read the tool response but extracted wrong values
- "TOOL_FAILURE" — the tool/API call failed and agent didn't handle it
- "TOOL_NOT_CALLED" — the agent should have called a tool but didn't
- "WRONG_TOOL" — the agent called the wrong tool
- "WRONG_TRANSITION" — the flow moved to an incorrect node
- "STUCK_TRANSITION" — the flow should have advanced but didn't
- "ASR_ERROR" — speech recognition misheard the user, causing downstream issues
- "PROMPT_ISSUE" — the node's prompt is ambiguous or incomplete, causing wrong behavior
- "MISSING_ERROR_HANDLING" — no fallback for a failure scenario

Respond with JSON only:
{
  "passed": true | false,
  "score": 0.0 to 1.0,
  "total_agent_turns": number,
  "turns_with_errors": number,
  "errors": [
    {
      "turn_index": number,
      "timestamp": "from call log if available",
      "category": "TOOL_ACCURACY" | "ACTION_EXECUTION" | "VARIABLE_EXTRACTION" | "ERROR_HANDLING" | "NODE_TRANSITION" | "PHANTOM_ACTION" | "MISSED_ACTION" | "DATA_ACCURACY",
      "severity": "critical" | "major" | "minor",
      "what_agent_said": "exact quote from transcript",
      "what_log_shows": "what the system log recorded",
      "expected_behavior": "what should have happened",
      "root_cause": "LLM_HALLUCINATION | LLM_MISREAD | TOOL_FAILURE | TOOL_NOT_CALLED | WRONG_TOOL | WRONG_TRANSITION | STUCK_TRANSITION | ASR_ERROR | PROMPT_ISSUE | MISSING_ERROR_HANDLING",
      "suggested_fix": "specific actionable fix — be concrete (e.g., 'Add null check for field X in tool response', 'Add fallback message when API returns empty')",
      "impact": "what user-facing impact this had"
    }
  ],
  "correct_actions": [
    {
      "category": "TOOL_ACCURACY" | "ACTION_EXECUTION" | "VARIABLE_EXTRACTION" | "NODE_TRANSITION" | "DATA_ACCURACY",
      "description": "what went right"
    }
  ],
  "error_summary": {
    "by_root_cause": { "LLM_HALLUCINATION": number, "LLM_MISREAD": number, "TOOL_FAILURE": number, "TOOL_NOT_CALLED": number, "WRONG_TOOL": number, "WRONG_TRANSITION": number, "STUCK_TRANSITION": number, "ASR_ERROR": number, "PROMPT_ISSUE": number, "MISSING_ERROR_HANDLING": number },
    "by_severity": { "critical": number, "major": number, "minor": number },
    "by_category": { "TOOL_ACCURACY": number, "ACTION_EXECUTION": number, "VARIABLE_EXTRACTION": number, "ERROR_HANDLING": number, "NODE_TRANSITION": number, "PHANTOM_ACTION": number, "MISSED_ACTION": number, "DATA_ACCURACY": number }
  },
  "recommendations": [
    "Top priority fix — most impactful change to improve the agent",
    "Second priority fix",
    "Third priority fix"
  ],
  "detail": "3-5 sentence executive summary: how well the agent's speech matched its actions, main failure patterns, and what to fix first"
}`;

  const result = await evaluateWithLLMJudge(prompt, "", true);

  // Parse the structured response from detail for metadata
  let parsedAnalysis: any = null;
  if (result.detail) {
    try { parsedAnalysis = JSON.parse(result.detail); } catch {}
  }

  return {
    passed: parsedAnalysis?.passed ?? result.passed,
    score: parsedAnalysis?.score ?? result.score,
    detail: result.detail,
    metadata: {
      type: "ACTION_CONSISTENCY",
      errors: parsedAnalysis?.errors || [],
      correct_actions: parsedAnalysis?.correct_actions || [],
      error_summary: parsedAnalysis?.error_summary || null,
      recommendations: parsedAnalysis?.recommendations || [],
      total_agent_turns: parsedAnalysis?.total_agent_turns || 0,
      turns_with_errors: parsedAnalysis?.turns_with_errors || 0,
    } as any,
  };
}
