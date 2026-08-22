-- =============================================================================
-- Settled-amount snapshot columns on transactions — prod DDL (manual apply)
-- task-settled-amount-snapshot (Task 1 of the paid-transaction-edit-cascade
-- decomposition — docs/architecture/2026-08-22-paid-transaction-edit-cascade.md,
-- AC3 "Где хранится «сколько уже выплачено»").
-- =============================================================================
--
-- Context
-- -------
-- The owner decided: editing the amount of an already-settled income must
-- return its paid derivative(s) to PENDING for a fresh confirmation, and that
-- row must show "how much of it is already paid" so the operator can see the
-- remaining difference. Today there is nowhere to read that number from —
-- three independent reasons, all verified against `origin/main` before this
-- migration was written (AC1 of the task file):
--   1. `settleByCompany` DELIBERATELY nulls `seniorSharePercent`/
--      `dropSharePercent` on the flip (pending-settlement.service.ts, the
--      CRITICAL comment there) — a non-null value there is read as a
--      GROSS↔NET discriminator elsewhere and would under-count the senior by
--      ~26x. Exactly the row that would need the percent to recompute a
--      share has it erased.
--   2. `transaction_audit_log`'s `PAY` entry is best-effort, written AFTER
--      the settle transaction commits — its own failure is only logged
--      (pending-settlement.service.ts, "a logging hiccup must not turn a
--      successful settlement into a 500"). A log that can silently miss a
--      real payment is not a source for money.
--   3. `pending_obligations` stores the OBLIGATION amount, never "how much of
--      it has closed" — closure is modelled wholesale via `status` +
--      `closing_transaction_id`; there is no partial-payment concept there.
--
-- This migration adds three columns to `transactions`, written together by
-- `PendingSettlementService.settleByCompany` at the same flip that already
-- nulls the share-percent columns above:
--   settled_amount        — MONOTONIC accumulator: the sum of every actual
--                            payout this row has ever settled. Increments on
--                            every settle, never decreases, never gets
--                            overwritten. "К доплате" is deliberately NOT
--                            stored — it is `amount − settled_amount`,
--                            computed by a reader — the same "store the
--                            immutable member, derive the mutable one"
--                            contract `original_amount`/`exchange_rate`
--                            already use on this row.
--   settled_currency       — the currency of the settle(s) accumulated above.
--                            A separate column because a DROP obligation can
--                            be settled in a currency OTHER than its own
--                            (USDT) — settleByCompany converts via NBU and
--                            writes the FACT in the payment currency. One
--                            number with no currency label would already be
--                            wrong.
--   settled_share_percent  — a snapshot of whichever of
--                            senior_share_percent/drop_share_percent was on
--                            this row immediately before this settle nulled
--                            it. Overwritten fresh on every settle (unlike
--                            settled_amount, only the latest percent is
--                            meaningful here).
--
-- There is no READER of these three columns yet — the cascade that returns a
-- derivative to PENDING and needs "already paid" to show a diff is a LATER
-- task in the same decomposition (tasks 2-3). This migration is pure
-- infrastructure: write-only, by design (see the task file — "здесь только
-- запись снимка; читателей у него пока нет, и это нормально").
--
-- REQUIRED companion step — re-apply the `non_deleted_transactions` view.
-- ------------------------------------------------------------------------
-- `non_deleted_transactions` (2026-08-03_non_deleted_transactions_view.sql)
-- is `CREATE OR REPLACE VIEW ... AS SELECT * FROM transactions WHERE
-- deleted_at IS NULL`. Postgres does NOT retroactively add a newly-created
-- base-table column to an EXISTING view — even a `SELECT *` one — until the
-- view is explicitly re-applied (same gotcha documented, and hit on crm_qa,
-- by 2026-08-12_drop_obligation_company_name_snapshot.sql's own header).
--
-- Apply order on EVERY environment (dev/crm_qa/prod), always both, always in
-- this order:
--   1. THIS file (adds the three columns to the base table).
--   2. apps/api/drizzle/manual/2026-08-03_non_deleted_transactions_view.sql
--      (re-`CREATE OR REPLACE VIEW` — picks the new columns up because it is
--      `SELECT *`).
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-22_settled_amount_snapshot.sql
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-03_non_deleted_transactions_view.sql
--
-- Wired into `.github/workflows/deploy.yml` in THIS SAME PR (copy step in
-- copy-compose + fail-loud apply step, including the view re-apply, in
-- deploy — both unconditional). `.github/workflows/**` is normally DevOps's
-- zone-of-write, not Coder's — this is the same deliberate, task-file-
-- sanctioned exception PR #590/#598 already established for
-- 2026-08-21_pending_obligations_payout_request_id.sql (same-PR shape, not a
-- follow-up DevOps PR). Safe to leave wired permanently — every statement
-- below is idempotent.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS`, safe to re-run any number of times,
-- on every deploy, forever. NULLABLE, NO DEFAULT, NO BACKFILL of historical
-- rows by design — every row created before this migration keeps NULL in all
-- three columns; that is the literal truth (it never went through the
-- settle-snapshot mechanism).
-- =============================================================================

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS settled_amount numeric(18, 6);

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS settled_currency currency;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS settled_share_percent integer;

DO $$
BEGIN
  RAISE NOTICE 'settled-amount-snapshot: settled_amount/settled_currency/settled_share_percent present on transactions (nullable, no backfill by design)';
END $$;

-- =============================================================================
-- VERIFY (after applying THIS file AND the view re-apply above):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'transactions'
--       AND column_name IN ('settled_amount', 'settled_currency', 'settled_share_percent');
--   -- must return all three rows.
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'non_deleted_transactions'
--       AND column_name IN ('settled_amount', 'settled_currency', 'settled_share_percent');
--   -- must ALSO return all three rows, once the view has been re-applied.
-- =============================================================================
--
-- Rollback (feature-level; only if this feature is being reverted entirely):
--   ALTER TABLE transactions DROP COLUMN IF EXISTS settled_amount;
--   ALTER TABLE transactions DROP COLUMN IF EXISTS settled_currency;
--   ALTER TABLE transactions DROP COLUMN IF EXISTS settled_share_percent;
--   -- then re-apply 2026-08-03_non_deleted_transactions_view.sql once more so
--   -- the view drops the columns too.
-- =============================================================================
