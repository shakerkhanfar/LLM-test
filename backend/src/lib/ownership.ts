/**
 * Ownership helpers — centralise the "can this user access this resource?" checks.
 *
 * Access is granted when ANY of these is true:
 *  1. Project has no owner (userId=null) — legacy records
 *  2. The requesting user owns the project (userId === req.userId)
 *  3. Both the requesting user and the project owner share the same organization
 *
 * Ready for org-level roles: add a `role` check inside `canAccess` when needed.
 */
import prisma from "./prisma";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";

type AccessResult<T> = T | null; // null means the response was already sent

/**
 * Returns true if the requesting user can access a project owned by `projectUserId`.
 */
export async function canAccess(
  projectUserId: string | null,
  req: AuthRequest,
): Promise<boolean> {
  if (projectUserId === null) return true;             // legacy / unowned
  if (projectUserId === req.userId) return true;       // own project
  if (!req.organizationId) return false;               // no org — deny
  const owner = await prisma.user.findUnique({
    where: { id: projectUserId },
    select: { organizationId: true },
  });
  return !!owner?.organizationId && owner.organizationId === req.organizationId;
}

/**
 * Verify an authenticated user can access a project.
 * Sends 404/403 and returns null if not allowed.
 */
export async function assertProjectAccess(
  projectId: string,
  req: AuthRequest,
  res: Response,
): Promise<AccessResult<{ id: string; userId: string | null }>> {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true },
  });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return null;
  }
  if (!await canAccess(project.userId, req)) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }
  return project;
}

/**
 * Verify an authenticated user can access a run (via its parent project).
 * Sends 404/403 and returns null if not allowed.
 */
export async function assertRunAccess(
  runId: string,
  req: AuthRequest,
  res: Response,
): Promise<AccessResult<{ id: string; projectId: string }>> {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, projectId: true, project: { select: { userId: true } } },
  });
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return null;
  }
  const projectUserId = (run as any).project?.userId as string | null | undefined;
  if (!await canAccess(projectUserId ?? null, req)) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }
  return { id: run.id, projectId: run.projectId };
}
