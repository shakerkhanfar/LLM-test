import { useEffect, useRef, useState, useCallback } from "react";
import { HamsaVoiceAgent } from "@hamsa-ai/voice-agents-sdk";
import type { ReceivedMessage } from "@hamsa-ai/voice-agents-sdk";
import { updateRun, fetchLogs, attachTranscript, getRun } from "../api/client";
import T from "../theme";

/**
 * ChatTester — drive a Hamsa agent over the SDK's chat-only mode (no mic, no
 * phone call), then run the produced conversation through the same evaluate
 * pipeline as a live call. P0 spike of the scenario testing harness: one text
 * conversation → an evaluated Run (source = CHAT_TEST) inside the dashboard,
 * reusing fetch-logs + attach-transcript + evaluate end to end.
 *
 * Transport parity: chat-only sessions exercise the same flow graph and tools as
 * a voice call, so flow/tool/hallucination findings surface here too — over text,
 * which is deterministic and free of ASR/TTS noise.
 */

interface ChatTesterProps {
  runId: string;      // pre-created Run (source: CHAT_TEST)
  agentId: string;
  apiKey: string;
  onClose: () => void;
  onFinished?: () => void; // called once the run reaches a terminal state
}

interface ChatMessage {
  seq: number;
  id: string;          // SDK message id, or a synthetic id for locally-sent user turns
  role: "agent" | "user";
  text: string;
}

type Phase =
  | "connecting"
  | "chatting"
  | "ending"
  | "fetching_data"
  | "evaluating"
  | "complete"
  | "error";

const CONNECT_TIMEOUT_MS = 45_000;
const EVAL_POLL_INTERVAL_MS = 2_000;
const EVAL_POLL_MAX = 150; // ~5 min — matches the server-side evaluation timeout

// Transcript shape the backend evaluators expect (same as the webhook payload).
function toTranscript(messages: ChatMessage[]): Array<Record<string, string>> {
  return messages.map((m): Record<string, string> =>
    m.role === "agent" ? { Agent: m.text } : { User: m.text }
  );
}

