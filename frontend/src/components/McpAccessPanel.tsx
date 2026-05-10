import { useEffect, useState } from "react";
import { getMcpTokenStatus, generateMcpToken, revokeMcpToken } from "../api/client";
import T from "../theme";

interface Props {
  projectId: string;
}

// Read once (during generation) and shown to the user. The component never holds
// the raw token in state beyond a single render cycle; once the modal is dismissed,
// it's gone — matching the server-side guarantee that tokens are never recoverable.
export default function McpAccessPanel({ projectId }: Props) {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<{ token: string; createdAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMcpTokenStatus(projectId)
      .then((r) => { if (!cancelled) { setHasToken(r.hasToken); setCreatedAt(r.createdAt); } })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [projectId]);

  async function handleGenerate() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const r = await generateMcpToken(projectId);
      setRevealed(r);
      setHasToken(true);
      setCreatedAt(r.createdAt);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    if (busy) return;
    if (!confirm("Revoke the MCP token? Any agents using it will lose access immediately.")) return;
    setBusy(true); setError(null);
    try {
      await revokeMcpToken(projectId);
      setHasToken(false);
      setCreatedAt(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Clipboard unavailable — copy manually");
    }
  }

  return (
    <div style={{
      border: `1px solid ${T.border}`, borderRadius: 8, padding: 16, background: T.card,
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>MCP Access</div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
            Plug an AI agent into this project's data via the Model Context Protocol.
          </div>
        </div>
        {hasToken === null ? (
          <span style={{ fontSize: 11, color: T.textMuted }}>Loading…</span>
        ) : hasToken ? (
          <button
            onClick={handleGenerate}
            disabled={busy}
            style={{ ...secondaryBtn, opacity: busy ? 0.6 : 1 }}
            title="Replace the existing token. Old token stops working immediately."
          >
            Rotate token
          </button>
        ) : (
          <button
            onClick={handleGenerate}
            disabled={busy}
            style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Generating…" : "Generate token"}
          </button>
        )}
      </div>

      {hasToken && createdAt && !revealed && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          fontSize: 11, color: T.textSecondary, padding: "6px 10px",
          background: T.cardAlt, borderRadius: 6 }}>
          <span>Active token — generated {new Date(createdAt).toLocaleString()}</span>
          <button
            onClick={handleRevoke}
            disabled={busy}
            style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
          >
            Revoke
          </button>
        </div>
      )}

      {revealed && (
        <div style={{ background: "#fffbeb", border: "1px solid #fbbf24", borderRadius: 6, padding: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#92400e", marginBottom: 6 }}>
            Copy this token now — it will not be shown again
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            fontFamily: "monospace", fontSize: 11, padding: "6px 10px",
            background: "#fff", border: "1px solid #fde68a", borderRadius: 4,
            wordBreak: "break-all",
          }}>
            <span style={{ flex: 1 }}>{revealed.token}</span>
            <button
              onClick={copyToken}
              style={{ ...secondaryBtn, padding: "3px 10px", fontSize: 10 }}
            >
              {copied ? "✓ Copied" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => setRevealed(null)}
            style={{ marginTop: 8, fontSize: 11, color: "#6b7280", background: "none", border: "none", cursor: "pointer" }}
          >
            I've copied it — dismiss
          </button>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 11, color: "#ef4444" }}>{error}</div>
      )}
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: "5px 14px", borderRadius: 5, border: "none",
  background: T.primary, color: "#fff", fontWeight: 600, fontSize: 12, cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  padding: "5px 14px", borderRadius: 5,
  border: `1px solid ${T.border}`, background: "transparent",
  color: T.textSecondary, fontWeight: 600, fontSize: 12, cursor: "pointer",
};
