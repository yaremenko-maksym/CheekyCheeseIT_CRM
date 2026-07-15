-- =============================================================================
-- Settle-phantom cleanup — prod DATA-FIX (manual apply, NOT auto-wired)
-- =============================================================================
--
-- Context
-- -------
-- ADR 2026-07-14 (docs/architecture/2026-07-14-settle-transition-in-place.md).
-- Before the "settle-in-place" fix, closing a COMPANY debt via `settleByCompany`
-- INSERTED a SECOND transaction (SENIOR_INCOME / PAYOUT_DROP, PAID) and left the
-- SOURCE IOU row (SENIOR_PENDING_PAYOUT / DROP_PENDING_PAYOUT) hanging FOREVER in
-- status=PENDING_PAYMENT — a phantom «Ожидает выплаты» row with a live «Выплатить»
-- button. The obligation itself is already PAID and `closing_transaction_id`
-- points at the settle row.
--
-- The new code transitions the SAME row in place (no second tx). This script
-- retro-fits the ALREADY-hung prod pairs to the new single-row model so the
-- phantom «Ожидает выплаты» rows disappear.
--
-- IMPORTANT — this is COSMETIC / UX, NOT money-critical
-- ----------------------------------------------------
-- The ledger on prod is ALREADY correct: a phantom `*_PENDING_PAYOUT` row is not
-- part of ANY money term (company-account ledger, drop aggregate, C4 income), and
-- a repeat settle is already blocked (obligation is PAID → 404). So this can run
-- AFTER the code deploy, without a freeze. It removes the phantom rows + button.
--
-- WARNING — DELETEs prod rows. NOT auto-applied on deploy.
-- --------------------------------------------------------
-- Unlike the schema DDL scripts in this folder, this file is INTENTIONALLY NOT
-- listed in .github/workflows/deploy.yml. Applying it is a deliberate,
-- security-reviewed, manual DevOps action:
--   1. Run STEP 0 (DRY-RUN) and sanity-check the count against the expected
--      number of hung pairs (≈ 28 as of 2026-07-15: 21 senior + 7 drop).
--   2. Run STEP 1 (BACKUP) — snapshots the phantom rows into a backup table so
--      the DELETE is recoverable.
--   3. Run STEP 2 (the transaction) — repoint + delete, with the pre-COMMIT
--      verification. COMMIT only if the verify count is 0 and the dry-run matched.
-- Everything is IDEMPOTENT: pairs already collapsed by the new code have
-- source_transaction_id = closing_transaction_id and are skipped, so a re-run is
-- a safe no-op.
--
-- Security-review fix (round 1, MED): STEP 2b's DELETE now additionally requires
-- `EXISTS (SELECT 1 FROM _settle_phantom_backup_20260715 b WHERE b.id = t.id)` —
-- i.e. it deletes ONLY rows STEP 1 actually backed up. Previously 2b's guard
-- ("nothing references this row") was broader than STEP 1's backup scope
-- ("rows belonging to a PAID obligation with closing≠source"): a hypothetical
-- orphan IOU matching 2b's predicate but NOT part of a hung-settle pair could
-- have been deleted with no recoverable copy. Verified on crm_qa: a synthetic
-- orphan row (no obligation ever pointed at it) is correctly left untouched —
-- only the true hung-pair phantom (present in the backup) is deleted.
--
-- How to apply (manual, from the VPS with Docker access to the prod stack)
-- -----------------------------------------------------------------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-07-15_settle_phantom_cleanup.sql
--
-- (Or run the STEPs interactively to eyeball each gate — recommended.)
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 0 — DRY-RUN. How many phantom pairs will collapse? Sanity-check first.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT o.id            AS obligation_id,
       o.source_transaction_id AS phantom_id,
       o.closing_transaction_id AS settlement_id,
       src.type        AS phantom_type,
       src.amount      AS phantom_amount
FROM pending_obligations o
JOIN transactions src ON src.id = o.source_transaction_id
WHERE o.status = 'PAID'
  AND o.closing_transaction_id IS NOT NULL
  AND o.closing_transaction_id <> o.source_transaction_id
  AND src.type IN ('SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT')
  AND src.status = 'PENDING_PAYMENT';

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — BACKUP the phantom rows before deleting (recoverable rollback).
--          Idempotent: CREATE IF NOT EXISTS + only inserts not-yet-backed rows.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS _settle_phantom_backup_20260715 (LIKE transactions INCLUDING ALL);

