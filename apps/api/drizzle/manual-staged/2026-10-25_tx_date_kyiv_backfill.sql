-- =============================================================================
-- Backfill legacy NULL transactions.tx_date to the Kyiv business day — ONE-TIME DATA-FIX
-- =============================================================================
--
-- backlog 338, owner decision 2 (approved 2026-10-25). Most insert paths have persisted a
-- non-null tx_date through `resolveTransactionDate` since PR #1133. The last two that did
-- not (`bookCompanyObligations`, the IOU rows of a drop-project payout paid without a date,
-- and the monthly salary cron) are fixed in the same PR as this file (#1158, SR-H-1), so
-- the code that ships with it writes no NULL tx_date. Older rows may still carry NULL, and
-- readers fall back to the Kyiv month of created_at
-- (`transactionBusinessMonth` -> `kyivMonthOf`). This file gives those rows the value
-- `resolveTransactionDate(null, created_at)` would persist for a new row:
--   - Kyiv day == UTC day of created_at  -> created_at itself (the real instant);
--   - otherwise (Kyiv already a day ahead, 21:00/22:00Z..24:00Z) -> UTC midnight of the
--     Kyiv day, the repository's date-only encoding.
-- Either way the UTC month of the stored value equals the Kyiv month of created_at, so
-- every row stays in the business month it is filed in today (proven per row by
-- tx-date-kyiv-backfill.integration.spec.ts). The Kyiv day comes from the IANA zone
-- 'Europe/Kyiv' per instant, so DST is never assumed.
--
-- WHAT IT TOUCHES: only tx_date, only on rows where tx_date IS NULL (soft-deleted rows
-- included). No balance reads tx_date: balances and the settled_amount cascade sum
-- amounts by type/status; tx_date feeds month windows, sort order and the date-policy
-- lower bound only.
--
-- SAFETY
--   - The whole file is ONE DO block, so it is one transaction under any invocation
--     (psql -f, psql --single-transaction, node-pg): it commits whole or not at all.
--   - Fail-loud: RAISE EXCEPTION if the update count differs from the backup count or
--     from the NULL count, or if any NULL row is left.
--   - Runs once: the backup table below is the marker. If it already exists, the backfill
--     has run; a NULL row found then means some writer persists NULL tx_date again, and
--     the file RAISES instead of silently patching it over.
--   - Output is aggregate counts only (the deploy log is public): no ids, no amounts.
--
-- RECOVERY: public._tx_date_kyiv_backfill_backup_20261025 keeps the id of every row this
-- file changed plus the value it wrote. It is never dropped by this file. The guard on
-- backfilled_tx_date leaves alone any row an operator has re-dated since.
--
-- ROLLBACK ORDER (SR-M-1). The rollback puts NULLs back while the backup table (the
-- run marker) stays, so the next apply of THIS file raises and turns the deploy red:
--   1. De-wire this file's deploy step first (or confirm it is already listed in
--      KNOWN_NOT_WIRED in scripts/devops/check-prod-ddl-wiring.py).
--   2. Only then run the UPDATE below. Its row count should equal
--      `SELECT count(*) FROM public._tx_date_kyiv_backfill_backup_20261025`, minus any rows
--      re-dated since.
--   3. To re-apply the backfill after a rollback, first rename the backup table out of the
--      way (ALTER TABLE ... RENAME TO ..._rolledback_<date>), and classify the renamed
--      table in privilege-classes.ts; otherwise the file treats the restored NULLs as new.
-- ROLLBACK:
--   UPDATE public.transactions t SET tx_date = NULL
--     FROM public._tx_date_kyiv_backfill_backup_20261025 b
--    WHERE t.id = b.transaction_id AND t.tx_date = b.backfilled_tx_date;
-- =============================================================================

DO $$
DECLARE
  prior_run boolean := to_regclass('public._tx_date_kyiv_backfill_backup_20261025') IS NOT NULL;
  null_before bigint;
  backed_up bigint;
  updated bigint;
  null_after bigint;
BEGIN
  SELECT count(*) INTO null_before FROM public.transactions WHERE tx_date IS NULL;
  RAISE NOTICE 'tx_date kyiv backfill: prior_run=% null_before=%', prior_run::text, null_before;

  IF prior_run AND null_before > 0 THEN
    RAISE EXCEPTION 'tx_date kyiv backfill: % row(s) with NULL tx_date appeared after the one-time backfill already ran; a writer persists NULL tx_date again. Investigate before re-running.', null_before;
  END IF;

  IF NOT prior_run THEN
    CREATE TABLE public._tx_date_kyiv_backfill_backup_20261025 (
      transaction_id uuid PRIMARY KEY,
      backfilled_tx_date timestamptz NOT NULL,
      backfilled_at timestamptz NOT NULL DEFAULT now()
    );
  END IF;

  INSERT INTO public._tx_date_kyiv_backfill_backup_20261025 (transaction_id, backfilled_tx_date)
  SELECT id,
         CASE
           WHEN (created_at AT TIME ZONE 'Europe/Kyiv')::date = (created_at AT TIME ZONE 'UTC')::date
             THEN created_at
           ELSE ((created_at AT TIME ZONE 'Europe/Kyiv')::date)::timestamp AT TIME ZONE 'UTC'
         END
    FROM public.transactions
   WHERE tx_date IS NULL;
  GET DIAGNOSTICS backed_up = ROW_COUNT;

  UPDATE public.transactions t
     SET tx_date = b.backfilled_tx_date
    FROM public._tx_date_kyiv_backfill_backup_20261025 b
   WHERE b.transaction_id = t.id
     AND t.tx_date IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;

  SELECT count(*) INTO null_after FROM public.transactions WHERE tx_date IS NULL;
  RAISE NOTICE 'tx_date kyiv backfill: updated=% null_after=%', updated, null_after;

  IF updated <> backed_up OR updated <> null_before OR null_after <> 0 THEN
    RAISE EXCEPTION 'tx_date kyiv backfill: counts disagree (null_before=%, backed_up=%, updated=%, null_after=%); rolled back, nothing written', null_before, backed_up, updated, null_after;
  END IF;
END
$$;
