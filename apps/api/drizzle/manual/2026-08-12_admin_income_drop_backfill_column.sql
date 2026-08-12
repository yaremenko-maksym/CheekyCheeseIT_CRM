-- =============================================================================
-- Admin-income → drop-share link column — prod DDL (manual apply)
-- task-admin-income-drop-backfill
-- =============================================================================
--
-- Context
-- -------
-- `createAdminIncome` (POST /transactions/admin-income) never called
-- `bookCompanyObligations` — only its sibling `declareUsdtProjectIncome`
-- (POST /finance/usdt-income) does. Every ADMIN_INCOME row created through the
-- OTHER form on a USDT-payment project with a bound drop is therefore missing
-- its DROP_PENDING_PAYOUT + pending_obligations pair. The companion task
-- task-admin-income-payment-type-guard (different agent, different PR) closes
-- the CODE gap going forward by removing the choice between the two forms —
-- this task's job is the DATA: доначислить missing shares for the whole
-- history. This file is step 1 of 3.
--
-- Before backfilling anything, "does this income already have a booked
-- share?" needed an answer that did not depend on matching project + amount +
-- time — good enough to browse, not good enough to move real money on. This
-- column is that answer: a direct, explicit link from a SENIOR_PENDING_PAYOUT
-- / DROP_PENDING_PAYOUT row back to the ADMIN_INCOME row it was booked from.
--
-- See the column comment on `transactions.sourceIncomeTransactionId` in
-- apps/api/src/database/schema.ts for the full reasoning (who writes it, why
-- it is nullable, why the payout-cascade path deliberately leaves it NULL).
--
-- REQUIRED apply order (mirrors the 2026-07-27 drop-share-pending-parity
-- precedent — same reasoning: the report MUST be a separate, prior step so a
-- human can look BEFORE anything is created; a wrongly-created financial
-- obligation is more expensive to unwind than a second deploy):
--   1. THIS file — schema: new column (idempotent, additive, safe to apply
--      even if nothing downstream ever runs).
--   2. `2026-08-12_admin_income_drop_backfill_report.sql` — READ-ONLY report;
--      OWNER reads the candidate + ambiguous lists in the deploy log and
--      decides whether to proceed. Makes ZERO writes.
--   3. `2026-08-12_admin_income_drop_backfill_apply.sql` — the actual
--      backfill, only after step 2's go-ahead.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_column.sql
--
-- REQUIRED DevOps wiring (this PR does NOT touch .github/workflows/** —
-- Coder zone-of-write; called out explicitly in this PR's body). Add all
-- THREE files above to deploy.yml's "Copy compose files and DDL via SCP"
-- `source:` list AND to the migrate step, in that exact order, applied
-- BEFORE the new api image serves traffic (the api reads this column on
-- every transactions query once the companion payment-type-guard PR's code
-- lands). `scripts/devops/check-prod-ddl-wiring.py` fails the build until
-- that happens — by design, same as `2026-08-05_salary_paid_amount.sql`.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, safe to re-run on every deploy,
-- forever. No data is read or written.
-- =============================================================================

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS source_income_transaction_id uuid
    REFERENCES transactions(id) ON DELETE SET NULL;

DO $$
BEGIN
  RAISE NOTICE 'admin-income-drop-backfill: source_income_transaction_id present on transactions (nullable, no backfill of the column itself by design — see the report/apply scripts for the DATA backfill)';
END $$;
