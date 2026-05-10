/**
 * Centralized configuration with startup validation.
 * Fails fast on missing required env vars so misconfigurations surface
 * at boot time rather than as runtime failures.
 */

const REQUIRED_IN_PRODUCTION = ["JWT_SECRET", "DATABASE_URL", "OPENAI_API_KEY", "MCP_TOKEN_PEPPER"];

export function validateConfig() {
  const env = process.env.NODE_ENV || "development";
  const missing: string[] = [];

  // JWT_SECRET must always be set and must not be the known-weak default
  if (!process.env.JWT_SECRET) {
    if (env === "production") {
      missing.push("JWT_SECRET");
    } else {
      console.warn(
        "[Config] WARNING: JWT_SECRET is not set. Using insecure default. " +
          "This MUST be set in production."
      );
    }
  } else if (process.env.JWT_SECRET === "hamsa-eval-dev-secret") {
    if (env === "production") {
      throw new Error(
        "[Config] FATAL: JWT_SECRET is set to the known-weak default value. " +
          "Generate a strong secret: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
      );
    }
  }

  if (env === "production") {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (!process.env[key]) missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[Config] FATAL: Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

export const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);

export const JWT_SECRET = process.env.JWT_SECRET || "hamsa-eval-dev-secret";
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "30d";

/** Minimum password length */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Server-side pepper for HMAC-keying MCP token hashes. CRITICAL: this value
 * must remain constant for the lifetime of issued tokens — rotating it
 * invalidates every existing MCP token. To rotate, plan a forced re-issuance.
 *
 * In dev, falls back to a JWT_SECRET-derived value so contributors don't need
 * to set up another env var. In production this is required and validated at
 * boot via REQUIRED_IN_PRODUCTION above.
 */
export const MCP_TOKEN_PEPPER =
  process.env.MCP_TOKEN_PEPPER ||
  (process.env.NODE_ENV !== "production"
    ? `dev-mcp-pepper-${JWT_SECRET}`
    : "");

/** Default lifetime for newly issued MCP tokens (1 year). Overridable per token. */
export const MCP_TOKEN_DEFAULT_TTL_DAYS = parseInt(
  process.env.MCP_TOKEN_DEFAULT_TTL_DAYS || "365",
  10
);
