-- When false, incoming webhook/ingest data is still stored but AI evaluation is skipped.
ALTER TABLE "Project" ADD COLUMN "evaluationEnabled" BOOLEAN NOT NULL DEFAULT true;
