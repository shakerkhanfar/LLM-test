/**
 * Seed / bootstrap script — safe to run on every deploy.
 *
 * Reads user accounts from environment variables and upserts them so the
 * deployed app always has working credentials, even after a fresh DB.
 *
 * Environment variables (set in Replit Secrets / deployment secrets):
 *   SEED_USER_1_EMAIL     e.g. admin@hamsa.ai
 *   SEED_USER_1_PASSWORD  e.g. Admin@Pass123!
 *   SEED_USER_2_EMAIL     e.g. alsalamah@kfaces.ai
 *   SEED_USER_2_PASSWORD  ...
 *   SEED_USER_3_EMAIL     e.g. demo@tryhamsa.com
 *   SEED_USER_3_PASSWORD  ...
 *
 * Accounts are also shared within the same organization. If you set
 * SEED_ORG_NAME the seed will create/find that org and link all seed users.
 */

import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);

interface SeedAccount {
  email: string;
  password: string;
}

function collectAccounts(): SeedAccount[] {
  const accounts: SeedAccount[] = [];
  for (let i = 1; i <= 10; i++) {
    const email = process.env[`SEED_USER_${i}_EMAIL`]?.trim().toLowerCase();
    const password = process.env[`SEED_USER_${i}_PASSWORD`]?.trim();
    if (email && password) accounts.push({ email, password });
  }
  return accounts;
}

async function main() {
  const accounts = collectAccounts();
  if (accounts.length === 0) {
    console.log("[Seed] No SEED_USER_* env vars found — skipping user seed");
    return;
  }

  // Optionally create / find a shared organization
  let orgId: string | null = null;
  const orgName = process.env.SEED_ORG_NAME?.trim();
  if (orgName) {
    const org = await prisma.organization.upsert({
      where: { id: `seed-org-${orgName.toLowerCase().replace(/\s+/g, "-")}` },
      update: { name: orgName },
      create: { id: `seed-org-${orgName.toLowerCase().replace(/\s+/g, "-")}`, name: orgName },
    });
    orgId = org.id;
    console.log(`[Seed] Organization: "${orgName}" (${orgId})`);
  }

  for (const { email, password } of accounts) {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await prisma.user.upsert({
      where: { email },
      update: { passwordHash, ...(orgId ? { organizationId: orgId } : {}) },
      create: { email, passwordHash, organizationId: orgId },
    });
    console.log(`[Seed] Upserted ${email}`);
  }
}

main()
  .catch((err) => {
    console.error("[Seed] Fatal:", err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
