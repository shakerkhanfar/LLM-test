-- Idempotent fix: add tokenVersion if the previous migration left it out.
-- The 20260518000000_add_tech_support migration could fail on re-run because
-- ALTER TYPE ADD VALUE had already partially applied the enum values, causing
-- a duplicate-value error that aborted before reaching the ALTER TABLE User line.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
