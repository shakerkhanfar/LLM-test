import { PASSWORD_MIN_LENGTH } from "./config";

/** Validates a password meets minimum policy requirements. Returns error string or null. */
export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (!/[A-Z]/.test(password)) return "Password must contain at least one uppercase letter";
  if (!/[a-z]/.test(password)) return "Password must contain at least one lowercase letter";
  if (!/[0-9]/.test(password)) return "Password must contain at least one number";
  if (!/[^A-Za-z0-9]/.test(password)) return "Password must contain at least one special character";
  return null;
}

/** Basic email format check — not a full RFC 5322 validator, just sanity. */
export function validateEmail(email: string): string | null {
  if (!email || !email.trim()) return "Email is required";
  if (email.length > 254) return "Invalid email";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Invalid email address";
  return null;
}
