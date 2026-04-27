/**
 * Hamsa Eval — Light Theme Design Tokens
 *
 * Central source of truth for all colors. Import as `T` in page components.
 * Usage: style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}` }}
 */

const T = {
  // ─── Backgrounds ─────────────────────────────────────────────
  bg: "#f8f9fa",           // page background
  card: "#ffffff",         // cards, panels, sections
  cardAlt: "#f1f3f5",     // alternate card bg (nested, muted)
  input: "#ffffff",        // form inputs
  hover: "#f1f3f5",        // hover states on rows/cards
  nav: "#ffffff",          // navigation bar

  // ─── Borders ─────────────────────────────────────────────────
  border: "#e5e7eb",       // standard borders
  borderLight: "#f0f0f0",  // subtle dividers
  borderDark: "#d1d5db",   // stronger borders (inputs, focus)

  // ─── Text ────────────────────────────────────────────────────
  text: "#111827",         // primary text
  textSecondary: "#6b7280",// secondary / labels
  textMuted: "#9ca3af",    // muted / placeholders
  textFaint: "#d1d5db",    // very faint (disabled)

  // ─── Brand ──────────────────────────────────────────────────
  primary: "#17B26A",      // primary CTA / brand green
  primaryHover: "#15a060", // CTA hover
  primaryLight: "#ecfdf3", // light green tint (badges, backgrounds)
  primaryText: "#ffffff",  // text on primary background

  // ─── Semantic ────────────────────────────────────────────────
  success: "#22c55e",
  successBg: "#f0fdf4",
  error: "#ef4444",
  errorBg: "#fef2f2",
  warning: "#f59e0b",
  warningBg: "#fffbeb",
  info: "#3b82f6",
  infoBg: "#eff6ff",

  // ─── Status ──────────────────────────────────────────────────
  statusPending: "#9ca3af",
  statusRunning: "#f59e0b",
  statusEvaluating: "#3b82f6",
  statusComplete: "#22c55e",
  statusFailed: "#ef4444",

  // ─── Node types (flow graph) ─────────────────────────────────
  nodeStart: "#22c55e",
  nodeConversation: "#3b82f6",
  nodeTool: "#f59e0b",
  nodeRouter: "#a855f7",
  nodeEnd: "#ef4444",

  // ─── Criterion types ─────────────────────────────────────────
  critFlowProgression: "#3b82f6",
  critActionConsistency: "#a855f7",
  critLayeredEvaluation: "#06b6d4",
  critLatency: "#f59e0b",
  critDeterministic: "#22c55e",
  critLlmJudge: "#ec4899",
  critWordAccuracy: "#06b6d4",
  critStructural: "#f97316",

  // ─── Shadows ─────────────────────────────────────────────────
  shadow: "0 1px 3px rgba(0,0,0,0.08)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.06)",
  shadowLg: "0 8px 24px rgba(0,0,0,0.08)",

  // ─── Misc ────────────────────────────────────────────────────
  link: "#17B26A",
  radius: 8,
  radiusSm: 6,
  radiusXs: 4,
} as const;

export default T;
