-- Add INGEST to ProjectType enum
-- INGEST projects receive webhook calls and store them without running AI evaluation.

ALTER TYPE "ProjectType" ADD VALUE IF NOT EXISTS 'INGEST';
