import { useEffect, useRef, useState } from "react";
import { HamsaVoiceAgent } from "@hamsa-ai/voice-agents-sdk";
import { updateRun } from "../api/client";

interface CallAgentProps {
  runId: string;
  agentId: string;
  apiKey: string;
  onCallEnded: () => void;
  onClose: () => void;
}

export default function CallAgent({ runId, agentId, apiKey, onCallEnded, onClose }: CallAgentProps) {
  const agentRef = useRef<HamsaVoiceAgent | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "ended">("idle");
  const [agentState, setAgentState] = useState<string>("idle");
  const [transcript, setTranscript] = useState<Array<{ speaker: string; text: string }>>([]);
  const [error, setError] = useState("");
  const [callId, setCallId] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (agentRef.current) {
        try { agentRef.current.end(); } catch {}
      }
    };
  }, []);

  async function startCall() {
    setError("");
    setStatus("connecting");

    try {
      const agent = new HamsaVoiceAgent(apiKey);
      agentRef.current = agent;

      agent.on("callStarted", ({ jobId }: any) => {
        console.log("Call started, jobId:", jobId);
        setCallId(jobId);
        setStatus("connected");

        // Save the call ID to the run
        updateRun(runId, { hamsaCallId: jobId, status: "RUNNING" });

        // Start duration timer
        timerRef.current = setInterval(() => {
          setDuration((d) => d + 1);
        }, 1000);
      });

      agent.on("agentStateChanged", (state: string) => {
        setAgentState(state);
      });

      agent.on("transcriptionReceived", (text: string) => {
        setTranscript((prev) => [...prev, { speaker: "User", text }]);
      });

      agent.on("answerReceived", (text: string) => {
        setTranscript((prev) => [...prev, { speaker: "Agent", text }]);
      });

      agent.on("callEnded", () => {
        setStatus("ended");
        if (timerRef.current) clearInterval(timerRef.current);

        // Update run status — webhook will handle the rest
        updateRun(runId, { status: "AWAITING_DATA" });
        onCallEnded();
      });

      agent.on("error", (e: any) => {
        console.error("Call error:", e);
        setError(typeof e === "string" ? e : e?.message || "Call error");
        setStatus("ended");
        if (timerRef.current) clearInterval(timerRef.current);
      });

      await agent.start({
        agentId,
        voiceEnablement: true,
      });
    } catch (err) {
      setError((err as Error).message);
      setStatus("idle");
    }
  }

  function endCall() {
    if (agentRef.current) {
      agentRef.current.end();
    }
  }

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  const stateColors: Record<string, string> = {
    idle: "#888",
    initializing: "#f59e0b",
    listening: "#22c55e",
    thinking: "#3b82f6",
    speaking: "#a855f7",
  };

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.8)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: "#111", border: "1px solid #333", borderRadius: 12,
        padding: 24, width: 500, maxHeight: "80vh", overflow: "auto",
      }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Voice Call</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 18 }}>
            &times;
          </button>
        </div>

        {/* Status */}
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          {status === "connected" && (
            <>
              <div style={{
                width: 80, height: 80, borderRadius: "50%", margin: "0 auto 12px",
                background: `${stateColors[agentState] || "#888"}33`,
                border: `2px solid ${stateColors[agentState] || "#888"}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                animation: agentState === "speaking" ? "pulse 1.5s infinite" : "none",
              }}>
                <span style={{ fontSize: 28 }}>
                  {agentState === "listening" ? "🎙" : agentState === "speaking" ? "🔊" : agentState === "thinking" ? "💭" : "📞"}
                </span>
              </div>
              <div style={{ color: stateColors[agentState] || "#888", fontSize: 14, marginBottom: 4 }}>
                {agentState.charAt(0).toUpperCase() + agentState.slice(1)}
              </div>
              <div style={{ color: "#888", fontSize: 24, fontFamily: "monospace" }}>
                {formatTime(duration)}
              </div>
            </>
          )}

          {status === "idle" && (
            <div style={{ color: "#888", fontSize: 14, marginBottom: 12 }}>
              Ready to call agent. Make sure your microphone is available.
            </div>
          )}

          {status === "connecting" && (
            <div style={{ color: "#f59e0b", fontSize: 14 }}>Connecting...</div>
          )}

          {status === "ended" && (
            <div style={{ color: "#22c55e", fontSize: 14 }}>
              Call ended. Waiting for webhook data...
              {callId && <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>Call ID: {callId}</div>}
            </div>
          )}
        </div>

        {error && (
          <div style={{ background: "#ef444422", border: "1px solid #ef4444", borderRadius: 6, padding: 8, marginBottom: 12, fontSize: 13, color: "#ef4444" }}>
            {error}
          </div>
        )}

        {/* Transcript */}
        {transcript.length > 0 && (
          <div style={{
            background: "#0a0a0a", borderRadius: 8, padding: 12, marginBottom: 16,
            maxHeight: 200, overflow: "auto", border: "1px solid #222",
          }}>
            {transcript.map((t, i) => (
              <div key={i} style={{ marginBottom: 6, fontSize: 13 }}>
                <span style={{ color: t.speaker === "Agent" ? "#3b82f6" : "#22c55e", fontWeight: 600 }}>
                  [{t.speaker}]
                </span>{" "}
                <span style={{ color: "#ccc" }}>{t.text}</span>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          {status === "idle" && (
            <button onClick={startCall} style={{
              background: "#22c55e", color: "#fff", padding: "10px 24px",
              borderRadius: 8, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600,
            }}>
              Start Call
            </button>
          )}
          {status === "connected" && (
            <button onClick={endCall} style={{
              background: "#ef4444", color: "#fff", padding: "10px 24px",
              borderRadius: 8, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600,
            }}>
              End Call
            </button>
          )}
          {status === "ended" && (
            <button onClick={onClose} style={{
              background: "#374151", color: "#fff", padding: "10px 24px",
              borderRadius: 8, border: "none", cursor: "pointer", fontSize: 14,
            }}>
              Close
            </button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.05); opacity: 0.8; }
        }
      `}</style>
    </div>
  );
}
