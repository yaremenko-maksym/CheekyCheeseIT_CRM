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
-- helper Path A already uses (and, as of security-review PR #443 HIGH-1,
-- `settleByCompany` REJECTS closing a Path-B-originated obligation from the
-- shared company account — that money never landed there; see
-- pending-settlement.service.ts). This script retro-fits Path B's HISTORICAL
-- rows to the state Path A would have created them in, so they can be
-- confirmed (settled) retroactively instead of staying silently instant-paid
-- forever.
--
-- Selection predicate — BY ORIGIN, not by "missing receipt"
-- -----------------------------------------------------------
-- Target: type = 'PAYOUT_DROP' AND status = 'PAID' AND payout_request_id IS
-- NOT NULL AND sender_id IS DISTINCT FROM receiver_id (see the self-loop note
-- below for the last clause).
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
-- Self-loop exclusion (security-review PR #443, MED-3)
-- --------------------------------------------------------
-- Rows created BEFORE Audit 2026-06-28 (#3) had `sender_id = receiver_id`
-- (= the drop) — a self-loop the cascade fix later corrected (the drop is
-- ONLY ever the receiver of this slice). For a self-loop row,
-- `computeDropAggregate` (received − sent) nets to EXACTLY ZERO today — the
-- row is balance-INVISIBLE. Converting + later settling such a row is NOT a
-- neutral round-trip: `settleByCompany`'s flip always stamps a definite
-- sender (null+'COMPANY', or an ADMIN_PERSONAL payer — see
-- pending-settlement.service.ts) that is NEVER the drop's own id again, so
-- the self-loop is broken by the settle and the row starts counting
-- (+amount) where it previously counted 0. That is a real balance INCREASE
-- this backfill's own "restores the exact same amount" guarantee does not
-- cover. Self-loop rows are therefore EXCLUDED from selection here — they
-- keep their current (already balance-neutral) PAYOUT_DROP/PAID/self-loop
-- shape untouched. If the owner later wants those cleaned up too, that is a
-- SEPARATE, deliberate task (different fix — the self-loop itself is the
-- defect to resolve, not covered by "book a pending obligation").
--
-- What "equivalent to a freshly-created IOU" means (fields read by the code)
-- -----------------------------------------------------------------------------
-- `settleByCompany` + the company/drop balance derivations
-- (company-account-balance.ts, computeDropAggregate / getDropSelfSummary) only
-- read: `transactions.type` (drop-vs-senior discriminator via
-- `resolveSource`), `transactions.status` (`= 'PENDING_PAYMENT'` — the flip's
-- WHERE-guard), `transactions.payout_request_id` (security-review PR #443
-- HIGH-1 — the cascade-vs-declaration funding-source guard; UNTOUCHED by this
-- script, so a converted row keeps proving its Path-B origin exactly like a
-- freshly-booked one would), and the PAIRED `pending_obligations` row
-- (creditor_user_id, debtor_type='COMPANY', source_transaction_id, amount,
-- currency, status='PENDING' — WITHOUT this row `settleByCompany` can never
-- find the obligation to close, and the row hangs pending forever). `amount`,
-- `currency`, `receiver_id`/`recipient_id`, `sender_id`/`sender_label`,
-- `project_id`, `created_by` are UNTOUCHED by this script — the historical
-- PAYOUT_DROP insert already stamped them identically to how
-- bookCompanyObligations stamps a fresh DROP_PENDING_PAYOUT (senderId=null,
-- senderLabel='COMPANY', receiverId/recipientId=drop — for a NON-self-loop
-- row; self-loop rows are excluded, see above). `drop_share_percent` /
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
-- Balance impact (expected, and visible to people) — DO NOT trust a stale note
-- -------------------------------------------------------------------------------
-- After this backfill, each affected drop's aggregate balance
-- (`computeDropAggregate` / `getDropSelfSummary`) DECREASES by the sum of the
-- converted rows' amounts, until an ADMIN/ACCOUNTANT settles each one again
-- (which restores the exact same amount — see the round-trip test in
-- `drop-payout-company-account.integration.spec.ts`, INV2b, and the dedicated
-- `drop-share-pending-parity-backfill.integration.spec.ts`).
--
-- security-review PR #443 (MED-3): an EARLIER version of this note claimed
-- "PROD carries zero PAYOUT_DROP rows", citing a code comment from Audit
-- 2026-06-28 (#3). That note predates the ~2026-07-01 Google Sheets
-- accounting import (~313 historical transactions) and ordinary drop-project
-- activity since — it is NOT reliable evidence of the CURRENT count. DO NOT
-- assume no-op. STEP 0 below is a standalone, read-only, always-safe count —
-- run it FIRST (or read its RAISE NOTICE output in the deploy log) and get
-- the OWNER's explicit go-ahead if the count is non-zero, since drop balances
-- will visibly dip until each row is settled.
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
-- security-review PR #443 (MED-4) — DE-WIRE AFTER A SUCCESSFUL APPLY.
-- Unlike the idempotent additive DDL elsewhere in this directory, this script
-- MUTATES money-status rows. `deploy.yml` re-applies every file in this
-- directory on EVERY deploy — today that is safe only because the sole
-- producer of a PAID `PAYOUT_DROP` with a non-null `payout_request_id` (the
-- old Path B) is REMOVED by this same PR, and `settleByCompany` always resets
-- `payout_request_id` to NULL on close. But nothing enforces "no future code
-- path ever again pairs PAID + PAYOUT_DROP + a live payout_request_id" — a
-- regression there would make this script silently re-open already-settled
-- debts on the NEXT deploy. Once the deploy log shows a successful apply
-- (verify passed), REMOVE this file's entry from `deploy.yml`'s migrate step
-- (mirrors the counterparty-masking prod-datafix precedent: apply once →
-- de-wire). DevOps owns the removal.
--
-- Idempotency
-- -----------
-- The core predicate is `type = 'PAYOUT_DROP' AND status = 'PAID' AND
-- payout_request_id IS NOT NULL AND sender_id IS DISTINCT FROM receiver_id`.
-- Once a row is converted, its type becomes 'DROP_PENDING_PAYOUT' — it no
-- longer matches this predicate, so a re-run of this whole script finds ZERO
-- target rows on the second pass: 0 backed up, 0 converted, 0 obligations
-- inserted, verify asserts targets=converted=obligations=0, exits 0.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 0 — standalone, READ-ONLY pre-count (security-review PR #443, MED-3).
--          Always safe to run in isolation — no writes. Prints the CURRENT
--          count (not a stale note) plus how many are self-loop rows (which
--          STEP 2 below deliberately excludes — see the header note).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_total integer;
  v_amount numeric;
  v_self_loop integer;
BEGIN
  SELECT count(*), COALESCE(sum(amount::numeric), 0)
    INTO v_total, v_amount
  FROM transactions
  WHERE type = 'PAYOUT_DROP' AND status = 'PAID' AND payout_request_id IS NOT NULL;

  SELECT count(*) INTO v_self_loop
  FROM transactions
  WHERE type = 'PAYOUT_DROP'
    AND status = 'PAID'
    AND payout_request_id IS NOT NULL
    AND sender_id = receiver_id;

  RAISE NOTICE 'drop-share-pending-parity STEP 0 (pre-count): % Path-B row(s), total amount %, of which % self-loop (excluded from conversion — see header)',
    v_total, v_amount, v_self_loop;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — the ENTIRE fix (target capture + backup + convert + obligation +
--          verify) in ONE transaction (security-review PR #443, MED-1: the
--          backup used to run as its own auto-committed statement BEFORE the
--          target set was captured, leaving a window — a row inserted by an
--          old, not-yet-replaced API instance between the two could be
--          converted without ever being backed up. Capturing the targets AND
--          backing them up FROM that same captured set, inside the SAME
--          transaction as the conversion, closes the window: either
--          everything below commits together, or nothing does — a rolled-back
--          run leaves NO converted rows and NO backup rows, safe to retry).
--          Unattended-safe: applied via a single `psql -v ON_ERROR_STOP=1 <
--          file` invocation, no human in the loop.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- 1a) Capture the target id set ONCE — every later step (backup, obligation
--     insert, verify) joins against this fixed set instead of re-querying by
--     type/status (which would see nothing once the rows are converted, and
--     — before this fix — could race a concurrently-inserted row). Excludes
--     self-loop rows (sender_id = receiver_id) — see the header note.
DROP TABLE IF EXISTS pg_temp._dspp_targets;
CREATE TEMP TABLE _dspp_targets AS
SELECT id, receiver_id, amount, currency
FROM transactions
WHERE type = 'PAYOUT_DROP'
  AND status = 'PAID'
  AND payout_request_id IS NOT NULL
  AND sender_id IS DISTINCT FROM receiver_id;

DO $$
DECLARE
  v_dry_run_count integer;
BEGIN
  SELECT count(*) INTO v_dry_run_count FROM _dspp_targets;
  RAISE NOTICE 'drop-share-pending-parity STEP 1: % row(s) will be converted to pending (self-loop rows excluded)', v_dry_run_count;
END $$;

-- 1b) BACKUP the affected rows FROM the captured target set (not a fresh
--     query) — guarantees byte-identical backup vs conversion scope, and,
--     since this now runs inside the SAME transaction as the conversion
--     below, is only ever durable together with it (never a claimed backup
--     for a conversion that didn't happen, and never a silent conversion
--     with no backup). This table is NEVER dropped by this script.
--     security-review PR #443 (LOW): explicit column list on BOTH sides
--     (not `SELECT t.*` into a `LIKE transactions INCLUDING ALL` table) — a
--     future `ALTER TABLE transactions ADD COLUMN …` would otherwise break a
--     re-run of this frozen-in-time script (backup table column count would
--     no longer match `transactions`'s CURRENT column count). The explicit
--     list is pinned to this migration's schema snapshot and stays correct
--     regardless of later additive schema changes.
CREATE TABLE IF NOT EXISTS _drop_share_pending_parity_backup_20260727 (
  LIKE transactions INCLUDING ALL
);

INSERT INTO _drop_share_pending_parity_backup_20260727 (
  id, type, status, amount, currency, sender_id, sender_label, receiver_id,
  receiver_label, recipient_id, project_id, payout_request_id,
  senior_share_percent, senior_share_percent_source, receipt_document_id,
  receipt_external_url, invoice_document_id, tx_hash, validated_by,
  validated_at, rejection_reason, notes, salary_month, tx_date, created_by,
  created_at, updated_at, funding_source, idempotency_key,
  drop_share_percent, drop_share_percent_source
)
SELECT
  t.id, t.type, t.status, t.amount, t.currency, t.sender_id, t.sender_label,
  t.receiver_id, t.receiver_label, t.recipient_id, t.project_id,
  t.payout_request_id, t.senior_share_percent, t.senior_share_percent_source,
  t.receipt_document_id, t.receipt_external_url, t.invoice_document_id,
  t.tx_hash, t.validated_by, t.validated_at, t.rejection_reason, t.notes,
  t.salary_month, t.tx_date, t.created_by, t.created_at, t.updated_at,
  t.funding_source, t.idempotency_key, t.drop_share_percent,
  t.drop_share_percent_source
FROM transactions t
JOIN _dspp_targets tgt ON tgt.id = t.id
WHERE NOT EXISTS (
  SELECT 1 FROM _drop_share_pending_parity_backup_20260727 b WHERE b.id = t.id
);

-- 1c) Flip the historical Path-B rows into the SAME pending state
--     `bookCompanyObligations` books today: type → DROP_PENDING_PAYOUT,
--     status → PENDING_PAYMENT. Every other column (amount, currency,
--     sender/receiver, project, createdBy, txHash, payout_request_id) is left
--     untouched — see the header note on field equivalence.
UPDATE transactions
SET type = 'DROP_PENDING_PAYOUT',
    status = 'PENDING_PAYMENT',
    updated_at = now()
WHERE id IN (SELECT id FROM _dspp_targets);

-- 1d) The PAIRED pending_obligations row — WITHOUT this, settleByCompany can
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

-- 1e) FAIL-LOUD verify: the number of rows actually converted (now
--     DROP_PENDING_PAYOUT/PENDING_PAYMENT) AND the number of paired PENDING
--     COMPANY obligations booked must BOTH equal the number of rows selected
--     in 1a — else RAISE EXCEPTION aborts this DO block, which aborts the
--     enclosing transaction (COMMIT below is never reached — nothing above,
--     including the backup, survives), and — because psql runs with
--     -v ON_ERROR_STOP=1 — the whole script/deploy step exits non-zero
--     instead of silently leaving a partial conversion.
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
-- STEP 2 (optional) — drop the backup once the fix is confirmed good on prod.
--          Left commented out — recoverability.
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS _drop_share_pending_parity_backup_20260727;
