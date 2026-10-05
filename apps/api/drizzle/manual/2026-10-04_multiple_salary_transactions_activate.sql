-- =============================================================================
-- Multipart salary — activate phase (run AFTER the new API image is started)
-- =============================================================================
--
-- The old API's salary cron requires uq_transactions_salary_receiver_month as
-- an ON CONFLICT arbiter. The new API no longer does: cron idempotency is owned
-- by salary_month_initializations and manual salary parts may share a month.
-- Therefore this breaking index change is deliberately separated from the
-- backward-compatible prepare phase and is applied only after the image swap.
--
-- Safe to re-run: the replacement lookup index is IF NOT EXISTS and the old
-- unique index is IF EXISTS.
-- =============================================================================

-- Keep an efficient receiver/month lookup before releasing uniqueness, so there
-- is never a deployment state with no supporting index for salary-month reads.
CREATE INDEX IF NOT EXISTS idx_transactions_salary_receiver_month
  ON transactions (receiver_id, salary_month)
  WHERE type = 'SALARY' AND salary_month IS NOT NULL;

DROP INDEX IF EXISTS uq_transactions_salary_receiver_month;

-- VERIFY (read-only):
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE tablename = 'transactions'
--      AND indexname IN (
--        'idx_transactions_salary_receiver_month',
--        'uq_transactions_salary_receiver_month'
--      );
-- Expected: idx_transactions_salary_receiver_month exists; uq_* does not.
-- =============================================================================
