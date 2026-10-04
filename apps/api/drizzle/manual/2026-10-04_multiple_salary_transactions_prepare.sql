-- =============================================================================
-- Multipart salary — prepare phase (backward-compatible with the old API)
-- =============================================================================
--
-- This phase intentionally KEEPS uq_transactions_salary_receiver_month.
-- Production migrations run while the previous API image may still be serving.
-- That image uses ON CONFLICT (receiver_id, salary_month) with the old partial
-- unique index as its arbiter, so dropping the index before the image swap would
-- make the old cron fail with "no unique or exclusion constraint matching".
--
-- The activate phase runs only after docker compose has swapped in the new API:
--   2026-10-04_multiple_salary_transactions_activate.sql
--
-- Safe to re-run: every DDL statement is idempotent and the backfill uses
-- ON CONFLICT DO NOTHING.
-- =============================================================================

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS salary_origin varchar(8);

CREATE TABLE IF NOT EXISTS salary_month_initializations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receiver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salary_month varchar(7) NOT NULL,
  initialized_by uuid REFERENCES users(id) ON DELETE SET NULL,
  initialized_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_month_initializations_receiver_month
  ON salary_month_initializations (receiver_id, salary_month);

-- Preserve the pre-multipart contract for every historical month. Before this
-- feature, ANY salary row occupied the unique receiver/month slot and therefore
-- prevented cron from creating another one. We cannot know whether a legacy row
-- was initially manual or cron-created, so adopting every existing SALARY row as
-- "already initialized" is the only migration that cannot invent extra salary.
-- DISTINCT ON is defensive for environments where the legacy unique index was
-- already absent; production normally has at most one row per pair.
INSERT INTO salary_month_initializations (
  receiver_id,
  salary_month,
  initialized_by,
  initialized_at
)
SELECT
  legacy.receiver_id,
  legacy.salary_month,
  legacy.created_by,
  legacy.created_at
FROM (
  SELECT DISTINCT ON (receiver_id, salary_month)
    receiver_id,
    salary_month,
    created_by,
    created_at,
    id
  FROM transactions
  WHERE type = 'SALARY'
    AND salary_month IS NOT NULL
    AND receiver_id IS NOT NULL
  ORDER BY receiver_id, salary_month, created_at ASC, id ASC
) AS legacy
ON CONFLICT (receiver_id, salary_month) DO NOTHING;

-- The view expands SELECT * at CREATE time. Replacing it here makes the new
-- salary_origin column visible to Drizzle's nonDeletedTransactions view before
-- the new API image starts. PostgreSQL permits adding view columns at the end;
-- ALTER TABLE ADD COLUMN appends the physical column, so existing view columns
-- keep their names/order and salary_origin is appended safely.
CREATE OR REPLACE VIEW non_deleted_transactions AS
SELECT * FROM transactions WHERE deleted_at IS NULL;

-- VERIFY (read-only):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'transactions' AND column_name = 'salary_origin';
--   SELECT to_regclass('public.salary_month_initializations');
--   SELECT count(*) FROM transactions
--    WHERE type='SALARY' AND salary_month IS NOT NULL AND receiver_id IS NOT NULL;
--   SELECT count(*) FROM salary_month_initializations;
-- =============================================================================
