import { Router } from "express";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma";
import { AuthRequest } from "../middleware/auth";
import { BCRYPT_ROUNDS } from "../lib/config";
import { validatePassword } from "./auth";

const router = Router();

/**
 * Return the organization filter clause for the current user.
 * - User has an org → filter to that org
 * - No org → filter to just this user (self-only visibility)
 */
function orgFilter(req: AuthRequest) {
  if (req.organizationId) {
    return { organizationId: req.organizationId };
  }
  return { id: req.userId };
}

// GET /api/users — list users in the same org (or just yourself if unaffiliated)
router.get("/", async (req: AuthRequest, res) => {
  try {
    const users = await prisma.user.findMany({
      where: orgFilter(req),
      select: { id: true, email: true, organizationId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(users);
  } catch (err) {
    console.error("[Users] List error:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// POST /api/users — create a user in the same org as the requester
router.post("/", async (req: AuthRequest, res) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "Email is required" });
  }
  if (email.length > 254) return res.status(400).json({ error: "Invalid email" });
  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Password is required" });
  }

  const validationError = validatePassword(password.trim());
  if (validationError) return res.status(400).json({ error: validationError });

  const cleanEmail = email.trim().toLowerCase();

  try {
    const hash = await bcrypt.hash(password.trim(), BCRYPT_ROUNDS);
    const user = await prisma.user.create({
      data: {
        email: cleanEmail,
        passwordHash: hash,
        organizationId: req.organizationId ?? null,
      },
      select: { id: true, email: true, organizationId: true, createdAt: true },
    });
    console.log(`[Users] ${req.userEmail} created user ${user.email}`);
    res.status(201).json(user);
  } catch (err: any) {
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "Email already registered" });
    }
    console.error("[Users] Create error:", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

// PATCH /api/users/:id/password — reset a user's password
router.patch("/:id/password", async (req: AuthRequest, res) => {
  const { password } = req.body as { password?: string };

  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "password is required" });
  }

  const validationError = validatePassword(password.trim());
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    // Verify target user is in the same org (or is the requester themselves)
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, email: true, organizationId: true },
    });
    if (!target) return res.status(404).json({ error: "User not found" });

    const sameOrg = req.organizationId
      ? target.organizationId === req.organizationId
      : target.id === req.userId;

    if (!sameOrg) return res.status(403).json({ error: "Access denied" });

    const hash = await bcrypt.hash(password.trim(), BCRYPT_ROUNDS);
    await prisma.user.update({
      where: { id: target.id },
      data: { passwordHash: hash },
    });
    console.log(`[Users] ${req.userEmail} reset password for ${target.email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[Users] Password reset error:", err);
    res.status(500).json({ error: "Failed to update password" });
  }
});

// DELETE /api/users/:id — remove a user (cannot delete yourself)
router.delete("/:id", async (req: AuthRequest, res) => {
  if (req.params.id === req.userId) {
    return res.status(400).json({ error: "You cannot delete your own account" });
  }

  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, email: true, organizationId: true },
    });
    if (!target) return res.status(404).json({ error: "User not found" });

    const sameOrg = req.organizationId
      ? target.organizationId === req.organizationId
      : false; // unaffiliated users can't delete others

    if (!sameOrg) return res.status(403).json({ error: "Access denied" });

    await prisma.user.delete({ where: { id: target.id } });
    console.log(`[Users] ${req.userEmail} deleted user ${target.email}`);
    res.json({ ok: true });
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "User not found" });
    console.error("[Users] Delete error:", err);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

export default router;
