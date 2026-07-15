-- =============================================================================
-- transaction_audit_log — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-receipts-backend. The generic `PATCH /api/transactions/:id/receipt`
-- attach/replace endpoint records every receipt mutation (ATTACH | REPLACE) in
-- a new audit table. Mirrors the existing *_audit_log tables (user/team/project)
-- with two deliberate differences:
--
--   1. `target_id` (the transactions.id) has NO FK reference — an audit trail
--      must OUTLIVE the row it describes. Deleting a transaction must not erase
--      the record that a receipt was attached/replaced on it.
--   2. `metadata` (jsonb) instead of `changes` — carries { oldDocId, oldExtUrl,
--      newDocId, newExtUrl, receiptKind } for the mutation.
--
-- `actor_id` → users(id) ON DELETE SET NULL (keep the audit if the actor is
-- later removed).
--
-- The dev database gets this change via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push). The prod image does NOT ship drizzle-kit, so prod is
-- migrated with THIS script.
--
-- How to apply
-- ------------
-- From the VPS (or any host with Docker access to the prod stack):
--
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-07-14_transaction_audit_log.sql
--
-- Add this file to .github/workflows/deploy.yml ("Pull, up, migrate,
-- health-check" step, Step 2b) and apply it BEFORE the new image serves
-- traffic. DevOps owns that wiring — this PR only ships the script + the note.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS — safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS transaction_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_id uuid NOT NULL,               -- transactions.id (no FK — audit survives tx delete)
  action text NOT NULL,                  -- 'ATTACH' | 'REPLACE'
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transaction_audit_log_target_id_idx
  ON transaction_audit_log (target_id);

CREATE INDEX IF NOT EXISTS transaction_audit_log_created_at_idx
  ON transaction_audit_log (created_at);

-- =============================================================================
-- VERIFY (after applying):
--   SELECT to_regclass('public.transaction_audit_log');           -- not null
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'transaction_audit_log';
-- =============================================================================
--
-- Rollback (feature-level):
--   DROP TABLE IF EXISTS transaction_audit_log;
-- =============================================================================
