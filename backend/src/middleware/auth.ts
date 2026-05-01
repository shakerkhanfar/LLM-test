import { Request, Response, NextFunction } from "express";
import { ParamsFlatDictionary } from "express-serve-static-core";
import jwt from "jsonwebtoken";
import { JWT_SECRET, JWT_EXPIRES_IN } from "../lib/config";

export { JWT_SECRET };

export interface AuthRequest extends Request<ParamsFlatDictionary> {
  userId?: string;
  userEmail?: string;
  /** Populated from JWT payload — no DB round-trip needed. */
  organizationId?: string;
  /** Injected by requestId middleware. */
  requestId?: string;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as any).userId !== "string" ||
      !(payload as any).userId
    ) {
      return res.status(401).json({ error: "Invalid token payload" });
    }
    req.userId = (payload as any).userId as string;
    req.userEmail = (payload as any).email as string | undefined;
    // organizationId is embedded in the token at login — zero DB cost per request.
    // If absent (old tokens), it will be undefined and org-level access degrades
    // to userId-only until the user re-logs-in.
    req.organizationId = (payload as any).organizationId as string | undefined;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Sign a JWT that includes the user's organizationId so downstream
 * middleware never needs a DB lookup to check org membership.
 */
export function signToken(userId: string, email: string, organizationId?: string | null): string {
  // jwt.sign expiresIn must be a StringValue ("30d", "1h") or number of seconds.
  // We cast via `as any` here because the env var is a string but the type expects
  // the branded StringValue type from @types/jsonwebtoken.
  return jwt.sign(
    { userId, email, ...(organizationId ? { organizationId } : {}) },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN as any }
  );
}
