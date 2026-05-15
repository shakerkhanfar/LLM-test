/**
 * Customer Experience Evaluator
 *
 * Third evaluation dimension alongside Quality and Compliance.
 * Measures how the interaction *felt* from the customer's perspective using
 * deterministic signals from the call log/transcript plus one LLM call for
 * empathy and resolution clarity.
 *
 * Score composition:
 *   experienceScore = interruption(20%) + latency(20%) + flowSmoothness(15%)
 *                   + empathy(25%) + resolution(20%)
 *
 * Requires OPENAI_API_KEY for the empathy/resolution sub-score.
 * Returns partial results (empathyScore = 50, resolutionScore = 50) on API
 * failure so the overall score is still meaningful.
 */

import { evaluateWithLLMJudge } from "./llmJudge";
import type { NodeVisit } from "./layeredEvaluator";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InterruptionEvent {
  utteranceIndex: number;
  text: string;
  nodeLabel: string;
}

export interface LatencyMeasurement {
  turnIndex: number;
  /** Milliseconds from "Waiting for user input" to next "Playing message". */
  waitMs: number;
  nodeLabel?: string;
}

export interface PerNodeExperience {
  nodeLabel: string;
  nodeType: string;
  interruptions: number;
  avgLatencyMs: number | null;
  correctionCycles: number;
  cutoffRestarts: number;
}

