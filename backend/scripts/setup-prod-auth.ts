/**
 * One-time production setup: creates the User table (via prisma db push),
 * creates the demo user, and assigns all existing projects to them.
 *
 * Usage (run from backend/):
 *   npx prisma db push && npx tsx scripts/setup-prod-auth.ts
 */
import bcrypt from "bcryptjs";
import prisma from "../src/lib/prisma";
import dotenv from "dotenv";
dotenv.config();

const EMAIL = "demo@tryhamsa.com";
const PASSWORD = "Hamsa@1234";

async function main() {
  // 1. Create user (skip if already exists)
  let user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (user) {
    console.log(`User already exists: ${user.email} (${user.id})`);
  } else {
    const passwordHash = await bcrypt.hash(PASSWORD, 12);
    user = await prisma.user.create({
      data: { email: EMAIL, passwordHash },
    });
    console.log(`Created user: ${user.email} (${user.id})`);
  }

  // 2. Assign all unowned projects to this user
  const result = await prisma.project.updateMany({
    where: { userId: null },
    data: { userId: user.id },
  });
  console.log(`Assigned ${result.count} unowned projects to ${user.email}`);

  // 3. Summary
  const totalProjects = await prisma.project.count({ where: { userId: user.id } });
  const totalUsers = await prisma.user.count();
  console.log(`\nDone. ${totalUsers} user(s), ${totalProjects} project(s) owned by ${user.email}`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
