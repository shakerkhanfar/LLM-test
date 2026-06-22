-- Intention funnel config: { intentField, successField, successMode, successValues? }
ALTER TABLE "Project" ADD COLUMN "intentionConfig" JSONB;
