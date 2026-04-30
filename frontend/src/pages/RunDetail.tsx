import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import T from "../theme";
import { getRun, createLabel, deleteLabel, triggerEvaluation, fetchLogs } from "../api/client";

const WorkflowCanvas = lazy(() => import("../components/WorkflowCanvas"));

// ─── Goal Achievement ──────────────────────────────────────────────

type GoalStatus = "SUCCESSFUL" | "FAILED" | "PARTIAL";

function computeGoal(run: any): { status: GoalStatus; reason: string } | null {
  if (run.status !== "COMPLETE") return null;

  const callStatus = (run.callStatus || "").toUpperCase();
  const outcome = (run.callOutcome || "").toLowerCase();
  const score: number | null = run.overallScore ?? null;
  const summary: string = run.outcomeResult?.summary || "";
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
                      || outcome.includes("stuck") || outcome.includes("timeout")
                      || outcome.includes("confused") || outcome.includes("dropped");
    const status: GoalStatus = (score != null && score >= 0.7) ? "PARTIAL" : "FAILED";
    const reason = summary
      || (isIncomplete
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

export default function RunDetail() {
  const { id, runId } = useParams();
  const [run, setRun] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [labelingWord, setLabelingWord] = useState<{ wordIndex: number; utteranceIndex: number; word: string; speaker: string } | null>(null);
  const [audioError, setAudioError] = useState(false);
  const [reEvaluating, setReEvaluating] = useState(false);
  const [labeling, setLabeling] = useState(false);
  // Tracks which runId the current poll belongs to. When the user navigates
  // to a different run, this ref changes and any in-flight poll for the old
  // runId will see a mismatch and stop — preventing stale data from being
  // applied to the new page.
  const activeRunIdRef = useRef<string | null>(null);

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
    setReEvaluating(false);
    setLabelingWord(null);
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (loading) return <p>Loading...</p>;
  if (!run) return <p>Run not found</p>;

  const transcript = (run.transcript || []) as any[];
  const evalResults = (run.evalResults || []) as any[];

  // Resolve recording URL — check all known Hamsa field locations
  const recordingUrl: string | null = (() => {
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
        {run.hamsaCallId && (!run.callLog || (Array.isArray(run.callLog) && run.callLog.length === 0)) && (
          <button
            onClick={async () => {
              try {
                const r = await fetchLogs(runId!);
                alert(`Fetched ${r.events} log events`);
                load();
              } catch (err) { alert("Failed: " + (err as Error).message); }
            }}
            style={{ background: "#f59e0b", color: "#000", padding: "6px 12px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
          >
            Fetch Logs
          </button>
        )}
        <button
          disabled={reEvaluating}
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
              if (activeRunIdRef.current !== capturedRunId) return; // navigated away
              getRun(capturedRunId).then((r) => {
                if (activeRunIdRef.current !== capturedRunId) return;
                setRun(r);
                if (["EVALUATING", "PENDING", "RUNNING"].includes(r.status)) {
                  setTimeout(poll, 2000);
                } else {
                  setReEvaluating(false);
                }
              }).catch(() => {
                if (activeRunIdRef.current === capturedRunId) setReEvaluating(false);
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

      {/* Call recording */}
      {recordingUrl && (
        <div style={{ marginBottom: 20 }}>
          {audioError ? (
            <div style={{ padding: "10px 14px", background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 12, color: T.textSecondary, display: "flex", alignItems: "center", gap: 10 }}>
              <span>Recording unavailable (URL may have expired)</span>
              <a href={recordingUrl} target="_blank" rel="noopener noreferrer" style={{ color: T.link, textDecoration: "none" }}>Open directly ↗</a>
            </div>
          ) : (
            <audio
              controls
              src={recordingUrl}
              onError={() => setAudioError(true)}
              style={{ width: "100%", accentColor: T.primary }}
            />
          )}
        </div>
      )}

      {/* Call outcome + score summary */}
      <div style={{ display: "flex", gap: 32, alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap" }}>
        {run.overallScore != null && (
          <div>
            <div style={{ fontSize: 12, color: T.textSecondary, marginBottom: 4 }}>Overall Score</div>
            <div style={{ fontSize: 36, fontWeight: 700, color: run.overallScore >= 0.8 ? "#22c55e" : run.overallScore >= 0.5 ? "#f59e0b" : "#ef4444" }}>
              {(run.overallScore * 100).toFixed(0)}%
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
        />
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

              return (
                <div key={ui} style={{ marginBottom: 12, direction: "rtl", textAlign: "right" }}>
                  <span style={{ fontSize: 11, color: isAgent ? "#3b82f6" : "#22c55e", marginLeft: 8, direction: "ltr" }}>
                    [{speaker}{gender && gender !== "unknown" ? ` - ${gender}` : ""}]
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
}: {
  workflowNodes: any[];
  workflowEdges: any[];
  callLog: any[];
  evalResult?: any;
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

  // If node_ids are null, match by conversation prompts and variables/tools
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

    // Match router nodes if we see ROUTER events
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

  const [flowExpanded, setFlowExpanded] = useState(false);
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
