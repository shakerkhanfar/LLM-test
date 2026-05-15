import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import T from "../theme";
import { getRun, createLabel, deleteLabel, triggerEvaluation, rehydrateRun, getRecordingUrl } from "../api/client";

const WorkflowCanvas = lazy(() => import("../components/WorkflowCanvas"));

// ─── Goal Achievement ──────────────────────────────────────────────

type GoalStatus = "SUCCESSFUL" | "FAILED" | "PARTIAL";

function computeGoal(run: any): { status: GoalStatus; reason: string } | null {
  if (run.status !== "COMPLETE") return null;

  const callStatus = (run.callStatus || "").toUpperCase();
  const outcome = (run.callOutcome || "").toLowerCase();
  const score: number | null = run.overallScore ?? null;
  // Handle "Sunnary" typo (double-n, capital S) that some agent LLMs emit alongside "summary"
  const summary: string = run.outcomeResult?.summary || run.outcomeResult?.Sunnary || "";
  const evalResults: any[] = run.evalResults || [];


  if (["NO_ANSWER", "BUSY", "VOICEMAIL"].includes(callStatus)) {
    const why = callStatus === "NO_ANSWER" ? "Call was not answered."
              : callStatus === "BUSY"      ? "Line was busy."
              : "Reached voicemail — no live conversation.";
    return { status: "FAILED", reason: why };
  }
  if (callStatus === "FAILED") {
    return { status: "FAILED", reason: "Call failed before completing." };
  }

  const failedCriteria = evalResults
    .filter((er: any) => er.score != null && er.score < 0.5)
    .map((er: any) => er.criterion?.label || er.criterion?.key)
    .filter(Boolean) as string[];
  const failedStr = failedCriteria.length ? ` Issues: ${failedCriteria.join(", ")}.` : "";

  // Check objective_met from outcomeResult — most reliable signal
  const objectiveMet = (run.outcomeResult?.objective_met || "").toLowerCase();

  // Check negative BEFORE positive — "not_interested" ⊃ "interested"
  const isNegative = outcome.includes("not_interested") || outcome.includes("rejected")
                  || outcome.includes("refused")        || outcome.includes("declined")
                  || outcome.includes("hangup")         || outcome.includes("hang_up")
                  || objectiveMet === "no";
  const isPositive = !isNegative && (
    outcome.includes("interested") || outcome.includes("success")   ||
    outcome.includes("booked")     || outcome.includes("converted") ||
    outcome.includes("completed")  || outcome.includes("agreed")
    || objectiveMet === "yes"
  );
  const isFollowup = !isNegative && !isPositive && (
    outcome.includes("followup") || outcome.includes("callback")
    || outcome.includes("pending")   || outcome.includes("later")
    || objectiveMet === "partial"
  );

  if (isNegative) {
    const isIncomplete = outcome.includes("hangup") || outcome.includes("hang_up")
                      || outcome.includes("stuck")  || outcome.includes("timeout")
                      || outcome.includes("confused") || outcome.includes("dropped");
    // "transferred" = agent correctly escalated an out-of-scope or complex request
    // — not a "customer declined" scenario, treat like an incomplete/redirected call
    const isTransferred = outcome.includes("transferred") || outcome.includes("transfer");
    const status: GoalStatus = (score != null && score >= 0.7) ? "PARTIAL" : "FAILED";
    const reason = summary
      || (isIncomplete || isTransferred
        ? (status === "PARTIAL"
          ? `Call ended before objective was met, but agent performed correctly (${(score! * 100).toFixed(0)}% quality).`
          : `Call did not complete — ${outcome.replace(/_/g, " ")}.${failedStr}`)
        : (status === "PARTIAL"
          ? `Customer declined, but the agent performed correctly (${(score! * 100).toFixed(0)}% quality).`
          : `Customer was not interested.${failedStr}`));
    return { status, reason };
  }
  if (isPositive) {
    if (score == null || score >= 0.7) {
      return { status: "SUCCESSFUL", reason: summary || `Call goal achieved.${failedStr}` };
    }
    return {
      status: "PARTIAL",
      reason: summary || `Positive outcome but agent quality was below target (${(score * 100).toFixed(0)}%).${failedStr}`,
    };
  }
  if (isFollowup) {
    return { status: "PARTIAL", reason: summary || `Call resulted in a follow-up, no definitive outcome yet.${failedStr}` };
  }

  if (score == null) return null;
  if (score >= 0.8) return { status: "SUCCESSFUL", reason: summary || `Agent performed well (${(score * 100).toFixed(0)}% quality score).` };
  if (score >= 0.5) return { status: "PARTIAL",    reason: summary || `Agent partially met the call goal (${(score * 100).toFixed(0)}% quality).${failedStr}` };
  return              { status: "FAILED",           reason: summary || `Agent did not meet the call goal (${(score * 100).toFixed(0)}% quality).${failedStr}` };
}

const GOAL_STYLE: Record<GoalStatus, { color: string; bg: string; border: string }> = {
  SUCCESSFUL: { color: "#22c55e", bg: T.successBg, border: "#22c55e55" },
  PARTIAL:    { color: "#f59e0b", bg: T.warningBg, border: "#f59e0b55" },
  FAILED:     { color: "#ef4444", bg: T.errorBg, border: "#ef444455" },
};

// ─── End Goal Achievement ──────────────────────────────────────────