export default function ChatTester({ runId, agentId, apiKey, onClose, onFinished }: ChatTesterProps) {
  const agentRef = useRef<HamsaVoiceAgent | null>(null);
  const unmountedRef = useRef(false);
  const finalizingRef = useRef(false); // guards against double-submit (user End + agent callEnded)
  const seqRef = useRef(0);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Live mirror of messages so the finalize handler reads the latest transcript
  // without a stale closure.
  const messagesRef = useRef<ChatMessage[]>([]);

  const [phase, setPhase] = useState<Phase>("connecting");
  const [agentState, setAgentState] = useState<string>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [callId, setCallId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [evalScore, setEvalScore] = useState<number | null>(null);
  const [evalResults, setEvalResults] = useState<any[]>([]);
  const [evalTimedOut, setEvalTimedOut] = useState(false);

  const safeTimeout = useCallback((fn: () => void, ms: number) => {
    const h = setTimeout(() => { if (!unmountedRef.current) fn(); }, ms);
    timeoutsRef.current.push(h);
    return h;
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
    scrollEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Upsert a message by id (agent turns stream: same id updates in place).
  const upsertMessage = useCallback((id: string, role: "agent" | "user", text: string) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = { ...next[idx], text };
        return next;
      }
      return [...prev, { seq: seqRef.current++, id, role, text }];
    });
  }, []);

  const pollForComplete = useCallback((attempt = 0) => {
    if (unmountedRef.current) return;
    if (attempt >= EVAL_POLL_MAX) {
      // Don't claim "complete" with a null score — the eval is still running server-side.
      setEvalTimedOut(true);
      setPhase("complete");
      onFinished?.();
      return;
    }
    safeTimeout(async () => {
      try {
        const run = await getRun(runId);
        if (unmountedRef.current) return;
        if (run.status === "COMPLETE") {
          setEvalScore(run.overallScore ?? null);
          setEvalResults(Array.isArray(run.evalResults) ? run.evalResults : []);
          setPhase("complete");
          onFinished?.();
        } else if (run.status === "FAILED") {
          setError(run.errorLog || "Evaluation failed");
          setPhase("error");
        } else {
          pollForComplete(attempt + 1);
        }
      } catch {
        pollForComplete(attempt + 1);
      }
    }, EVAL_POLL_INTERVAL_MS);
    // safeTimeout / getRun / onFinished are stable enough; runId is fixed per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // End the session (if not already) and run the conversation through the
  // evaluate pipeline. Shared by the user's "End & Evaluate" and by an
  // agent-initiated hangup (callEnded) so neither path strands the run.
  const finalize = useCallback(async () => {
    if (finalizingRef.current) return;
    finalizingRef.current = true;

    setPhase("ending");
    try { agentRef.current?.end(); } catch { /* already ended */ }

    const transcript = toTranscript(messagesRef.current);
    if (transcript.length === 0) {
      setError("No conversation was captured — nothing to evaluate.");
      setPhase("error");
      return;
    }

    await updateRun(runId, { status: "AWAITING_DATA" }).catch(() => {});
    if (unmountedRef.current) return;
    setPhase("fetching_data");

    // Best-effort: pull the node/tool trace via the jobId. May be empty for chat
    // sessions or absent if no jobId was captured — evaluation still proceeds on
    // the transcript.
    try { await fetchLogs(runId); } catch { /* trace optional */ }
    if (unmountedRef.current) return;

    setPhase("evaluating");
    try {
      // attachTranscript stores the transcript AND triggers the single evaluation
      // (call log already attached above, so the evaluator sees both).
      await attachTranscript(runId, transcript, { source: "CHAT_TEST" });
    } catch (err) {
      if (unmountedRef.current) return;
      setError(`Failed to submit transcript: ${(err as Error).message}`);
      setPhase("error");
      return;
    }
    pollForComplete();
  }, [runId, pollForComplete]);

  // ── Start the chat-only session on mount ──────────────────────────────
  // Created fresh on every effect run so React StrictMode's mount→unmount→mount
  // in dev ends the first throwaway session and starts a live one, rather than
  // leaving a dead agent behind. Per-effect `disposed` flag ignores events from
  // a session that has already been torn down.
  useEffect(() => {
    unmountedRef.current = false;
    let disposed = false;

    const agent = new HamsaVoiceAgent(apiKey);
    agentRef.current = agent;

    agent.on("callStarted", ({ jobId }) => {
      if (disposed) return;
      setPhase((p) => (p === "connecting" ? "chatting" : p));
      if (jobId) {
        setCallId(jobId);
        // Persist the jobId so the trace can be fetched and the run is
        // rehydratable later. Skip empty ids to avoid a "" hamsaCallId.
        updateRun(runId, { hamsaCallId: jobId, status: "RUNNING" }).catch(() => {});
      }
    });

    agent.on("agentStateChanged", (state) => {
      if (!disposed) setAgentState(String(state));
    });

    // Deterministic chat event. Render agent turns from here; user turns are
    // added optimistically on send (below). Also flip out of "connecting" here
    // in case callStarted did not fire first.
    agent.on("chatMessageReceived", (msg: ReceivedMessage) => {
      if (disposed) return;
      setPhase((p) => (p === "connecting" ? "chatting" : p));
      if (msg.role === "agent") upsertMessage(msg.id, "agent", msg.text);
    });

    // Agent-initiated end (e.g. it said goodbye and hung up): finalize so the
    // conversation still gets evaluated instead of stalling on "ending".
    agent.on("callEnded", () => {
      if (disposed) return;
      if (!finalizingRef.current && messagesRef.current.length > 0) {
        void finalize();
      } else if (!finalizingRef.current) {
        setPhase("error");
        setError("The session ended before any messages were exchanged.");
      }
    });

    agent.on("error", (e: any) => {
      if (disposed) return;
      setError(typeof e === "string" ? e : e?.message || "Chat session error");
      setPhase("error");
    });

    agent.start({ agentId, isChatOnly: true }).catch((err) => {
      if (disposed) return;
      setError((err as Error).message);
      setPhase("error");
    });

    // Watchdog: if the session never signals it started, surface an error
    // instead of hanging on "connecting" forever.
    const watchdog = setTimeout(() => {
      if (disposed) return;
      setPhase((p) => {
        if (p === "connecting") {
          setError("Could not start the chat session (no response). Check the agent ID, API key, and region.");
          return "error";
        }
        return p;
      });
    }, CONNECT_TIMEOUT_MS);

    return () => {
      disposed = true;
      unmountedRef.current = true;
      clearTimeout(watchdog);
      timeoutsRef.current.forEach(clearTimeout);
      timeoutsRef.current = [];
      try { agent.end(); } catch { /* already ended */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || phase !== "chatting") return;
    setInput("");
    // Optimistic user bubble with a synthetic id (SDK ids are for agent turns).
    upsertMessage(`local-user-${seqRef.current}`, "user", text);
    try {
      await agentRef.current?.sendMessage(text);
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
    }
  }

  const phaseLabel: Record<Phase, string> = {
    connecting: "Connecting…",
    chatting: "Chat active",
    ending: "Ending…",
    fetching_data: "Fetching trace…",
    evaluating: "Evaluating…",
    complete: evalTimedOut ? "Still evaluating…" : "Evaluation complete",
    error: "Error",
  };

  const stateColor: Record<string, string> = {
    idle: T.textSecondary, thinking: "#3b82f6", speaking: "#a855f7", listening: "#22c55e",
  };

  const busy = phase === "ending" || phase === "fetching_data" || phase === "evaluating";

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
        width: 620, maxHeight: "90vh", display: "flex", flexDirection: "column",
      }}>
        {/* Header */}
        <div style={{
          padding: "16px 20px", borderBottom: `1px solid ${T.border}`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>💬 Chat Test</h2>
            <span style={{ fontSize: 12, color: phase === "error" ? "#ef4444" : T.textSecondary }}>
              {phaseLabel[phase]}{callId ? ` · ${callId.slice(0, 8)}…` : ""}
            </span>
          </div>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 20, padding: 4,
          }}>&times;</button>
        </div>

        {/* Agent state / eval banner */}
        {phase === "chatting" && (
          <div style={{ padding: "8px 20px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: stateColor[agentState] || T.textSecondary,
              animation: agentState === "thinking" || agentState === "speaking" ? "pulse 1.4s infinite" : "none",
            }} />
            <span style={{ color: stateColor[agentState] || T.textSecondary }}>
              {agentState === "thinking" ? "Agent is thinking…" : agentState === "speaking" ? "Agent is replying…" : "Your turn — type a message"}
            </span>
          </div>
        )}
        {phase === "complete" && (
          <div style={{
            padding: "14px 20px", borderBottom: `1px solid ${T.border}`,
            background: evalTimedOut || evalScore == null ? T.card : evalScore >= 0.8 ? T.successBg : evalScore >= 0.5 ? T.warningBg : T.errorBg,
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {evalTimedOut ? "Evaluation still running" : "Evaluation complete"}
              </div>
              <div style={{ fontSize: 11, color: T.textSecondary }}>
                {evalTimedOut
                  ? "Taking longer than expected — it will finish in the background; reopen the run to see results."
                  : `${evalResults.length} criteria evaluated${callId ? ` · call ${callId.slice(0, 8)}…` : ""}`}
              </div>
            </div>
            {!evalTimedOut && evalScore != null && (
              <div style={{ fontSize: 24, fontWeight: 700, color: evalScore >= 0.8 ? "#22c55e" : evalScore >= 0.5 ? "#f59e0b" : "#ef4444" }}>
                {(evalScore * 100).toFixed(0)}%
              </div>
            )}
          </div>
        )}

        {/* Transcript */}
        <div style={{ flex: 1, overflow: "auto", padding: "16px 20px", minHeight: 240, maxHeight: 440 }}>
          {phase === "connecting" && (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#f59e0b", fontSize: 14, animation: "pulse 1.5s infinite" }}>
              Starting chat-only session…
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {messages.map((m) => (
              <div key={m.id} style={{ display: "flex", flexDirection: m.role === "user" ? "row-reverse" : "row", gap: 8 }}>
                <div dir="auto" style={{
                  maxWidth: "80%", padding: "10px 14px",
                  borderRadius: m.role === "user" ? "12px 12px 0 12px" : "12px 12px 12px 0",
                  background: m.role === "agent" ? "#1a2332" : "#1a331a",
                  border: `1px solid ${m.role === "agent" ? "#1e3a5f" : "#1e5f1e"}`,
                  textAlign: "start",
                }}>
                  <div style={{ fontSize: 10, color: m.role === "agent" ? "#3b82f6" : "#22c55e", marginBottom: 4 }}>
                    {m.role === "agent" ? "Agent" : "You"}
                  </div>
                  <div style={{ fontSize: 13, color: T.text, lineHeight: 1.5 }}>{m.text}</div>
                </div>
              </div>
            ))}
            <div ref={scrollEndRef} />
          </div>
          {error && (
            <div style={{ background: T.errorBg, border: "1px solid #ef444433", borderRadius: 8, padding: 12, fontSize: 13, color: "#ef4444", marginTop: 8 }}>
              {error}
            </div>
          )}
        </div>

        {/* Input / actions */}
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${T.border}`, display: "flex", gap: 8, alignItems: "center" }}>
          {phase === "chatting" && (
            <>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") send(); }}
                placeholder="Type the caller's message…"
                dir="auto"
                autoFocus
                style={{
                  flex: 1, padding: "10px 12px", borderRadius: 8, fontSize: 13,
                  background: T.cardAlt, border: `1px solid ${T.border}`, color: T.text,
                }}
              />
              <button onClick={send} disabled={!input.trim()} style={{
                background: input.trim() ? T.primary : "#374151", color: "#fff",
                padding: "10px 18px", borderRadius: 8, border: "none", cursor: input.trim() ? "pointer" : "default", fontSize: 13, fontWeight: 600,
              }}>Send</button>
              <button onClick={() => finalize()} disabled={messages.length === 0} style={{
                background: "#ef4444", color: "#fff", padding: "10px 16px", borderRadius: 8, border: "none",
                cursor: messages.length ? "pointer" : "default", fontSize: 13, fontWeight: 600, opacity: messages.length ? 1 : 0.5,
              }}>End &amp; Evaluate</button>
            </>
          )}
          {busy && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.textSecondary, fontSize: 13 }}>
              <div style={{ width: 14, height: 14, border: `2px solid ${T.textSecondary}`, borderTopColor: "transparent", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
              {phaseLabel[phase]}
            </div>
          )}
          {(phase === "complete" || phase === "error") && (
            <button onClick={onClose} style={{
              background: T.primary, color: "#fff", padding: "10px 24px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, marginLeft: "auto",
            }}>{phase === "complete" && !evalTimedOut ? "View Results" : "Close"}</button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
