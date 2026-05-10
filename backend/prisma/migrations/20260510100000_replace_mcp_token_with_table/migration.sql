-- Drop the columns added in 20260510090000_add_mcp_token. Safe to drop because
-- nothing in production uses them yet (no tokens have been generated against
-- the previous schema in any deployed environment).
ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_mcpTokenHash_key";
DROP INDEX IF EXISTS "Project_mcpTokenHash_key";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "mcpTokenHash";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "mcpTokenCreatedAt";

-- Create the new McpToken table.
CREATE TABLE "McpToken" (
  "id"              TEXT NOT NULL,
  "projectId"       TEXT,
  "organizationId"  TEXT,
  "tokenHash"       TEXT NOT NULL,
  "name"            TEXT,
  "scope"           TEXT NOT NULL DEFAULT 'read',
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"       TIMESTAMP(3),
  "lastUsedAt"      TIMESTAMP(3),
  "revokedAt"       TIMESTAMP(3),
  CONSTRAINT "McpToken_pkey" PRIMARY KEY ("id")
);

-- Exactly one of projectId / organizationId must be set. Enforced at DB level
-- so application bugs cannot create dangling or ambiguous tokens.
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_scope_xor"
  CHECK (
    ("projectId" IS NOT NULL AND "organizationId" IS NULL) OR
    ("projectId" IS NULL AND "organizationId" IS NOT NULL)
  );

-- scope must be one of the allowed values (cheap insurance against typos).
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_scope_values"
  CHECK ("scope" IN ('read', 'read_write'));

-- Indexes
CREATE UNIQUE INDEX "McpToken_tokenHash_key" ON "McpToken"("tokenHash");
CREATE INDEX "McpToken_projectId_revokedAt_idx" ON "McpToken"("projectId", "revokedAt");
CREATE INDEX "McpToken_organizationId_revokedAt_idx" ON "McpToken"("organizationId", "revokedAt");
CREATE INDEX "McpToken_expiresAt_idx" ON "McpToken"("expiresAt");

-- Foreign key to Project (organizationId is informational for now; no FK to
-- avoid coupling until org-scoped tokens are explicitly supported).
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
