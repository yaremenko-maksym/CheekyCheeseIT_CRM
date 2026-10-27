-- =============================================================================
-- transactions.tx_date becomes NOT NULL — PERMANENT CONSTRAINT (backlog 338, final step)
-- =============================================================================
--
-- Owner-approved 2026-10-26 ("Разрешаю правки в прод базе"). Every insert path has
-- persisted a non-null tx_date since #1158/#1159, the legacy NULL rows were backfilled by
-- 2026-10-25_tx_date_kyiv_backfill.sql, and the last NULL-tolerant reader (kyivMonthOf)
-- was removed in #1184. This file makes the database enforce what the code already does.
--
-- Apply:
-- psql -v ON_ERROR_STOP=1 --single-transaction -f 2026-10-27_transactions_tx_date_not_null.sql
--
-- SAFETY
--   - One DO block = one transaction under any invocation; it commits whole or not at all.
--   - Fail-loud pre-check: RAISE EXCEPTION if any row still has tx_date IS NULL (soft-deleted
--     rows included). The message carries the count only — the deploy log is public.
--   - Idempotent: when the column is already NOT NULL the file prints a NOTICE and writes
--     nothing, so it stays wired on every deploy and re-asserts the constraint.
--   - No data rewrite. SET NOT NULL scans the table once under ACCESS EXCLUSIVE; the
--     table is small (hundreds of rows), so the lock is held for milliseconds.
--
-- ROLLBACK (schema): ALTER TABLE public.transactions ALTER COLUMN tx_date DROP NOT NULL;
--   Rolling back the API IMAGE alone is safe without it: every image since #1158 writes a
--   non-null tx_date on every insert path, so an older image never trips the constraint.
-- =============================================================================

DO $$
DECLARE
  already_not_null boolean;
  null_rows bigint;
BEGIN
  SELECT a.attnotnull INTO already_not_null
    FROM pg_attribute a
   WHERE a.attrelid = 'public.transactions'::regclass
     AND a.attname = 'tx_date'
     AND NOT a.attisdropped;

  IF already_not_null IS NULL THEN
    RAISE EXCEPTION 'public.transactions.tx_date does not exist';
  END IF;

  IF already_not_null THEN
    RAISE NOTICE 'transactions.tx_date is already NOT NULL; nothing to do';
    RETURN;
  END IF;

  SELECT count(*) INTO null_rows FROM public.transactions WHERE tx_date IS NULL;
  IF null_rows > 0 THEN
    RAISE EXCEPTION 'transactions.tx_date NOT NULL refused: % row(s) still have tx_date IS NULL', null_rows;
  END IF;

  ALTER TABLE public.transactions ALTER COLUMN tx_date SET NOT NULL;
  RAISE NOTICE 'transactions.tx_date is now NOT NULL (0 NULL rows checked)';
END
$$;
