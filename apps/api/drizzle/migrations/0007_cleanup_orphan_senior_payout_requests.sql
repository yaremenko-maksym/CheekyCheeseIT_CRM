-- Migration: cleanup orphan payout_requests created by the auto-payout-on-validate bug.
--
-- Context (feat/finance-payout-flow #7):
--   Before this fix, validateTransaction for SENIOR_INCOME atomically created a
--   payout_request + PAYOUT(PENDING_PAYMENT) row in addition to flipping the income
--   to VALIDATED. When the SENIOR then called POST /api/payout-requests a second
--   payout_request + PAYOUT was inserted → duplicate payout.
--
-- This migration safely removes orphan rows: payout_requests that are PENDING and
-- have NO linked SENIOR_INCOME or DROP_INCOME (i.e. they were created by the auto
-- path and never received a manual link). Their sole linked transaction is a
-- PAYOUT(PENDING_PAYMENT) which is also cleaned up.
--
-- Safety conditions (all must be true to delete):
--   1. payout_requests.status = 'PENDING'               — never paid
--   2. No linked SENIOR_INCOME / DROP_INCOME rows       — true orphan (income was
--      never linked because validate didn't set payoutRequestId for SENIOR_INCOME
--      before the fix landed, OR this is a leftover from the old auto-path)
--   3. All linked PAYOUT rows are PENDING_PAYMENT        — never paid
--
-- Idempotent: WHERE conditions narrow to exactly the affected rows; re-running
-- after the orphans are gone is a no-op.

-- Step 1: delete orphan PAYOUT(PENDING_PAYMENT) rows linked to the phantom requests.
DELETE FROM transactions
WHERE payout_request_id IN (
  SELECT pr.id
  FROM payout_requests pr
  WHERE pr.status = 'PENDING'
    -- No SENIOR_INCOME or DROP_INCOME linked to this request
    AND NOT EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.payout_request_id = pr.id
        AND t.type IN ('SENIOR_INCOME', 'DROP_INCOME')
    )
    -- All linked POUTOUTs are still PENDING_PAYMENT (never paid)
    AND NOT EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.payout_request_id = pr.id
        AND t.type = 'PAYOUT'
        AND t.status != 'PENDING_PAYMENT'
    )
)
AND type = 'PAYOUT'
AND status = 'PENDING_PAYMENT';

-- Step 2: delete the now-unlinkable orphan payout_requests.
DELETE FROM payout_requests
WHERE status = 'PENDING'
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.payout_request_id = payout_requests.id
      AND t.type IN ('SENIOR_INCOME', 'DROP_INCOME')
  )
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.payout_request_id = payout_requests.id
      AND t.type = 'PAYOUT'
      AND t.status != 'PENDING_PAYMENT'
  );
