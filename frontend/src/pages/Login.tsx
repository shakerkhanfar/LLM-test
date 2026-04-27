import { useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import T from "../theme";

function HamsaLogo() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="38" fill="none" viewBox="0 0 48 46">
      <path fill="#17B26A" d="M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z" />
    </svg>
  );
}

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Where to go after login: the page the user was trying to access, or home.
  // Only allow local paths (start with /) to prevent open-redirect attacks.
  const rawFrom = (location.state as { from?: { pathname: string } } | null)?.from?.pathname || "/";
  const destination = rawFrom.startsWith("/") && !rawFrom.startsWith("//") && rawFrom !== "/login"
    ? rawFrom
    : "/";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password.trim());
      navigate(destination, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: T.radius,
          boxShadow: T.shadowMd,
          padding: "40px 48px",
          width: "100%",
          maxWidth: 400,
        }}
      >
        {/* Logo + title */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
            <HamsaLogo />
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: T.text, marginBottom: 4 }}>
            Hamsa Eval
          </h1>
          <p style={{ fontSize: 14, color: T.textSecondary }}>Sign in to your account</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label
              htmlFor="email"
              style={{ display: "block", fontSize: 13, fontWeight: 500, color: T.text, marginBottom: 6 }}
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                background: T.input,
                border: `1px solid ${T.borderDark}`,
                borderRadius: T.radiusSm,
                fontSize: 14,
                color: T.text,
                outline: "none",
                boxSizing: "border-box",
              }}
              onFocus={(e) => (e.target.style.borderColor = T.primary)}
              onBlur={(e) => (e.target.style.borderColor = T.borderDark)}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label
              htmlFor="password"
              style={{ display: "block", fontSize: 13, fontWeight: 500, color: T.text, marginBottom: 6 }}
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                background: T.input,
                border: `1px solid ${T.borderDark}`,
                borderRadius: T.radiusSm,
                fontSize: 14,
                color: T.text,
                outline: "none",
                boxSizing: "border-box",
              }}
              onFocus={(e) => (e.target.style.borderColor = T.primary)}
              onBlur={(e) => (e.target.style.borderColor = T.borderDark)}
            />
          </div>

          {error && (
            <div
              style={{
                background: T.errorBg,
                border: `1px solid ${T.error}`,
                borderRadius: T.radiusSm,
                padding: "10px 12px",
                fontSize: 13,
                color: T.error,
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            style={{
              width: "100%",
              padding: "11px 0",
              background: T.primary,
              color: T.primaryText,
              border: "none",
              borderRadius: T.radiusSm,
              fontSize: 14,
              fontWeight: 600,
              cursor: submitting ? "not-allowed" : "pointer",
              opacity: submitting ? 0.75 : 1,
            }}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
