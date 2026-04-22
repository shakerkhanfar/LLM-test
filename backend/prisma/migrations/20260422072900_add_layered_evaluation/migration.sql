-- AlterEnum
ALTER TYPE "CriterionType" ADD VALUE 'LAYERED_EVALUATION';

-- CreateIndex (unique constraint on Run for webhook dedup)
CREATE UNIQUE INDEX IF NOT EXISTS "Run_projectId_hamsaCallId_key" ON "Run"("projectId", "hamsaCallId");