INSERT INTO _settle_phantom_backup_20260715
SELECT t.*
FROM transactions t
JOIN pending_obligations o ON o.source_transaction_id = t.id
WHERE o.status = 'PAID'
  AND o.closing_transaction_id IS NOT NULL
  AND o.closing_transaction_id <> o.source_transaction_id
  AND t.type IN ('SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT')
  AND t.status = 'PENDING_PAYMENT'
  AND NOT EXISTS (SELECT 1 FROM _settle_phantom_backup_20260715 b WHERE b.id = t.id);

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 — PRIMARY fix: repoint the obligation to the settlement row, then delete
--          the phantom IOU. Wrapped in one transaction with a pre-COMMIT verify.
--          Bring the old pairs to the new single-row model
--          (source_transaction_id = closing_transaction_id = one row).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- 2a) Repoint source_transaction_id → the settlement row. This releases the
--     FK 'restrict' on the phantom (pending_obligations.source_transaction_id).
--     The obligation is PAID, so uq_pending_obligations_source_pending
--     (WHERE status='PENDING') is not touched.
UPDATE pending_obligations o
SET source_transaction_id = o.closing_transaction_id,
    updated_at = now()
FROM transactions src
WHERE src.id = o.source_transaction_id
  AND o.status = 'PAID'
  AND o.closing_transaction_id IS NOT NULL
  AND o.closing_transaction_id <> o.source_transaction_id
  AND src.type IN ('SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT')
  AND src.status = 'PENDING_PAYMENT';

-- 2b) Delete the now-orphaned phantom IOU. Guarded: only when NOTHING references
--     it (source_transaction_id was repointed above; closing_transaction_id never
--     pointed at a phantom; a PENDING IOU has no invoice signature) AND — the
--     security-review fix (round 1, MED) — only when the row was ACTUALLY backed
--     up in STEP 1. Without this last guard, a hypothetical orphan IOU that
--     matches the "nothing references it" predicate but was NOT one of the
--     hung-settle pairs STEP 1 targeted (e.g. some other unforeseen orphan) could
--     be deleted with no backup to recover from. STEP 1's INSERT and this
--     DELETE now share the EXACT SAME row set by construction (STEP 1 backs up
--     precisely the hung-pair phantoms; this only deletes rows present in that
--     backup), so nothing is ever deleted without a recoverable copy.
DELETE FROM transactions t
WHERE t.type IN ('SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT')
  AND t.status = 'PENDING_PAYMENT'
  AND NOT EXISTS (SELECT 1 FROM pending_obligations o WHERE o.source_transaction_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM pending_obligations o WHERE o.closing_transaction_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM invoice_signatures s WHERE s.transaction_id = t.id)
  AND EXISTS (SELECT 1 FROM _settle_phantom_backup_20260715 b WHERE b.id = t.id);

-- 2c) VERIFY before COMMIT — must be 0. If not, ROLLBACK and investigate.
SELECT count(*) AS remaining_phantoms
FROM pending_obligations o
JOIN transactions src ON src.id = o.source_transaction_id
WHERE o.status = 'PAID'
  AND src.type IN ('SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT')
  AND src.status = 'PENDING_PAYMENT';  -- expected: 0

COMMIT;  -- only if remaining_phantoms = 0 AND the STEP 0 dry-run count matched.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3 (optional) — drop the backup once the fix is confirmed good on prod.
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS _settle_phantom_backup_20260715;

-- =============================================================================
-- FALLBACK (zero-delete) — use ONLY if prod-DELETE is vetoed.
-- =============================================================================
-- Neutralises the phantom's status (no delete / no repoint). Removes the
-- «Ожидает выплаты» label + «Выплатить» button (both gate on status=PENDING_PAYMENT).
-- Money-safe (a PAID *_PENDING_PAYOUT is in no money term) but leaves TWO PAID
-- rows historically (does NOT reach the single-row model). Not run by default.
--
--   UPDATE transactions t
--   SET status = 'PAID', updated_at = now()
--   FROM pending_obligations o
--   WHERE o.source_transaction_id = t.id
--     AND o.status = 'PAID'
--     AND t.type IN ('SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT')
--     AND t.status = 'PENDING_PAYMENT';
-- =============================================================================
