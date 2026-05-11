/**
 * Prisma config file. Replaces the deprecated `package.json#prisma` block
 * (which Prisma 7 will remove).
 *
 * We load .env explicitly: unlike the package.json config, prisma.config.ts
 * does NOT auto-load .env into process.env before running. Without this,
 * the seed subprocess loses DATABASE_URL when prisma CLI is invoked outside
 * a package.json script.
 */
import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    // Same command that used to live in package.json#prisma.seed.
    seed: "tsx prisma/seed.ts",
  },
});
