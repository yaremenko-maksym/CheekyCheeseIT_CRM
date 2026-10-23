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

-- idempotency_key predates this feature in application code, but keep this
-- migration self-contained for environments that missed the earlier additive
-- migration. Nullable + no default means existing rows are unchanged.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS salary_origin varchar(8);

-- Safe before the image swap: the old API never writes idempotency_key on
-- SALARY rows, so all of its inserts carry NULL and are unaffected. New clients
-- use this partial index to make one manual salary-part intent replay-safe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_salary_idempotency_key
  ON transactions (idempotency_key)
  WHERE type = 'SALARY' AND idempotency_key IS NOT NULL;

-- Defense in depth: the new API marks operator-created salary parts MANUAL,
-- and every such write must carry an intent key. Legacy/old-API rows keep
-- salary_origin NULL and remain valid during the rolling prepare phase; CRON
-- rows also remain keyless by design.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_transactions_manual_salary_idempotency_key'
      AND conrelid = 'transactions'::regclass
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT ck_transactions_manual_salary_idempotency_key
      CHECK (
        type <> 'SALARY'
        OR salary_origin IS DISTINCT FROM 'MANUAL'
        OR idempotency_key IS NOT NULL
      ) NOT VALID;
  END IF;
END
$$;

-- NOT VALID avoids turning an upgrade into a destructive/blocking deploy if
-- an environment somehow already contains MANUAL rows written by an earlier
-- optional-key build. PostgreSQL still enforces the CHECK for every NEW/updated
-- row. Validate immediately when there is no historical exception.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM transactions
    WHERE type = 'SALARY'
      AND salary_origin = 'MANUAL'
      AND idempotency_key IS NULL
  ) THEN
    ALTER TABLE transactions
      VALIDATE CONSTRAINT ck_transactions_manual_salary_idempotency_key;
  END IF;
END
$$;

-- SR-795-L-3 (task-retro-salary-ledger-integrity, 2026-10-24). Value domain for
-- salary_origin. The column shipped as a bare varchar(8), which accepts any
-- 8-character string: a stored 'Manual' or 'cron' satisfies neither the
-- automatic-component predicate nor the month-accounting one, so the row goes
-- invisible to cron idempotency AND to the gap report at the same time, silently.
-- Mirrors `ck_transactions_salary_origin_domain` in schema.ts; the list is the
-- `SalaryOrigin` union in @crm/shared. NULL stays legal (rows written before the
-- column existed). Added pre-swap on purpose: the previous API image writes only
-- MANUAL and CRON, both inside the domain.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_transactions_salary_origin_domain'
      AND conrelid = 'transactions'::regclass
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT ck_transactions_salary_origin_domain
      CHECK (
        salary_origin IS NULL
        OR salary_origin IN ('MANUAL', 'CRON', 'ADJUSTED')
      ) NOT VALID;
  END IF;
END
$$;

-- NOT VALID for the same reason as the CHECK above: an environment that somehow
-- holds an out-of-domain value must not turn this deploy into a failed one.
-- PostgreSQL enforces the CHECK on every new and updated row regardless, so the
-- defect cannot spread; validate as soon as the table is clean.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM transactions
    WHERE salary_origin IS NOT NULL
      AND salary_origin NOT IN ('MANUAL', 'CRON', 'ADJUSTED')
  ) THEN
    ALTER TABLE transactions
      VALIDATE CONSTRAINT ck_transactions_salary_origin_domain;
  END IF;
END
$$;

-- IF NOT EXISTS is name-based. Fail loud if a pre-existing index with this
-- name does not actually enforce the contract this rollout relies on.
DO $$
DECLARE
  v_unique boolean;
  v_predicate text;
  v_columns text[];
BEGIN
  SELECT
    i.indisunique,
    pg_get_expr(i.indpred, i.indrelid),
    ARRAY(
      SELECT a.attname
      FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a
        ON a.attrelid = i.indrelid
       AND a.attnum = k.attnum
      ORDER BY k.ord
    )
  INTO v_unique, v_predicate, v_columns
  FROM pg_index i
  JOIN pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_class tbl ON tbl.oid = i.indrelid
  WHERE tbl.relname = 'transactions'
    AND idx.relname = 'uq_transactions_salary_idempotency_key';

  IF v_unique IS DISTINCT FROM TRUE
     OR v_columns IS DISTINCT FROM ARRAY['idempotency_key']::text[]
     OR v_predicate IS NULL
     OR position('type = ''SALARY''::transaction_type' in v_predicate) = 0
     OR position('idempotency_key IS NOT NULL' in v_predicate) = 0
     OR position(' AND ' in v_predicate) = 0
  THEN
    RAISE EXCEPTION
      'uq_transactions_salary_idempotency_key exists with an unexpected definition';
  END IF;
END
$$;

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
    -- SR-795-M-1 / owner decision D-3 (2026-10-24) REVERSED the rule that used
    -- to live on this line. It read `AND (salary_origin IS NULL OR salary_origin
    -- = 'CRON')`, on the reasoning that a manual part must never claim the cron
    -- marker — and that is exactly the hole the retro review measured: a month
    -- whose only salary is manual stays markerless, so the next cron run (or an
    -- ADMIN pressing Backfill) mints a SECOND payable salary for the same
    -- person and month, with nothing in the UI or the API saying so.
    --
    -- Under D-3 the first part recorded for a receiver/month owns the month,
    -- whoever recorded it, which is also what the pre-multipart unique index
    -- meant. So every origin is adopted here EXCEPT ADJUSTED: an ADJUSTED row
    -- was reclassified precisely because another row already held that month,
    -- and letting it claim a marker on replay would hand it a slot it lost.
    -- `IS DISTINCT FROM` rather than `<>` because NULL (legacy) must pass.
    AND salary_origin IS DISTINCT FROM 'ADJUSTED'
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
--    WHERE table_name = 'transactions'
--      AND column_name IN ('idempotency_key', 'salary_origin');
--   SELECT to_regclass('public.salary_month_initializations');
--   SELECT count(*) FROM transactions
--    WHERE type='SALARY' AND salary_month IS NOT NULL AND receiver_id IS NOT NULL;
--   SELECT count(*) FROM salary_month_initializations;
-- =============================================================================
