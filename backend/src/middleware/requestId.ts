import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import type { AuthRequest } from "./auth";

/**
 * Injects a unique X-Request-ID on every request.
 * Reuses the client-supplied header if present (for distributed tracing).
 * Exposed on res.locals and req.requestId so all logs can be correlated.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const existing = req.headers["x-request-id"];
  const id = (typeof existing === "string" && existing.length > 0 && existing.length < 128)
    ? existing
    : uuidv4();
  (req as AuthRequest).requestId = id;
  res.setHeader("X-Request-ID", id);
  next();
}
