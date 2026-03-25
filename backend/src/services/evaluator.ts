import { PrismaClient, CriterionType, Run, Criterion } from "@prisma/client";
import { evaluateWithLLMJudge } from "./llmJudge";

const prisma = new PrismaClient();

// ─── Main dispatcher ───────────────────────────────────────────────

export async function evaluateRun(runId: string) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { project: { include: { criteria: true } }, wordLabels: true },
  });

  if (!run) throw new Error(`Run ${runId} not found`);
  if (!run.callLog && !run.transcript) {
    throw new Error(`Run ${runId} has no data to evaluate`);
  }

  const results: Array<{
    criterionId: string;
    passed: boolean | null;
    score: number | null;
    detail: string | null;
    metadata?: Record<string, unknown> | null;
  }> = [];

  for (const criterion of run.project.criteria) {
    try {
      const result = await evaluateCriterion(criterion, run);
      results.push({ criterionId: criterion.id, ...result });
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
    default:
      return { passed: null, score: null, detail: `Unknown type: ${criterion.type}` };
  }
}

// ─── Helpers: extract flow data from call log ──────────────────────

function extractFlowData(callLog: any[]) {
  // Count node movements
  const nodeMoves = callLog.filter(
    (e: any) => e.category === "node_movement" && e.message === "Node moved"
  );

  // Count unique nodes visited (by node_id or by inferring from conversation prompts)
  const visitedNodeIds = new Set<string>();
  const nodeSequence: string[] = [];

  for (const e of callLog) {
    if (e.category === "node_movement" && e.node_id) {
      visitedNodeIds.add(e.node_id);
      nodeSequence.push(e.node_id);
    }
  }

  // If node_ids are null, infer from conversation prompts (each unique prompt = different node)
  if (visitedNodeIds.size === 0) {
    const prompts = callLog.filter(
      (e: any) => e.category === "CONVERSATION" && e.message === "Playing message (prompt) [non-blocking]"
    );
    for (const p of prompts) {
      const msg = p.payload?.message?.slice(0, 80) || "unknown";
      visitedNodeIds.add(msg);
      nodeSequence.push(msg);
    }
  }

  // Extract variable extractions completed
  const extractedVars = callLog
    .filter((e: any) =>
      e.category === "VARIABLE_EXTRACTION" &&
      (e.message?.includes("Updated variable") || e.message?.includes("Extracted variable"))
    )
    .map((e: any) => e.payload?.variable || e.payload?.name)
    .filter(Boolean);

  // Extract tool executions
  const toolExecutions = callLog.filter(
    (e: any) => e.category === "TOOLS" && e.message === "Executing Tool"
  );

  // Extract tool successes
  const toolSuccesses = callLog.filter(
    (e: any) => e.category === "TOOLS" && e.message === "Tool Success"
  );

  // Count "Waiting for user input" events (each = a turn where agent asked and waited)
  const waitingEvents = callLog.filter(
    (e: any) => e.category === "CONVERSATION" && e.message === "Waiting for user input"
  );

  // Count flow chain starts
  const chainStarts = callLog.filter(
    (e: any) => e.category === "FLOW" && e.message === "Starting node chain execution"
  );

  // Total nodes in flow
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
  const callLog = run.callLog as any[];

  if (!callLog) {
    return { passed: null, score: null, detail: "No call log available" };
  }

  // Tool calls check
  if (expected.requiredTools) {
    const toolEvents = callLog.filter(
      (e: any) => e.category === "TOOLS" && e.message === "Executing Tool"
    );
    const calledTools = toolEvents.map((e: any) => e.payload?.toolName);

    const failedToolEvents = callLog.filter(
      (e: any) =>
        e.category === "TOOLS" &&
        e.message === "Tool Success" &&
        e.payload?.response?.ok === false
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
  if (expected.requiredVariables) {
    const varEvents = callLog.filter(
      (e: any) =>
        e.category === "VARIABLE_EXTRACTION" &&
        e.message?.includes("Updated variable")
    );
    const extractedVars = varEvents.map((e: any) => e.payload?.variable);

    const required: string[] = expected.requiredVariables;
    const missing = required.filter((v) => !extractedVars.includes(v));
    const score = required.length > 0 ? (required.length - missing.length) / required.length : 1;

    return {
      passed: missing.length === 0,
      score,
      detail: `Extracted: [${extractedVars.join(", ")}] | Missing: [${missing.join(", ")}]`,
    };
  }

  return { passed: null, score: null, detail: "No expected value defined for DETERMINISTIC" };
}

// ─── STRUCTURAL — Node Transitions ─────────────────────────────────

function evaluateStructural(criterion: Criterion, run: any) {
  const expected = criterion.expectedValue as any;
  const callLog = run.callLog as any[];

  if (!callLog) {
    return { passed: null, score: null, detail: "No call log available" };
  }

  if (expected.expectedSequence) {
    const nodeEvents = callLog.filter(
      (e: any) => e.category === "node_movement" && e.message === "Node moved"
    );
    const actual = nodeEvents.map((e: any) => e.node_id);

    // Deduplicate consecutive same nodes
    const deduped: string[] = [];
    for (const n of actual) {
      if (deduped[deduped.length - 1] !== n) deduped.push(n);
    }

    const expectedSeq: string[] = expected.expectedSequence;

    // Subsequence match
    let ei = 0;
    for (const node of deduped) {
      if (ei < expectedSeq.length && node === expectedSeq[ei]) ei++;
    }

    const matchedCount = ei;
    const score = expectedSeq.length > 0 ? matchedCount / expectedSeq.length : 1;

    return {
      passed: score === 1.0,
      score,
      detail: `Matched ${matchedCount}/${expectedSeq.length} nodes.\nExpected: ${expectedSeq.join(" → ")}\nActual: ${deduped.join(" → ")}`,
    };
  }

  return { passed: null, score: null, detail: "No expectedSequence defined" };
}

// ─── LLM_JUDGE ─────────────────────────────────────────────────────

async function evaluateLLMJudge(criterion: Criterion, run: any) {
  const transcript = run.transcript as any[];
  const expected = criterion.expectedValue as any;

  if (!transcript) {
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

  return evaluateWithLLMJudge(
    expected.rule || expected.prompt || "Evaluate this transcript",
    transcriptText + genderContext
  );
}

// ─── WORD_ACCURACY ─────────────────────────────────────────────────

function evaluateWordAccuracy(criterion: Criterion, run: any) {
  const transcript = run.transcript as any[];
  const wordLabels = run.wordLabels || [];
  const expected = criterion.expectedValue as any;
  const threshold = expected?.threshold ?? 0.95;

  if (!transcript) {
    return { passed: null, score: null, detail: "No transcript available" };
  }

  // Count total words from all agent utterances
  const allWords: string[] = [];
  for (const utterance of transcript) {
    const text = utterance.Agent || utterance.User || "";
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
  const callLog = run.callLog as any[];
  const expected = criterion.expectedValue as any;
  const maxToolLatencyMs = expected?.maxToolLatencyMs ?? 3000;
  const maxNodeTransitionMs = expected?.maxNodeTransitionMs ?? 2000;

  if (!callLog) {
    return { passed: null, score: null, detail: "No call log available" };
  }

  // Measure tool execution times
  const toolStarts: Record<string, string> = {};
  const toolLatencies: Array<{ tool: string; durationMs: number }> = [];

  for (const event of callLog) {
    if (event.category === "TOOLS" && event.message === "Executing Tool") {
      toolStarts[event.node_id] = event.timestamp;
    }
    if (
      event.category === "TOOLS" &&
      event.message === "Tool API call completed" &&
      toolStarts[event.node_id]
    ) {
      const start = new Date(toolStarts[event.node_id]).getTime();
      const end = new Date(event.timestamp).getTime();
      toolLatencies.push({
        tool: event.payload?.request?.url || event.node_id,
        durationMs: end - start,
      });
      delete toolStarts[event.node_id];
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
    nodeTransitions.push({
      from: nodeMoves[i - 1].node_id,
      to: nodeMoves[i].node_id,
      durationMs: curr - prev,
    });
  }

  // Total call duration from webhook data
  const webhookData = run.webhookData as any;
  const totalDurationMs = webhookData?.data?.callEndedAt && webhookData?.data?.callStartedAt
    ? webhookData.data.callEndedAt - webhookData.data.callStartedAt
    : null;

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

async function evaluateFlowProgression(criterion: Criterion, run: any) {
  const callLog = run.callLog as any[];
  const transcript = run.transcript as any[];
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

  const prompt = `You are evaluating a voice AI agent's ability to navigate through a multi-node conversation flow.

${expectedFlowSection}
${statsSection}
${callLogSection}
${transcriptSection}

EVALUATION CRITERIA — analyze the call data and produce exact numeric counts for each metric:

1. **Word Count**: Total number of words spoken by the agent across the entire conversation
2. **Dialect**: What Arabic dialect was used (0=none/English, identify if Gulf/Egyptian/Levantine etc.)
3. **Language Switch Requests**: How many times did the user request or trigger a language switch?
4. **Language Switching Errors**: How many times did the agent fail to switch language correctly when requested?
5. **Gender Detection**: Did the agent correctly detect and use the right gender grammar? (1=correct, 0=not applicable)
6. **Gender Detection Errors**: How many times did the agent use wrong gender-inflected Arabic grammar?
7. **Tools Executed**: How many tool/function calls were executed during the call?
8. **Failed Tool Calls**: How many tool calls failed or returned errors?
9. **Data Retrieved**: How many pieces of data were successfully retrieved from tool calls?
10. **Data Reading Errors**: How many times did the agent fail to read or use retrieved data correctly?
11. **Node Transitions**: Total number of node transitions that occurred
12. **Node Transition Errors**: How many times did the agent fail to transition when it should have? (user provided required info but agent stayed on same node)
13. **Knowledge Base Requests**: How many knowledge base queries were made?
14. **Knowledge Base Errors**: How many KB queries failed or returned wrong info?
15. **MCP Requests**: How many MCP tool requests were made?
16. **MCP Usage Errors**: How many MCP requests failed?
17. **Outcome Fields**: How many outcome fields were filled?
18. **Wrong Outcomes**: How many outcome fields had incorrect values?
19. **Flow Progression**: Which node did the agent reach? How far through the expected flow?
20. **Failed Transition Details**: For each failed transition, describe what the user said and what should have happened

Respond with JSON only:
{
  "passed": true | false,
  "score": 0.0 to 1.0,
  "word_count": number,
  "dialect": "Gulf/Egyptian/Levantine/English/None",
  "language_switch_requests": number,
  "language_switching_errors": number,
  "gender_detection": number (1=correct, 0=N/A),
  "gender_detection_errors": number,
  "tools_executed": number,
  "failed_tool_calls": number,
  "data_retrieved": number,
  "data_reading_errors": number,
  "node_transitions": number,
  "node_transition_errors": number,
  "kb_requests": number,
  "kb_errors": number,
  "mcp_requests": number,
  "mcp_errors": number,
  "outcome_fields": number,
  "wrong_outcomes": number,
  "last_node_reached": "node label",
  "nodes_completed": number,
  "nodes_expected": number,
  "stuck_on_node": "node label if stuck, or null",
  "stuck_turns": number,
  "failed_transitions": [{"user_said": "what user said", "expected_action": "what should have happened", "actual_action": "what agent did instead"}],
  "variables_extracted": ["list"],
  "variables_missed": ["list"],
  "detail": "2-3 sentence summary including: how many transitions failed, where agent got stuck, key errors"
}`;

  const result = await evaluateWithLLMJudge(prompt, "");

  // Enhance with flow stats in metadata
  return {
    ...result,
    metadata: {
      flow,
      llmAnalysis: result.detail,
    } as any,
  };
}
