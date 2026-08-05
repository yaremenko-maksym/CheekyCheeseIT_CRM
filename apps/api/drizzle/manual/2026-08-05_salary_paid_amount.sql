-- =============================================================================
-- Salary pay-time obligation snapshot — prod DDL (manual apply)
-- task-salary-pay-amount
-- =============================================================================
--
-- Context
-- -------
-- Paying a PENDING salary can now record the amount ACTUALLY paid (owner
-- decision, 2026-08-05: the transaction must show «30 000 UAH» so a bank
-- statement reconciles one-to-one), while the salary may have been created as
-- an obligation in another denomination («800 USD»).
--
-- `transactions.amount` / `.currency` therefore become the FACT of the payment.
-- The obligation they settled MUST NOT be lost — USD reporting, balances and
-- the «projects unpaid this month» metric are all built on it — so it is
-- preserved in the three columns added here, stamped once by
-- `TransactionsService.paySalary` at the PENDING→PAID flip:
--
--   original_amount    `amount`   as it stood immediately BEFORE the payment
--   original_currency  `currency` as it stood immediately BEFORE the payment
--   exchange_rate      effective applied rate = paid / original, computed
--                      server-side from those two amounts (never client-
--                      supplied — the payer settles at their own bank's rate,
--                      which is by definition whatever the amounts imply).
--                      scale 8 rather than the 6 used for money: it is a ratio,
--                      and a sub-unit rate (UAH→USD ≈ 0.02666667) must keep its
--                      precision.
--
-- See the column comment in `apps/api/src/database/schema.ts` for the full
-- reasoning; dev/CI get these columns from `drizzle-kit push` against that
-- file, prod from THIS one.
--
-- NO BACKFILL — deliberately
-- --------------------------
-- These columns stay NULL on every pre-existing row, and that is the literal
-- truth: those rows were never paid through the amount-aware flow, their
-- `amount` still means exactly what it always meant. Nothing to migrate, and
-- every existing balance / summary / metric keeps returning the SAME number it
-- returned before this file ran. A backfill would have to invent an obligation
-- that was never separately recorded — strictly worse than an honest NULL.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-05_salary_paid_amount.sql
--
-- REQUIRED DevOps wiring (this PR does NOT touch `.github/workflows/**` —
-- Coder zone-of-write): add this filename to deploy.yml's "Copy compose files
-- and DDL via SCP" `source:` list AND to the migrate step, applied BEFORE the
-- new api image serves traffic. `scripts/devops/check-prod-ddl-wiring.py`
-- (wired into ci.yml) fails the build until that happens — by design, so this
-- file cannot silently reach main unapplied the way
-- `2026-07-25_vacancy_i18n_seo.sql` did.
--
-- ORDERING vs the api image: the api reads these columns on every transaction
-- read (they are part of the row SELECT and of the DTO), so applying this file
-- BEFORE the new image is not merely preferred — a new image against an
-- un-migrated DB would error on every transactions query. The reverse order is
-- safe in the other direction: applying this file while the OLD image runs is a
-- no-op for it (it never references the new columns).
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` ×3, safe to re-run on every deploy,
-- forever. No data is read or written.
-- =============================================================================

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS original_amount numeric(18, 6);

-- Reuses the EXISTING `currency` pg enum (already shared by
-- transactions.currency / users.salary_currency) — a real DB-level type, so an
-- out-of-enum value is rejected by the database, not merely by Zod.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS original_currency currency;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18, 8);

DO $$
BEGIN
  RAISE NOTICE 'salary-paid-amount: original_amount / original_currency / exchange_rate present on transactions (no backfill by design — NULL means "never paid through the amount-aware flow")';
END $$;
