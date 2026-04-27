/**
 * Ownership helpers — centralise the "does this user own this resource?" checks.
 *
 * Projects with userId=null are legacy records accessible by any authenticated
 * user (read AND write). New projects always get a userId at creation time.
 */
import prisma from "./prisma";
import type { Response } from "express";

type AccessResult<T> = T | null; // null means the response was already sent

/**
 * Verify an authenticated user can access a project.
 * Sends 404/403 and returns null if not allowed.
 */
export async function assertProjectAccess(
  projectId: string,
  userId: string | undefined,
  res: Response,
): Promise<AccessResult<{ id: string; userId: string | null }>> {
  // userId must be set by requireAuth middleware; if missing, reject immediately
  if (!userId) {
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
  // Legacy projects (userId=null) are accessible by any authenticated user.
  // New projects require matching userId.
  if (project.userId !== null && project.userId !== userId) {
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
  userId: string | undefined,
  res: Response,
): Promise<AccessResult<{ id: string; projectId: string }>> {
  if (!userId) {
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
  // project is guaranteed by FK, but use optional chain defensively for orphaned rows
  const projectUserId = (run as any).project?.userId as string | null | undefined;
  if (projectUserId !== null && projectUserId !== undefined && projectUserId !== userId) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }
  return { id: run.id, projectId: run.projectId };
}