function formatOutcome(outcome: string): string {
  return outcome.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function outcomeStyle(outcome: string): { color: string; bg: string } {
  const lower = outcome.toLowerCase();
  // Negative outcomes must be checked BEFORE positive ones — "not_interested" contains "interested"
  if (lower.includes("not_interested") || lower.includes("rejected") || lower.includes("declined") || lower.includes("refused") || lower.includes("hangup") || lower.includes("hang_up"))
    return { color: "#ef4444", bg: T.errorBg };
  if (lower.includes("interested") || lower.includes("success") || lower.includes("converted") || lower.includes("booked"))
    return { color: "#22c55e", bg: T.successBg };
  if (lower.includes("followup") || lower.includes("callback") || lower.includes("pending") || lower.includes("later"))
    return { color: "#f59e0b", bg: T.warningBg };
  if (lower.includes("no_answer") || lower.includes("busy") || lower.includes("voicemail"))
    return { color: "#6b7280", bg: T.cardAlt };
  return { color: "#a78bfa", bg: "#f3e8ff" };
}

function OutcomeBadge({ outcome, size = "small" }: { outcome: string | null | undefined; size?: "small" | "large" }) {
  if (!outcome) return <span style={{ color: T.textFaint, fontSize: 12 }}>—</span>;
  const { color, bg } = outcomeStyle(outcome);
  return (
    <span style={{
      fontSize: size === "large" ? 14 : 11,
      padding: size === "large" ? "4px 12px" : "2px 8px",
      borderRadius: 10,
      background: bg, color,
      border: `1px solid ${color}44`,
      whiteSpace: "nowrap",
      fontWeight: size === "large" ? 600 : 400,
    }}>
      {formatOutcome(outcome)}
    </span>
  );
}

// Labels for Agent utterances
const AGENT_LABEL_TYPES = [
  { type: "LLM_ERROR", label: "Wrong Word (LLM)", desc: "LLM generated the wrong word" },
  { type: "TTS_ERROR", label: "Wrong Pronunciation (TTS)", desc: "Text-to-speech mispronounced" },
  { type: "WRONG_LANGUAGE", label: "Wrong Language", desc: "Word in wrong language" },
  { type: "WRONG_GENDER", label: "Wrong Gender", desc: "Wrong gender inflection" },
  { type: "HALLUCINATED", label: "Hallucinated", desc: "Word shouldn't have been said" },
];

// Labels for User utterances
const USER_LABEL_TYPES = [
  { type: "ASR_ERROR", label: "Wrong Transcription (ASR)", desc: "Speech-to-text transcribed incorrectly" },
  { type: "WRONG_WORD", label: "Wrong Word", desc: "Word is incorrect" },
];

const LABEL_TYPES = [
  ...AGENT_LABEL_TYPES.map((t) => t.type),
  ...USER_LABEL_TYPES.map((t) => t.type),
];

const LABEL_COLORS: Record<string, string> = {
  WRONG_WORD: "#ef4444",
  WRONG_LANGUAGE: "#f59e0b",
  WRONG_GENDER: "#a855f7",
  HALLUCINATED: "#ec4899",
  LLM_ERROR: "#ef4444",
  TTS_ERROR: "#f97316",
  ASR_ERROR: "#06b6d4",
};

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function RunDetail() {
  const { id, runId } = useParams();
  const [run, setRun] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [labelingWord, setLabelingWord] = useState<{ wordIndex: number; utteranceIndex: number; word: string; speaker: string } | null>(null);
  const [audioError, setAudioError] = useState(false);
  const [audioErrorDetail, setAudioErrorDetail] = useState<string | null>(null);
  const [freshRecordingUrl, setFreshRecordingUrl] = useState<string | null>(null);
  const [recordingRefreshAttempted, setRecordingRefreshAttempted] = useState(false);
  const [recordingRefreshing, setRecordingRefreshing] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  // Incremented when the user retries after a failed load — forces the audio
  // element to reload the stream (changing src is the only way to trigger a reload).
  const [audioSrcVersion, setAudioSrcVersion] = useState(0);
  const [reEvaluating, setReEvaluating] = useState(false);
  const [rehydrating, setRehydrating] = useState(false);
  const [labeling, setLabeling] = useState(false);
  // Tracks which runId the current poll belongs to. When the user navigates
  // to a different run, this ref changes and any in-flight poll for the old
  // runId will see a mismatch and stop — preventing stale data from being
  // applied to the new page.
  const activeRunIdRef = useRef<string | null>(null);
  // Prevents setState calls on an unmounted component (e.g. user navigates away
  // while a rehydrate/eval poll is in flight).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = () => {
    getRun(runId!)
      .then(setRun)
      .finally(() => setLoading(false));
  };


  // Reset per-run state when navigating between runs
  useEffect(() => {
    activeRunIdRef.current = runId!; // mark the new run; invalidates all old polls
    setLoading(true);
    setAudioError(false);
    setAudioErrorDetail(null);
    setFreshRecordingUrl(null);
    setRecordingRefreshAttempted(false);
    setRecordingRefreshing(false);
    setAudioTime(0);
    setAudioDuration(0);
    setIsAudioPlaying(false);
    setIsMuted(false);
    setAudioSrcVersion(0);
    setReEvaluating(false);
    setLabelingWord(null);
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // ── Audio-sync: node movement timeline ─────────────────────────────
  // Computed here (before early returns) so hooks are always called in the same order.
  // Uses run?.callLog with optional chaining since run may be null while loading.
  //
  // Two extraction paths, mirroring FlowProgressionView:
  //   1. Primary: `node_movement` category events with a node_id/nodeId field.
  //   2. Fallback: when (1) yields nothing, attribute the first known timestamp
  //      to each visited node by fuzzy-matching "Playing message" events against
  //      node prompts. This handles calls where Hamsa logs movements without IDs.
  const nodeMovementsForSync = useMemo(() => {
    const cl = Array.isArray((run as any)?.callLog) ? (run as any).callLog : [];
    const workflowNodes = (run as any)?.project?.agentStructure?.workflow?.nodes ?? [];

    const out: Array<{ nodeId: string; timestamp: string }> = [];
    for (const e of cl) {
      const nid = e.node_id || e.nodeId;
      if (e.category === "node_movement" && nid && e.timestamp) {
        out.push({ nodeId: nid, timestamp: e.timestamp });
      }
    }

    // Path 2: TRANSITION/ROUTER payload.next_node — present in logs since mid-2025.
    // These carry the real destination node ID so no fuzzy matching is needed.
    // TRANSITION fires when the agent leaves a node; next_node is the destination.
    // ROUTER fires at a decision point; next_node is the chosen branch.
    if (out.length === 0) {
      for (const e of cl) {
        if (!e.timestamp) continue;
        const nextNode = e.payload?.next_node;
        if (!nextNode) continue;
        if (e.category === "TRANSITION" || e.category === "ROUTER") {
          out.push({ nodeId: String(nextNode), timestamp: e.timestamp });
        }
      }
      // Deduplicate: ROUTER and TRANSITION can both fire for the same movement
      // at the same instant, producing two identical (nodeId, timestamp) pairs.
      const seenKeys = new Set<string>();
      for (let i = out.length - 1; i >= 0; i--) {
        const key = `${out[i].nodeId}|${out[i].timestamp}`;
        if (seenKeys.has(key)) out.splice(i, 1);
        else seenKeys.add(key);
      }
      // Prepend the start node: TRANSITION.next_node is always a destination, so
      // the first node (greeting) is never emitted by any transition event.
      // Without this, activeNodeId is null for the entire greeting segment.
      if (out.length > 0) {
        const startNode = workflowNodes.find((n: any) => n.type === "start");
        const firstEventTs = cl.find((e: any) => e.timestamp)?.timestamp;
        if (startNode && firstEventTs) {
          out.unshift({ nodeId: String(startNode.id), timestamp: firstEventTs });
        }
      }
    }

    if (out.length === 0 && workflowNodes.length > 0) {
      // Fallback: Hamsa prod logs sometimes emit `nodeId: null` on every event
      // (we've seen this on the Noura agent). We derive movements from:
      //   (a) "Playing message" → conversation/start nodes (match by prompt text)
      //   (b) "Executing Tool" → tool nodes (match by agentStructure.tools toolId→nodeId)
      //   (c) ROUTER events    → router nodes (best-effort, no per-event linkage)
      //
      // Whitespace must be normalized for (a): Hamsa replaces literal spaces in
      // logged prompts with newlines (and other whitespace runs).
      const norm = (s: string) =>
        s.replace(/\{\{.*?\}\}/g, "")
         .replace(/\s+/g, " ")
         .trim();

      // (a) Conversation/start nodes via prompt text
      const prompts = cl.filter((e: any) => typeof e?.message === "string" && e.message.includes("Playing message"));
      for (const p of prompts) {
        const msg = norm(p.payload?.message || "");
        if (!msg || !p.timestamp) continue;
        const msgPrefix = msg.slice(0, 60);
        for (const node of workflowNodes) {
          if (!node.message) continue;
          const nodeMsg = norm(String(node.message));
          if (!nodeMsg) continue;
          const nodePrefix = nodeMsg.slice(0, 60);
          const probe = 30;
          if (msgPrefix.includes(nodePrefix.slice(0, probe)) ||
              nodePrefix.includes(msgPrefix.slice(0, probe))) {
            out.push({ nodeId: node.id, timestamp: p.timestamp });
            break;
          }
        }
      }

      // (b) Tool nodes via agentStructure.tools (nodeId↔toolId registry).
      // A single Hamsa toolId is typically registered against MANY workflow
      // nodes (every node that may call it), so a flat toolId→nodeId map
      // picks the wrong node. Disambiguate by graph proximity, using
      // `workflow.edges` as the source of truth (node.transitions[].targetNodeId
      // is empty string in prod data — only the React-Flow edges array is
      // populated with the real wiring).
      const agentTools: Array<{ nodeId?: string; toolId?: string }> =
        (run as any)?.project?.agentStructure?.tools ?? [];
      const toolIdToNodeIds = new Map<string, string[]>();
      for (const t of agentTools) {
        if (!t.toolId || !t.nodeId) continue;
        const key = String(t.toolId);
        const arr = toolIdToNodeIds.get(key) ?? [];
        arr.push(String(t.nodeId));
        toolIdToNodeIds.set(key, arr);
      }

      // Build outgoing-edges map from workflow.edges (the real graph).
      const wfEdges: any[] = (run as any)?.project?.agentStructure?.workflow?.edges ?? [];
      const outgoingTargetsByNode = new Map<string, string[]>();
      for (const e of wfEdges) {
        const src = e?.source ?? e?.sourceNodeId;
        const tgt = e?.target ?? e?.targetNodeId;
        if (!src || !tgt) continue;
        const arr = outgoingTargetsByNode.get(src) ?? [];
        arr.push(tgt);
        outgoingTargetsByNode.set(src, arr);
      }

      const toolEvents = cl.filter((e: any) => e?.category === "TOOLS" && e?.message === "Executing Tool");
      for (const te of toolEvents) {
        const tid = te.payload?.toolId;
        const ts  = te.timestamp;
        if (!tid || !ts) continue;
        const candidates = toolIdToNodeIds.get(String(tid)) ?? [];
        if (candidates.length === 0) continue;

        // Find the most-recently-visited node before this tool's timestamp.
        const tsMs = new Date(ts).getTime();
        const priorMovements = out.filter(m => new Date(m.timestamp).getTime() <= tsMs);
        priorMovements.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const lastPriorId = priorMovements[priorMovements.length - 1]?.nodeId;

        // 1st choice: direct neighbour of the prior visited node that matches a candidate
        let chosen: string | null = null;
        if (lastPriorId) {
          const neighbours = outgoingTargetsByNode.get(lastPriorId) ?? [];
          for (const n of neighbours) {
            if (candidates.includes(n)) { chosen = n; break; }
          }
        }
        // 2nd choice: any candidate reachable 1 hop further (handles a
        // conversation→router→tool pattern, common when a router gates the
        // tool call from a shared conversation node).
        if (!chosen && lastPriorId) {
          const hop1 = outgoingTargetsByNode.get(lastPriorId) ?? [];
          for (const mid of hop1) {
            const hop2 = outgoingTargetsByNode.get(mid) ?? [];
            const hit = hop2.find(n => candidates.includes(n));
            if (hit) { chosen = hit; break; }
          }
        }
        // Last resort: first registered candidate (deterministic, but
        // potentially wrong if the prior-node signal is missing entirely).
        if (!chosen) chosen = candidates[0];
        out.push({ nodeId: chosen, timestamp: ts });
      }

      // (c) Router nodes — use the same edge-based graph lookup. Find router
      // nodes that the prior visited node connects to (via workflow.edges).
      const routerNodes = workflowNodes.filter((n: any) => n.type === "router");
      const routerNodeIds = new Set(routerNodes.map((n: any) => n.id));
      const routerEvents = cl.filter((e: any) => e?.category === "ROUTER" && e?.timestamp);
      for (const re of routerEvents) {
        const ts = re.timestamp;
        let target: string | null = null;
        if (out.length > 0) {
          const sorted = [...out].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
          const prevId = sorted[sorted.length - 1].nodeId;
          const neighbours = outgoingTargetsByNode.get(prevId) ?? [];
          target = neighbours.find(n => routerNodeIds.has(n)) ?? null;
        }
        if (!target && routerNodes.length > 0) target = routerNodes[0].id;
        if (target) out.push({ nodeId: target, timestamp: ts });
      }
    }

    // Sort ascending by timestamp. Filter invalid first so sort comparator
    // never produces NaN (undefined behavior in some engines).
    return out
      .filter(m => Number.isFinite(new Date(m.timestamp).getTime()))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }, [
    (run as any)?.callLog,
    (run as any)?.project?.agentStructure?.workflow?.nodes,
    (run as any)?.project?.agentStructure?.workflow?.edges,
    (run as any)?.project?.agentStructure?.tools,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Absolute ms anchor for audioTime = 0. The recording starts when the call
  // connects (ringing/lead-in), not when the agent says its first word. Prefer
  // run.callDate as the anchor; only fall back to the first node movement
  // timestamp if callDate is missing. Without this, every node highlight would
  // appear ~3-5 seconds too early relative to what the user hears.
  const callStartMs = useMemo(() => {
    const cd = (run as any)?.callDate;
    if (cd) {
      const ms = new Date(cd).getTime();
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
    if (nodeMovementsForSync.length === 0) return null;
    const ms = new Date(nodeMovementsForSync[0].timestamp).getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }, [(run as any)?.callDate, nodeMovementsForSync]);

  // The node the agent was on at the current audio playback position.
  // Computed whenever audioTime > 0, not just while playing — so the highlight
  // persists when the user pauses to inspect the canvas.
  const activeNodeId = useMemo(() => {
    if (callStartMs == null || nodeMovementsForSync.length === 0) return null;
    const absTimeMs = callStartMs + audioTime * 1000;
    let active: string | null = null;
    for (const m of nodeMovementsForSync) {
      const ms = new Date(m.timestamp).getTime();
      if (ms <= absTimeMs) active = m.nodeId;
      else break;
    }
    return active;
  }, [audioTime, callStartMs, nodeMovementsForSync]);

  // Per-utterance audio offsets derived from CONVERSATION events in the call log.
  // Agent turns are matched to "Playing message" events; user turns to STT/recognition events.
  // Index matches transcript[i] — null when no timestamp can be derived.
  const transcriptTimestamps = useMemo((): (number | null)[] => {
    const tArr = Array.isArray((run as any)?.transcript) ? (run as any).transcript : [];
    if (!callStartMs || tArr.length === 0) return tArr.map(() => null);
    const cl = Array.isArray((run as any)?.callLog) ? (run as any).callLog : [];

    const agentTimes: number[] = [];
    const userTimes: number[] = [];

    for (const e of cl) {
      if (e.category !== "CONVERSATION" || !e.timestamp) continue;
      const ts = new Date(e.timestamp).getTime();
      if (!Number.isFinite(ts)) continue;
      const role = e.payload?.role ? String(e.payload.role).toLowerCase() : null;
      const msgLower = String(e.message ?? "").toLowerCase();
      if (role === "agent" || msgLower.includes("playing message") || msgLower.includes("agent said") || msgLower.includes("agent response")) {
        agentTimes.push(ts);
      } else if (role === "user" || msgLower.includes("user said") || msgLower.includes("user input") || msgLower.includes("recognition") || msgLower.includes("stt")) {
        userTimes.push(ts);
      }
    }

    let ai = 0, ui = 0;
    return tArr.map((utt: any) => {
      const ts = utt.Agent ? agentTimes[ai++] : userTimes[ui++];
      if (ts == null) return null;
      const offset = (ts - callStartMs) / 1000;
      return Number.isFinite(offset) && offset >= 0 ? offset : null;
    });
  }, [(run as any)?.transcript, (run as any)?.callLog, callStartMs]);

  if (loading) return <p>Loading...</p>;
  if (!run) return <p>Run not found</p>;

  const transcript = (run.transcript || []) as any[];
  const evalResults = (run.evalResults || []) as any[];
  const layeredDetail: any = (() => {
    const le = evalResults.find((er: any) => er.criterion?.type === "LAYERED_EVALUATION");
    if (!le?.detail) return null;
    try { return typeof le.detail === "string" ? JSON.parse(le.detail) : le.detail; } catch { return null; }
  })();
  const objectiveAchieved: boolean | null = layeredDetail?.objectiveAchieved != null ? !!layeredDetail.objectiveAchieved : null;
  const complianceScore: number | null = layeredDetail?.complianceScore ?? null;

  // Resolve recording URL — prefer a fresh URL (fetched after CloudFront expiry),
  // fall back to the stored webhook URL for recent calls where it's still valid.
  const recordingUrl: string | null = freshRecordingUrl || (() => {
    const w = run.webhookData as any;
    return (
      w?.data?.conversationRecording ||      // webhook: payload.data.conversationRecording
      w?.mediaUrl ||                         // history runs: conv.mediaUrl
      w?.data?.recordingUrl ||               // live webhook: payload.data.recordingUrl
      w?.data?.recording_url ||
      w?.caller_info?.recording_url ||
      w?.recordingUrl ||
      null
    );
  })();
  // Use our backend streaming proxy for the <audio> src so the browser always
  // receives the correct Content-Type header. CloudFront serves OGG files as
  // application/octet-stream which Chrome refuses to play (code 4 error).
  // The stream proxy URL. The ?v= cache-buster forces the audio element to reload
  // after a successful retry (browser won't re-fetch if the src string is unchanged).
  const audioSrc: string | null = recordingUrl ? `/api/runs/${runId}/recording-stream?v=${audioSrcVersion}` : null;
  const wordLabels = (run.wordLabels || []) as any[];

  // Flatten words for labeling.
  // uttStartIdx[ui] = first globalWordIndex of utterance ui, so any word at position wi
  // within utterance ui has globalIndex = uttStartIdx[ui] + wi. This is O(n) and handles
  // duplicate words in the same utterance correctly (no findIndex needed during render).
  let globalWordIndex = 0;
  const flatWords: Array<{ word: string; utteranceIndex: number; globalIndex: number; speaker: string }> = [];
  const uttStartIdx: number[] = [];
  transcript.forEach((utt: any, ui: number) => {
    uttStartIdx[ui] = globalWordIndex;
    const text = utt.Agent || utt.User || "";
    const speaker = utt.Agent ? "Agent" : "User";
    text.split(/\s+/).filter(Boolean).forEach((w: string) => {
      flatWords.push({ word: w, utteranceIndex: ui, globalIndex: globalWordIndex, speaker });
      globalWordIndex++;
    });
  });

  async function handleLabel(type: string, correction?: string) {
    if (!labelingWord || labeling) return;
    setLabeling(true);
    try {
      await createLabel(runId!, {
        wordIndex: labelingWord.wordIndex,
        utteranceIndex: labelingWord.utteranceIndex,
        originalWord: labelingWord.word,
        labelType: type,
        correction: correction || null,
      });
      setLabelingWord(null);
      load();
    } finally {
      setLabeling(false);
    }
  }

  async function handleRemoveLabel(labelId: string) {
    if (labeling) return;
    setLabeling(true);
    try {
      await deleteLabel(labelId);
      setLabelingWord(null);
      load();
    } finally {
      setLabeling(false);
    }
  }

  return (
    <div>
      <Link to={`/projects/${id}`} style={{ color: T.textSecondary, textDecoration: "none", fontSize: 14 }}>
        &larr; Back to project
      </Link>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "16px 0" }}>
        <h1 style={{ margin: 0 }}>{run.modelUsed}</h1>
        <span style={{ color: run.status === "COMPLETE" ? "#22c55e" : "#f59e0b", fontSize: 14 }}>
          {run.status}
        </span>
      </div>

      {/* Call IDs — copyable */}
      {(run.conversationId || run.hamsaCallId) && (
        <div style={{ display: "flex", gap: 16, marginBottom: 16, fontSize: 12, color: T.textSecondary }}>
          {run.conversationId && (
            <span>
              Conv ID:{" "}
              <code
                onClick={(e) => { navigator.clipboard.writeText(run.conversationId).then(() => { (e.target as HTMLElement).style.background = T.successBg; setTimeout(() => { (e.target as HTMLElement).style.background = T.cardAlt; }, 600); }).catch(() => { window.prompt("Copy this ID:", run.conversationId); }); }}
                title="Click to copy"
                style={{ cursor: "pointer", background: T.cardAlt, padding: "2px 6px", borderRadius: 3, color: T.text, fontFamily: "monospace", fontSize: 11, transition: "background 0.2s" }}
              >
                {run.conversationId}
              </code>
            </span>
          )}
          {run.hamsaCallId && (
            <span>
              Call ID:{" "}
              <code
                onClick={(e) => { navigator.clipboard.writeText(run.hamsaCallId).then(() => { (e.target as HTMLElement).style.background = T.successBg; setTimeout(() => { (e.target as HTMLElement).style.background = T.cardAlt; }, 600); }).catch(() => { window.prompt("Copy this ID:", run.hamsaCallId); }); }}
                title="Click to copy"
                style={{ cursor: "pointer", background: T.cardAlt, padding: "2px 6px", borderRadius: 3, color: T.text, fontFamily: "monospace", fontSize: 11, transition: "background 0.2s" }}
              >
                {run.hamsaCallId}
              </code>
            </span>
          )}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {run.hamsaCallId && (
          <button
            disabled={rehydrating || reEvaluating}
            title="Re-fetch fresh call logs and transcript from Hamsa, then re-evaluate"
            onClick={async () => {
              setRehydrating(true);
              const capturedRunId = runId!;
              try {
                const r = await rehydrateRun(capturedRunId);
                if (r.warnings?.length) {
                  console.warn(`[Rehydrate] warnings: ${r.warnings.join("; ")}`);
                }
                // Rehydrate triggers evaluation — poll until terminal state
                const poll = () => {
                  if (!mountedRef.current || activeRunIdRef.current !== capturedRunId) return;
                  getRun(capturedRunId).then((updated) => {
                    if (!mountedRef.current || activeRunIdRef.current !== capturedRunId) return;
                    setRun(updated);
                    if (["EVALUATING", "PENDING", "RUNNING"].includes(updated.status)) {
                      setTimeout(poll, 2000);
                    } else {
                      setRehydrating(false);
                      if (updated.status === "FAILED") {
                        alert("Evaluation failed after rehydration. Check the run's error log for details.");
                      }
                    }
                  }).catch(() => {
                    if (mountedRef.current && activeRunIdRef.current === capturedRunId) setRehydrating(false);
                  });
                };
                setTimeout(poll, 1500);
              } catch (err) {
                setRehydrating(false);
                alert("Rehydrate failed: " + (err as Error).message);
              }
            }}
            style={{ background: rehydrating ? "#d1fae5" : "#f59e0b", color: rehydrating ? "#065f46" : "#000", padding: "6px 12px", borderRadius: 4, border: "none", cursor: (rehydrating || reEvaluating) ? "default" : "pointer", fontSize: 12, fontWeight: 600 }}
          >
            {rehydrating ? "Rehydrating…" : "Rehydrate & Re-evaluate"}
          </button>
        )}
        <button
          disabled={reEvaluating || rehydrating}
          onClick={async () => {
            setReEvaluating(true);
            const capturedRunId = runId!;
            try {
              await triggerEvaluation(capturedRunId);
            } catch (err) {
              const msg = (err as Error).message;
              // 409 = already evaluating — just start polling to track it
              if (!msg.includes("409")) {
                setReEvaluating(false);
                return;
              }
            }
            const poll = () => {
              if (!mountedRef.current || activeRunIdRef.current !== capturedRunId) return;
              getRun(capturedRunId).then((r) => {
                if (!mountedRef.current || activeRunIdRef.current !== capturedRunId) return;
                setRun(r);
                if (["EVALUATING", "PENDING", "RUNNING"].includes(r.status)) {
                  setTimeout(poll, 2000);
                } else {
                  setReEvaluating(false);
                  if (r.status === "FAILED") {
                    alert("Evaluation failed. Check the run's error log for details.");
                  }
                }
              }).catch(() => {
                if (mountedRef.current && activeRunIdRef.current === capturedRunId) setReEvaluating(false);
              });
            };
            setTimeout(poll, 1500);
          }}
          style={{ background: reEvaluating ? "#b8e6cc" : T.primary, color: "#fff", padding: "6px 12px", borderRadius: 4, border: "none", cursor: reEvaluating ? "default" : "pointer", fontSize: 12 }}
        >
          {reEvaluating ? "Evaluating…" : "Re-evaluate"}
        </button>
        {run.status === "COMPLETE" && (<>
          <button
            onClick={() => {
              const exportData = {
                callId: run.hamsaCallId,
                conversationId: run.conversationId,
                callDate: run.callDate,
                callDuration: run.callDuration,
                callStatus: run.callStatus,
                callOutcome: run.callOutcome,
                channel: run.webhookData?.caller_info?.call_type || run.webhookData?.channelType || null,
                modelUsed: run.modelUsed,
                recordingUrl: recordingUrl,
                outcomeResult: run.outcomeResult,
                overallScore: run.overallScore,
                evalCost: run.evalCost,
                goal: computeGoal(run),
                transcript: transcript.map((t: any) => {
                  if (t.Agent) return { speaker: "Agent", text: t.Agent };
                  if (t.User) return { speaker: "User", text: t.User, gender: t.metadata?.gender };
                  return t;
                }),
                criteria: evalResults.map((er: any) => ({
                  name: er.criterion?.label || er.criterion?.key,
                  type: er.criterion?.type,
                  passed: er.passed,
                  score: er.score,
                  detail: er.detail,
                })),
                wordLabels: wordLabels.map((l: any) => ({
                  wordIndex: l.wordIndex,
                  utteranceIndex: l.utteranceIndex,
                  originalWord: l.originalWord,
                  labelType: l.labelType,
                  correction: l.correction,
                })),
                agentSummary: run.project?.agentSummary || null,
              };
              const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `eval-${run.conversationId || run.id}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            style={{ background: T.cardAlt, color: T.text, padding: "6px 12px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 12 }}
          >
            Export JSON
          </button>
          <button
            onClick={() => {
              const fullExport = {
                ...run,
                // Remove circular/large fields, keep everything useful
                project: {
                  id: run.project?.id,
                  name: run.project?.name,
                  agentId: run.project?.agentId,
                  agentSummary: run.project?.agentSummary,
                  agentStructure: run.project?.agentStructure,
                },
              };
              const blob = new Blob([JSON.stringify(fullExport, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `full-export-${run.conversationId || run.id}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            style={{ background: T.card, color: T.textMuted, padding: "6px 12px", borderRadius: 4, border: `1px solid ${T.border}`, cursor: "pointer", fontSize: 12 }}
          >
            Full Export
          </button>
        </>)}
      </div>

      {/* Call outcome + score summary */}
      <div style={{ display: "flex", gap: 32, alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap" }}>
        {run.overallScore != null && (
          <div>
            <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 4 }}>Quality Score</div>
            <div style={{ fontSize: 36, fontWeight: 700, color: run.overallScore >= 0.8 ? "#22c55e" : run.overallScore >= 0.5 ? "#f59e0b" : "#ef4444" }}>
              {(run.overallScore * 100).toFixed(0)}%
            </div>
          </div>
        )}
        {complianceScore != null && (
          <div>
            <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 4 }}>Compliance</div>
            <div style={{ fontSize: 36, fontWeight: 700, color: complianceScore >= 80 ? "#22c55e" : complianceScore >= 50 ? "#f59e0b" : "#ef4444" }}>
              {Math.round(complianceScore)}%
            </div>
          </div>
        )}
        {layeredDetail?.experienceScore != null && (
          <div>
            <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 4 }}>Experience</div>
            <div style={{ fontSize: 36, fontWeight: 700, color: layeredDetail.experienceScore >= 80 ? "#22c55e" : layeredDetail.experienceScore >= 50 ? "#f59e0b" : "#ef4444" }}>
              {Math.round(layeredDetail.experienceScore)}%
            </div>
          </div>
        )}
        {objectiveAchieved != null && (
          <div>
            <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 4 }}>Objective</div>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              fontSize: 18, fontWeight: 700,
              color: objectiveAchieved ? "#17B26A" : "#ef4444",
              background: objectiveAchieved ? "#17B26A18" : "#ef444418",
              borderRadius: 8, padding: "6px 12px",
            }}>
              {objectiveAchieved ? "✓ Met" : "✗ Not Met"}
            </div>
          </div>
        )}
        {run.evalCost != null && run.evalCost > 0 && (
          <div>
            <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 4 }}>Eval Cost</div>
            <div style={{ fontSize: 20, fontWeight: 600, color: "#a78bfa" }}>
              ${run.evalCost < 0.01 ? run.evalCost.toFixed(4) : run.evalCost.toFixed(3)}
            </div>
          </div>
        )}
        {run.callOutcome && (
          <div>
            <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 6 }}>Call Outcome</div>
            <OutcomeBadge outcome={run.callOutcome} size="large" />
          </div>
        )}
        {(() => {
          const goal = computeGoal(run);
          if (!goal) return null;
          const s = GOAL_STYLE[goal.status];
          return (
            <div style={{
              flex: 1, minWidth: 260,
              background: s.bg, border: `1px solid ${s.border}`,
              borderRadius: 8, padding: "12px 16px",
            }}>
              <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 6 }}>Goal</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: s.color, marginBottom: 6 }}>
                {goal.status === "SUCCESSFUL" ? "✓ Successful" : goal.status === "PARTIAL" ? "~ Partial" : "✗ Failed"}
              </div>
              <div style={{ fontSize: 13, color: T.text, lineHeight: 1.5 }}>{goal.reason}</div>
            </div>
          );
        })()}
      </div>

      {/* Outcome variables */}
      {run.outcomeResult && Object.keys(run.outcomeResult).filter(k => !["summary", "call_outcome", "default_params"].includes(k) && run.outcomeResult[k]).length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 8 }}>Extracted Variables</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(run.outcomeResult)
              .filter(([k, v]) => !["summary", "call_outcome", "default_params"].includes(k) && v)
              .map(([k, v]) => (
                <span key={k} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 12 }}>
                  <span style={{ color: T.textSecondary }}>{k}: </span>
                  <span style={{ color: T.text }}>{String(v)}</span>
                </span>
              ))}
          </div>
        </div>
      )}

      {/* Per-criterion breakdown */}
      {evalResults.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Criteria Results</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {evalResults.map((er: any) => (
              <CriterionCard key={er.id} er={er} />
            ))}
          </div>
        </div>
      )}

      {/* Metrics Breakdown (from FLOW_PROGRESSION) */}
      {(() => {
        const fpResult = evalResults.find((er: any) => er.criterion?.type === "FLOW_PROGRESSION");
        const metrics = fpResult?.metadata?.metrics || (fpResult?.metadata as any)?.metrics;
        // Try parsing from detail if metadata doesn't have it (LLM returns it in the JSON response)
        let parsedData: any = null;
        if (fpResult?.detail) {
          try { parsedData = JSON.parse(fpResult.detail); } catch {}
        }
        const m = metrics || parsedData?.metrics;
        const failedTransitions = parsedData?.failed_transitions || fpResult?.metadata?.failed_transitions || [];
        const wordCount = parsedData?.word_count || fpResult?.metadata?.word_count;
        const dialect = parsedData?.dialect || fpResult?.metadata?.dialect;

        if (!m && !parsedData) return null;

        const categories = m ? [
          { key: "language_switching", label: "Language Switching", ...m.language_switching },
          { key: "gender_detection", label: "Gender Detection", ...m.gender_detection },
          { key: "tool_calls", label: "Tool Calls", ...m.tool_calls },
          { key: "data_reading", label: "Data Reading", ...m.data_reading },
          { key: "node_transitions", label: "Node Transitions", ...m.node_transitions },
          { key: "kb_retrieval", label: "Knowledge Base", ...m.kb_retrieval },
          { key: "mcp_usage", label: "MCP Tools", ...m.mcp_usage },
          { key: "outcome_fields", label: "Outcome Fields", ...m.outcome_fields },
        ] : [];

        return (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 16, marginBottom: 12 }}>Detailed Metrics</h2>

            {/* Summary info */}
            <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              {wordCount != null && (
                <div style={{ background: T.card, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                  <span style={{ color: T.textSecondary }}>Words: </span><strong>{wordCount}</strong>
                </div>
              )}
              {dialect && (
                <div style={{ background: T.card, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                  <span style={{ color: T.textSecondary }}>Dialect: </span><strong>{dialect}</strong>
                </div>
              )}
              {parsedData?.nodes_completed != null && (
                <div style={{ background: T.card, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                  <span style={{ color: T.textSecondary }}>Nodes: </span><strong>{parsedData.nodes_completed}/{parsedData.nodes_expected}</strong>
                </div>
              )}
              {parsedData?.stuck_on_node && (
                <div style={{ background: T.errorBg, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                  <span style={{ color: "#ef4444" }}>Stuck on: </span><strong style={{ color: "#ef4444" }}>{parsedData.stuck_on_node}</strong>
                  {parsedData.stuck_turns > 0 && <span style={{ color: T.textSecondary }}> ({parsedData.stuck_turns} turns)</span>}
                </div>
              )}
            </div>

            {/* Percentage bars */}
            {categories.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                {categories.map((cat: any) => {
                  const total = cat.total || 0;
                  const errors = cat.errors || 0;
                  const success = total > 0 ? total - errors : 0;
                  const pct = total > 0 ? Math.round((success / total) * 100) : null;
                  const color = pct === null ? T.textMuted : pct >= 80 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";

                  return (
                    <MetricRow key={cat.key} label={cat.label} total={total} errors={errors} pct={pct} color={color} comment={cat.comment} />
                  );
                })}
              </div>
            )}

            {/* Failed Transitions (collapsible) */}
            {failedTransitions.length > 0 && (
              <CollapsibleSection title={`Failed Transitions (${failedTransitions.length})`}>
                {failedTransitions.map((ft: any, i: number) => (
                  <div key={i} style={{ background: T.cardAlt, padding: 12, borderRadius: 6, marginBottom: 8, border: `1px solid ${T.border}` }}>
                    <div style={{ fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: "#22c55e" }}>User said:</span> <span style={{ color: T.text }}>{ft.user_said}</span>
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: "#3b82f6" }}>Expected:</span> <span style={{ color: T.text }}>{ft.expected_action}</span>
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: "#ef4444" }}>Actual:</span> <span style={{ color: T.text }}>{ft.actual_action}</span>
                    </div>
                    {ft.comment && (
                      <div style={{ fontSize: 11, color: T.textSecondary, fontStyle: "italic" }}>{ft.comment}</div>
                    )}
                  </div>
                ))}
              </CollapsibleSection>
            )}

            {/* Variables */}
            {(parsedData?.variables_extracted?.length > 0 || parsedData?.variables_missed?.length > 0) && (
              <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 12 }}>
                {parsedData.variables_extracted?.length > 0 && (
                  <div>
                    <span style={{ color: T.textSecondary }}>Extracted: </span>
                    {parsedData.variables_extracted.map((v: string, i: number) => (
                      <span key={i} style={{ color: "#22c55e", marginRight: 6 }}>{v}</span>
                    ))}
                  </div>
                )}
                {parsedData.variables_missed?.length > 0 && (
                  <div>
                    <span style={{ color: T.textSecondary }}>Missed: </span>
                    {parsedData.variables_missed.map((v: string, i: number) => (
                      <span key={i} style={{ color: "#ef4444", marginRight: 6 }}>{v}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Action Consistency Analysis (from ACTION_CONSISTENCY) */}
      {(() => {
        const acResult = evalResults.find((er: any) => er.criterion?.type === "ACTION_CONSISTENCY");
        if (!acResult) return null;

        let parsed: any = null;
        if (acResult.detail) {
          try { parsed = JSON.parse(acResult.detail); } catch {}
        }
        const meta = acResult.metadata || {};
        const errors: any[] = parsed?.errors || meta.errors || [];
        const correctActions: any[] = parsed?.correct_actions || meta.correct_actions || [];
        const errSummary = parsed?.error_summary || meta.error_summary;
        const recommendations: string[] = parsed?.recommendations || meta.recommendations || [];
        const totalTurns = parsed?.total_agent_turns || meta.total_agent_turns || 0;
        const turnsWithErrors = parsed?.turns_with_errors || meta.turns_with_errors || 0;

        const severityColors: Record<string, string> = { critical: "#ef4444", major: "#f59e0b", minor: "#888" };
        const rootCauseLabels: Record<string, string> = {
          LLM_HALLUCINATION: "LLM Hallucination",
          LLM_MISREAD: "LLM Misread Data",
          TOOL_FAILURE: "Tool Failure",
          TOOL_NOT_CALLED: "Tool Not Called",
          WRONG_TOOL: "Wrong Tool",
          WRONG_TRANSITION: "Wrong Transition",
          STUCK_TRANSITION: "Stuck Transition",
          ASR_ERROR: "ASR Error",
          PROMPT_ISSUE: "Prompt Issue",
          MISSING_ERROR_HANDLING: "Missing Error Handling",
        };

        return (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 16, marginBottom: 12 }}>Action Consistency Analysis</h2>

            {/* Summary bar */}
            <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <div style={{ background: T.card, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                <span style={{ color: T.textSecondary }}>Score: </span>
                <strong style={{ color: acResult.score == null ? T.textSecondary : acResult.score >= 0.8 ? "#22c55e" : acResult.score >= 0.5 ? "#f59e0b" : "#ef4444" }}>
                  {acResult.score != null ? `${(acResult.score * 100).toFixed(0)}%` : "—"}
                </strong>
              </div>
              <div style={{ background: T.card, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                <span style={{ color: T.textSecondary }}>Turns: </span>
                <strong>{turnsWithErrors > 0 ? <span style={{ color: "#ef4444" }}>{turnsWithErrors} errors</span> : <span style={{ color: "#22c55e" }}>clean</span>} / {totalTurns}</strong>
              </div>
              {errors.length > 0 && errSummary?.by_severity && (
                <>
                  {errSummary.by_severity.critical > 0 && (
                    <div style={{ background: T.errorBg, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                      <span style={{ color: "#ef4444" }}>{errSummary.by_severity.critical} critical</span>
                    </div>
                  )}
                  {errSummary.by_severity.major > 0 && (
                    <div style={{ background: T.warningBg, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                      <span style={{ color: "#f59e0b" }}>{errSummary.by_severity.major} major</span>
                    </div>
                  )}
                  {errSummary.by_severity.minor > 0 && (
                    <div style={{ background: T.card, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                      <span style={{ color: T.textSecondary }}>{errSummary.by_severity.minor} minor</span>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Root cause breakdown */}
            {errSummary?.by_root_cause && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: T.textSecondary, marginBottom: 8 }}>Errors by Root Cause</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {Object.entries(errSummary.by_root_cause as Record<string, number>)
                    .filter(([, count]) => count > 0)
                    .sort(([, a], [, b]) => b - a)
                    .map(([cause, count]) => (
                      <span key={cause} style={{
                        background: T.cardAlt, padding: "4px 10px", borderRadius: 4,
                        border: `1px solid ${T.border}`, fontSize: 11, color: T.text,
                      }}>
                        {rootCauseLabels[cause] || cause}: <strong>{count}</strong>
                      </span>
                    ))}
                </div>
              </div>
            )}

            {/* Errors list */}
            {errors.length > 0 && (
              <CollapsibleSection title={`Errors Found (${errors.length})`} defaultOpen={true}>
                {errors.map((err: any, i: number) => (
                  <div key={i} style={{
                    background: T.cardAlt, padding: 14, borderRadius: 6, marginBottom: 8,
                    border: `1px solid ${severityColors[err.severity] || T.border}33`,
                    borderLeft: `3px solid ${severityColors[err.severity] || T.textSecondary}`,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 11, color: severityColors[err.severity], textTransform: "uppercase", fontWeight: 600 }}>
                        {err.severity} — {err.category?.replace(/_/g, " ")}
                      </span>
                      {err.timestamp && <span style={{ fontSize: 10, color: T.textMuted }}>{err.timestamp}</span>}
                    </div>
                    {err.what_agent_said && (
                      <div style={{ fontSize: 12, marginBottom: 4 }}>
                        <span style={{ color: "#3b82f6" }}>Agent said:</span>{" "}
                        <span style={{ color: T.text }}>"{err.what_agent_said}"</span>
                      </div>
                    )}
                    {err.what_log_shows && (
                      <div style={{ fontSize: 12, marginBottom: 4 }}>
                        <span style={{ color: "#f59e0b" }}>Log shows:</span>{" "}
                        <span style={{ color: T.text }}>{err.what_log_shows}</span>
                      </div>
                    )}
                    {err.expected_behavior && (
                      <div style={{ fontSize: 12, marginBottom: 4 }}>
                        <span style={{ color: "#22c55e" }}>Expected:</span>{" "}
                        <span style={{ color: T.text }}>{err.expected_behavior}</span>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
                      {err.root_cause && (
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 3, background: T.card, border: `1px solid ${T.border}`, color: T.text }}>
                          Cause: {rootCauseLabels[err.root_cause] || err.root_cause}
                        </span>
                      )}
                      {err.impact && (
                        <span style={{ fontSize: 11, color: T.textSecondary }}>
                          Impact: {err.impact}
                        </span>
                      )}
                    </div>
                    {err.suggested_fix && (
                      <div style={{ fontSize: 12, marginTop: 8, padding: "6px 10px", background: T.successBg, border: `1px solid ${T.border}`, borderRadius: 4, color: "#22c55e" }}>
                        Fix: {err.suggested_fix}
                      </div>
                    )}
                  </div>
                ))}
              </CollapsibleSection>
            )}

            {/* Correct actions */}
            {correctActions.length > 0 && (
              <CollapsibleSection title={`Correct Actions (${correctActions.length})`} defaultOpen={false}>
                {correctActions.map((a: any, i: number) => (
                  <div key={i} style={{ fontSize: 12, padding: "6px 10px", marginBottom: 4, color: T.textSecondary }}>
                    <span style={{ color: "#22c55e", marginRight: 8 }}>{a.category?.replace(/_/g, " ")}</span>
                    {a.description}
                  </div>
                ))}
              </CollapsibleSection>
            )}

            {/* Recommendations */}
            {recommendations.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 13, color: T.textSecondary, marginBottom: 8 }}>Top Recommendations</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {recommendations.map((rec: string, i: number) => (
                    <div key={i} style={{
                      display: "flex", gap: 10, alignItems: "flex-start",
                      fontSize: 13, padding: "8px 12px", background: T.cardAlt,
                      borderRadius: 6, border: `1px solid ${T.border}`,
                    }}>
                      <span style={{ color: T.primary, fontWeight: 700, minWidth: 20 }}>#{i + 1}</span>
                      <span style={{ color: T.text }}>{rec}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Executive summary */}
            {parsed?.detail && (
              <div style={{
                marginTop: 16, padding: 14, background: T.card, borderRadius: 8,
                border: `1px solid ${T.border}`, fontSize: 13, color: T.textSecondary, lineHeight: 1.6, boxShadow: T.shadow,
              }}>
                {parsed.detail}
              </div>
            )}
          </div>
        );
      })()}

      {/* Action Hallucination Analysis (from ACTION_HALLUCINATION) */}
      {(() => {
        const ahResult = evalResults.find((er: any) => er.criterion?.type === "ACTION_HALLUCINATION");
        if (!ahResult) return null;

        let parsed: any = null;
        if (ahResult.detail) {
          try { parsed = JSON.parse(ahResult.detail); } catch {}
        }
        const meta = ahResult.metadata || {};
        const hallucinated: any[] = parsed?.hallucinated_actions || meta.hallucinated_actions || [];
        const verified: any[] = parsed?.verified_actions || meta.verified_actions || [];
        const totalClaims: number = parsed?.total_action_claims ?? meta.total_action_claims ?? (hallucinated.length + verified.length);

        const errorTypeColors: Record<string, string> = {
          HALLUCINATION: "#ef4444",
          MISREPRESENTATION: "#f59e0b",
          OUTCOME_MISMATCH: "#f97316",
        };
        const errorTypeLabels: Record<string, string> = {
          HALLUCINATION: "Phantom Action",
          MISREPRESENTATION: "Told caller it succeeded (it failed)",
          OUTCOME_MISMATCH: "Outcome variables contradict claim",
        };
        const severityColors: Record<string, string> = { critical: "#ef4444", major: "#f59e0b", minor: "#9ca3af" };

        return (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 16, marginBottom: 12 }}>Action Hallucination Check</h2>

            {/* Summary bar */}
            <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <div style={{ background: T.card, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                <span style={{ color: T.textSecondary }}>Score: </span>
                <strong style={{ color: ahResult.score == null ? T.textSecondary : ahResult.score >= 0.8 ? "#22c55e" : ahResult.score >= 0.5 ? "#f59e0b" : "#ef4444" }}>
                  {ahResult.score != null ? `${(ahResult.score * 100).toFixed(0)}%` : "—"}
                </strong>
              </div>
              <div style={{ background: T.card, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                <span style={{ color: T.textSecondary }}>Action claims: </span>
                <strong>{totalClaims}</strong>
              </div>
              {hallucinated.length > 0 && (
                <div style={{ background: T.errorBg, padding: "8px 14px", borderRadius: 6, border: `1px solid #ef444433`, fontSize: 13 }}>
                  <span style={{ color: "#ef4444" }}>{hallucinated.length} hallucinated</span>
                </div>
              )}
              {verified.length > 0 && (
                <div style={{ background: T.successBg, padding: "8px 14px", borderRadius: 6, border: `1px solid #22c55e33`, fontSize: 13 }}>
                  <span style={{ color: "#22c55e" }}>{verified.length} verified</span>
                </div>
              )}
            </div>

            {/* Hallucinated actions */}
            {hallucinated.length > 0 && (
              <CollapsibleSection title={`Hallucinated / Misrepresented Actions (${hallucinated.length})`} defaultOpen={true}>
                {hallucinated.map((item: any, i: number) => (
                  <div key={i} style={{
                    background: T.cardAlt, padding: 14, borderRadius: 6, marginBottom: 8,
                    borderLeft: `3px solid ${errorTypeColors[item.error_type] || "#ef4444"}`,
                    border: `1px solid ${(errorTypeColors[item.error_type] || "#ef4444")}33`,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 11, color: errorTypeColors[item.error_type] || "#ef4444", textTransform: "uppercase", fontWeight: 600 }}>
                        {item.error_type?.replace(/_/g, " ")}
                        {item.severity && <span style={{ color: severityColors[item.severity], marginLeft: 8 }}>· {item.severity}</span>}
                      </span>
                      {item.claimed_action && (
                        <span style={{ fontSize: 11, color: T.textSecondary }}>{item.claimed_action}</span>
                      )}
                    </div>
                    {item.error_type && (
                      <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 6 }}>
                        {errorTypeLabels[item.error_type]}
                      </div>
                    )}
                    {item.what_agent_said && (
                      <div style={{ fontSize: 12, marginBottom: 6, padding: "6px 10px", background: T.card, borderRadius: 4, borderLeft: `2px solid #3b82f6` }}>
                        <span style={{ color: "#3b82f6", fontWeight: 600 }}>Agent said: </span>
                        <span style={{ color: T.text }}>"{item.what_agent_said}"</span>
                      </div>
                    )}
                    {item.evidence && (
                      <div style={{ fontSize: 12, color: T.textSecondary, marginTop: 4 }}>
                        <span style={{ color: T.text, fontWeight: 600 }}>Evidence: </span>
                        {item.evidence}
                      </div>
                    )}
                  </div>
                ))}
              </CollapsibleSection>
            )}

            {/* Verified actions */}
            {verified.length > 0 && (
              <CollapsibleSection title={`Verified Actions (${verified.length})`} defaultOpen={false}>
                {verified.map((item: any, i: number) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
                    fontSize: 12, padding: "8px 12px", marginBottom: 4,
                    background: T.successBg, borderRadius: 4, border: `1px solid #22c55e22`,
                  }}>
                    <div>
                      <span style={{ color: "#22c55e", marginRight: 8 }}>✓</span>
                      <span style={{ color: T.text }}>"{item.what_agent_said}"</span>
                    </div>
                    {item.verified_by && (
                      <span style={{ color: T.textMuted, fontSize: 11, marginLeft: 12, whiteSpace: "nowrap" }}>
                        via {item.verified_by}
                      </span>
                    )}
                  </div>
                ))}
              </CollapsibleSection>
            )}

            {/* Executive summary */}
            {parsed?.detail && (
              <div style={{
                marginTop: 12, padding: 14, background: T.card, borderRadius: 8,
                border: `1px solid ${T.border}`, fontSize: 13, color: T.textSecondary, lineHeight: 1.6, boxShadow: T.shadow,
              }}>
                {parsed.detail}
              </div>
            )}

            {/* Not applicable notice */}
            {ahResult.passed === null && !hallucinated.length && !verified.length && (
              <div style={{ fontSize: 13, color: T.textMuted, padding: "10px 14px", background: T.card, borderRadius: 6, border: `1px solid ${T.border}` }}>
                No action completion claims detected in this call — criterion not applicable.
              </div>
            )}
          </div>
        );
      })()}

      {/* Layered Node Evaluation Breakdown */}
      {(() => {
        const leResult = evalResults.find((er: any) => er.criterion?.type === "LAYERED_EVALUATION");
        if (!leResult?.detail) return null;

        let parsed: any = null;
        try { parsed = JSON.parse(leResult.detail); } catch { return null; }

        const meta = leResult.metadata || {};
        const navIssues: any[] = parsed.navigation?.issues || [];
        const perNode: any[] = parsed.perNode || [];
        const criticalIssues: string[] = parsed.criticalIssues || [];
        const experienceIssues: string[] = parsed.experienceIssues || [];
        const comments: string[] = parsed.comments || [];
        const improvements: string[] = parsed.improvements || [];
        const navScore = parsed.navigation?.score ?? meta.layer2Score;
        const layer3Avg = meta.layer3Avg;
        const layer4Score = meta.layer4Score ?? parsed.overallScore;

        const severityColors: Record<string, string> = { critical: "#ef4444", warning: "#f59e0b", info: "#888" };
        const issueTypeLabels: Record<string, string> = {
          stuck: "Stuck", loop: "Loop", wrong_transition: "Wrong Transition",
          skipped_node: "Skipped Node", backward_jump: "Backward Jump", dead_end: "Dead End",
        };

        return (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 16, marginBottom: 12 }}>Layered Node Evaluation</h2>

            {/* Summary narrative */}
            {parsed.summary && (
              <div style={{
                background: leResult.passed ? T.successBg : T.errorBg,
                border: `1px solid ${leResult.passed ? "#22c55e33" : "#ef444433"}`,
                borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13, lineHeight: 1.6, color: T.text,
              }}>
                {parsed.summary}
              </div>
            )}

            {/* Layer score bars */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {[
                { label: "Navigation (Layer 2)", score: navScore, weight: "30%" },
                { label: "Per-Node Behavior (Layer 3)", score: layer3Avg, weight: "50%" },
                { label: "Overall Quality (Layer 4)", score: layer4Score, weight: "20%" },
              ].map((layer) => {
                const pct = layer.score != null ? Math.round((layer.score / 10) * 100) : null;
                const color = pct == null ? T.textMuted : pct >= 80 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";
                return (
                  <div key={layer.label} style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                    background: T.card, borderRadius: 6, border: `1px solid ${T.border}`,
                  }}>
                    <div style={{ width: 200, fontSize: 13, fontWeight: 500 }}>
                      {layer.label}
                      <span style={{ fontSize: 10, color: T.textMuted, marginLeft: 6 }}>{layer.weight}</span>
                    </div>
                    <div style={{ flex: 1, height: 8, background: "#e5e7eb", borderRadius: 4, overflow: "hidden" }}>
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
              {parsed.objectiveAchieved != null && (
                <div style={{
                  background: parsed.objectiveAchieved ? T.successBg : T.errorBg,
                  padding: "8px 14px", borderRadius: 6,
                  border: `1px solid ${parsed.objectiveAchieved ? "#22c55e33" : "#ef444433"}`,
                  fontSize: 13,
                }}>
                  <span style={{ color: T.textSecondary }}>Objective: </span>
                  <strong style={{ color: parsed.objectiveAchieved ? "#22c55e" : "#ef4444" }}>
                    {parsed.objectiveAchieved ? "Achieved" : "Not Achieved"}
                  </strong>
                </div>
              )}
              {parsed.callerSentiment && (
                <div style={{ background: T.card, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                  <span style={{ color: T.textSecondary }}>Sentiment: </span>
                  <strong style={{ color: T.text }}>{parsed.callerSentiment}</strong>
                </div>
              )}
              {parsed.efficiency && (
                <div style={{ background: T.card, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                  <span style={{ color: T.textSecondary }}>Efficiency: </span>
                  <strong style={{ color: parsed.efficiency.score >= 7 ? "#22c55e" : parsed.efficiency.score >= 5 ? "#f59e0b" : "#ef4444" }}>
                    {parsed.efficiency.score}/10
                  </strong>
                </div>
              )}
              {meta.nodesEvaluated != null && (
                <div style={{ background: T.card, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 13 }}>
                  <span style={{ color: T.textSecondary }}>Nodes Evaluated: </span>
                  <strong>{meta.nodesEvaluated}</strong>
                </div>
              )}
            </div>

            {/* Efficiency reasoning */}
            {parsed.efficiency?.reasoning && (
              <div style={{
                padding: "10px 14px", background: T.cardAlt, borderRadius: 6,
                border: `1px solid ${T.border}`, fontSize: 12, color: T.textSecondary, marginBottom: 16, lineHeight: 1.5,
              }}>
                {parsed.efficiency.reasoning}
              </div>
            )}

            {/* Critical Issues */}
            {criticalIssues.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: "#ef4444", fontWeight: 600, marginBottom: 8 }}>Critical Issues</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {criticalIssues.map((issue: string, i: number) => (
                    <div key={i} style={{
                      padding: "8px 12px", background: T.errorBg, borderRadius: 6,
                      border: `1px solid ${T.border}`, borderLeft: "3px solid #ef4444",
                      fontSize: 13, color: T.text, lineHeight: 1.5,
                    }}>
                      {issue}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Experience Issues — system limitations, not agent failures */}
            {experienceIssues.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: "#f59e0b", fontWeight: 600, marginBottom: 8 }}>Experience Issues</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {experienceIssues.map((issue: string, i: number) => (
                    <div key={i} style={{
                      padding: "8px 12px", background: T.warningBg, borderRadius: 6,
                      border: `1px solid ${T.border}`, borderLeft: "3px solid #f59e0b",
                      fontSize: 13, color: T.text, lineHeight: 1.5,
                    }}>
                      {issue}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Experience Metrics breakdown */}
            {parsed.experience && (
              <CollapsibleSection title="Experience Metrics" defaultOpen={false}>
                {/* Sub-scores */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, marginBottom: 12 }}>
                  {[
                    { label: "Interruptions", value: parsed.experience.interruptionScore },
                    { label: "Latency", value: parsed.experience.latencyScore },
                    { label: "Flow Smoothness", value: parsed.experience.flowSmoothnessScore },
                    { label: "Empathy", value: parsed.experience.empathyScore },
                    { label: "Resolution", value: parsed.experience.resolutionScore },
                  ].map(({ label, value }) => {
                    const c = value >= 80 ? "#22c55e" : value >= 50 ? "#f59e0b" : "#ef4444";
                    return (
                      <div key={label} style={{ background: T.cardAlt, borderRadius: 6, padding: "10px 12px", border: `1px solid ${T.border}` }}>
                        <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>{label}</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: c }}>{Math.round(value)}%</div>
                      </div>
                    );
                  })}
                </div>

                {/* Interruption events */}
                {parsed.experience.interruptions?.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 6 }}>
                      Interruption Events ({parsed.experience.interruptions.length})
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {parsed.experience.interruptions.map((ev: any, i: number) => (
                        <div key={i} style={{
                          fontSize: 12, padding: "6px 10px", background: T.card,
                          borderRadius: 4, border: `1px solid ${T.border}`, color: T.text,
                        }}>
                          <span style={{ color: T.textMuted }}>Turn {ev.utteranceIndex + 1} · </span>
                          <span style={{ color: "#f59e0b" }}>{ev.nodeLabel}</span>
                          <span style={{ color: T.textSecondary }}> — "{ev.text}"</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Latency summary */}
                {parsed.experience.latencies?.length > 0 && (() => {
                  const lats: any[] = parsed.experience.latencies;
                  const avg = lats.reduce((s: number, l: any) => s + l.waitMs, 0) / lats.length;
                  const maxL = Math.max(...lats.map((l: any) => l.waitMs));
                  return (
                    <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 6 }}>
                      Avg RTT: <strong style={{ color: T.text }}>{(avg / 1000).toFixed(1)}s</strong>
                      {" "} · Max: <strong style={{ color: maxL > 25000 ? "#ef4444" : T.text }}>{(maxL / 1000).toFixed(1)}s</strong>
                      {" "} · Turns measured: <strong style={{ color: T.text }}>{lats.length}</strong>
                    </div>
                  );
                })()}

                {/* Per-node experience */}
                {parsed.experience.perNode?.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 6 }}>Per-Node</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {parsed.experience.perNode.map((n: any, i: number) => (
                        <div key={i} style={{
                          fontSize: 12, padding: "6px 10px", background: T.card,
                          borderRadius: 4, border: `1px solid ${T.border}`,
                          display: "flex", gap: 12, flexWrap: "wrap",
                        }}>
                          <span style={{ fontWeight: 600, color: T.text, minWidth: 80 }}>{n.nodeLabel}</span>
                          {n.interruptions > 0 && <span style={{ color: "#f59e0b" }}>⚡ {n.interruptions} interruption{n.interruptions > 1 ? "s" : ""}</span>}
                          {n.avgLatencyMs != null && <span style={{ color: T.textSecondary }}>RTT {(n.avgLatencyMs / 1000).toFixed(1)}s</span>}
                          {n.correctionCycles > 0 && <span style={{ color: "#a78bfa" }}>↻ {n.correctionCycles} re-ask{n.correctionCycles > 1 ? "s" : ""}</span>}
                          {n.cutoffRestarts > 0 && <span style={{ color: "#60a5fa" }}>✂ {n.cutoffRestarts} restart{n.cutoffRestarts > 1 ? "s" : ""}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CollapsibleSection>
            )}

            {/* Comments — non-critical observations */}
            {comments.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: "#6b7280", fontWeight: 600, marginBottom: 8 }}>Comments</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {comments.map((c: string, i: number) => (
                    <div key={i} style={{
                      padding: "8px 12px", background: T.cardAlt, borderRadius: 6,
                      border: `1px solid ${T.border}`, borderLeft: "3px solid #9ca3af",
                      fontSize: 13, color: T.text, lineHeight: 1.5,
                    }}>
                      {c}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Navigation Issues */}
            {navIssues.length > 0 && (
              <CollapsibleSection title={`Navigation Issues (${navIssues.length})`} defaultOpen={true}>
                {navIssues.map((issue: any, i: number) => (
                  <div key={i} style={{
                    background: T.cardAlt, padding: 12, borderRadius: 6, marginBottom: 8,
                    border: `1px solid ${severityColors[issue.severity] || T.border}33`,
                    borderLeft: `3px solid ${severityColors[issue.severity] || T.textSecondary}`,
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
                        fontSize: 11, color: T.textSecondary, padding: "1px 6px", borderRadius: 3,
                        background: T.card, border: `1px solid ${T.border}`,
                      }}>
                        {issueTypeLabels[issue.type] || issue.type}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 500, color: T.text }}>
                        {issue.nodeLabel}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: T.textSecondary, lineHeight: 1.5 }}>
                      {issue.detail}
                    </div>
                  </div>
                ))}
              </CollapsibleSection>
            )}

            {/* Per-Node Results */}
            {perNode.length > 0 && (
              <CollapsibleSection title={`Per-Node Results (${perNode.length} nodes)`} defaultOpen={false}>
                {perNode.map((node: any, i: number) => {
                  const nodeScore = node.overallNodeScore;
                  const scoreColor = nodeScore >= 8 ? "#22c55e" : nodeScore >= 5 ? "#f59e0b" : "#ef4444";
                  const hasIssues = node.offTopic?.detected || node.hallucination?.detected || node.stuck?.detected
                    || !node.transitionCorrectness?.correct
                    || (node.instructionAdherence?.violated?.length > 0);

                  return (
                    <div key={i} style={{
                      background: T.cardAlt, borderRadius: 6, marginBottom: 8, overflow: "hidden",
                      border: `1px solid ${hasIssues ? "#f59e0b33" : T.border}`,
                    }}>
                      {/* Node header */}
                      <div style={{
                        display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                      }}>
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
                          <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
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
                              <span style={{ color: T.textSecondary }}>Instructions ({node.instructionAdherence.score}/10):</span>
                              {node.instructionAdherence.followed?.length > 0 && (
                                <span style={{ color: "#22c55e" }}>
                                  {node.instructionAdherence.followed.length} followed
                                </span>
                              )}
                              {node.instructionAdherence.violated?.length > 0 && (
                                <span style={{ color: "#ef4444" }}>
                                  {node.instructionAdherence.violated.length} violated
                                </span>
                              )}
                            </div>
                            {node.instructionAdherence.violated?.length > 0 && (
                              <div style={{ marginLeft: 12 }}>
                                {node.instructionAdherence.violated.map((v: string, vi: number) => (
                                  <div key={vi} style={{ color: "#ef4444", fontSize: 11, lineHeight: 1.5 }}>
                                    - {v}
                                  </div>
                                ))}
                              </div>
                            )}
                            {node.instructionAdherence.evidence && (
                              <div style={{ color: T.textMuted, fontSize: 11, marginTop: 2, fontStyle: "italic" }}>
                                {node.instructionAdherence.evidence}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Transition correctness */}
                        {node.transitionCorrectness && (
                          <div style={{ fontSize: 12 }}>
                            <span style={{ color: T.textSecondary }}>Transition: </span>
                            <span style={{ color: node.transitionCorrectness.correct ? "#22c55e" : "#ef4444" }}>
                              {node.transitionCorrectness.correct ? "Correct" : "Incorrect"}
                            </span>
                            <span style={{ color: T.textMuted, marginLeft: 6 }}>({node.transitionCorrectness.score}/10)</span>
                            {node.transitionCorrectness.reasoning && !node.transitionCorrectness.correct && (
                              <div style={{ color: T.textSecondary, fontSize: 11, marginTop: 2, marginLeft: 12 }}>
                                {node.transitionCorrectness.reasoning}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Detection flags */}
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {node.hallucination?.detected && (
                            <span style={{
                              fontSize: 11, padding: "2px 8px", borderRadius: 4,
                              background: "#fdf2f8", color: "#ec4899", border: "1px solid #ec489944",
                            }}>
                              Hallucination detected
                            </span>
                          )}
                          {node.offTopic?.detected && (
                            <span style={{
                              fontSize: 11, padding: "2px 8px", borderRadius: 4,
                              background: T.warningBg, color: "#f59e0b", border: "1px solid #f59e0b44",
                            }}>
                              Off-topic ({node.offTopic.turns?.length || 0} turns)
                            </span>
                          )}
                          {node.stuck?.detected && (
                            <span style={{
                              fontSize: 11, padding: "2px 8px", borderRadius: 4,
                              background: T.errorBg, color: "#ef4444", border: "1px solid #ef444444",
                            }}>
                              Stuck ({node.stuck.unnecessaryTurns} unnecessary turns)
                            </span>
                          )}
                          {!node.hallucination?.detected && !node.offTopic?.detected && !node.stuck?.detected && node.transitionCorrectness?.correct && (
                            <span style={{
                              fontSize: 11, padding: "2px 8px", borderRadius: 4,
                              background: T.successBg, color: "#22c55e", border: "1px solid #22c55e33",
                            }}>
                              Clean
                            </span>
                          )}
                        </div>

                        {/* Hallucination / stuck evidence */}
                        {node.hallucination?.detected && node.hallucination.evidence && (
                          <div style={{ fontSize: 11, color: "#ec4899", marginLeft: 12, lineHeight: 1.5 }}>
                            {node.hallucination.evidence}
                          </div>
                        )}
                        {node.stuck?.detected && node.stuck.reasoning && (
                          <div style={{ fontSize: 11, color: T.textSecondary, marginLeft: 12, lineHeight: 1.5 }}>
                            {node.stuck.reasoning}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </CollapsibleSection>
            )}

            {/* Improvements */}
            {improvements.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 13, color: T.textSecondary, marginBottom: 8 }}>Recommendations</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {improvements.map((rec: string, i: number) => (
                    <div key={i} style={{
                      display: "flex", gap: 10, alignItems: "flex-start",
                      fontSize: 13, padding: "8px 12px", background: T.cardAlt,
                      borderRadius: 6, border: `1px solid ${T.border}`,
                    }}>
                      <span style={{ color: T.primary, fontWeight: 700, minWidth: 20 }}>#{i + 1}</span>
                      <span style={{ color: T.text }}>{rec}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Flow Progression Visual */}
      {run.project?.agentStructure?.workflow?.nodes && Array.isArray(run.callLog) && (
        <FlowProgressionView
          workflowNodes={run.project.agentStructure.workflow.nodes}
          workflowEdges={run.project.agentStructure.workflow.edges || []}
          callLog={run.callLog}
          evalResult={evalResults.find((er: any) => er.criterion?.type === "FLOW_PROGRESSION")}
          activeNodeId={activeNodeId}
          isPlaying={isAudioPlaying}
        />
      )}

      {/* Call recording — placed between Flow Progression and Transcript so both
          the lighting-up nodes (above) and the live transcript (below) stay
          visible while playback drives them. */}
      {recordingUrl && (
        <div style={{
          // NavBar at App.tsx is sticky with top:0 z-index:50, so this bar
          // pins just below it (navbar is ~51px tall) with a lower z-index.
          position: "sticky", top: 56, zIndex: 5,
          marginBottom: 20, background: T.card, border: `1px solid ${T.border}`,
          borderRadius: 8, padding: "10px 14px",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: audioError ? 0 : 8, gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Call Recording
              {isAudioPlaying && (
                <span style={{ marginLeft: 8, color: T.primary, fontWeight: 700 }}>
                  ● LIVE
                </span>
              )}
            </span>
            {/* Now-at indicator: visible feedback for the audio↔node sync.
                Shows the active node's label, or "no node tracking" if the
                callLog has no usable timeline. */}
            {audioTime > 0 && (() => {
              const wfNodes = (run as any)?.project?.agentStructure?.workflow?.nodes ?? [];
              if (nodeMovementsForSync.length === 0) {
                return (
                  <span style={{ fontSize: 11, color: T.textMuted, fontStyle: "italic" }}>
                    No node timeline in callLog
                  </span>
                );
              }
              const node = activeNodeId ? wfNodes.find((n: any) => n.id === activeNodeId) : null;
              const label = node?.label || node?.type || (activeNodeId ?? "—");
              return (
                <span style={{ fontSize: 12, color: T.text, fontWeight: 600 }}>
                  Now at: <span style={{ color: T.primary }}>{label}</span>
                </span>
              );
            })()}
            <a href={recordingUrl} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 12, color: T.link, textDecoration: "none", marginLeft: "auto" }}>
              Open directly ↗
            </a>
          </div>
          {audioError ? (
            <div style={{ fontSize: 12, color: T.textSecondary, display: "flex", flexDirection: "column", gap: 8 }}>
              {audioErrorDetail === "ogg-unsupported" ? (
                <>
                  <div style={{ color: T.text }}>
                    This recording is in <strong>OGG format</strong>, which Safari doesn't support.
                    Use <strong>Chrome or Firefox</strong> to play it here, or download it below.
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <a
                      href={recordingUrl!}
                      download
                      style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, background: T.primary, color: "#fff", textDecoration: "none", border: "none" }}
                    >
                      Download recording ↓
                    </a>
                    <a
                      href={recordingUrl!}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 11, color: T.link, textDecoration: "none" }}
                    >
                      Open in new tab ↗
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    Recording unavailable.{" "}
                    {audioErrorDetail && <span style={{ color: "#ef4444" }}>({audioErrorDetail})</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button
                      type="button"
                      disabled={recordingRefreshing}
                      onClick={() => {
                        setRecordingRefreshing(true);
                        setAudioErrorDetail(null);
                        getRecordingUrl(runId!)
                          .then(({ url }) => {
                            setFreshRecordingUrl(url);
                            setAudioError(false);
                            setRecordingRefreshAttempted(false);
                            setAudioSrcVersion(v => v + 1); // force audio element to reload the stream
                          })
                          .catch((err) => {
                            const msg = err instanceof Error ? err.message : String(err);
                            setAudioErrorDetail(msg.slice(0, 200));
                          })
                          .finally(() => setRecordingRefreshing(false));
                      }}
                      style={{
                        fontSize: 11, padding: "4px 10px", borderRadius: 4,
                        background: T.card, color: T.text, border: `1px solid ${T.border}`,
                        cursor: recordingRefreshing ? "default" : "pointer",
                      }}
                    >
                      {recordingRefreshing ? "Fetching…" : "Retry from Hamsa"}
                    </button>
                    <span style={{ fontSize: 11, color: T.textMuted }}>
                      or use "Open directly" above
                    </span>
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              {/* Native <audio> kept hidden — remove `style` override to revert to browser player */}
              <audio
                ref={audioRef}
                controls
                src={audioSrc ?? undefined}
                onError={(e) => {
                  // Capture browser-level detail so the user (and we) see WHY.
                  // MediaError codes: 1=aborted, 2=network, 3=decode, 4=src not supported.
                  const mediaErr = (e.currentTarget as HTMLAudioElement).error;
                  const codes: Record<number, string> = {
                    1: "playback aborted",
                    2: "network error",
                    3: "decode error (codec unsupported?)",
                    4: "format not supported by this browser",
                  };
                  const detail = mediaErr ? codes[mediaErr.code] || `media error ${mediaErr.code}` : "load failed";

                  // Code 4 = format/codec not supported. Check whether this browser
                  // genuinely can't play OGG (Safari returns "" for all OGG canPlayType
                  // queries). If so, skip the retry — a fresh URL won't fix a codec gap.
                  if (mediaErr?.code === 4) {
                    const probe = document.createElement("audio");
                    const canOgg = probe.canPlayType("audio/ogg") !== "" || probe.canPlayType("audio/ogg; codecs=\"vorbis\"") !== "";
                    if (!canOgg) {
                      setAudioError(true);
                      setAudioErrorDetail("ogg-unsupported");
                      return;
                    }
                  }

                  if (!recordingRefreshAttempted) {
                    setRecordingRefreshAttempted(true);
                    setRecordingRefreshing(true);
                    setAudioErrorDetail(null);
                    getRecordingUrl(runId!)
                      .then(({ url }) => { setFreshRecordingUrl(url); setAudioError(false); setAudioSrcVersion(v => v + 1); })
                      .catch((refreshErr) => {
                        const msg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
                        setAudioError(true);
                        setAudioErrorDetail(`refresh failed: ${msg.slice(0, 180)}`);
                      })
                      .finally(() => setRecordingRefreshing(false));
                  } else {
                    setAudioError(true);
                    setAudioErrorDetail(detail);
                  }
                }}
                onLoadedMetadata={() => { const d = audioRef.current?.duration ?? 0; setAudioDuration(Number.isFinite(d) ? d : 0); }}
                onDurationChange={() => { const d = audioRef.current?.duration ?? 0; setAudioDuration(Number.isFinite(d) ? d : 0); }}
                onTimeUpdate={() => setAudioTime(audioRef.current?.currentTime ?? 0)}
                onSeeking={() => setAudioTime(audioRef.current?.currentTime ?? 0)}
                onSeeked={() => setAudioTime(audioRef.current?.currentTime ?? 0)}
                onPlay={() => setIsAudioPlaying(true)}
                onPause={() => setIsAudioPlaying(false)}
                onEnded={() => { setIsAudioPlaying(false); setAudioTime(0); }}
                style={{ display: "none" }}
              />
              {/* Custom player — same controls as the native player + node markers on the bar */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "2px 0" }}>
                {/* Play / Pause */}
                <button
                  onClick={() => {
                    const a = audioRef.current;
                    if (!a) return;
                    isAudioPlaying ? a.pause() : a.play().catch(() => {});
                  }}
                  title={isAudioPlaying ? "Pause" : "Play"}
                  style={{ background: "none", border: "none", cursor: "pointer", color: T.text, fontSize: 15, lineHeight: 1, padding: "4px 6px", borderRadius: 4, flexShrink: 0 }}
                >
                  {isAudioPlaying ? "⏸" : "▶"}
                </button>
                {/* Current / total time */}
                <span style={{ fontSize: 12, color: T.textMuted, flexShrink: 0, minWidth: 82, fontVariantNumeric: "tabular-nums" }}>
                  {formatTime(audioTime)} / {formatTime(audioDuration)}
                </span>
                {/* Progress bar — node markers sit on the same track */}
                <div
                  ref={progressBarRef}
                  onMouseDown={(e: React.MouseEvent<HTMLDivElement>) => {
                    e.preventDefault();
                    const bar = progressBarRef.current;
                    if (!bar || !audioDuration) return;
                    const seek = (clientX: number) => {
                      if (!mountedRef.current) return;
                      const rect = bar.getBoundingClientRect();
                      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                      const seekTo = frac * audioDuration;
                      if (audioRef.current) { audioRef.current.currentTime = seekTo; setAudioTime(seekTo); }
                    };
                    seek(e.clientX);
                    const onMove = (me: MouseEvent) => seek(me.clientX);
                    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
                    document.addEventListener("mousemove", onMove);
                    document.addEventListener("mouseup", onUp);
                  }}
                  style={{ flex: 1, position: "relative", height: 28, cursor: "pointer", userSelect: "none" }}
                >
                  {/* Track */}
                  <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 3, background: T.border, borderRadius: 2, transform: "translateY(-50%)", pointerEvents: "none" }} />
                  {/* Fill */}
                  <div style={{ position: "absolute", top: "50%", left: 0, width: `${audioDuration > 0 ? (audioTime / audioDuration) * 100 : 0}%`, height: 3, background: T.primary, borderRadius: 2, transform: "translateY(-50%)", pointerEvents: "none" }} />
                  {/* Node transition markers */}
                  {audioDuration > 0 && callStartMs != null && (() => {
                    const wfNodes = (run as any)?.project?.agentStructure?.workflow?.nodes ?? [];
                    return nodeMovementsForSync
                      .map((mov) => {
                        const offsetSec = (new Date(mov.timestamp).getTime() - callStartMs) / 1000;
                        return { mov, offsetSec };
                      })
                      .filter(({ offsetSec }) => offsetSec >= 0) // skip movements before recording start
                      .map(({ mov, offsetSec }) => {
                        const pct = Math.min(100, Math.max(0, (offsetSec / audioDuration) * 100));
                        const node = wfNodes.find((n: any) => n.id === mov.nodeId);
                        const label = node?.label || node?.type || mov.nodeId;
                        const isActive = mov.nodeId === activeNodeId;
                        return (
                          <div
                            key={`${mov.nodeId}-${mov.timestamp}`}
                            title={`${label} — ${formatTime(offsetSec)}`}
                            style={{
                              position: "absolute", left: `${pct}%`, top: "50%",
                              transform: "translate(-50%, -50%)",
                              width: isActive ? 11 : 7, height: isActive ? 11 : 7,
                              borderRadius: "50%",
                              background: isActive ? T.primary : T.textSecondary,
                              border: `2px solid ${isActive ? T.primary : T.border}`,
                              boxShadow: isActive ? `0 0 0 3px ${T.primary}33` : "none",
                              zIndex: 2, pointerEvents: "none", transition: "all 0.15s",
                            }}
                          />
                        );
                      });
                  })()}
                  {/* Playhead thumb */}
                  <div style={{ position: "absolute", left: `${audioDuration > 0 ? (audioTime / audioDuration) * 100 : 0}%`, top: "50%", transform: "translate(-50%, -50%)", width: 13, height: 13, borderRadius: "50%", background: T.primary, zIndex: 3, pointerEvents: "none", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
                </div>
                {/* Mute / Unmute */}
                <button
                  onClick={() => { const a = audioRef.current; if (!a) return; a.muted = !a.muted; setIsMuted(a.muted); }}
                  title={isMuted ? "Unmute" : "Mute"}
                  style={{ background: "none", border: "none", cursor: "pointer", color: T.text, fontSize: 15, lineHeight: 1, padding: "4px 6px", borderRadius: 4, flexShrink: 0 }}
                >
                  {isMuted ? "🔇" : "🔊"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Transcript with word labeling */}
      {transcript.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>
            Transcript
            <span style={{ fontSize: 12, color: T.textSecondary, marginLeft: 8 }}>
              (click words to label)
            </span>
          </h2>
          <div style={{ background: T.card, borderRadius: 8, padding: 16, border: `1px solid ${T.border}`, maxHeight: 500, overflow: "auto", boxShadow: T.shadow }}>
            {transcript.map((utt: any, ui: number) => {
              const isAgent = !!utt.Agent;
              const text = utt.Agent || utt.User || "";
              const words = text.split(/\s+/).filter(Boolean);
              const speaker = isAgent ? "Agent" : "User";
              const gender = utt.metadata?.gender;

              const turnOffset = transcriptTimestamps[ui];

              return (
                <div key={ui} style={{ marginBottom: 12, direction: "rtl", textAlign: "right" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, direction: "ltr", marginLeft: 8 }}>
                    <span style={{ fontSize: 11, color: isAgent ? "#3b82f6" : "#22c55e" }}>
                      [{speaker}{gender && gender !== "unknown" ? ` - ${gender}` : ""}]
                    </span>
                    {turnOffset != null && recordingUrl && (
                      <button
                        onClick={() => {
                          const a = audioRef.current;
                          if (!a) return;
                          const seekTo = Math.max(0, turnOffset - 0.2);
                          a.currentTime = seekTo;
                          setAudioTime(seekTo); // update immediately — don't wait for async onSeeked
                          a.play().catch(() => {});
                        }}
                        title={`Play from ${turnOffset.toFixed(1)}s`}
                        style={{
                          background: "none", border: "none", cursor: "pointer",
                          padding: "1px 3px", borderRadius: 3, lineHeight: 1,
                          color: isAgent ? "#3b82f6" : "#22c55e", fontSize: 10,
                          opacity: 0.65,
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.65"; }}
                      >
                        ▶
                      </button>
                    )}
                  </span>
                  <div style={{ direction: "rtl", lineHeight: 2 }}>
                    {words.map((word: string, wi: number) => {
                      // Direct index: uttStartIdx[ui] + wi is always correct,
                      // even for duplicate words within the same utterance.
                      const actualGlobalIndex = (uttStartIdx[ui] ?? 0) + wi;
                      const label = wordLabels.find((l: any) => l.wordIndex === actualGlobalIndex);

                      return (
                        <span
                          key={wi}
                          onClick={() =>
                            setLabelingWord({ wordIndex: actualGlobalIndex, utteranceIndex: ui, word, speaker })
                          }
                          style={{
                            cursor: "pointer",
                            padding: "2px 4px",
                            borderRadius: 3,
                            background: label ? `${LABEL_COLORS[label.labelType]}22` : "transparent",
                            borderBottom: label ? `2px solid ${LABEL_COLORS[label.labelType]}` : "none",
                            position: "relative",
                          }}
                          title={label ? `${label.labelType}${label.correction ? ` → ${label.correction}` : ""}` : "Click to label"}
                        >
                          {word}{" "}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Labeling popup */}
          {labelingWord && (
            <div
              onClick={() => setLabelingWord(null)}
              style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.3)", zIndex: 999 }}
            />
          )}
          {labelingWord && (
            <div style={{
              position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
              background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 20,
              zIndex: 1001, minWidth: 280, boxShadow: T.shadowLg,
            }}>
              <div style={{ fontSize: 14, marginBottom: 4 }}>
                Label word: <strong style={{ color: T.text }}>{labelingWord.word}</strong>
              </div>
              <div style={{ fontSize: 11, color: T.textSecondary, marginBottom: 12 }}>
                Speaker: <span style={{ color: labelingWord.speaker === "Agent" ? "#3b82f6" : "#22c55e" }}>{labelingWord.speaker}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(labelingWord.speaker === "Agent" ? AGENT_LABEL_TYPES : USER_LABEL_TYPES).map((lt) => (
                  <button
                    key={lt.type}
                    disabled={labeling}
                    onClick={() => handleLabel(lt.type)}
                    style={{
                      background: `${LABEL_COLORS[lt.type] || "#888"}22`,
                      color: LABEL_COLORS[lt.type] || "#888",
                      border: `1px solid ${LABEL_COLORS[lt.type] || "#888"}44`,
                      padding: "8px 14px",
                      borderRadius: 4,
                      cursor: labeling ? "default" : "pointer",
                      fontSize: 13,
                      textAlign: "left",
                      opacity: labeling ? 0.5 : 1,
                    }}
                  >
                    <div style={{ fontWeight: 500 }}>{lt.label}</div>
                    <div style={{ fontSize: 11, opacity: 0.7 }}>{lt.desc}</div>
                  </button>
                ))}
                {/* Check if already labeled — show remove option */}
                {wordLabels.find((l: any) => l.wordIndex === labelingWord.wordIndex) && (
                  <button
                    onClick={() => {
                      const existing = wordLabels.find((l: any) => l.wordIndex === labelingWord.wordIndex);
                      if (existing) handleRemoveLabel(existing.id);
                    }}
                    style={{ background: "none", color: T.textMuted, border: `1px solid ${T.border}`, padding: "6px 12px", borderRadius: 4, cursor: "pointer", fontSize: 13 }}
                  >
                    Remove Label
                  </button>
                )}
                <button
                  onClick={() => setLabelingWord(null)}
                  style={{ background: "none", color: T.textSecondary, border: "none", cursor: "pointer", fontSize: 12, marginTop: 4 }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {/* Word accuracy stats */}
          {wordLabels.length > 0 && (
            <div style={{ marginTop: 16, padding: 12, background: T.card, borderRadius: 6, border: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 13, color: T.textSecondary }}>
                Labels: {wordLabels.length} / {flatWords.length} words |{" "}
                {LABEL_TYPES.map((t) => {
                  const count = wordLabels.filter((l: any) => l.labelType === t).length;
                  return count > 0 ? (
                    <span key={t} style={{ color: LABEL_COLORS[t], marginRight: 12 }}>
                      {t.replace(/_/g, " ")}: {count}
                    </span>
                  ) : null;
                })}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Call metadata bar — outcome, time, caller number, full outcome fields */}
      {(() => {
        const SKIP_KEYS = new Set(["summary", "Sunnary", "call_outcome", "default_params", "failure_reason"]);
        const callerPhone =
          run.outcomeResult?.caller_phone ||
          run.webhookData?.caller_info?.caller_number ||
          run.webhookData?.caller_info?.phone_number ||
          run.webhookData?.from_number ||
          null;
        const callTime = run.callDate ? (() => {
          const d = new Date(run.callDate);
          const timeStr = d.toLocaleString();
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const offset = -d.getTimezoneOffset();
          const sign = offset >= 0 ? "+" : "-";
          const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
          const mm = String(Math.abs(offset) % 60).padStart(2, "0");
          return `${timeStr} (your time · ${tz} UTC${sign}${hh}:${mm})`;
        })() : null;

        // All non-empty outcome fields, excluding internal/redundant ones
        const outcomeFields: { label: string; value: string }[] = run.outcomeResult
          ? Object.entries(run.outcomeResult as Record<string, any>)
              .filter(([k, v]) => !SKIP_KEYS.has(k) && v != null && v !== "" && k !== "caller_phone")
              .map(([k, v]) => ({
                label: k.replace(/_/g, " "),
                value: typeof v === "object" ? JSON.stringify(v) : String(v),
              }))
          : [];

        const hasAny = run.callOutcome || callTime || callerPhone || outcomeFields.length > 0;
        if (!hasAny) return null;

        return (
          <div style={{
            padding: "14px 16px", marginBottom: 24,
            background: T.card, border: `1px solid ${T.border}`,
            borderRadius: 8, boxShadow: T.shadow,
          }}>
            {/* First row: call outcome, time, caller */}
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: outcomeFields.length > 0 ? 12 : 0 }}>
              {run.callOutcome && (
                <div>
                  <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 2 }}>Call Outcome</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: T.text, textTransform: "capitalize" }}>
                    {run.callOutcome.replace(/_/g, " ")}
                  </div>
                </div>
              )}
              {callTime && (
                <div>
                  <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 2 }}>Time</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{callTime}</div>
                </div>
              )}
              {callerPhone && (
                <div>
                  <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 2 }}>Caller</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{callerPhone}</div>
                </div>
              )}
            </div>
            {/* Second row: all outcome fields as compact chips */}
            {outcomeFields.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
                {outcomeFields.map(({ label, value }) => (
                  <span key={label} style={{
                    background: T.cardAlt, border: `1px solid ${T.border}`,
                    borderRadius: 6, padding: "3px 8px", fontSize: 11,
                  }}>
                    <span style={{ color: T.textMuted }}>{label}: </span>
                    <span style={{ color: T.text, fontWeight: 600 }}>{value}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Call Log with category counts and filtering */}
      {Array.isArray(run.callLog) && run.callLog.length > 0 && <CallLogViewer callLog={run.callLog} />}
    </div>
  );
}

// ─── Criterion Card Component ──────────────────────────────────────

const CRITERION_TYPE_COLORS: Record<string, string> = {
  FLOW_PROGRESSION: "#3b82f6",
  ACTION_CONSISTENCY: "#a855f7",
  ACTION_HALLUCINATION: "#dc2626",
  LAYERED_EVALUATION: "#06b6d4",
  LATENCY: "#f59e0b",
  DETERMINISTIC: "#22c55e",
  LLM_JUDGE: "#ec4899",
  WORD_ACCURACY: "#06b6d4",
  STRUCTURAL: "#f97316",
};

function CriterionCard({ er }: { er: any }) {
  const [expanded, setExpanded] = useState(false);
  const type: string = er.criterion?.type ?? "";
  const label: string = er.criterion?.label || er.criterion?.key || type;
  const score: number | null = er.score;
  const passed: boolean | null = er.passed;

  // Parse detail for structured types — extract the human-readable narrative field
  let parsedNarrative: string | null = null;
  if (er.detail && (type === "FLOW_PROGRESSION" || type === "ACTION_CONSISTENCY" || type === "ACTION_HALLUCINATION")) {
    try {
      const p = JSON.parse(er.detail);
      parsedNarrative = typeof p.detail === "string" ? p.detail : null;
    } catch {}
  }
  if (er.detail && type === "LAYERED_EVALUATION") {
    try {
      const p = JSON.parse(er.detail);
      parsedNarrative = typeof p.summary === "string" ? p.summary : null;
    } catch {}
  }

  // Summary: always shown inline (collapsed state)
  const summary = (() => {
    // Structured types — show the LLM narrative, or a generic fallback
    if (type === "FLOW_PROGRESSION" || type === "ACTION_CONSISTENCY" || type === "ACTION_HALLUCINATION" || type === "LAYERED_EVALUATION") {
      return parsedNarrative || "See detailed analysis below ↓";
    }
    if (!er.detail) return null;
    if (type === "LATENCY") {
      // Pull "Total call: Xs" and "N slow tools" from the detail string
      const timeMatch = er.detail.match(/Total call:\s*([\d.]+s|N\/A)/);
      const slowMatch = er.detail.match(/(\d+)\s*tool[s]?\s*over/i);
      const parts = [
        timeMatch ? `Total: ${timeMatch[1]}` : null,
        slowMatch ? `${slowMatch[1]} slow tool${slowMatch[1] !== "1" ? "s" : ""}` : null,
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(" · ") : er.detail.slice(0, 120);
    }
    // Generic: show inline if short, truncate if long
    return er.detail.length > 160 ? er.detail.slice(0, 160) + "…" : er.detail;
  })();

  // Whether clicking expand reveals additional content beyond the summary
  const hasExpandableContent = (() => {
    if (type === "FLOW_PROGRESSION" || type === "ACTION_CONSISTENCY" || type === "ACTION_HALLUCINATION" || type === "LAYERED_EVALUATION") return false; // detailed sections already rendered below
    if (!er.detail) return false;
    return er.detail.length > 160; // only expandable if content was truncated
  })();

  const scoreColor = score == null ? T.textMuted : score >= 0.8 ? "#22c55e" : score >= 0.5 ? "#f59e0b" : "#ef4444";
  const passColor = passed == null ? T.textMuted : passed ? "#22c55e" : "#ef4444";
  const typeColor = CRITERION_TYPE_COLORS[type] || "#888";

  return (
    <div style={{
      background: T.card, borderRadius: 8, border: `1px solid ${T.border}`,
      overflow: "hidden", boxShadow: T.shadow,
    }}>
      {/* Header row */}
      <div
        onClick={() => hasExpandableContent && setExpanded(!expanded)}
        style={{
          display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
          cursor: hasExpandableContent ? "pointer" : "default",
        }}
      >
        {/* Pass/fail dot */}
        <div style={{
          width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
          background: passColor,
          boxShadow: `0 0 6px ${passColor}66`,
        }} />

        {/* Label */}
        <div style={{ flex: 1, fontSize: 13, fontWeight: 500, color: T.text }}>
          {label}
        </div>

        {/* Type badge */}
        <span style={{
          fontSize: 10, padding: "1px 7px", borderRadius: 4,
          background: `${typeColor}18`, color: typeColor, border: `1px solid ${typeColor}33`,
          flexShrink: 0,
        }}>
          {type.replace(/_/g, " ")}
        </span>

        {/* Score */}
        <div style={{ fontWeight: 700, fontSize: 15, color: scoreColor, minWidth: 40, textAlign: "right", flexShrink: 0 }}>
          {score != null ? `${(score * 100).toFixed(0)}%` : "—"}
        </div>

        {/* Expand arrow — only shown when there's more to reveal */}
        {hasExpandableContent && (
          <span style={{ color: T.textFaint, fontSize: 10, flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
        )}
      </div>

      {/* Summary line (always visible) */}
      {summary && (
        <div style={{ padding: "0 14px 10px 36px", fontSize: 12, color: T.textSecondary, lineHeight: 1.5 }}>
          {expanded ? er.detail : summary}
        </div>
      )}
    </div>
  );
}

// ─── Module-level constants (not recreated per render) ─────────────

const NODE_TYPE_COLORS: Record<string, string> = {
  start: "#22c55e",
  conversation: "#3b82f6",
  tool: "#f59e0b",
  router: "#a855f7",
  end: "#ef4444",
};

const CALL_LOG_CATEGORY_COLORS: Record<string, string> = {
  node_movement: "#3b82f6",
  FLOW: "#3b82f6",
  TOOLS: "#f59e0b",
  VARIABLE_EXTRACTION: "#a855f7",
  VARIABLE: "#a855f7",
  CONVERSATION: "#22c55e",
  ROUTER: "#ec4899",
  TRANSITION: "#ec4899",
};

// ─── Flow Progression Visual Component ─────────────────────────────

function FlowProgressionView({
  workflowNodes,
  workflowEdges,
  callLog,
  evalResult,
  activeNodeId,
  isPlaying,
}: {
  workflowNodes: any[];
  workflowEdges: any[];
  callLog: any[];
  evalResult?: any;
  activeNodeId?: string | null;
  isPlaying?: boolean;
}) {
  // Determine which nodes were visited from the call log
  const visitedNodeIds = new Set<string>();
  const nodeMovements: Array<{ nodeId: string; timestamp: string }> = [];

  // Check both node_id and nodeId (API returns camelCase)
  for (const e of callLog) {
    const nid = e.node_id || e.nodeId;
    if (e.category === "node_movement" && nid) {
      visitedNodeIds.add(nid);
      nodeMovements.push({ nodeId: nid, timestamp: e.timestamp });
    }
  }

  // If node_ids are null, try TRANSITION/ROUTER payload.next_node first (new log
  // format, mid-2025+), then fall back to fuzzy text matching for older logs.
  if (visitedNodeIds.size === 0) {
    for (const e of callLog) {
      const nextNode = e.payload?.next_node;
      if (!nextNode) continue;
      if (e.category === "TRANSITION" || e.category === "ROUTER") {
        visitedNodeIds.add(String(nextNode));
        if (e.timestamp) nodeMovements.push({ nodeId: String(nextNode), timestamp: e.timestamp });
      }
    }
    // Prepend start node — TRANSITION.next_node never fires into the first node.
    if (visitedNodeIds.size > 0) {
      const startNode = workflowNodes.find((n: any) => n.type === "start");
      const firstEventTs = callLog.find((e: any) => e.timestamp)?.timestamp;
      if (startNode && firstEventTs && !visitedNodeIds.has(String(startNode.id))) {
        visitedNodeIds.add(String(startNode.id));
        nodeMovements.unshift({ nodeId: String(startNode.id), timestamp: firstEventTs });
      }
    }
  }

  // Fuzzy fallback for logs that predate the next_node fields.
  if (visitedNodeIds.size === 0) {
    // Match by prompt content (fuzzy — first 30 chars of the node message, ignoring template vars)
    const prompts = callLog.filter(
      (e: any) => e.message?.includes("Playing message")
    );
    for (const p of prompts) {
      const msg = (p.payload?.message || "").replace(/\{\{.*?\}\}/g, "").trim();
      if (!msg) continue;
      for (const node of workflowNodes) {
        if (!node.message) continue;
        const nodeMsg = node.message.replace(/\{\{.*?\}\}/g, "").trim();
        // Match if first 30 non-template chars overlap
        const msgStart = msg.slice(0, 40).trim();
        const nodeStart = nodeMsg.slice(0, 40).trim();
        if (msgStart && nodeStart && (msgStart.includes(nodeStart.slice(0, 20)) || nodeStart.includes(msgStart.slice(0, 20)))) {
          visitedNodeIds.add(node.id);
          nodeMovements.push({ nodeId: node.id, timestamp: p.timestamp });
          break;
        }
      }
    }

    // Match tool nodes by tool name
    const toolEvents = callLog.filter((e: any) => e.category === "TOOLS" && e.message === "Executing Tool");
    for (const te of toolEvents) {
      const toolName = te.payload?.toolName || "";
      for (const node of workflowNodes) {
        if (node.type === "tool" && node.description && toolName.includes(node.description.trim().slice(0, 15))) {
          visitedNodeIds.add(node.id);
          break;
        }
      }
    }

    // Match router nodes if we see ROUTER events.
    // Old logs have no next_node so we can't tell which router — mark all.
    const routerEvents = callLog.filter((e: any) => e.category === "ROUTER");
    if (routerEvents.length > 0) {
      for (const node of workflowNodes) {
        if (node.type === "router") visitedNodeIds.add(node.id);
      }
    }
  }

  // Extract variables (check both field naming conventions)
  const extractedVars = callLog
    .filter((e: any) =>
      (e.category === "VARIABLE_EXTRACTION" && (e.message?.includes("Updated variable") || e.message?.includes("Extracted"))) ||
      (e.category === "VARIABLE" && e.message?.includes("Extracted variable"))
    )
    .map((e: any) => ({
      name: e.payload?.variable || e.payload?.name,
      value: e.payload?.new_value || e.payload?.value,
      timestamp: e.timestamp,
    }))
    .filter((v: any) => v.name);

  // Extract tool calls
  const toolCalls = callLog
    .filter((e: any) => e.category === "TOOLS" && (e.message === "Executing Tool" || e.message?.includes("Executing")))
    .map((e: any) => ({
      name: e.payload?.toolName,
      nodeId: e.node_id || e.nodeId,
      timestamp: e.timestamp,
    }));

  // Build ordered node list based on flow (start node first, then follow edges)
  const startNode = workflowNodes.find((n: any) => n.type === "start");
  const orderedNodes: any[] = [];
  const visited = new Set<string>();

  function walkFlow(nodeId: string) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = workflowNodes.find((n: any) => n.id === nodeId);
    if (node) orderedNodes.push(node);
    const outEdges = workflowEdges.filter((e: any) => e.source === nodeId);
    const uniqueTargets = [...new Set(outEdges.map((e: any) => e.target))];
    for (const t of uniqueTargets) walkFlow(t);
  }
  if (startNode) walkFlow(startNode.id);
  // Add any unvisited nodes
  for (const n of workflowNodes) {
    if (!visited.has(n.id)) orderedNodes.push(n);
  }

  // Find last reached node
  const lastReachedIdx = orderedNodes.reduce((maxIdx, node, idx) => {
    return visitedNodeIds.has(node.id) ? idx : maxIdx;
  }, -1);


  // Determine stuck node ID
  const stuckNodeId = lastReachedIdx >= 0 && lastReachedIdx < orderedNodes.length - 1
    ? orderedNodes[lastReachedIdx]?.id
    : undefined;

  // Expanded by default so the audio→node sync is visible without an extra click.
  const [flowExpanded, setFlowExpanded] = useState(true);
  const [viewMode, setViewMode] = useState<"graph" | "list">("graph");

  return (
    <div style={{ marginBottom: 32 }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, userSelect: "none", marginBottom: flowExpanded ? 12 : 0 }}
      >
        <span
          onClick={() => setFlowExpanded(!flowExpanded)}
          style={{ color: T.textSecondary, fontSize: 12, transition: "transform 0.15s", transform: flowExpanded ? "rotate(90deg)" : "rotate(0deg)", cursor: "pointer" }}
        >&#9654;</span>
        <h2 onClick={() => setFlowExpanded(!flowExpanded)} style={{ fontSize: 16, margin: 0, cursor: "pointer" }}>Flow Progression</h2>
        {evalResult && (
          <span style={{
            fontSize: 11, padding: "2px 8px", borderRadius: 10,
            background: evalResult.passed ? T.successBg : T.errorBg,
            color: evalResult.passed ? "#22c55e" : "#ef4444",
          }}>
            {evalResult.passed ? "PASS" : "FAIL"} {evalResult.score != null ? `${(evalResult.score * 100).toFixed(0)}%` : ""}
          </span>
        )}
        {flowExpanded && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <button
              onClick={() => setViewMode("graph")}
              style={{
                fontSize: 11, padding: "3px 10px", borderRadius: 4, cursor: "pointer",
                background: viewMode === "graph" ? T.cardAlt : "transparent",
                color: viewMode === "graph" ? T.text : T.textMuted,
                border: `1px solid ${viewMode === "graph" ? T.borderDark : T.border}`,
              }}
            >Graph</button>
            <button
              onClick={() => setViewMode("list")}
              style={{
                fontSize: 11, padding: "3px 10px", borderRadius: 4, cursor: "pointer",
                background: viewMode === "list" ? T.cardAlt : "transparent",
                color: viewMode === "list" ? T.text : T.textMuted,
                border: `1px solid ${viewMode === "list" ? T.borderDark : T.border}`,
              }}
            >List</button>
          </div>
        )}
      </div>

      {!flowExpanded ? null : <>
      {/* LLM Analysis Summary — parse JSON detail, show only the human narrative */}
      {(() => {
        if (!evalResult?.detail) return null;
        let narrative = evalResult.detail as string;
        try {
          const p = JSON.parse(evalResult.detail);
          if (typeof p.detail === "string") narrative = p.detail;
        } catch {}
        return (
          <div style={{
            background: evalResult.passed ? T.successBg : T.errorBg,
            border: `1px solid ${evalResult.passed ? "#22c55e33" : "#ef444433"}`,
            borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13, lineHeight: 1.6,
            color: T.text,
          }}>
            {narrative}
          </div>
        );
      })()}

      {/* Graph View — React Flow Canvas */}
      {viewMode === "graph" && (
        <Suspense fallback={<div style={{ height: 500, background: T.cardAlt, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: T.textMuted }}>Loading flow diagram...</div>}>
          <WorkflowCanvas
            workflowNodes={workflowNodes}
            workflowEdges={workflowEdges}
            visitedNodeIds={visitedNodeIds}
            stuckNodeId={stuckNodeId}
            extractedVars={extractedVars}
            toolCalls={toolCalls}
            activeNodeId={activeNodeId ?? null}
            isPlaying={isPlaying ?? false}
            callLog={callLog}
            nodeMovements={nodeMovements}
          />
        </Suspense>
      )}

      {/* List View — original vertical list */}
      {viewMode === "list" && (
      <div style={{ background: T.card, borderRadius: 8, padding: 16, border: `1px solid ${T.border}`, boxShadow: T.shadow }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {orderedNodes.map((node: any, idx: number) => {
            const wasVisited = visitedNodeIds.has(node.id);
            const isStuckHere = wasVisited && idx === lastReachedIdx && lastReachedIdx < orderedNodes.length - 1;
            const isPastReach = idx > lastReachedIdx && lastReachedIdx >= 0;
            const nodeVars = node.extractVariables?.variables?.map((v: any) => v.name) || [];
            const extractedHere = extractedVars.filter((v: any) => nodeVars.includes(v.name));
            const toolHere = toolCalls.find((t: any) => t.nodeId === node.id);
            const typeColor = NODE_TYPE_COLORS[node.type] || "#888";

            return (
              <div key={node.id}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                  background: isStuckHere ? T.errorBg : wasVisited ? T.successBg : T.cardAlt,
                  border: `1px solid ${isStuckHere ? "#ef444444" : wasVisited ? "#22c55e33" : T.border}`,
                  borderRadius: 6, opacity: isPastReach ? 0.4 : 1,
                }}>
                  {/* Status indicator */}
                  <div style={{
                    width: 24, height: 24, borderRadius: "50%", flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12,
                    background: wasVisited
                      ? (isStuckHere ? "#ef444433" : "#22c55e33")
                      : T.border,
                    color: wasVisited
                      ? (isStuckHere ? "#ef4444" : "#22c55e")
                      : T.textMuted,
                  }}>
                    {wasVisited ? (isStuckHere ? "!" : "\u2713") : idx + 1}
                  </div>

                  {/* Node info */}
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{node.label}</span>
                      <span style={{
                        fontSize: 10, padding: "1px 6px", borderRadius: 3,
                        background: `${typeColor}22`, color: typeColor, border: `1px solid ${typeColor}44`,
                      }}>
                        {node.type}
                      </span>
                      {isStuckHere && (
                        <span style={{
                          fontSize: 10, padding: "1px 6px", borderRadius: 3,
                          background: T.errorBg, color: "#ef4444", border: "1px solid #ef444444",
                        }}>
                          STUCK HERE
                        </span>
                      )}
                    </div>

                    {/* Variables extracted at this node */}
                    {extractedHere.length > 0 && (
                      <div style={{ fontSize: 11, color: "#22c55e", marginTop: 4 }}>
                        Extracted: {extractedHere.map((v: any) => `${v.name}="${v.value}"`).join(", ")}
                      </div>
                    )}

                    {/* Tool called at this node */}
                    {toolHere && (
                      <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 2 }}>
                        Tool: {toolHere.name}
                      </div>
                    )}

                    {/* Expected variables not extracted */}
                    {wasVisited && isStuckHere && nodeVars.length > 0 && extractedHere.length === 0 && (
                      <div style={{ fontSize: 11, color: "#ef4444", marginTop: 2 }}>
                        Failed to extract: {nodeVars.join(", ")}
                      </div>
                    )}

                    {/* Transitions */}
                    {node.transitions?.length > 0 && (
                      <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>
                        Transitions: {node.transitions.map((t: any) => t.condition?.description || t.condition?.prompt).join(" | ")}
                      </div>
                    )}
                  </div>
                </div>

                {/* Connector arrow */}
                {idx < orderedNodes.length - 1 && (
                  <div style={{ display: "flex", justifyContent: "flex-start", paddingLeft: 22 }}>
                    <div style={{
                      width: 2, height: 12,
                      background: wasVisited && !isStuckHere ? "#22c55e44" : T.border,
                    }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      )}

      {/* Summary bar */}
      <div style={{
        marginTop: 12, padding: "8px 12px", background: T.cardAlt,
        borderRadius: 6, fontSize: 12, color: T.textSecondary,
        display: "flex", gap: 16, flexWrap: "wrap",
      }}>
        <span>Nodes reached: <strong style={{ color: T.text }}>{visitedNodeIds.size}/{orderedNodes.length}</strong></span>
        <span>Variables: <strong style={{ color: T.text }}>{extractedVars.length}</strong></span>
        <span>Tools: <strong style={{ color: T.text }}>{toolCalls.length}</strong></span>
        {lastReachedIdx >= 0 && lastReachedIdx < orderedNodes.length - 1 && (
          <span style={{ color: "#ef4444" }}>
            Stopped at node {lastReachedIdx + 1}/{orderedNodes.length}
          </span>
        )}
      </div>
      </>}
    </div>
  );
}

// ─── Metric Row Component ──────────────────────────────────────────

function MetricRow({ label, total, errors, pct, color, comment }: {
  label: string; total: number; errors: number; pct: number | null; color: string; comment?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
          background: T.card, borderRadius: 6, border: `1px solid ${T.border}`, cursor: "pointer",
        }}
      >
        {/* Label */}
        <div style={{ width: 140, fontSize: 13, fontWeight: 500 }}>{label}</div>

        {/* Bar */}
        <div style={{ flex: 1, height: 8, background: "#e5e7eb", borderRadius: 4, overflow: "hidden" }}>
          {pct != null && (
            <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4, transition: "width 0.3s" }} />
          )}
        </div>

        {/* Percentage */}
        <div style={{ width: 50, textAlign: "right", fontSize: 14, fontWeight: 700, color }}>
          {pct != null ? `${pct}%` : "N/A"}
        </div>

        {/* Error badge */}
        {errors > 0 && (
          <div style={{ fontSize: 11, padding: "2px 6px", borderRadius: 3, background: T.errorBg, color: "#ef4444", border: `1px solid ${T.border}` }}>
            {errors} error{errors > 1 ? "s" : ""}
          </div>
        )}

        {/* Expand arrow */}
        <span style={{ color: T.textMuted, fontSize: 10 }}>{expanded ? "\u25B2" : "\u25BC"}</span>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ padding: "8px 14px 8px 26px", fontSize: 12, color: T.textSecondary, background: T.cardAlt, borderRadius: "0 0 6px 6px", borderTop: "none" }}>
          <span>Total: {total} | Errors: {errors} | Success: {total - errors}</span>
          {comment && <div style={{ marginTop: 4, color: T.textSecondary, fontStyle: "italic" }}>{comment}</div>}
        </div>
      )}
    </div>
  );
}

// ─── Collapsible Section Component ─────────────────────────────────

function CollapsibleSection({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: T.cardAlt, border: `1px solid ${T.border}`, borderRadius: 6,
          padding: "8px 14px", color: T.text, cursor: "pointer", fontSize: 13,
          width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between",
        }}
      >
        <span>{title}</span>
        <span style={{ color: T.textMuted }}>{open ? "\u25B2" : "\u25BC"}</span>
      </button>
      {open && (
        <div style={{ padding: "12px 0" }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Call Log Viewer with category counts ──────────────────────────

function CallLogViewer({ callLog }: { callLog: any[] }) {
  const [filter, setFilter] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  const CATEGORY_COLORS = CALL_LOG_CATEGORY_COLORS;

  const categoryCounts: Record<string, { total: number; info: number; debug: number }> = {};
  for (const e of callLog) {
    const cat = e.category || "OTHER";
    if (!categoryCounts[cat]) categoryCounts[cat] = { total: 0, info: 0, debug: 0 };
    categoryCounts[cat].total++;
    if (e.type === "INFO") categoryCounts[cat].info++;
    if (e.type === "DEBUG") categoryCounts[cat].debug++;
  }

  const filtered = callLog.filter((e: any) => {
    if (!showDebug && e.type === "DEBUG") return false;
    if (filter && e.category !== filter) return false;
    return true;
  });

  return (
    <div style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 16, marginBottom: 12 }}>Call Log</h2>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        <button onClick={() => setFilter(null)} style={{
          padding: "4px 10px", borderRadius: 4, fontSize: 11, cursor: "pointer",
          border: `1px solid ${!filter ? T.borderDark : T.border}`,
          background: !filter ? T.cardAlt : T.card, color: !filter ? T.text : T.textSecondary,
        }}>
          All ({callLog.length})
        </button>
        {Object.entries(categoryCounts).sort((a, b) => b[1].total - a[1].total).map(([cat, counts]) => (
          <button key={cat} onClick={() => setFilter(filter === cat ? null : cat)} style={{
            padding: "4px 10px", borderRadius: 4, fontSize: 11, cursor: "pointer",
            border: `1px solid ${filter === cat ? (CATEGORY_COLORS[cat] || T.textSecondary) : T.border}`,
            background: filter === cat ? `${CATEGORY_COLORS[cat] || T.textSecondary}22` : T.card,
            color: CATEGORY_COLORS[cat] || "#888",
          }}>
            {cat} ({counts.total})
          </button>
        ))}
        <label style={{ fontSize: 11, color: T.textMuted, display: "flex", alignItems: "center", gap: 4, marginLeft: 8 }}>
          <input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} />
          Show DEBUG
        </label>
      </div>

      <div style={{ background: T.card, borderRadius: 8, padding: 16, border: `1px solid ${T.border}`, maxHeight: 500, overflow: "auto", boxShadow: T.shadow }}>
        {filtered.map((event: any, i: number) => (
          <div key={i} style={{
            display: "flex", gap: 8, marginBottom: 4, fontSize: 11, lineHeight: 1.6,
            opacity: event.type === "DEBUG" ? 0.6 : 1, padding: "2px 0",
            borderBottom: event.category === "node_movement" ? `1px solid ${T.border}` : "none",
          }}>
            <span style={{ color: T.textMuted, fontFamily: "monospace", whiteSpace: "nowrap", width: 85, flexShrink: 0 }}>
              {event.timestamp?.split("T")[1]?.slice(0, 12)}
            </span>
            <span style={{ color: event.type === "DEBUG" ? T.textMuted : T.textSecondary, width: 40, flexShrink: 0, fontSize: 10 }}>
              {event.type}
            </span>
            <span style={{ color: CATEGORY_COLORS[event.category] || "#888", width: 130, flexShrink: 0 }}>
              {event.category}
            </span>
            <span style={{ color: T.text, flex: 1 }}>
              {event.message}
              {event.payload?.variable && <span style={{ color: "#a855f7" }}> {event.payload.variable}={event.payload.new_value || event.payload.value}</span>}
              {event.payload?.toolName && <span style={{ color: "#f59e0b" }}> [{event.payload.toolName}]</span>}
              {event.payload?.total_nodes && <span style={{ color: T.textMuted }}> ({event.payload.total_nodes} nodes)</span>}
              {event.payload?.action && <span style={{ color: "#3b82f6" }}> ({event.payload.action})</span>}
              {event.payload?.success === false && <span style={{ color: "#ef4444" }}> FAILED</span>}
              {event.payload?.tools && <span style={{ color: T.textMuted }}> [{event.payload.tools.join(", ")}]</span>}
              {event.payload?.next_node && <span style={{ color: "#3b82f6" }}> → {event.payload.next_node}</span>}
            </span>
            {event.node_id && <span style={{ color: T.textFaint, fontFamily: "monospace", fontSize: 10, flexShrink: 0 }}>{event.node_id.slice(0, 8)}</span>}
          </div>
        ))}
        {filtered.length === 0 && <div style={{ color: T.textMuted, fontSize: 12, padding: 8 }}>No events match the current filter.</div>}
      </div>
    </div>
  );
}
