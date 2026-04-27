import { Request, Response, NextFunction } from "express";
import { ParamsFlatDictionary } from "express-serve-static-core";
import jwt from "jsonwebtoken";

export const JWT_SECRET = process.env.JWT_SECRET || "hamsa-eval-dev-secret";

if (!process.env.JWT_SECRET) {
  console.warn(
    "[Auth] WARNING: JWT_SECRET env var is not set. Using insecure default. " +
    "Set JWT_SECRET in your .env file before deploying to production.",
  );
}

export interface AuthRequest extends Request<ParamsFlatDictionary> {
  userId?: string;
  userEmail?: string;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Validate payload shape — a tampered token could have missing/wrong fields
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
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function signToken(userId: string, email: string): string {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: "30d" });
}
