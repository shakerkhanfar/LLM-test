-- CreateTable
CREATE TABLE "ProjectAnalysis" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "runIds" TEXT[],
    "runsIncluded" INTEGER NOT NULL,
    "dateFilterType" TEXT,
    "filterFrom" TIMESTAMP(3),
    "filterTo" TIMESTAMP(3),
    "analysis" JSONB NOT NULL,
    "healthScore" DOUBLE PRECISION,
    "comparedToVersion" INTEGER,
    "comparison" JSONB,
    "analysisCost" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectAnalysis_projectId_idx" ON "ProjectAnalysis"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAnalysis_projectId_version_key" ON "ProjectAnalysis"("projectId", "version");

-- AddForeignKey
ALTER TABLE "ProjectAnalysis" ADD CONSTRAINT "ProjectAnalysis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
