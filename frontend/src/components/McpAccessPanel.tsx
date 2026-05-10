import { useEffect, useState, useCallback } from "react";
import {
  listMcpTokens, issueMcpToken, revokeMcpToken,
  type McpTokenSummary,
} from "../api/client";
import T from "../theme";

interface Props {
  projectId: string;
}

const TTL_OPTIONS: Array<{ label: string; days: number | null }> = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "Never", days: null },
];

// Self-contained UI for managing per-project MCP tokens. All sensitive token
// values live only in transient state (`revealed`) and are dropped on dismissal.
// The component never persists raw tokens to localStorage or the URL.
export default function McpAccessPanel({ projectId }: Props) {
  const [tokens, setTokens] = useState<McpTokenSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Form state for issuing a new token
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<"read" | "read_write">("read");
  const [newTtlDays, setNewTtlDays] = useState<number | null>(365);

  // Reveal modal — token shown exactly once
  const [revealed, setRevealed] = useState<{ token: string; name: string | null; expiresAt: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  // Two-step revoke confirmation per token id
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await listMcpTokens(projectId);
      setTokens(r.tokens);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    listMcpTokens(projectId)
      .then((r) => { if (!cancelled) setTokens(r.tokens); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [projectId]);

  async function handleIssue() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const r = await issueMcpToken(projectId, {
        name: newName.trim() || null,
        scope: newScope,
        ttlDays: newTtlDays,
      });
      setRevealed({ token: r.token, name: newName.trim() || null, expiresAt: r.expiresAt });
      setNewName("");
      setNewTtlDays(365);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(tokenId: string) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await revokeMcpToken(projectId, tokenId);
      setConfirmRevoke(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyRevealed() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Clipboard unavailable — copy the token manually");
    }
  }

  const active = (tokens ?? []).filter(t => !t.revokedAt);
  const recentlyRevoked = (tokens ?? []).filter(t => !!t.revokedAt);

  return (
    <div style={{
      border: `1px solid ${T.border}`, borderRadius: 8, padding: 16, background: T.card,
      display: "flex", flexDirection: "column", gap: 14,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>MCP Access Tokens</div>
        <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
          Plug AI agents into this project's data via the Model Context Protocol. Issue a separate token for each agent or device — revoking one does not affect others.
        </div>
      </div>

      {/* Issue new token */}
      <div style={{
        background: T.cardAlt, padding: 12, borderRadius: 6,
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 200px", minWidth: 0 }}>
            <label style={lbl}>Name (optional)</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value.slice(0, 80))}
              placeholder="e.g. Claude Desktop — laptop"
              disabled={busy}
              style={input}
            />
          </div>
          <div>
            <label style={lbl}>Expires</label>
            <select
              value={newTtlDays === null ? "never" : String(newTtlDays)}
              onChange={(e) => setNewTtlDays(e.target.value === "never" ? null : Number(e.target.value))}
              disabled={busy}
              style={input}
            >
              {TTL_OPTIONS.map(opt => (
                <option key={opt.label} value={opt.days === null ? "never" : opt.days}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={lbl}>Scope</label>
            <select
              value={newScope}
              onChange={(e) => setNewScope(e.target.value as "read" | "read_write")}
              disabled={busy}
              style={input}
            >
              <option value="read">Read only</option>
              <option value="read_write">Read + write</option>
            </select>
          </div>
          <button
            onClick={handleIssue}
            disabled={busy}
            style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Generating…" : "Issue token"}
          </button>
        </div>
        {newScope === "read_write" && (
          <div style={{
            fontSize: 11, color: "#92400e", background: "#fef3c7",
            border: "1px solid #fbbf24", borderRadius: 4, padding: "6px 10px",
          }}>
            <strong>⚠ Write access:</strong> agents using this token can rewrite workflow node prompts on the live Hamsa agent and trigger paid re-evaluations. Each write requires the agent to pass <code>confirm: true</code> and a written reason, both audit-logged. Issue write tokens only to trusted agents you can monitor.
          </div>
        )}
      </div>

      {/* Reveal box — single-shot copy UX */}
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
            <button onClick={copyRevealed} style={{ ...secondaryBtn, padding: "3px 10px", fontSize: 10 }}>
              {copied ? "✓ Copied" : "Copy"}
            </button>
          </div>
          <div style={{ fontSize: 10, color: "#92400e", marginTop: 6 }}>
            {revealed.name ? `Name: ${revealed.name} · ` : ""}
            {revealed.expiresAt ? `Expires ${new Date(revealed.expiresAt).toLocaleDateString()}` : "No expiry"}
          </div>
          <button
            onClick={() => setRevealed(null)}
            style={{ marginTop: 8, fontSize: 11, color: "#6b7280", background: "none", border: "none", cursor: "pointer" }}
          >
            I've copied it — dismiss
          </button>
        </div>
      )}

      {/* Active tokens list */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, marginBottom: 6 }}>
          Active tokens {active.length > 0 ? `(${active.length})` : ""}
        </div>
        {tokens === null ? (
          <div style={{ fontSize: 11, color: T.textMuted }}>Loading…</div>
        ) : active.length === 0 ? (
          <div style={{ fontSize: 11, color: T.textMuted }}>No active tokens.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {active.map(t => (
              <TokenRow
                key={t.id}
                token={t}
                confirmingRevoke={confirmRevoke === t.id}
                onConfirmRevoke={() => setConfirmRevoke(t.id)}
                onCancelRevoke={() => setConfirmRevoke(null)}
                onRevoke={() => handleRevoke(t.id)}
                busy={busy}
              />
            ))}
          </div>
        )}
      </div>

      {recentlyRevoked.length > 0 && (
        <details style={{ fontSize: 11 }}>
          <summary style={{ color: T.textMuted, cursor: "pointer" }}>
            Recently revoked ({recentlyRevoked.length})
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            {recentlyRevoked.map(t => (
              <div key={t.id} style={{
                padding: "6px 10px", background: T.cardAlt, borderRadius: 4,
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
              }}>
                <span style={{ color: T.textSecondary }}>
                  {t.name || <em style={{ color: T.textMuted }}>unnamed</em>}
                </span>
                <span style={{ color: T.textMuted, fontSize: 10 }}>
                  revoked {new Date(t.revokedAt!).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      {error && <div style={{ fontSize: 11, color: "#ef4444" }}>{error}</div>}
    </div>
  );
}

function TokenRow({
  token, confirmingRevoke, onConfirmRevoke, onCancelRevoke, onRevoke, busy,
}: {
  token: McpTokenSummary;
  confirmingRevoke: boolean;
  onConfirmRevoke: () => void;
  onCancelRevoke: () => void;
  onRevoke: () => void;
  busy: boolean;
}) {
  const expiresSoon = token.expiresAt && (new Date(token.expiresAt).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000);
  return (
    <div style={{
      padding: "8px 10px", background: T.cardAlt, borderRadius: 4,
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: T.text, fontWeight: 500 }}>
          {token.name || <em style={{ color: T.textMuted, fontWeight: 400 }}>unnamed token</em>}
          <span style={{
            marginLeft: 8, fontSize: 10, padding: "1px 6px", borderRadius: 3,
            background: token.scope === "read_write" ? "#fef3c7" : "#e0f2fe",
            color: token.scope === "read_write" ? "#92400e" : "#0369a1",
          }}>{token.scope}</span>
        </div>
        <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>
          Created {new Date(token.createdAt).toLocaleDateString()}
          {" · "}
          {token.expiresAt
            ? <span style={{ color: expiresSoon ? "#ef4444" : T.textMuted }}>
                Expires {new Date(token.expiresAt).toLocaleDateString()}
              </span>
            : "No expiry"}
          {token.lastUsedAt && (
            <>
              {" · "}Last used {new Date(token.lastUsedAt).toLocaleDateString()}
            </>
          )}
        </div>
      </div>
      {confirmingRevoke ? (
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={onCancelRevoke} disabled={busy} style={{ ...secondaryBtn, padding: "3px 10px", fontSize: 10 }}>
            Cancel
          </button>
          <button onClick={onRevoke} disabled={busy} style={{ ...dangerBtn, padding: "3px 10px", fontSize: 10 }}>
            Confirm revoke
          </button>
        </div>
      ) : (
        <button
          onClick={onConfirmRevoke}
          disabled={busy}
          style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
        >
          Revoke
        </button>
      )}
    </div>
  );
}

const lbl: React.CSSProperties = { display: "block", fontSize: 10, color: T.textMuted, marginBottom: 3 };
const input: React.CSSProperties = {
  fontSize: 12, padding: "5px 8px", borderRadius: 4,
  border: `1px solid ${T.border}`, background: T.card, color: T.text, width: "100%",
};
const primaryBtn: React.CSSProperties = {
  padding: "6px 14px", borderRadius: 4, border: "none",
  background: T.primary, color: "#fff", fontWeight: 600, fontSize: 12, cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  padding: "5px 14px", borderRadius: 4,
  border: `1px solid ${T.border}`, background: "transparent",
  color: T.textSecondary, fontWeight: 600, fontSize: 12, cursor: "pointer",
};
const dangerBtn: React.CSSProperties = {
  padding: "5px 14px", borderRadius: 4, border: "none",
  background: "#ef4444", color: "#fff", fontWeight: 600, fontSize: 12, cursor: "pointer",
};
