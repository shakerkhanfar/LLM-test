-- Add composite index on EvalResult(runId, passed) to support the
-- MIN_EVALUATED_CRITERIA correlated subqueries in the dashboard SQL.
-- Without this index those subqueries scan the full EvalResult table
-- once per Run row, causing O(n*m) performance on large projects.
CREATE INDEX IF NOT EXISTS "EvalResult_runId_passed_idx" ON "EvalResult"("runId", "passed");
