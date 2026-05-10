-- AlterTable
ALTER TABLE "Project"
  ADD COLUMN "mcpTokenHash" TEXT,
  ADD COLUMN "mcpTokenCreatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Project_mcpTokenHash_key" ON "Project"("mcpTokenHash");
