-- =============================================================================
-- pending_obligations.payout_request_id — durable payout link (prod DDL, manual apply)
-- =============================================================================
--
-- Context
-- -------
-- Backlog 74/B-1 (task-settle-payout-link-lost). `PendingSettlementService
-- .settleByCompany` (task-settle-in-place ADR, 2026-07-14) flips a cascade-
-- booked obligation's source IOU row IN PLACE and deliberately resets ITS
-- `transactions.payout_request_id` to NULL on the flip — keeping it would
-- bleed the settled row into `autoCreateForPayout`'s payoutRequestId
-- aggregation and the `findOne` SENIOR_INCOME-by-payoutRequestId enrichment
-- (see the CRITICAL comment in pending-settlement.service.ts). That reset is
-- correct and stays untouched by this migration.
--
-- But `pending_obligations` never stored `payout_request_id` at all, and the
-- only surviving link after settle was the self-referential
-- `closing_transaction_id` plus free-text `notes`. Consequence: a payout's
-- detail read (`TransactionsService.findPayoutRequest`) — which resolves
-- "obligations that arose from this payout" via the LIVE
-- `transactions.payout_request_id` column — silently drops a settled
-- obligation from that view the moment it is paid off. The payout looks like
-- it produced zero senior/drop obligations, even though the money is
-- correct (aggregates dedupe via `closing_transaction_id`, unaffected).
--
-- Fix: a SEPARATE, durable column on `pending_obligations`, stamped ONCE at
-- booking time (`TransactionsService.bookCompanyObligations`) from the SAME
-- `payoutRequestId` the source IOU transaction receives, and NEVER touched
-- by settle. `findPayoutRequest` now also resolves obligations via this
-- column (through `source_transaction_id`, which keeps pointing at the
-- obligation's current — possibly flipped — row under task-settle-in-place),
-- recovering exactly the rows the live-relation query drops after settle.
--
-- Informational only, never a security/money gate — nothing in this repo
-- branches on this column's value the way `drop_cascade_origin` does, so
-- there is no fail-safe-default concern here and no need for that column's
-- elaborate self-referential cutover machinery. `ON DELETE SET NULL` mirrors
-- `transactions.payout_request_id`'s own FK behaviour: a future
-- `payout_requests` cleanup nulling it only degrades a display, never money.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-21_pending_obligations_payout_request_id.sql
--
-- DevOps owns wiring this into `.github/workflows/deploy.yml` (copy +
-- apply steps, same precedent as PR #571 for
-- 2026-08-18_sender_receiver_invariant.sql) — this PR does not touch
-- `.github/workflows/**` (zone-of-write: apps/api/** is Coder's,
-- .github/workflows/** is DevOps's). Safe to leave wired permanently —
-- every statement below is idempotent.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and
-- the backfill UPDATE only ever touches rows still matching
-- `payout_request_id IS NULL` (once backfilled, a row no longer matches) —
-- safe to re-run any number of times, on every deploy, forever.
-- =============================================================================

-- ── Schema: add the column (nullable, no default — matches
--             transactions.payout_request_id's own shape). ─────────────────
ALTER TABLE pending_obligations
  ADD COLUMN IF NOT EXISTS payout_request_id uuid
    REFERENCES payout_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pending_obligations_payout_request
  ON pending_obligations (payout_request_id);

-- ── Backfill: an obligation still PENDING (not yet settled) still carries
--             the link on its source transaction — settleByCompany only
--             resets it AT settle time — so recover it for free, for every
--             environment this migration runs on (dev/qa/prod alike).
--             Obligations already PAID before this migration cannot be
--             recovered (the link was already lost before this fix existed)
--             — out of scope per the backlog item (representation-only bug,
--             no money to reconstruct, and no reliable source left to read
--             it from). Logged via RAISE NOTICE so the deploy log shows
--             exactly how many rows this pass touched (0 is a valid,
--             expected outcome on every deploy after the first). ──────────
DO $$
DECLARE
  v_backfilled integer;
BEGIN
  UPDATE pending_obligations o
  SET payout_request_id = t.payout_request_id
  FROM transactions t
  WHERE o.source_transaction_id = t.id
    AND o.payout_request_id IS NULL
    AND o.status = 'PENDING'
    AND t.payout_request_id IS NOT NULL;

  GET DIAGNOSTICS v_backfilled = ROW_COUNT;
  RAISE NOTICE 'pending-obligations-payout-request-id: backfilled=% still-PENDING obligation row(s) from their source transaction', v_backfilled;
END $$;
