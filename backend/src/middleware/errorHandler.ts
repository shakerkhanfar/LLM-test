import { Request, Response, NextFunction } from "express";
import type { AuthRequest } from "./auth";

/**
 * Centralised error handler. Masks Prisma error codes and internal
 * stack traces from API responses while preserving them in server logs.
 *
 * Register LAST in Express middleware chain.
 */
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const requestId = (req as AuthRequest).requestId;
  const status = err.status || err.statusCode || 500;

  // Always log the full error server-side
  console.error(`[Error] ${req.method} ${req.path} → ${status}`, {
    requestId,
    message: err.message,
    code: err.code,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });

  // Map known Prisma error codes to user-safe messages
  if (err.code) {
    const prismaMessages: Record<string, string> = {
      P2002: "A record with that value already exists",
      P2025: "Record not found",
      P2003: "Related record not found",
      P2000: "Value too long for this field",
    };
    if (prismaMessages[err.code]) {
      return res.status(status === 500 ? 400 : status).json({
        error: prismaMessages[err.code],
        requestId,
      });
    }
  }

  // Never leak stack traces or internal messages in production
  const message =
    process.env.NODE_ENV === "production" && status === 500
      ? "An unexpected error occurred. Please try again."
      : err.message || "Internal server error";

  res.status(status).json({ error: message, requestId });
}
