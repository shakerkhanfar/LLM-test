import { useState, useEffect } from "react";
import { listUsers, createUser, resetUserPassword, deleteUser } from "../api/client";
import { useAuth } from "../context/AuthContext";
import T from "../theme";

interface UserRow {
  id: string;
  email: string;
  organizationId: string | null;
  organization: { name: string } | null;
  createdAt: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Add user form
  const [showAdd, setShowAdd] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);

  // Password reset modal
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const data = await listUsers();
      setUsers(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function parseApiError(err: any): string {
    const msg = err?.message || "Unknown error";
    const body = msg.replace(/^API error \d+: /, "");
    try { return JSON.parse(body).error; } catch { return msg; }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddError("");
    setAdding(true);
    try {
      await createUser(newEmail.trim(), newPassword);
      setNewEmail("");
      setNewPassword("");
      setShowAdd(false);
      await load();
    } catch (err: any) {
      setAddError(parseApiError(err));
    } finally {
      setAdding(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!resetTarget) return;
    setResetError("");
    setResetting(true);
    try {
      await resetUserPassword(resetTarget.id, resetPw);
      setResetPw("");
      setResetSuccess(true);
      // Auto-close after showing success for 1.5 s
      setTimeout(() => {
        setResetTarget(null);
        setResetSuccess(false);
      }, 1500);
    } catch (err: any) {
      setResetError(parseApiError(err));
    } finally {
      setResetting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteUser(deleteTarget.id);
      setDeleteTarget(null);
      await load();
    } catch (err: any) {
      alert(parseApiError(err));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  // Derive org name from the first user that has an organization object
  const orgDisplayName = users.find(u => u.organization)?.organization?.name ?? null;

  return (
    <div style={{ maxWidth: 700 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: T.text }}>Users</h1>
          {orgDisplayName && (
            <p style={{ fontSize: 13, color: T.textSecondary, margin: "4px 0 0" }}>
              {orgDisplayName}
            </p>
          )}
        </div>
        <button
          onClick={() => { setShowAdd(true); setAddError(""); }}
          style={{
            background: T.primary, color: T.primaryText, border: "none",
            borderRadius: T.radiusSm, padding: "8px 16px", fontSize: 14,
            fontWeight: 600, cursor: "pointer",
          }}
          onMouseEnter={e => (e.currentTarget.style.background = T.primaryHover)}
          onMouseLeave={e => (e.currentTarget.style.background = T.primary)}
        >
          + Add user
        </button>
      </div>

      {/* Add user form */}
      {showAdd && (
        <form
          onSubmit={handleAdd}
          style={{
            background: T.card, border: `1px solid ${T.border}`, borderRadius: T.radius,
            padding: 20, marginBottom: 20, boxShadow: T.shadow,
          }}
        >
          <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600, color: T.text }}>
            New user
          </h3>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <input
              type="email"
              placeholder="Email address"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              required
              style={{
                flex: 1, padding: "8px 12px", borderRadius: T.radiusSm,
                border: `1px solid ${T.borderDark}`, fontSize: 14,
                background: T.input, color: T.text, outline: "none",
              }}
            />
            <input
              type="password"
              placeholder="Password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              required
              style={{
                flex: 1, padding: "8px 12px", borderRadius: T.radiusSm,
                border: `1px solid ${T.borderDark}`, fontSize: 14,
                background: T.input, color: T.text, outline: "none",
              }}
            />
          </div>
          <p style={{ fontSize: 12, color: T.textMuted, margin: "0 0 10px" }}>
            Min 12 chars · uppercase · lowercase · number · special character
          </p>
          {addError && (
            <p style={{ color: T.error, fontSize: 13, margin: "0 0 10px" }}>{addError}</p>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="submit"
              disabled={adding}
              style={{
                background: T.primary, color: T.primaryText, border: "none",
                borderRadius: T.radiusSm, padding: "7px 16px", fontSize: 14,
                fontWeight: 600, cursor: adding ? "not-allowed" : "pointer",
                opacity: adding ? 0.7 : 1,
              }}
            >
              {adding ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              onClick={() => { setShowAdd(false); setNewEmail(""); setNewPassword(""); setAddError(""); }}
              style={{
                background: "none", color: T.textSecondary,
                border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                padding: "7px 16px", fontSize: 14, cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Error */}
      {error && (
        <div style={{ color: T.error, background: T.errorBg, padding: "10px 14px", borderRadius: T.radiusSm, marginBottom: 16, fontSize: 14 }}>
          {error}
        </div>
      )}

      {/* Users table */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.radius, boxShadow: T.shadow, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: "center", color: T.textSecondary, fontSize: 14 }}>
            Loading…
          </div>
        ) : users.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: T.textSecondary, fontSize: 14 }}>
            No users found.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 12, fontWeight: 600, color: T.textSecondary, textTransform: "uppercase", letterSpacing: "0.05em" }}>Email</th>
                <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 12, fontWeight: 600, color: T.textSecondary, textTransform: "uppercase", letterSpacing: "0.05em" }}>Joined</th>
                <th style={{ padding: "10px 16px", textAlign: "right", fontSize: 12, fontWeight: 600, color: T.textSecondary, textTransform: "uppercase", letterSpacing: "0.05em" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr
                  key={u.id}
                  style={{
                    borderBottom: i < users.length - 1 ? `1px solid ${T.borderLight}` : "none",
                  }}
                >
                  <td style={{ padding: "12px 16px", fontSize: 14, color: T.text }}>
                    {u.email}
                    {/* me?.id is set by /api/auth/me on mount — only render badge once that resolves */}
                    {me?.id && u.id === me.id && (
                      <span style={{ marginLeft: 8, fontSize: 11, background: T.primaryLight, color: T.primary, padding: "2px 7px", borderRadius: 99, fontWeight: 600 }}>
                        you
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: 13, color: T.textSecondary }}>
                    {formatDate(u.createdAt)}
                  </td>
                  <td style={{ padding: "12px 16px", textAlign: "right" }}>
                    <button
                      onClick={() => { setResetTarget(u); setResetPw(""); setResetError(""); setResetSuccess(false); }}
                      style={{
                        fontSize: 13, color: T.textSecondary, background: "none",
                        border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                        padding: "4px 10px", cursor: "pointer", marginRight: 6,
                      }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = T.borderDark)}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = T.border)}
                    >
                      Reset password
                    </button>
                    {/* Hide delete button for own account — enforced server-side too */}
                    {u.id !== me?.id && (
                      <button
                        onClick={() => setDeleteTarget(u)}
                        style={{
                          fontSize: 13, color: T.error, background: "none",
                          border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                          padding: "4px 10px", cursor: "pointer",
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = T.error; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Reset password modal */}
      {resetTarget && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
        }}>
          <form
            onSubmit={handleResetPassword}
            style={{
              background: T.card, borderRadius: T.radius, padding: 24, width: 360,
              boxShadow: T.shadowLg, border: `1px solid ${T.border}`,
            }}
          >
            <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 700, color: T.text }}>
              Reset password
            </h3>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: T.textSecondary }}>
              {resetTarget.email}
            </p>

            {resetSuccess ? (
              <div style={{ padding: "12px 14px", background: T.successBg, borderRadius: T.radiusSm, color: T.success, fontSize: 14, fontWeight: 500, textAlign: "center" }}>
                Password updated
              </div>
            ) : (
              <>
                <input
                  type="password"
                  placeholder="New password"
                  value={resetPw}
                  onChange={e => setResetPw(e.target.value)}
                  required
                  autoFocus
                  style={{
                    width: "100%", boxSizing: "border-box", padding: "8px 12px",
                    borderRadius: T.radiusSm, border: `1px solid ${T.borderDark}`,
                    fontSize: 14, background: T.input, color: T.text,
                    outline: "none", marginBottom: 8,
                  }}
                />
                <p style={{ fontSize: 12, color: T.textMuted, margin: "0 0 12px" }}>
                  Min 12 chars · uppercase · lowercase · number · special character
                </p>
                {resetError && (
                  <p style={{ color: T.error, fontSize: 13, margin: "0 0 10px" }}>{resetError}</p>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => { setResetTarget(null); setResetPw(""); setResetError(""); setResetSuccess(false); }}
                    style={{
                      background: "none", color: T.textSecondary,
                      border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                      padding: "7px 16px", fontSize: 14, cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={resetting}
                    style={{
                      background: T.primary, color: T.primaryText, border: "none",
                      borderRadius: T.radiusSm, padding: "7px 16px", fontSize: 14,
                      fontWeight: 600, cursor: resetting ? "not-allowed" : "pointer",
                      opacity: resetting ? 0.7 : 1,
                    }}
                  >
                    {resetting ? "Saving…" : "Save"}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
        }}>
          <div style={{
            background: T.card, borderRadius: T.radius, padding: 24, width: 360,
            boxShadow: T.shadowLg, border: `1px solid ${T.border}`,
          }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: T.text }}>
              Remove user?
            </h3>
            <p style={{ margin: "0 0 20px", fontSize: 14, color: T.textSecondary }}>
              <strong style={{ color: T.text }}>{deleteTarget.email}</strong> will lose access immediately.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                style={{
                  background: "none", color: T.textSecondary,
                  border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                  padding: "7px 16px", fontSize: 14, cursor: deleting ? "not-allowed" : "pointer",
                  opacity: deleting ? 0.5 : 1,
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={{
                  background: T.error, color: "#fff", border: "none",
                  borderRadius: T.radiusSm, padding: "7px 16px", fontSize: 14,
                  fontWeight: 600, cursor: deleting ? "not-allowed" : "pointer",
                  opacity: deleting ? 0.7 : 1,
                }}
              >
                {deleting ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
