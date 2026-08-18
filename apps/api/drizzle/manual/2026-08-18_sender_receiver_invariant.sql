-- =============================================================================
-- transactions: sender_id <> receiver_id invariant — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-sender-receiver-invariant (backlog A-2). Financial audit found: nothing
-- anywhere forbids a `transactions` row that pays a user to themselves — no
-- DB CHECK (unlike the receipt-fields XOR CHECK from an older migration), no
-- Zod `.refine`, no service-layer guard. The system stayed intact only by
-- accident: the one legacy write path that could produce such a row was
-- deleted, and `bookCompanyObligations` (transactions.service.ts) simply
-- never fills `senderId` for the obligation rows it writes. A self-paying row
-- has already happened once in prod (an artifact of that deleted path) and
-- cost a real investigation — two readers disagreed on the numbers it
-- produced, and it took an owner decision to determine which reading was
-- correct.
--
-- Unblocked 2026-08-17: the owner ran this exact check against prod TWICE
-- (once with a join to `users`, once without) and confirmed ZERO existing
-- rows with `sender_id = receiver_id`. This migration was blocked before that
-- confirmation — the constraint cannot go on top of corrupted rows.
--
-- Why `<>` and NOT `IS DISTINCT FROM` (verified on a scratch DB, not assumed)
-- -----------------------------------------------------------------------------
-- SQL three-valued logic: `sender_id <> receiver_id` evaluates to NULL (not
-- FALSE) whenever either side is NULL, and a CHECK constraint only rejects an
-- explicit FALSE — NULL passes. So `<>` allows every row where one or both
-- sides are empty, which is the overwhelmingly common case here (most
-- `transactions` rows use `senderLabel`/`receiverLabel` string markers
-- instead of a real user FK on one or both sides).
--
-- `sender_id IS DISTINCT FROM receiver_id` looks like the "NULL-safe" choice
-- but is WRONG for this table: `NULL IS DISTINCT FROM NULL` evaluates to
-- FALSE, so that variant would REJECT every legitimate both-NULL row — and
-- there are many (any row where neither side ever carried a user FK).
--
-- Both branches were reproduced by hand on a scratch database before writing
-- this file — see the four-case proof (both filled+different passes, both
-- filled+equal rejected, one NULL passes, both NULL passes) in the task PR
-- body / `.claude/tasks/task-sender-receiver-invariant.md`.
--
-- The dev database gets this change via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push reads the `check()` clause added to `transactions` in
-- schema.ts). The prod image does NOT ship drizzle-kit, so prod is migrated
-- with THIS script.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-18_sender_receiver_invariant.sql
--
-- Idempotent: the ADD CONSTRAINT is guarded by a `pg_constraint` catalog
-- check inside a DO block (Postgres has no `ADD CONSTRAINT IF NOT EXISTS`
-- syntax for CHECK constraints — verified directly: `ALTER TABLE t ADD
-- CONSTRAINT IF NOT EXISTS …` is a syntax error on Postgres 16). Safe to
-- re-run any number of times, on every deploy, forever. Also verified by hand
-- on the scratch DB: dropping the constraint and re-running this script
-- re-adds it; running it again with the constraint already present is a
-- silent no-op — neither path errors.
--
-- A validation SELECT runs first and aborts loudly (this script runs with
-- `-v ON_ERROR_STOP=1`) if any self-paying row exists, instead of letting the
-- ADD CONSTRAINT fail with Postgres's much less actionable
-- "check constraint is violated by some row" error.
-- =============================================================================

DO $$
DECLARE
  bad_row_count integer;
BEGIN
  SELECT count(*) INTO bad_row_count
  FROM transactions
  WHERE sender_id IS NOT NULL
    AND receiver_id IS NOT NULL
    AND sender_id = receiver_id;

  IF bad_row_count > 0 THEN
    RAISE EXCEPTION
      'ABORT: % transactions row(s) have sender_id = receiver_id — the '
      'sender/receiver invariant CHECK constraint cannot be added on top of '
      'them. This migration was unblocked 2026-08-17 on the assumption of '
      'zero such rows (owner-verified twice); investigate before re-running.',
      bad_row_count;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_transactions_sender_ne_receiver'
      AND conrelid = 'transactions'::regclass
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT ck_transactions_sender_ne_receiver
      CHECK (sender_id <> receiver_id);
  END IF;
END $$;

-- =============================================================================
-- VERIFY (after applying):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'transactions'::regclass
--      AND conname = 'ck_transactions_sender_ne_receiver';
--   -- expect: CHECK ((sender_id <> receiver_id))
-- =============================================================================
--
-- Rollback (feature-level; only if this invariant is being reverted entirely):
--   ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_sender_ne_receiver;
-- =============================================================================
