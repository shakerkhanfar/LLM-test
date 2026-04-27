/**
 * Create a user directly in the database.
 * Usage: npx tsx scripts/create-user.ts <email> <password>
 */
import bcrypt from "bcryptjs";
import prisma from "../src/lib/prisma";
import dotenv from "dotenv";
dotenv.config();

const [, , email, password] = process.argv;

if (!email || !password) {
  console.error("Usage: npx tsx scripts/create-user.ts <email> <password>");
  process.exit(1);
}

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    console.error(`User already exists: ${email}`);
    process.exit(1);
  }

  if (password.length < 6) {
    console.error("Password must be at least 6 characters");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12); // cost 12 per OWASP recommendation
  const user = await prisma.user.create({
    data: { email: email.trim().toLowerCase(), passwordHash },
  });

  console.log(`Created user: ${user.email} (id: ${user.id})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
