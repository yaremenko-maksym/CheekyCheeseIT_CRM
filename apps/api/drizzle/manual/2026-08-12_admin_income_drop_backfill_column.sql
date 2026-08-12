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
-- security-review round 2 (PR #517, MED-F): this file ALSO carries a partial
-- unique index — `uq_transactions_source_income_drop_link` — that converts
-- the apply script's idempotency guarantee from "predicate, evaluated once"
-- into a DB-enforced constraint: at most one DROP_PENDING_PAYOUT/PAYOUT_DROP
-- row may ever exist per `source_income_transaction_id`. A genuinely
-- concurrent second `apply.sql` run (a manual re-trigger while a prior run
-- is still in flight) hits 23505 on the second INSERT instead of silently
-- creating a duplicate drop-share obligation. See the doc comment on
-- `sourceIncomeTransactionId` in schema.ts for why it is scoped to the
-- drop-share types only (never conflicts with the co-existing
-- SENIOR_PENDING_PAYOUT row the SAME `bookCompanyObligations` call books for
-- the SAME income — different `type`, outside this partial index's row set).
--
-- REQUIRED apply order (mirrors the 2026-07-27 drop-share-pending-parity
-- precedent — same reasoning: the report MUST be a separate, prior step so a
-- human can look BEFORE anything is created; a wrongly-created financial
-- obligation is more expensive to unwind than a second deploy):
--   1. THIS file — schema: new column + unique index (idempotent, additive,
--      safe to apply even if nothing downstream ever runs).
--   2. `2026-08-12_admin_income_drop_backfill_report.sql` — READ-ONLY,
--      AGGREGATE-ONLY report; OWNER reads the candidate/ambiguous COUNTS +
--      total USDT in the (public) deploy log and decides whether to proceed.
--      Makes ZERO writes. Security-review round 2 (PR #517, HIGH-3): this
--      repo is PUBLIC — GitHub Actions logs are public too — so the
--      automated report NEVER prints per-row detail (client names, drop
--      names, individual amounts) into that log. Row-level detail lives in
--      `apps/api/drizzle/manual-private/2026-08-12_admin_income_drop_backfill_detail.sql`
--      — a SIBLING directory, not this one, precisely so
--      `scripts/devops/check-prod-ddl-wiring.py` (which scans `manual/` and
--      requires every file in it to be wired or excepted) never has to know
--      about it. See that file's header: it is NEVER wired into deploy.yml,
--      run manually and privately by an owner with direct DB access when
--      the row-level breakdown is actually needed.
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
-- Coder zone-of-write; called out explicitly in this PR's body). Add THIS
-- file, the report file, and the apply file (three files — NOT the detail
-- file, which must never run inside CI) to deploy.yml's "Copy compose files
-- and DDL via SCP" `source:` list AND to the migrate step, in that exact
-- order, applied BEFORE the new api image serves traffic (the api reads this
-- column on every transactions query once the companion payment-type-guard
-- PR's code lands). `scripts/devops/check-prod-ddl-wiring.py` fails the
-- build until that happens — by design, same as
-- `2026-08-05_salary_paid_amount.sql`.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS,
-- safe to re-run on every deploy, forever. No data is read or written.
-- =============================================================================

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS source_income_transaction_id uuid
    REFERENCES transactions(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_source_income_drop_link
  ON transactions (source_income_transaction_id)
  WHERE type IN ('DROP_PENDING_PAYOUT', 'PAYOUT_DROP')
    AND source_income_transaction_id IS NOT NULL;

DO $$
BEGIN
  RAISE NOTICE 'admin-income-drop-backfill: source_income_transaction_id + uq_transactions_source_income_drop_link present on transactions (column nullable, no backfill of the column itself by design — see the report/apply scripts for the DATA backfill)';
END $$;
