-- =============================================================================
-- transactions soft-delete columns — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-soft-delete-and-money-audit (security-audit finding 3, 27.07 + direct
-- owner requirement). Deleting a transaction today is HARD — the row
-- physically disappears with no trace. For a system that computes shares,
-- payouts and salaries, that means a mistaken or bad-faith delete is
-- unrecoverable AND unprovable. This migration adds the three columns
-- `adminDeleteTransaction` (apps/api/src/finance/transactions.service.ts) now
-- stamps instead of running `DELETE FROM transactions`, plus a `restoreTransaction`
-- counterpart (ADMIN-only) that clears them.
--
-- Owner requirement (27.07, verbatim by sense): "удалённые транзакции видны
-- только админу или бухгалтеру, и сразу не видны в общем списке транзакций."
--   - `deleted_at`       — NULL = active row. Set = soft-deleted.
--   - `deleted_by`       — who deleted it (ADMIN only can delete).
--   - `deletion_reason`  — MANDATORY at delete time (enforced by
--                          `deleteTransactionSchema` in @crm/shared, not by a
--                          DB constraint — a NOT NULL here would also reject
--                          every PRE-EXISTING row's implicit NULL, which is
--                          exactly what "no reason on old rows" should mean).
--
-- All three are set/cleared together — never independently — by
-- `adminDeleteTransaction` / `restoreTransaction`.
--
-- The dev database gets this change via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push). The prod image does NOT ship drizzle-kit, so prod is
-- migrated with THIS script.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-01_transaction_soft_delete.sql
--
-- DEPENDENCY (DevOps zone, NOT wired by this PR): add this file to
-- .github/workflows/deploy.yml's migrate step (copy the pattern used for
-- e.g. 2026-07-14_transaction_audit_log.sql — scp source: list entry +
-- fail-loud apply step BEFORE the new api image serves traffic). Until that
-- wiring lands, `scripts/devops/check-prod-ddl-wiring.py` (run in ci.yml) will
-- correctly flag this file as unwired — that is expected, not a bug in this
-- PR; the task's own instructions call this out as a DevOps-owned follow-up.
-- Coder does not touch `.github/workflows/**` (zone-of-write).
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` —
-- safe to re-run any number of times, on every deploy, forever.
-- =============================================================================

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS deletion_reason varchar(500);

-- Supports the `WHERE deleted_at IS NULL` predicate every hot read now
-- carries (findAll's default list + every balance/summary aggregate).
CREATE INDEX IF NOT EXISTS idx_transactions_active_created_at
  ON transactions (created_at)
  WHERE deleted_at IS NULL;

-- =============================================================================
-- VERIFY (after applying):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'transactions'
--      AND column_name IN ('deleted_at', 'deleted_by', 'deletion_reason');
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'transactions' AND indexname = 'idx_transactions_active_created_at';
-- =============================================================================
--
-- Rollback (feature-level; loses any recorded deletions — only if this
-- feature is being reverted entirely, not for routine ops):
--   DROP INDEX IF EXISTS idx_transactions_active_created_at;
--   ALTER TABLE transactions DROP COLUMN IF EXISTS deletion_reason;
--   ALTER TABLE transactions DROP COLUMN IF EXISTS deleted_by;
--   ALTER TABLE transactions DROP COLUMN IF EXISTS deleted_at;
-- =============================================================================