export interface ExperienceResult {
  /** 0-100 composite score. */
  experienceScore: number;
  interruptionScore: number;
  latencyScore: number;
  flowSmoothnessScore: number;
  empathyScore: number;
  resolutionScore: number;
  interruptions: InterruptionEvent[];
  latencies: LatencyMeasurement[];
  perNode: PerNodeExperience[];
  costUsd: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Arabic phrases a caller uses when they cannot hear the agent or suspect the
 * call dropped. Each match is an audio interruption event.
 */
const INTERRUPTION_REGEX =
  /\b(ألو|آلو|هالو|هلو|هالو؟|تسمعني|هل تسمعني|أنت معي|هل أنت هناك|فيه أحد|أهلا؟|اهلا؟|مرحبا؟)\b/i;

// ── Deterministic helpers ─────────────────────────────────────────────────────

/**
 * Scan transcript turns for Arabic "are you there?" patterns.
 * Maps each match back to the node visit it occurred in.
 */
function detectInterruptions(
  transcript: Array<Record<string, string>>,
  visits: NodeVisit[],
): InterruptionEvent[] {
  const events: InterruptionEvent[] = [];

  // Build a simple turn-to-node index: for each turn index, which nodeLabel?
  // visits[].transcriptTurns are the source-of-truth; traverse them in order.
  const turnNodeMap: string[] = [];
  for (const v of visits) {
    for (let i = 0; i < v.transcriptTurns.length; i++) {
      turnNodeMap.push(v.nodeLabel);
    }
  }

  let globalTurnIdx = 0;
  for (let i = 0; i < transcript.length; i++) {
    const turn = transcript[i];
    const text = turn.User || turn.Agent || "";
    if (turn.User && INTERRUPTION_REGEX.test(turn.User)) {
      events.push({
        utteranceIndex: i,
        text: turn.User,
        nodeLabel: turnNodeMap[globalTurnIdx] ?? "unknown",
      });
    }
    globalTurnIdx++;
  }

  return events;
}

/**
 * Walk the call log looking for consecutive "Waiting for user input" →
 * "Playing message" pairs and compute the delta in milliseconds.
 * This approximates the total round-trip time per conversation turn
 * (user speech + STT + LLM + TTS + platform overhead).
 */
function measureLatencies(callLog: any[]): LatencyMeasurement[] {
  const measurements: LatencyMeasurement[] = [];
  let waitTs: number | null = null;
  let waitIdx = 0;
  let turnIndex = 0;

  for (let i = 0; i < callLog.length; i++) {
    const e = callLog[i];
    if (!e.timestamp) continue;

    if (e.category === "CONVERSATION" && e.message === "Waiting for user input") {
      waitTs = new Date(e.timestamp).getTime();
      waitIdx = turnIndex++;
    } else if (
      waitTs !== null &&
      e.category === "CONVERSATION" &&
      typeof e.message === "string" &&
      e.message.startsWith("Playing message")
    ) {
      const playTs = new Date(e.timestamp).getTime();
      if (Number.isFinite(playTs) && playTs > waitTs) {
        measurements.push({ turnIndex: waitIdx, waitMs: playTs - waitTs });
      }
      waitTs = null;
    }
  }

  return measurements;
}

/**
 * Detect when the agent restarted a sentence mid-utterance — a sign the
 * previous audio was cut by the user or platform noise.
 *
 * Heuristic: consecutive agent turns in the same visit where the second turn
 * shares >50% of words with the first (but is not identical — identical is
 * a stuck-loop, handled by Layer 2) and the first turn is shorter than 20 words.
 */
function detectCutoffRestarts(visits: NodeVisit[]): number {
  let count = 0;
  for (const v of visits) {
    const agentTurns = v.transcriptTurns
      .filter((t) => t.speaker === "Agent")
      .map((t) => t.text.trim().toLowerCase().split(/\s+/).filter(Boolean));

    for (let i = 0; i + 1 < agentTurns.length; i++) {
      const a = agentTurns[i];
      const b = agentTurns[i + 1];
      if (a.length === 0 || a.length >= 20) continue; // only flag short turns
      const setA = new Set(a);
      const overlap = b.filter((w) => setA.has(w)).length;
      const overlapRatio = overlap / Math.max(setA.size, 1);
      // >50% overlap but not identical (identical is a stuck-loop)
      if (overlapRatio > 0.5 && overlap < a.length) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Detect correction cycles: the agent asks for information the user has
 * already provided in a previous turn of the same node.
 *
 * Heuristic: if the agent turns in a node contain >1 distinct question
 * (ending with "?") and the user turns between them contain content
 * (≥3 words each), that's a correction cycle.
 */
function detectCorrectionCycles(visits: NodeVisit[]): number {
  let count = 0;
  for (const v of visits) {
    if (v.nodeType !== "conversation" && v.nodeType !== "start") continue;

    const agentQuestions = v.transcriptTurns
      .filter((t) => t.speaker === "Agent" && t.text.includes("?"))
      .map((t) => t.text.trim().toLowerCase().split(/\s+/).filter(Boolean));

    if (agentQuestions.length < 2) continue;

    // Check if the user answered in between (≥3 words = substantive answer)
    const userSubstantive = v.transcriptTurns
      .filter((t) => t.speaker === "User")
      .some((t) => t.text.trim().split(/\s+/).filter(Boolean).length >= 3);

    if (userSubstantive) {
      // Check if questions are semantically similar (word overlap > 40%)
      const q1 = new Set(agentQuestions[0]);
      const q2 = agentQuestions[agentQuestions.length - 1];
      const overlap = q2.filter((w) => q1.has(w)).length;
      const ratio = overlap / Math.max(q1.size, 1);
      if (ratio > 0.4) count++;
    }
  }
  return count;
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

function scoreInterruptions(count: number): number {
  if (count === 0) return 100;
  if (count === 1) return 80;
  if (count === 2) return 60;
  if (count <= 4) return 35;
  return 15;
}

/**
 * Converts average RTT to a 0-100 score.
 * Voicebot RTT naturally includes user speech time (~2-5s), STT (~0.5s),
 * LLM (~1-3s), TTS (~0.5s). Baseline of ~5s is expected; penalise above 10s.
 */
function scoreLatency(avgMs: number): number {
  const s = avgMs / 1000;
  if (s <= 8) return 100;
  if (s <= 12) return 85;
  if (s <= 18) return 70;
  if (s <= 25) return 50;
  if (s <= 35) return 25;
  return 10;
}

function scoreFlowSmoothness(correctionCycles: number, cutoffRestarts: number): number {
  return Math.max(0, 100 - correctionCycles * 20 - cutoffRestarts * 10);
}

// ── LLM: Empathy + Resolution ─────────────────────────────────────────────────

interface EmpathyResult {
  empathyScore: number;     // 0-100
  resolutionScore: number;  // 0-100
  costUsd: number;
}

async function evaluateEmpathyAndResolution(
  transcript: Array<Record<string, string>>,
  agentSummary: string,
): Promise<EmpathyResult> {
  const transcriptText = transcript
    .map((t) => (t.Agent ? `Agent: ${t.Agent}` : `User: ${t.User}`))
    .join("\n")
    .slice(0, 6000); // cap to keep prompt small

  const prompt = `You are evaluating a voice AI customer-service call transcript.
Score two dimensions on a 0-10 scale (integers only):

EMPATHY (0-10): How well did the agent acknowledged the user's feelings, frustrations, or needs? Did it adapt tone appropriately? 0 = robotic / dismissive. 10 = warm, responsive, appropriately empathetic.

RESOLUTION CLARITY (0-10): How clearly was the outcome or next step communicated to the user? Did the user know what happened and what to expect? 0 = user left confused. 10 = clear, actionable resolution stated.

AGENT PURPOSE:
${agentSummary ? agentSummary.slice(0, 500) : "Voice AI agent"}

TRANSCRIPT:
${transcriptText}

Respond ONLY with valid JSON, no other text:
{"passed": null, "score": null, "empathy": <0-10>, "resolution": <0-10>}`;

  try {
    // isFullPrompt=true returns raw JSON in the detail field
    const { detail, costUsd } = await evaluateWithLLMJudge(
      prompt,
      "",
      true,
      "gpt-4.1-mini",
    );
    const parsed = JSON.parse(detail);
    const empathy = Math.min(10, Math.max(0, Number(parsed?.empathy ?? 5)));
    const resolution = Math.min(10, Math.max(0, Number(parsed?.resolution ?? 5)));
    return {
      empathyScore: Math.round(empathy * 10),
      resolutionScore: Math.round(resolution * 10),
      costUsd,
    };
  } catch {
    return { empathyScore: 50, resolutionScore: 50, costUsd: 0 };
  }
}

// ── Per-node aggregation ──────────────────────────────────────────────────────

function buildPerNodeExperience(
  visits: NodeVisit[],
  interruptions: InterruptionEvent[],
  latencies: LatencyMeasurement[],
  correctionsByNode: Map<string, number>,
  cutoffsByNode: Map<string, number>,
): PerNodeExperience[] {
  const intrByNode = new Map<string, number>();
  for (const ev of interruptions) {
    intrByNode.set(ev.nodeLabel, (intrByNode.get(ev.nodeLabel) ?? 0) + 1);
  }

  // Assign latencies to nodes via turn ordering.
  // latencies[i].turnIndex is the Nth "Waiting for user input" event across the call.
  // We approximate by distributing latencies proportionally across conversation nodes.
  const convVisits = visits.filter(
    (v) => v.nodeType === "conversation" || v.nodeType === "start",
  );
  const latencyByNode = new Map<string, number[]>();
  let latIdx = 0;
  for (const v of convVisits) {
    const turnCount = v.transcriptTurns.filter((t) => t.speaker === "User").length;
    const slice = latencies.slice(latIdx, latIdx + turnCount);
    if (slice.length > 0) {
      latencyByNode.set(v.nodeLabel, slice.map((l) => l.waitMs));
    }
    latIdx += turnCount;
  }

  return visits
    .filter((v) => v.nodeType === "conversation" || v.nodeType === "start" || v.nodeType === "tool")
    .map((v) => {
      const nodeLats = latencyByNode.get(v.nodeLabel);
      const avgLat =
        nodeLats && nodeLats.length > 0
          ? nodeLats.reduce((s, x) => s + x, 0) / nodeLats.length
          : null;
      return {
        nodeLabel: v.nodeLabel,
        nodeType: v.nodeType,
        interruptions: intrByNode.get(v.nodeLabel) ?? 0,
        avgLatencyMs: avgLat,
        correctionCycles: correctionsByNode.get(v.nodeLabel) ?? 0,
        cutoffRestarts: cutoffsByNode.get(v.nodeLabel) ?? 0,
      };
    });
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function evaluateExperience(
  callLog: any[],
  transcript: Array<Record<string, string>>,
  visits: NodeVisit[],
  agentSummary: string,
): Promise<ExperienceResult> {
  // 1. Deterministic metrics
  const interruptions = detectInterruptions(transcript, visits);
  const latencies = measureLatencies(callLog);
  const cutoffRestarts = detectCutoffRestarts(visits);
  const correctionCycles = detectCorrectionCycles(visits);

  // Per-node maps (currently whole-call — may expand to per-node later)
  const correctionsByNode = new Map<string, number>();
  const cutoffsByNode = new Map<string, number>();
  // Populate per-visit breakdowns
  for (const v of visits) {
    const vCycles = detectCorrectionCycles([v]);
    const vCutoffs = detectCutoffRestarts([v]);
    if (vCycles > 0) correctionsByNode.set(v.nodeLabel, vCycles);
    if (vCutoffs > 0) cutoffsByNode.set(v.nodeLabel, vCutoffs);
  }

  // 2. Sub-scores
  const interruptionScore = scoreInterruptions(interruptions.length);
  const avgLatencyMs =
    latencies.length > 0
      ? latencies.reduce((s, l) => s + l.waitMs, 0) / latencies.length
      : null;
  const latencyScore = avgLatencyMs != null ? scoreLatency(avgLatencyMs) : 75; // neutral if no data
  const flowSmoothnessScore = scoreFlowSmoothness(correctionCycles, cutoffRestarts);

  // 3. LLM sub-scores
  const { empathyScore, resolutionScore, costUsd } =
    await evaluateEmpathyAndResolution(transcript, agentSummary);

  // 4. Composite
  const experienceScore = Math.round(
    interruptionScore * 0.20 +
    latencyScore      * 0.20 +
    flowSmoothnessScore * 0.15 +
    empathyScore      * 0.25 +
    resolutionScore   * 0.20,
  );

  const perNode = buildPerNodeExperience(
    visits,
    interruptions,
    latencies,
    correctionsByNode,
    cutoffsByNode,
  );

  return {
    experienceScore,
    interruptionScore,
    latencyScore,
    flowSmoothnessScore,
    empathyScore,
    resolutionScore,
    interruptions,
    latencies,
    perNode,
    costUsd,
  };
}
