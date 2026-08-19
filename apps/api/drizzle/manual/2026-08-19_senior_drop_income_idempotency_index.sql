-- =============================================================================
-- SENIOR_INCOME / DROP_INCOME idempotency backstop — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- Backlog item 73/A-3 (finance audit "приходы и бронирование обязательств",
-- 2026-08-17). `POST /transactions/senior-income` (createSeniorIncome) and
-- `POST /transactions/drop-income` (createDropIncome) had no idempotency key —
-- unlike `declareUsdtProjectIncome` (PR #367, MED-1) and the dividend flow
-- (BIZ-19, MED-2), which already carry this exact contract. A double-submit
-- (double click / network retry) by a SENIOR/DROP created TWO income rows with
-- identical data; once that pair reached payout validation,
-- `bookCompanyObligations` booked the company TWO obligations for the same
-- piece of work — a real money double-booking, not a display glitch.
--
-- The fix mirrors the ADMIN_INCOME contract 1:1 — client-supplied UUID,
-- early-SELECT replay guard in the service, key persisted on insert, and THESE
-- two partial unique indexes as the last line of defence against a truly
-- concurrent race that slips past the early-SELECT.
--
-- The `idempotency_key` column is SHARED across all four idempotent flows
-- (DIVIDEND_TO_ADMIN, ADMIN_INCOME, SENIOR_INCOME, DROP_INCOME). This script's
-- two indexes are DISJOINT from every other index on that column: each is
-- scoped to its own `type`, so they never overlap. The ADD COLUMN below is
-- idempotent so this script is safe whether or not any of the earlier
-- idempotency DDL has already run.
--
-- The dev database gets these changes via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push). The prod image does NOT ship drizzle-kit, so prod is
-- migrated with THIS script.
--
-- How to apply
-- ------------
-- From the VPS (or any host with Docker access to the prod stack):
--
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-19_senior_drop_income_idempotency_index.sql
--
-- DevOps wires this file into .github/workflows/deploy.yml (copy step +
-- ON_ERROR_STOP=1 apply step, same shape every other file in this directory
-- uses — see scripts/devops/check-prod-ddl-wiring.py for the guard that fails
-- CI if a manual DDL file is left unreferenced there). apps/api/** is this
-- PR's zone-of-write; .github/workflows/** is DevOps's — the wiring is a
-- separate, coordinated PR/commit, same precedent as
-- 2026-07-14_usdt_income_idempotency_index.sql (wired by a follow-up DevOps
-- commit, not this migration's own PR).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS —
-- safe to re-run.
-- =============================================================================

-- 1. idempotency_key column (shared across all four idempotent flows; no-op if
--    already added by an earlier migration).
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

-- 2. Partial unique index scoped to SENIOR_INCOME — the DB backstop that turns
--    a concurrent duplicate submit into a 23505 (caught + re-read by the
--    service) instead of a second income row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_senior_income_idempotency_key
  ON transactions (idempotency_key)
  WHERE type = 'SENIOR_INCOME' AND idempotency_key IS NOT NULL;

-- 3. Same backstop, scoped to DROP_INCOME.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_drop_income_idempotency_key
  ON transactions (idempotency_key)
  WHERE type = 'DROP_INCOME' AND idempotency_key IS NOT NULL;

-- =============================================================================
-- VERIFY (after applying):
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'transactions'
--      AND indexname IN (
--        'uq_transactions_senior_income_idempotency_key',
--        'uq_transactions_drop_income_idempotency_key'
--      );
-- =============================================================================
--
-- Rollback (feature-level):
--   DROP INDEX IF EXISTS uq_transactions_senior_income_idempotency_key;
--   DROP INDEX IF EXISTS uq_transactions_drop_income_idempotency_key;
--   -- Do NOT drop idempotency_key — it is shared with dividend/admin-income.
-- =============================================================================
