import { useEffect, useRef, useState, useCallback } from "react";
import { HamsaVoiceAgent } from "@hamsa-ai/voice-agents-sdk";
import { updateRun, fetchLogs, triggerEvaluation, getRun } from "../api/client";

interface CallAgentProps {
  runId: string;
  agentId: string;
  apiKey: string;
  webhookUrl: string;
  onCallEnded: () => void;
  onClose: () => void;
}

interface TranscriptMessage {
  id: number;
  speaker: "Agent" | "User";
  text: string;
  timestamp: number;
}

type CallPhase = "idle" | "connecting" | "in_call" | "call_ended" | "fetching_data" | "evaluating" | "complete" | "error";

export default function CallAgent({ runId, agentId, apiKey, webhookUrl, onCallEnded, onClose }: CallAgentProps) {
  const agentRef = useRef<HamsaVoiceAgent | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const msgIdRef = useRef(0);
  const unmountedRef = useRef(false);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const startingRef = useRef(false);

  const [phase, setPhase] = useState<CallPhase>("idle");
  const [agentState, setAgentState] = useState<string>("idle");
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [error, setError] = useState("");
  const [callId, setCallId] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [evalScore, setEvalScore] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Safe setTimeout that tracks handles for cleanup
  const safeTimeout = useCallback((fn: () => void, ms: number) => {
    const handle = setTimeout(() => {
      if (!unmountedRef.current) fn();
    }, ms);
    timeoutsRef.current.push(handle);
    return handle;
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  // Cleanup
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      if (timerRef.current) clearInterval(timerRef.current);
      timeoutsRef.current.forEach(clearTimeout);
      if (agentRef.current) {
        try { agentRef.current.end(); } catch {}
      }
    };
  }, []);

  const addMessage = useCallback((speaker: "Agent" | "User", text: string) => {
    const id = ++msgIdRef.current;
    setTranscript((prev) => [...prev, { id, speaker, text, timestamp: Date.now() }]);
  }, []);

  async function startCall() {
    // Guard against double invocation (ref survives across closures, unlike phase state)
    if (startingRef.current) return;
    if (phase !== "idle" && phase !== "error") return;
    startingRef.current = true;

    // Reset state for retry
    setError("");
    setPhase("connecting");
    setTranscript([]);
    setCallId(null);
    setDuration(0);
    setEvalScore(null);
    setAgentState("idle");
    msgIdRef.current = 0;

    try {
      const agent = new HamsaVoiceAgent(apiKey);
      agentRef.current = agent;

      agent.on("callStarted", ({ jobId }: any) => {
        startingRef.current = false;
        setCallId(jobId);
        setPhase("in_call");
        updateRun(runId, { hamsaCallId: jobId, status: "RUNNING" }).catch(() => {});

        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
          setDuration((d) => d + 1);
        }, 1000);
      });

      agent.on("agentStateChanged", (state: string) => {
        setAgentState(state);
      });

      agent.on("transcriptionReceived", (text: string) => {
        addMessage("User", text);
      });

      agent.on("answerReceived", (text: string) => {
        addMessage("Agent", text);
      });

      agent.on("callEnded", () => {
        if (timerRef.current) clearInterval(timerRef.current);
        setPhase("call_ended");
        updateRun(runId, { status: "AWAITING_DATA" }).catch(() => {});

        // Start post-call data fetch after a short delay for webhook
        safeTimeout(() => startPostCallProcess(), 3000);
        // Notify parent after post-call process is queued
        onCallEnded();
      });

      agent.on("error", (e: any) => {
        startingRef.current = false;
        setError(typeof e === "string" ? e : e?.message || "Call error");
        setPhase("error");
        if (timerRef.current) clearInterval(timerRef.current);
      });

      await agent.start({ agentId, voiceEnablement: true });
    } catch (err) {
      startingRef.current = false;
      setError((err as Error).message);
      setPhase("error");
    }
  }

  async function startPostCallProcess() {
    if (unmountedRef.current) return;
    setPhase("fetching_data");

    let attempts = 0;
    const maxAttempts = 20;

    async function pollForData() {
      if (unmountedRef.current) return;
      attempts++;

      try {
        const run = await getRun(runId);
        if (unmountedRef.current) return;

        const hasTranscript = run.transcript != null;
        const hasCallLog = run.callLog != null && (Array.isArray(run.callLog) ? run.callLog.length > 0 : true);

        if (!hasCallLog && run.hamsaCallId) {
          try { await fetchLogs(runId); } catch {}
        }

        if (hasTranscript && hasCallLog) {
          await runEvaluation();
          return;
        }

        if (attempts >= maxAttempts) {
          // Final attempt: try fetching logs one more time then evaluate anyway
          if (!hasCallLog && run.hamsaCallId) {
            try { await fetchLogs(runId); } catch {}
          }
          await runEvaluation();
          return;
        }
      } catch {
        if (attempts >= maxAttempts) {
          if (!unmountedRef.current) setPhase("complete");
          return;
        }
      }

      // Schedule next poll (recursive setTimeout prevents overlapping ticks)
      safeTimeout(pollForData, 3000);
    }

    async function runEvaluation() {
      if (unmountedRef.current) return;
      setPhase("evaluating");

      try {
        await triggerEvaluation(runId);
        if (unmountedRef.current) return;
        await pollForEvalComplete();
      } catch {
        if (!unmountedRef.current) setPhase("complete");
      }
    }

    async function pollForEvalComplete(evalAttempts = 0) {
      if (unmountedRef.current) return;
      if (evalAttempts >= 30) {
        setPhase("complete");
        return;
      }

      safeTimeout(async () => {
        if (unmountedRef.current) return;
        try {
          const updatedRun = await getRun(runId);
          if (unmountedRef.current) return;
          if (updatedRun.status === "COMPLETE") {
            setEvalScore(updatedRun.overallScore);
            setPhase("complete");
          } else {
            await pollForEvalComplete(evalAttempts + 1);
          }
        } catch {
          if (!unmountedRef.current) setPhase("complete");
        }
      }, 2000);
    }

    pollForData();
  }

  function endCall() {
    if (agentRef.current) {
      agentRef.current.end();
    }
  }

  function copyWebhook() {
    navigator.clipboard.writeText(webhookUrl).catch(() => {});
    setWebhookCopied(true);
    safeTimeout(() => setWebhookCopied(false), 2000);
  }

  function handleClose() {
    // End the call if still active before closing
    if (phase === "in_call" && agentRef.current) {
      try { agentRef.current.end(); } catch {}
    }
    onClose();
  }

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  const stateColors: Record<string, string> = {
    idle: "#888",
    initializing: "#f59e0b",
    listening: "#22c55e",
    thinking: "#3b82f6",
    speaking: "#a855f7",
  };

  const stateIcons: Record<string, string> = {
    idle: "📞",
    initializing: "⏳",
    listening: "🎙",
    thinking: "💭",
    speaking: "🔊",
  };

  const phaseLabels: Record<CallPhase, string> = {
    idle: "Ready",
    connecting: "Connecting...",
    in_call: "In Call",
    call_ended: "Call Ended",
    fetching_data: "Fetching call data...",
    evaluating: "Running evaluation...",
    complete: "Evaluation Complete",
    error: "Error",
  };

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.85)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: "#111", border: "1px solid #333", borderRadius: 12,
        width: 600, maxHeight: "90vh", display: "flex", flexDirection: "column",
      }}>
        {/* Header */}
        <div style={{
          padding: "16px 20px", borderBottom: "1px solid #222",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>Voice Call</h2>
            <span style={{ fontSize: 12, color: phaseLabels[phase] === "Error" ? "#ef4444" : "#888" }}>
              {phaseLabels[phase]}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {phase === "in_call" && (
              <span style={{ fontFamily: "monospace", color: "#888", fontSize: 16 }}>
                {formatTime(duration)}
              </span>
            )}
            <button onClick={handleClose} style={{
              background: "none", border: "none", color: "#666",
              cursor: "pointer", fontSize: 20, padding: 4,
            }}>
              &times;
            </button>
          </div>
        </div>

        {/* Webhook URL bar */}
        <div style={{
          padding: "8px 20px", background: "#0a0a0a", borderBottom: "1px solid #1a1a1a",
          display: "flex", alignItems: "center", gap: 8, fontSize: 11,
        }}>
          <span style={{ color: "#666" }}>Webhook:</span>
          <code style={{ color: "#888", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {webhookUrl}
          </code>
          <button onClick={copyWebhook} style={{
            background: webhookCopied ? "#22c55e22" : "#1a1a1a",
            border: `1px solid ${webhookCopied ? "#22c55e44" : "#333"}`,
            color: webhookCopied ? "#22c55e" : "#888",
            padding: "2px 8px", borderRadius: 3, cursor: "pointer", fontSize: 11,
          }}>
            {webhookCopied ? "Copied!" : "Copy"}
          </button>
        </div>

        {/* Agent state indicator */}
        {phase === "in_call" && (
          <div style={{
            padding: "12px 20px", display: "flex", alignItems: "center", gap: 12,
            borderBottom: "1px solid #1a1a1a",
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: "50%",
              background: `${stateColors[agentState] || "#888"}22`,
              border: `2px solid ${stateColors[agentState] || "#888"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16,
              animation: agentState === "speaking" ? "pulse 1.5s infinite" : "none",
            }}>
              {stateIcons[agentState] || "📞"}
            </div>
            <div>
              <div style={{ color: stateColors[agentState] || "#888", fontSize: 13, fontWeight: 600 }}>
                {agentState.charAt(0).toUpperCase() + agentState.slice(1)}
              </div>
              <div style={{ fontSize: 11, color: "#555" }}>
                {agentState === "listening" ? "Your turn to speak..." : agentState === "speaking" ? "Agent is responding..." : agentState === "thinking" ? "Processing..." : ""}
              </div>
            </div>
            {transcript.length > 0 && (
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", animation: "pulse 2s infinite" }} />
                <span style={{ fontSize: 10, color: "#22c55e" }}>LIVE</span>
              </div>
            )}
          </div>
        )}

        {/* Post-call progress */}
        {(phase === "call_ended" || phase === "fetching_data" || phase === "evaluating") && (
          <div style={{ padding: "16px 20px", borderBottom: "1px solid #1a1a1a" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {[
                { label: "Call Ended", done: true },
                { label: "Fetching Data", done: phase !== "call_ended", active: phase === "fetching_data" },
                { label: "Evaluating", done: phase === "evaluating", active: phase === "evaluating" },
              ].map((step, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: "50%", fontSize: 10,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: step.done ? "#22c55e22" : "#222",
                    border: `1px solid ${step.active ? "#f59e0b" : step.done ? "#22c55e44" : "#333"}`,
                    color: step.done ? "#22c55e" : "#666",
                    animation: step.active ? "pulse 1.5s infinite" : "none",
                  }}>
                    {step.done && !step.active ? "✓" : step.active ? "⏳" : i + 1}
                  </div>
                  <span style={{ fontSize: 11, color: step.active ? "#f59e0b" : step.done ? "#22c55e" : "#666" }}>
                    {step.label}
                  </span>
                  {i < 2 && <span style={{ color: "#333", margin: "0 4px" }}>→</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Evaluation complete banner */}
        {phase === "complete" && (
          <div style={{
            padding: "16px 20px", borderBottom: "1px solid #1a1a1a",
            background: evalScore != null ? (evalScore >= 0.8 ? "#22c55e11" : evalScore >= 0.5 ? "#f59e0b11" : "#ef444411") : "#1a1a1a",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>Evaluation Complete</div>
                <div style={{ fontSize: 11, color: "#888" }}>
                  {callId && `Call ID: ${callId}`}
                </div>
              </div>
              {evalScore != null && (
                <div style={{
                  fontSize: 24, fontWeight: 700,
                  color: evalScore >= 0.8 ? "#22c55e" : evalScore >= 0.5 ? "#f59e0b" : "#ef4444",
                }}>
                  {(evalScore * 100).toFixed(0)}%
                </div>
              )}
            </div>
          </div>
        )}

        {/* Conversation transcript */}
        <div style={{
          flex: 1, overflow: "auto", padding: "16px 20px",
          minHeight: 200, maxHeight: 400,
        }}>
          {phase === "idle" && (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🎙</div>
              <div style={{ color: "#888", fontSize: 14, marginBottom: 8 }}>
                Ready to call agent
              </div>
              <div style={{ color: "#555", fontSize: 12 }}>
                Make sure your microphone is available and the webhook URL is configured in the Hamsa dashboard.
              </div>
            </div>
          )}

          {phase === "connecting" && (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ fontSize: 14, color: "#f59e0b", animation: "pulse 1.5s infinite" }}>
                Connecting to agent...
              </div>
            </div>
          )}

          {transcript.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {transcript.map((msg) => (
                <div
                  key={msg.id}
                  style={{
                    display: "flex",
                    flexDirection: msg.speaker === "User" ? "row-reverse" : "row",
                    gap: 8,
                  }}
                >
                  <div style={{
                    maxWidth: "80%",
                    padding: "10px 14px",
                    borderRadius: msg.speaker === "User" ? "12px 12px 0 12px" : "12px 12px 12px 0",
                    background: msg.speaker === "Agent" ? "#1a2332" : "#1a331a",
                    border: `1px solid ${msg.speaker === "Agent" ? "#1e3a5f" : "#1e5f1e"}`,
                    textAlign: "start" as const,
                  }} dir="auto">
                    <div style={{ fontSize: 10, color: msg.speaker === "Agent" ? "#3b82f6" : "#22c55e", marginBottom: 4 }}>
                      {msg.speaker === "Agent" ? "Agent" : "You"}
                    </div>
                    <div style={{ fontSize: 13, color: "#e0e0e0", lineHeight: 1.5 }}>
                      {msg.text}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          )}

          {error && (
            <div style={{
              background: "#ef444418", border: "1px solid #ef444433", borderRadius: 8,
              padding: 12, fontSize: 13, color: "#ef4444", marginTop: 8,
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Actions footer */}
        <div style={{
          padding: "12px 20px", borderTop: "1px solid #222",
          display: "flex", gap: 8, justifyContent: "center",
        }}>
          {phase === "idle" && (
            <button onClick={startCall} style={{
              background: "#22c55e", color: "#fff", padding: "10px 32px",
              borderRadius: 8, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600,
              display: "flex", alignItems: "center", gap: 8,
            }}>
              🎙 Start Call
            </button>
          )}
          {phase === "in_call" && (
            <button onClick={endCall} style={{
              background: "#ef4444", color: "#fff", padding: "10px 32px",
              borderRadius: 8, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600,
              display: "flex", alignItems: "center", gap: 8,
            }}>
              📞 End Call
            </button>
          )}
          {phase === "connecting" && (
            <button disabled style={{
              background: "#374151", color: "#888", padding: "10px 32px",
              borderRadius: 8, border: "none", fontSize: 14,
            }}>
              Connecting...
            </button>
          )}
          {(phase === "call_ended" || phase === "fetching_data" || phase === "evaluating") && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#888", fontSize: 13 }}>
              <div style={{ width: 14, height: 14, border: "2px solid #888", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
              Processing...
            </div>
          )}
          {phase === "complete" && (
            <button onClick={handleClose} style={{
              background: "#2563eb", color: "#fff", padding: "10px 32px",
              borderRadius: 8, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600,
            }}>
              View Results
            </button>
          )}
          {phase === "error" && (
            <>
              <button onClick={startCall} style={{
                background: "#374151", color: "#fff", padding: "10px 24px",
                borderRadius: 8, border: "none", cursor: "pointer", fontSize: 14,
              }}>
                Retry
              </button>
              <button onClick={handleClose} style={{
                background: "none", color: "#888", padding: "10px 24px",
                borderRadius: 8, border: "1px solid #333", cursor: "pointer", fontSize: 14,
              }}>
                Close
              </button>
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.05); opacity: 0.8; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
