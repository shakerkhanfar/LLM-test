import prisma from "../lib/prisma";
import type { AuthRequest } from "./auth";

/**
 * Write an audit log entry for a sensitive operation.
 * Fire-and-forget — never throws; audit failure must not block the request.
 */
export function audit(
  req: AuthRequest,
  action: string,
  resourceId?: string,
  meta?: Record<string, unknown>
) {
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    undefined;

  prisma.auditLog
    .create({
      data: {
        userId: req.userId ?? null,
        userEmail: req.userEmail ?? null,
        action,
        resourceId: resourceId ?? null,
        meta: meta ? (meta as any) : undefined,
        ip: ip ?? null,
        requestId: req.requestId ?? null,
      },
    })
    .catch((err) =>
      console.error(`[Audit] Failed to write audit log (action=${action}):`, err)
    );
}
