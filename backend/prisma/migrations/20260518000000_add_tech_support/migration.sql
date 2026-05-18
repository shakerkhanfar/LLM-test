-- Add tokenVersion to User (idempotent)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- Add updatedAt to Run (idempotent)
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Add human review fields to Run
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "humanReviewNote" TEXT;
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "humanReviewedAt" TIMESTAMP(3);
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "humanReviewedBy" TEXT;
ALTER TABLE "Run" ADD COLUMN IF NOT EXISTS "apiPayload" JSONB;

-- Add TECH_SUPPORT to ProjectType enum
DO $$ BEGIN
  ALTER TYPE "ProjectType" ADD VALUE IF NOT EXISTS 'TECH_SUPPORT';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add PENDING_REVIEW to RunStatus enum
DO $$ BEGIN
  ALTER TYPE "RunStatus" ADD VALUE IF NOT EXISTS 'PENDING_REVIEW';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add TECH_SUPPORT_ANALYSIS to CriterionType enum
DO $$ BEGIN
  ALTER TYPE "CriterionType" ADD VALUE IF NOT EXISTS 'TECH_SUPPORT_ANALYSIS';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create DocType enum
DO $$ BEGIN
  CREATE TYPE "DocType" AS ENUM ('DESCRIPTION', 'CODE_SNIPPET', 'ERROR_CODES', 'DATA_FLOW');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create IssueType enum
DO $$ BEGIN
  CREATE TYPE "IssueType" AS ENUM ('AGENT_BEHAVIOR', 'BACKEND_FAILURE', 'DATA_MISMATCH', 'VARIABLE_SETTER', 'CONFIGURATION', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create IssueStatus enum
DO $$ BEGIN
  CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create SystemDocument table
CREATE TABLE IF NOT EXISTS "SystemDocument" (
  "id"        TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "docType"   "DocType" NOT NULL DEFAULT 'DESCRIPTION',
  "content"   TEXT NOT NULL,
  "order"     INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SystemDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SystemDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "SystemDocument_projectId_idx" ON "SystemDocument"("projectId");

-- Create TechIssue table
CREATE TABLE IF NOT EXISTS "TechIssue" (
  "id"          TEXT NOT NULL,
  "projectId"   TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "issueType"   "IssueType" NOT NULL,
  "status"      "IssueStatus" NOT NULL DEFAULT 'OPEN',
  "description" TEXT NOT NULL,
  "rootCause"   TEXT,
  "fix"         TEXT,
  "component"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TechIssue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TechIssue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "TechIssue_projectId_idx" ON "TechIssue"("projectId");

-- Create TechIssueFix table
CREATE TABLE IF NOT EXISTS "TechIssueFix" (
  "id"          TEXT NOT NULL,
  "issueId"     TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "nodeId"      TEXT,
  "oldPrompt"   TEXT,
  "newPrompt"   TEXT,
  "appliedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedBy"   TEXT,
  CONSTRAINT "TechIssueFix_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TechIssueFix_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "TechIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "TechIssueFix_issueId_idx" ON "TechIssueFix"("issueId");

-- Create TechIssueRun table
CREATE TABLE IF NOT EXISTS "TechIssueRun" (
  "id"      TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "runId"   TEXT NOT NULL,
  "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TechIssueRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TechIssueRun_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "TechIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TechIssueRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TechIssueRun_issueId_runId_key" UNIQUE ("issueId", "runId")
);
