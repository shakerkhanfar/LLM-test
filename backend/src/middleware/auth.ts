import { Request, Response, NextFunction } from "express";
import { ParamsFlatDictionary } from "express-serve-static-core";
import jwt from "jsonwebtoken";
import { JWT_SECRET, JWT_EXPIRES_IN } from "../lib/config";
import prisma from "../lib/prisma";

export interface AuthRequest extends Request<ParamsFlatDictionary> {
  userId?: string;
  userEmail?: string;
  /** Populated from JWT payload — no DB round-trip needed. */
  organizationId?: string;
  /** Injected by requestId middleware. */
  requestId?: string;
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  // Browser media elements (audio/video src) cannot send Authorization headers,
  // so also accept the token as a query param for streaming routes.
  const queryToken = typeof req.query?.token === "string" ? req.query.token : null;
  if (!auth?.startsWith("Bearer ") && !queryToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : queryToken!;
  let payload: any;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.userId !== "string" ||
    !payload.userId
  ) {
    return res.status(401).json({ error: "Invalid token payload" });
  }

  // Revocation check: compare tokenVersion in JWT against DB.
  // Tokens issued before revocation support was added carry no tokenVersion field;
  // treat them as version 0 (matching the DB default) so existing sessions survive
  // the upgrade. After a user explicitly logs out, their DB tokenVersion increments,
  // invalidating any older token regardless of whether it carried the field.
  const tokenVer = typeof payload.tokenVersion === "number" ? payload.tokenVersion : 0;
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { tokenVersion: true },
    });
    if (!user || user.tokenVersion !== tokenVer) {
      return res.status(401).json({ error: "Token has been revoked — please log in again" });
    }
  } catch (err) {
    // DB unavailable — fail closed: a token that can't be verified against current
    // revocation state must be rejected, not trusted. The caller can retry.
    console.error("[Auth] DB unavailable during token revocation check:", err);
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }

  req.userId = payload.userId as string;
  req.userEmail = payload.email as string | undefined;
  // organizationId is embedded in the token at login — zero DB cost per request.
  // If absent (old tokens), it will be undefined and org-level access degrades
  // to userId-only until the user re-logs-in.
  req.organizationId = payload.organizationId as string | undefined;
  next();
}

/**
 * Sign a JWT that includes the user's organizationId and tokenVersion so that
 * explicit logout can invalidate all previously issued tokens.
 */
export function signToken(
  userId: string,
  email: string,
  organizationId?: string | null,
  tokenVersion?: number,
): string {
  // jwt.sign expiresIn must be a StringValue ("30d", "1h") or number of seconds.
  // We cast via `as any` here because the env var is a string but the type expects
  // the branded StringValue type from @types/jsonwebtoken.
  return jwt.sign(
    {
      userId,
      email,
      ...(organizationId ? { organizationId } : {}),
      ...(tokenVersion !== undefined ? { tokenVersion } : {}),
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN as any },
  );
}
