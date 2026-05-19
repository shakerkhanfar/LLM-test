-- AlterEnum: add TECH_SUPPORT to ProjectType
-- IF NOT EXISTS guards make this safe to re-run after a partial failure where
-- ALTER TYPE ADD VALUE persisted non-transactionally but the rest rolled back.
ALTER TYPE "ProjectType" ADD VALUE IF NOT EXISTS 'TECH_SUPPORT';

-- AlterEnum: add PENDING_REVIEW to RunStatus
ALTER TYPE "RunStatus" ADD VALUE IF NOT EXISTS 'PENDING_REVIEW';

-- AlterEnum: add TECH_SUPPORT_ANALYSIS to CriterionType
ALTER TYPE "CriterionType" ADD VALUE IF NOT EXISTS 'TECH_SUPPORT_ANALYSIS';

-- CreateEnum (safe to re-run)
DO $$ BEGIN
  CREATE TYPE "DocType" AS ENUM ('DESCRIPTION', 'CODE_SNIPPET', 'ERROR_CODES', 'DATA_FLOW');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "IssueType" AS ENUM ('AGENT_BEHAVIOR', 'BACKEND_FAILURE', 'DATA_MISMATCH', 'VARIABLE_SETTER', 'CONFIGURATION', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable User: add tokenVersion
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable Run: add updatedAt and human review fields
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "humanReviewNote" TEXT;
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "humanReviewedAt" TIMESTAMP(3);
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "humanReviewedBy" TEXT;
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "apiPayload" JSONB;

-- CreateTable SystemDocument
CREATE TABLE IF NOT EXISTS "SystemDocument" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "docType" "DocType" NOT NULL DEFAULT 'DESCRIPTION',
    "content" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SystemDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable TechIssue
CREATE TABLE IF NOT EXISTS "TechIssue" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "issueType" "IssueType" NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL,
    "rootCause" TEXT,
    "fix" TEXT,
    "component" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TechIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable TechIssueFix
CREATE TABLE IF NOT EXISTS "TechIssueFix" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "nodeId" TEXT,
    "oldPrompt" TEXT,
    "newPrompt" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedBy" TEXT,
    CONSTRAINT "TechIssueFix_pkey" PRIMARY KEY ("id")
);

-- CreateTable TechIssueRun
CREATE TABLE IF NOT EXISTS "TechIssueRun" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TechIssueRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (IF NOT EXISTS to survive re-runs)
CREATE INDEX IF NOT EXISTS "SystemDocument_projectId_idx" ON "SystemDocument"("projectId");
CREATE INDEX IF NOT EXISTS "TechIssue_projectId_idx" ON "TechIssue"("projectId");
CREATE INDEX IF NOT EXISTS "TechIssueFix_issueId_idx" ON "TechIssueFix"("issueId");
CREATE UNIQUE INDEX IF NOT EXISTS "TechIssueRun_issueId_runId_key" ON "TechIssueRun"("issueId", "runId");

-- AddForeignKey (only if constraint doesn't exist yet)
DO $$ BEGIN
  ALTER TABLE "SystemDocument" ADD CONSTRAINT "SystemDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "TechIssue" ADD CONSTRAINT "TechIssue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "TechIssueFix" ADD CONSTRAINT "TechIssueFix_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "TechIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "TechIssueRun" ADD CONSTRAINT "TechIssueRun_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "TechIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "TechIssueRun" ADD CONSTRAINT "TechIssueRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
