-- =============================================================================
-- Drop-share pending-parity backfill — prod DATA-FIX (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-drop-share-pending-parity (owner rule, 2026-07-27): a drop's share of
-- income must never be credited straight away — it is booked as a PENDING
-- COMPANY obligation and only becomes PAID when an ADMIN/ACCOUNTANT settles it
-- with a receipt + funding source (`PendingSettlementService.settleByCompany`).
--
-- Before this task's code fix, TWO code paths booked a drop's share:
--   Path A (declareUsdtProjectIncome, admin-declared USDT income) — already
--     compliant: books DROP_PENDING_PAYOUT (PENDING_PAYMENT) + a paired
--     pending_obligations row, closed later via settleByCompany.
--   Path B (applyPayoutPaidCascade, the drop's OWN self-service payout
--     confirmation) — bypassed the rule: inserted PAYOUT_DROP directly with
--     status='PAID', no receipt, no pending_obligations row.
-- The code fix in this PR routes Path B through the SAME bookCompanyObligations
-- helper Path A already uses. This script retro-fits Path B's HISTORICAL rows
-- to the state Path A would have created them in, so they can be confirmed
-- (settled) retroactively instead of staying silently instant-paid forever.
--
-- Selection predicate — BY ORIGIN, not by "missing receipt"
-- -----------------------------------------------------------
-- Target: type = 'PAYOUT_DROP' AND status = 'PAID' AND payout_request_id IS
-- NOT NULL.
--
-- `payout_request_id` is the origin discriminator, NOT the absence of a
-- receipt. `settleByCompany`'s in-place flip (task-settle-in-place, ADR
-- 2026-07-14) explicitly RESETS `payout_request_id` to NULL when it closes an
-- obligation — see the "CRITICAL (ADR)" comment in pending-settlement.service.ts
-- — precisely so a settled row never bleeds into `payoutRequestId`-keyed
-- aggregations. A LEGACY closing route (settling a pre-refactor obligation with
-- NO funding/receipt at all — see the removed 2-segment
-- `:id/settle-company` route, task-receipts-backend review round 1) ALSO
-- produced PAYOUT_DROP/PAID rows with NO receipt, but with
-- payout_request_id = NULL (already reset by the closing flip). Selecting by
-- "no receipt" would sweep those already-honestly-closed legacy debts back
-- into PENDING — re-opening debts that were correctly paid. Selecting by
-- `payout_request_id IS NOT NULL` instead hits ONLY the cascade-originated
-- (Path B) rows, which is exactly what this task's owner-approved backfill
-- targets.
--
-- What "equivalent to a freshly-created IOU" means (fields read by the code)
-- -----------------------------------------------------------------------------
-- `settleByCompany` + the company/drop balance derivations
-- (company-account-balance.ts, computeDropAggregate / getDropSelfSummary) only
-- read: `transactions.type` (drop-vs-senior discriminator via
-- `resolveSource`), `transactions.status` (`= 'PENDING_PAYMENT'` — the flip's
-- WHERE-guard), and the PAIRED `pending_obligations` row (creditor_user_id,
-- debtor_type='COMPANY', source_transaction_id, amount, currency,
-- status='PENDING' — WITHOUT this row `settleByCompany` can never find the
-- obligation to close, and the row hangs pending forever). `amount`,
-- `currency`, `receiver_id`/`recipient_id`, `sender_id`/`sender_label`,
-- `project_id`, `created_by` are UNTOUCHED by this script — the historical
-- PAYOUT_DROP insert already stamped them identically to how
-- bookCompanyObligations stamps a fresh DROP_PENDING_PAYOUT (senderId=null,
-- senderLabel='COMPANY', receiverId/recipientId=drop). `drop_share_percent` /
-- `drop_share_percent_source` are LEFT NULL — the historical cascade never
-- stamped a snapshot on PAYOUT_DROP either, and neither field is read by
-- balance/settle code (only by the live cascade's OWN distribution math at
-- booking time, which this backfill does not re-run) — NULL here is the same
-- "no snapshot" state the codebase already handles everywhere else with a
-- `?? resolveDropShare(...)` fallback (see transactions.service.ts).
-- `txHash` is intentionally left as-is (audit trail of the ORIGINAL on-chain
-- confirm) even though a freshly-booked DROP_PENDING_PAYOUT never carries one —
-- it is not read by settleByCompany or any balance derivation, so its presence
-- here is harmless and keeps the pre-existing audit link.
--
-- Balance impact (expected, and visible to people)
-- ---------------------------------------------------
-- After this backfill, each affected drop's aggregate balance
-- (`computeDropAggregate` / `getDropSelfSummary`) DECREASES by the sum of the
-- converted rows' amounts, until an ADMIN/ACCOUNTANT settles each one again
-- (which restores the exact same amount — see the round-trip test in
-- `drop-payout-company-account.integration.spec.ts`, INV2b-style assertion).
-- Per the code comment in `applyPayoutPaidCascade` at the time of this fix,
-- PROD carried **zero** PAYOUT_DROP rows (task-drop-share-override-and-receiver
-- Audit 2026-06-28 (#3) notes "PROD has 0 PAYOUT_DROP rows"), so this backfill
-- is EXPECTED to be a no-op on prod — but the script still runs and asserts,
-- because "expected zero" is not a substitute for verifying zero. STEP 2's
-- RAISE NOTICE prints the exact count so the owner can see it in the deploy log.
--
-- How to apply
-- ------------
-- From the VPS (or any host with Docker access to the prod stack):
--
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-07-27_drop_share_pending_parity_backfill.sql
--
-- Add this file to `.github/workflows/deploy.yml`'s migrate step, applied
-- BEFORE the new api image serves traffic (same slot as the prior manual
-- scripts in this directory). DevOps owns that wiring — this PR only ships the
-- script + this note (see PR body).
--
-- Idempotency
-- -----------
-- The UPDATE's WHERE-predicate is `type = 'PAYOUT_DROP' AND status = 'PAID'
-- AND payout_request_id IS NOT NULL`. Once a row is converted, its type
-- becomes 'DROP_PENDING_PAYOUT' — it no longer matches this predicate, so a
-- re-run of this whole script (STEP 1 backup + STEP 2 convert) finds ZERO
-- target rows on the second pass: 0 backed up, 0 converted, 0 obligations
-- inserted, verify asserts targets=converted=obligations=0, exits 0.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — BACKUP the affected rows BEFORE mutating them (recoverable
--          rollback; this table is NEVER dropped by this script).
--          Idempotent: CREATE IF NOT EXISTS + only inserts not-yet-backed rows.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS _drop_share_pending_parity_backup_20260727 (
  LIKE transactions INCLUDING ALL
);

INSERT INTO _drop_share_pending_parity_backup_20260727
SELECT t.*
FROM transactions t
WHERE t.type = 'PAYOUT_DROP'
  AND t.status = 'PAID'
  AND t.payout_request_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM _drop_share_pending_parity_backup_20260727 b WHERE b.id = t.id
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 — PRIMARY fix, wrapped in ONE transaction with a FAIL-LOUD assert
--          (unattended-safe — this script is applied via a single
--          `psql -v ON_ERROR_STOP=1 < file` invocation, no human in the loop).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- 2.pre) Dry-run count, logged so the deploy-step log shows N before any write
--        happens.
DO $$
DECLARE
  v_dry_run_count integer;
BEGIN
  SELECT count(*) INTO v_dry_run_count
  FROM transactions
  WHERE type = 'PAYOUT_DROP' AND status = 'PAID' AND payout_request_id IS NOT NULL;

  RAISE NOTICE 'drop-share-pending-parity: % Path-B row(s) will be converted to pending', v_dry_run_count;
END $$;

-- 2a) Capture the target id set ONCE, before the UPDATE changes `type` out
--     from under the predicate — every later step (obligation insert, verify)
--     joins against this fixed set instead of re-querying by type/status
--     (which would see nothing once the rows are converted).
DROP TABLE IF EXISTS _dspp_targets;
CREATE TEMP TABLE _dspp_targets AS
SELECT id, receiver_id, amount, currency
FROM transactions
WHERE type = 'PAYOUT_DROP' AND status = 'PAID' AND payout_request_id IS NOT NULL;

-- 2b) Flip the historical Path-B rows into the SAME pending state
--     `bookCompanyObligations` books today: type → DROP_PENDING_PAYOUT,
--     status → PENDING_PAYMENT. Every other column (amount, currency,
--     sender/receiver, project, createdBy, txHash) is left untouched — see the
--     header note on field equivalence.
UPDATE transactions
SET type = 'DROP_PENDING_PAYOUT',
    status = 'PENDING_PAYMENT',
    updated_at = now()
WHERE id IN (SELECT id FROM _dspp_targets);

-- 2c) The PAIRED pending_obligations row — WITHOUT this, settleByCompany can
--     never see the row (it queries pending_obligations, not transactions
--     directly) and the flipped IOU hangs in PENDING forever with nothing able
--     to close it. Guarded by NOT EXISTS (defensive — the uq_pending_
--     obligations_source_pending partial-unique index would reject a
--     duplicate anyway) so a target that implausibly already has a PENDING
--     obligation is skipped rather than erroring.
INSERT INTO pending_obligations
  (creditor_user_id, debtor_type, debtor_user_id, source_transaction_id, amount, currency, status)
SELECT tgt.receiver_id, 'COMPANY', NULL, tgt.id, tgt.amount, tgt.currency, 'PENDING'
FROM _dspp_targets tgt
WHERE tgt.receiver_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pending_obligations o WHERE o.source_transaction_id = tgt.id
  );

-- 2d) FAIL-LOUD verify: the number of rows actually converted (now
--     DROP_PENDING_PAYOUT/PENDING_PAYMENT) AND the number of paired PENDING
--     COMPANY obligations booked must BOTH equal the number of rows selected
--     in 2a — else RAISE EXCEPTION aborts this DO block, which aborts the
--     enclosing transaction (COMMIT below is never reached), and — because
--     psql runs with -v ON_ERROR_STOP=1 — the whole script/deploy step exits
--     non-zero instead of silently leaving a partial conversion.
DO $$
DECLARE
  v_targets integer;
  v_converted integer;
  v_obligations integer;
BEGIN
  SELECT count(*) INTO v_targets FROM _dspp_targets;

  SELECT count(*) INTO v_converted
  FROM transactions t
  JOIN _dspp_targets tgt ON tgt.id = t.id
  WHERE t.type = 'DROP_PENDING_PAYOUT' AND t.status = 'PENDING_PAYMENT';

  SELECT count(*) INTO v_obligations
  FROM pending_obligations o
  JOIN _dspp_targets tgt ON tgt.id = o.source_transaction_id
  WHERE o.status = 'PENDING' AND o.debtor_type = 'COMPANY';

  IF v_converted <> v_targets OR v_obligations <> v_targets THEN
    RAISE EXCEPTION 'drop-share-pending-parity verify failed: targets=%, converted=%, obligations=% (all three must match)',
      v_targets, v_converted, v_obligations;
  END IF;

  RAISE NOTICE 'drop-share-pending-parity: verify passed — % row(s) converted + paired obligation booked (targets=converted=obligations)', v_targets;
END $$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3 (optional) — drop the backup once the fix is confirmed good on prod.
--          Left commented out — recoverability.
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS _drop_share_pending_parity_backup_20260727;
