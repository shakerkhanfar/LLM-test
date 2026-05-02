/**
 * Seed / bootstrap script — safe to run on every deploy.
 *
 * Reads user accounts from environment variables and upserts them so the
 * deployed app always has working credentials, even after a fresh DB.
 *
 * Environment variables (set in Replit Secrets / deployment secrets):
 *   SEED_USER_1_EMAIL     e.g. admin@hamsa.ai
 *   SEED_USER_1_PASSWORD  e.g. Admin@Pass123!
 *   SEED_USER_1_ORG       e.g. Hamsa           (org name, created if missing)
 *
 *   SEED_USER_2_EMAIL     e.g. alsalamah@kfaces.ai
 *   SEED_USER_2_PASSWORD  ...
 *   SEED_USER_2_ORG       Al Salama
 *
 *   SEED_USER_3_EMAIL / SEED_USER_3_PASSWORD / SEED_USER_3_ORG ...
 *   (up to SEED_USER_10_*)
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
  orgName?: string;
}

function collectAccounts(): SeedAccount[] {
  const accounts: SeedAccount[] = [];
  for (let i = 1; i <= 10; i++) {
    const email = process.env[`SEED_USER_${i}_EMAIL`]?.trim().toLowerCase();
    const password = process.env[`SEED_USER_${i}_PASSWORD`]?.trim();
    const orgName = process.env[`SEED_USER_${i}_ORG`]?.trim();
    if (email && password) accounts.push({ email, password, orgName });
  }
  return accounts;
}

// Cache org IDs so we don't re-create the same org for multiple users
const orgCache = new Map<string, string>();

async function getOrCreateOrg(name: string): Promise<string> {
  if (orgCache.has(name)) return orgCache.get(name)!;
  const id = `seed-org-${name.toLowerCase().replace(/\s+/g, "-")}`;
  const org = await prisma.organization.upsert({
    where: { id },
    update: { name },
    create: { id, name },
  });
  orgCache.set(name, org.id);
  console.log(`[Seed] Organization: "${name}" (${org.id})`);
  return org.id;
}

async function main() {
  const accounts = collectAccounts();
  if (accounts.length === 0) {
    console.log("[Seed] No SEED_USER_* env vars found — skipping user seed");
    return;
  }

  for (const { email, password, orgName } of accounts) {
    const orgId = orgName ? await getOrCreateOrg(orgName) : null;
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await prisma.user.upsert({
      where: { email },
      update: { passwordHash, ...(orgId !== null ? { organizationId: orgId } : {}) },
      create: { email, passwordHash, organizationId: orgId },
    });
    console.log(`[Seed] Upserted ${email}${orgName ? ` → ${orgName}` : ""}`);
  }
}

main()
  .catch((err) => {
    console.error("[Seed] Fatal:", err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
