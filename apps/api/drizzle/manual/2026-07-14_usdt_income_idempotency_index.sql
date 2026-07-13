-- =============================================================================
-- ADMIN_INCOME idempotency backstop — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- Security-review PR #367 (MED-1). `POST /api/finance/usdt-income`
-- (declareUsdtProjectIncome) had no idempotency key: a double-submit (double
-- click / network retry) created TWO ADMIN_INCOME rows + TWO sets of company
-- obligations (senior / drop shares). The fix mirrors the dividend BIZ-19
-- (MED-2) contract 1:1 — client-supplied UUID, early-SELECT replay guard, key
-- persisted on insert, and THIS partial unique index as the last line of
-- defence against a truly concurrent race that slips past the early-SELECT.
--
-- The `idempotency_key` column is SHARED with the dividend flow (BIZ-19). This
-- index is DISJOINT from `uq_transactions_dividend_idempotency_key`: both key
-- the same column but on a different, mutually-exclusive `type`, so they never
-- overlap. The ADD COLUMN below is idempotent so this script is safe whether or
-- not the dividend DDL has already run.
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
--     < apps/api/drizzle/manual/2026-07-14_usdt_income_idempotency_index.sql
--
-- Add this file to .github/workflows/deploy.yml ("Pull, up, migrate,
-- health-check" step, Step 2b) and apply it BEFORE the new image serves
-- traffic. DevOps owns that wiring — this PR only ships the script + the note.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS —
-- safe to re-run.
-- =============================================================================

-- 1. idempotency_key column (shared with dividend BIZ-19; no-op if already added).
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

-- 2. Partial unique index scoped to ADMIN_INCOME — the DB backstop that turns a
--    concurrent duplicate submit into a 23505 (caught + re-read by the service)
--    instead of a second income + duplicated obligations.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_admin_income_idempotency_key
  ON transactions (idempotency_key)
  WHERE type = 'ADMIN_INCOME' AND idempotency_key IS NOT NULL;

-- =============================================================================
-- VERIFY (after applying):
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'transactions'
--      AND indexname = 'uq_transactions_admin_income_idempotency_key';
-- =============================================================================
--
-- Rollback (feature-level):
--   DROP INDEX IF EXISTS uq_transactions_admin_income_idempotency_key;
--   -- Do NOT drop idempotency_key — it is shared with the dividend flow.
-- =============================================================================
