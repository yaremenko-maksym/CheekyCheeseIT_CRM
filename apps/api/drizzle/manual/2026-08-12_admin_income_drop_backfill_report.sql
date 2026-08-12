-- =============================================================================
-- Admin-income drop-share backfill — REPORT (standalone, READ-ONLY, no writes)
-- task-admin-income-drop-backfill
-- =============================================================================
--
-- Deploy sequencing (DevOps owns the wiring in .github/workflows/deploy.yml —
-- see 2026-08-12_admin_income_drop_backfill_column.sql's header):
--   1. Apply `2026-08-12_admin_income_drop_backfill_column.sql` (schema).
--   2. Apply THIS file → read the RAISE NOTICE output in the deploy log →
--      OWNER decides whether to proceed.
--   3. Only THEN apply `2026-08-12_admin_income_drop_backfill_apply.sql` (the
--      actual backfill — separate file, separate step, gated on the owner's
--      go-ahead from step 2, not auto-chained).
--
-- This file is 100% read-only: no CREATE/INSERT/UPDATE/DELETE of any kind,
-- not even a temp table. Proven by
-- apps/api/src/finance/admin-income-drop-backfill.integration.spec.ts (AC3):
-- table row counts are identical before and after running it.
--
-- Selection predicate (mirrors the apply file EXACTLY — same CTEs, same
-- WHERE clauses; only the SELECT list differs, this file adds human-readable
-- columns for the report, the apply file adds the columns it needs to write)
-- ------------------------------------------------------------------------------
-- A candidate is an ADMIN_INCOME row where ALL of:
--   - type = 'ADMIN_INCOME' AND deleted_at IS NULL (soft-deleted incomes are
--     never processed — task-admin-income-drop-backfill AC8);
--   - its project has drop_id IS NOT NULL AND payment_type = 'USDT' — ONLY
--     USDT projects: on any other payment type the drop declares their OWN
--     income (createDropIncome) and a backfilled share here would DOUBLE the
--     obligation (AC6);
--   - the income is not already LINKED to an existing DROP_PENDING_PAYOUT /
--     PAYOUT_DROP row via `source_income_transaction_id` — that would mean
--     the fixed code (declareUsdtProjectIncome, post this task's companion
--     PR) already booked its share properly; nothing to backfill.
--
-- AMBIGUOUS (task's own rule: "сузь, а не расширяй" — narrow the selection,
-- never widen it by guessing): if a project carries ANY existing
-- DROP_PENDING_PAYOUT / PAYOUT_DROP row with `source_income_transaction_id
-- IS NULL` (i.e. a drop-share row whose origin income cannot be determined —
-- either pre-dates this column, or was booked by some other historical
-- path), then EVERY ADMIN_INCOME candidate on THAT project is undecidable:
-- there is no way to tell which income(s) the untagged row already covers.
-- Deliberately conservative — this may over-flag a genuinely-unrelated
-- untagged row (e.g. one from the payout cascade, discriminated by
-- `drop_cascade_origin=true`) as "ambiguous" rather than trying to be
-- clever about excluding it; a human reviewing a short list is cheaper than
-- a wrong guess on money. Every such project is entirely excluded from BOTH
-- the candidate list AND the apply file's target set — resolved manually by
-- the owner, never auto-processed.
--
-- Percent + amount — OWNER-APPROVED ASSUMPTION (say it out loud)
-- -----------------------------------------------------------------------------
-- No historical drop-share % was ever recorded for these incomes (the
-- snapshot columns were added later). This report — and the apply file that
-- follows it — compute the share using TODAY's `resolveDropShare` rule:
-- project override → drop's user-level default → 5%. If a project's or
-- drop's share % ever changed over time, the backfilled amount will NOT
-- match what would have been booked back when the income was originally
-- declared. This is a deliberate, disclosed approximation, not a bug — see
-- the task file (task-admin-income-drop-backfill.md) for the owner's framing.
--
-- `share_amount` below is a Postgres `numeric` (exact decimal) re-statement
-- of `roundShareAmount` (apps/api/src/finance/transactions.service.ts):
--   incomeMinor = Math.round(income * 1_000_000)
--   shareMinor  = Math.round(incomeMinor * percent / 100)
--   return shareMinor / 1_000_000  (already at 6dp)
-- `round(numeric)` rounds half AWAY FROM ZERO; `Math.round` rounds half
-- toward +Infinity — identical for the exclusively non-negative amounts this
-- script ever sees. Pinned by a real comparison test (both computations run
-- against a shared value table, including half-cent amounts):
--   apps/api/src/finance/admin-income-drop-backfill.integration.spec.ts
--   ("SQL rounding matches roundShareAmount byte-for-byte").
--
-- Run standalone:
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_report.sql
-- =============================================================================

DO $$
DECLARE
  rec RECORD;
  v_candidates integer := 0;
  v_ambiguous integer := 0;
BEGIN
  FOR rec IN
    WITH usdt_drop_incomes AS (
      SELECT
        t.id AS income_id,
        t.project_id,
        t.amount,
        COALESCE(t.tx_date, t.created_at) AS effective_date,
        p.name AS project_name,
        p.drop_id,
        p.drop_share_percent_override
      FROM transactions t
      JOIN projects p ON p.id = t.project_id
      WHERE t.type = 'ADMIN_INCOME'
        AND t.deleted_at IS NULL
        AND p.drop_id IS NOT NULL
        AND p.payment_type = 'USDT'
    ),
    linked AS (
      SELECT DISTINCT source_income_transaction_id AS income_id
      FROM transactions
      WHERE type IN ('DROP_PENDING_PAYOUT', 'PAYOUT_DROP')
        AND deleted_at IS NULL
        AND source_income_transaction_id IS NOT NULL
    ),
    ambiguous_projects AS (
      SELECT DISTINCT project_id
      FROM transactions
      WHERE type IN ('DROP_PENDING_PAYOUT', 'PAYOUT_DROP')
        AND deleted_at IS NULL
        AND source_income_transaction_id IS NULL
    )
    SELECT
      u.income_id,
      u.project_id,
      u.project_name,
      u.effective_date,
      u.amount,
      u.drop_id,
      d.display_name AS drop_name,
      COALESCE(u.drop_share_percent_override, d.drop_share_percent, 5) AS resolved_percent,
      CASE
        WHEN u.drop_share_percent_override IS NOT NULL THEN 'PROJECT'
        ELSE 'USER_DEFAULT'
      END AS percent_source,
      (
        round(round(u.amount * 1000000) * COALESCE(u.drop_share_percent_override, d.drop_share_percent, 5) / 100)
        / 1000000
      )::numeric(18, 6) AS share_amount,
      (u.project_id IN (SELECT project_id FROM ambiguous_projects)) AS is_ambiguous
    FROM usdt_drop_incomes u
    JOIN users d ON d.id = u.drop_id
    WHERE u.income_id NOT IN (SELECT income_id FROM linked)
    ORDER BY u.effective_date
  LOOP
    IF rec.is_ambiguous THEN
      v_ambiguous := v_ambiguous + 1;
      RAISE NOTICE 'AMBIGUOUS — income=% project=% (%) date=% amount=% USDT drop=% (%) — project already carries an untagged drop-share row, origin cannot be determined; SKIPPED on both the report and the apply file, resolve manually',
        rec.income_id, rec.project_name, rec.project_id, rec.effective_date, rec.amount, rec.drop_name, rec.drop_id;
    ELSE
      v_candidates := v_candidates + 1;
      RAISE NOTICE 'CANDIDATE — income=% project=% (%) date=% amount=% USDT drop=% (%) percent=% source=% share=% USDT',
        rec.income_id, rec.project_name, rec.project_id, rec.effective_date, rec.amount, rec.drop_name, rec.drop_id, rec.resolved_percent, rec.percent_source, rec.share_amount;
    END IF;
  END LOOP;

  RAISE NOTICE 'admin-income-drop-backfill REPORT (read-only, no writes): % candidate(s) would be created by the apply file, % ambiguous row(s) need manual review — nothing has been written yet',
    v_candidates, v_ambiguous;
END $$;
