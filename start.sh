#!/bin/bash

echo "[startup] Running pre-migration SQL (safe column additions)..."
(cd backend && node_modules/.bin/prisma db execute --stdin <<'SQL'
-- User: columns added after initial schema
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion"   INTEGER      NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- Project: @updatedAt and nullable feature columns
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT NOW();
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "hamsaApiKey"      TEXT;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "evalContext"      TEXT;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "webhookSecret"    TEXT;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "agentStructure"   JSONB;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "agentSummary"     TEXT;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "historyStartDate" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "historyEndDate"   TIMESTAMP(3);

-- Run: @updatedAt (the db-push blocker) + human-review columns
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT NOW();
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "humanReviewNote" TEXT;
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "humanReviewedAt" TIMESTAMP(3);
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "humanReviewedBy" TEXT;
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "apiPayload"      JSONB;
SQL
) && echo "[startup] Pre-migration complete." \
  || echo "[startup] WARNING: pre-migration SQL failed — continuing anyway"

echo "[startup] Running prisma db push..."
(cd backend && node_modules/.bin/prisma db push --accept-data-loss) \
  && echo "[startup] Schema sync complete." \
  || echo "[startup] WARNING: prisma db push failed — starting app anyway"

echo "[startup] Starting app..."
node backend/dist/app.js
