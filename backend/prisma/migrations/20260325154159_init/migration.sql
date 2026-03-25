-- CreateEnum
CREATE TYPE "CriterionType" AS ENUM ('DETERMINISTIC', 'LLM_JUDGE', 'STRUCTURAL', 'WORD_ACCURACY', 'LATENCY');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'AWAITING_DATA', 'EVALUATING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "LabelType" AS ENUM ('WRONG_WORD', 'WRONG_LANGUAGE', 'WRONG_GENDER', 'HALLUCINATED');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "description" TEXT,
    "agentStructure" JSONB,
    "flowDefinition" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Criterion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT,
    "type" "CriterionType" NOT NULL,
    "expectedValue" JSONB NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Criterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "modelUsed" TEXT NOT NULL,
    "hamsaCallId" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "callLog" JSONB,
    "transcript" JSONB,
    "webhookData" JSONB,
    "overallScore" DOUBLE PRECISION,
    "errorLog" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "criterionId" TEXT NOT NULL,
    "passed" BOOLEAN,
    "score" DOUBLE PRECISION,
    "detail" TEXT,
    "metadata" JSONB,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WordLabel" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "wordIndex" INTEGER NOT NULL,
    "utteranceIndex" INTEGER NOT NULL,
    "originalWord" TEXT NOT NULL,
    "labelType" "LabelType" NOT NULL,
    "correction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WordLabel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Criterion_projectId_key_key" ON "Criterion"("projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "EvalResult_runId_criterionId_key" ON "EvalResult"("runId", "criterionId");

-- CreateIndex
CREATE UNIQUE INDEX "WordLabel_runId_wordIndex_key" ON "WordLabel"("runId", "wordIndex");

-- AddForeignKey
ALTER TABLE "Criterion" ADD CONSTRAINT "Criterion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_criterionId_fkey" FOREIGN KEY ("criterionId") REFERENCES "Criterion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordLabel" ADD CONSTRAINT "WordLabel_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
