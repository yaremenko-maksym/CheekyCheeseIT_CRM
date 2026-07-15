-- =============================================================================
-- Settle-phantom cleanup — prod DATA-FIX (AUTO-WIRED variant, unattended-safe)
-- =============================================================================
--
-- This is the auto-wired sibling of
-- `apps/api/drizzle/manual/2026-07-15_settle_phantom_cleanup.sql`. Same
-- context, same predicates, same guards — reproduced 1-for-1 below. The ONLY
-- functional difference is HOW the pre-COMMIT verification gate works:
--
--   manual file : STEP 0 (separate DRY-RUN SELECT) + STEP 2's pre-COMMIT
--                 SELECT is meant to be EYEBALLED by a human before typing
--                 `COMMIT;` interactively.
--   this file   : the dry-run count and the pre-COMMIT verification are both
--                 emitted as RAISE NOTICE (visible in deploy-step logs) and
--                 the verification is a FAIL-LOUD assert — a DO block that
--                 RAISEs EXCEPTION when remaining≠0. Since this whole file
--                 runs as ONE `psql -v ON_ERROR_STOP=1 < file` invocation
--                 (no human in the loop), a RAISE EXCEPTION aborts the psql
--                 script before the `COMMIT;` line is ever reached — the
--                 in-flight transaction is left open, and Postgres implicitly
--                 rolls it back when the connection/session closes with the
--                 script. `ON_ERROR_STOP=1` makes psql exit non-zero on that
--                 error, so the deploy.yml apply-step (and the deploy job)
--                 goes red. That is the safety net for unattended execution.
--
-- Owner authorization
-- --------------------
-- Owner explicitly instructed (2026-07-15) to apply the existing manual
-- cleanup on prod WITHOUT their own involvement ("выполни сам без меня").
-- There is no SSH access to the VPS from the orchestrator — the only path to
-- the prod DB is the deploy pipeline (`.github/workflows/deploy.yml`), which
-- already applies manual SQL files over SSH (Steps 2a–2d). This file + the
-- deploy.yml wiring is that authorized, unattended path.
--
-- Context (unchanged from the manual file)
-- -----------------------------------------
-- ADR 2026-07-14 (docs/architecture/2026-07-14-settle-transition-in-place.md).
-- Before the "settle-in-place" fix (#379), closing a COMPANY debt via
-- `settleByCompany` INSERTED a SECOND transaction (SENIOR_INCOME /
-- PAYOUT_DROP, PAID) and left the SOURCE IOU row (SENIOR_PENDING_PAYOUT /
-- DROP_PENDING_PAYOUT) hanging FOREVER in status=PENDING_PAYMENT — a phantom
-- «Ожидает выплаты» row with a live «Выплатить» button. The obligation itself
-- is already PAID and `closing_transaction_id` points at the settle row.
--
-- The new code transitions the SAME row in place (no second tx). This script
-- retro-fits the ALREADY-hung prod pairs to the new single-row model so the
-- phantom «Ожидает выплаты» rows disappear.
--
-- IMPORTANT — this is COSMETIC / UX, NOT money-critical
-- -------------------------------------------------------
-- The ledger on prod is ALREADY correct: a phantom `*_PENDING_PAYOUT` row is
-- not part of ANY money term (company-account ledger, drop aggregate, C4
-- income), and a repeat settle is already blocked (obligation is PAID → 404).
-- So this can run AFTER the code deploy, without a freeze. It removes the
-- phantom rows + button. Expected ≈28 hung pairs as of 2026-07-15 (21 senior
-- + 7 drop).
--
-- Idempotency
-- -----------
-- Same as the manual file: pairs already collapsed by the new code have
-- source_transaction_id = closing_transaction_id and are skipped by every
-- predicate below, so a re-run (e.g. on the next deploy) is a safe no-op —
-- 0 backed up, 0 repointed, 0 deleted, assert passes (remaining=0), exit 0.
--
-- Security-review parity (round 1, MED — carried over verbatim)
-- ----------------------------------------------------------------
-- STEP 2b's DELETE requires `EXISTS (SELECT 1 FROM
-- _settle_phantom_backup_20260715 b WHERE b.id = t.id)` — i.e. it deletes
-- ONLY rows STEP 1 actually backed up. This keeps every DELETE recoverable
-- from the backup table (never dropped by this script — STEP 3 stays
-- commented out, exactly like the manual file).
--
-- How this gets applied
-- ----------------------
-- Wired into `.github/workflows/deploy.yml`: copied to the VPS via the
-- existing `copy-compose` SCP step, then applied by the `deploy` job with
-- `psql -v ON_ERROR_STOP=1 < file`, after Step 2d (transaction_audit_log) and
-- before api/nginx are (re)started. See that file for the exact apply-block.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — BACKUP the phantom rows before deleting (recoverable rollback).
--          Idempotent: CREATE IF NOT EXISTS + only inserts not-yet-backed rows.
--          Same backup table + predicate as the manual file (shared, reused
--          across both variants — whichever runs first creates it).
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
-- STEP 2 — PRIMARY fix, wrapped in ONE transaction with a FAIL-LOUD assert
--          instead of an interactive eyeball. Repoint + delete, bringing the
--          old pairs to the new single-row model
--          (source_transaction_id = closing_transaction_id = one row).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- 2.pre) Dry-run count, logged so the deploy-step log shows N before any
--        write happens (unattended equivalent of the manual file's STEP 0).
DO $$
DECLARE
  v_dry_run_count integer;
BEGIN
  SELECT count(*) INTO v_dry_run_count
  FROM pending_obligations o
  JOIN transactions src ON src.id = o.source_transaction_id
  WHERE o.status = 'PAID'
    AND o.closing_transaction_id IS NOT NULL
    AND o.closing_transaction_id <> o.source_transaction_id
    AND src.type IN ('SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT')
    AND src.status = 'PENDING_PAYMENT';

  RAISE NOTICE 'phantom-cleanup: % hung pair(s) will be collapsed', v_dry_run_count;
END $$;

-- 2a) Repoint source_transaction_id → the settlement row. This releases the
--     FK 'restrict' on the phantom (pending_obligations.source_transaction_id).
--     The obligation is PAID, so uq_pending_obligations_source_pending
--     (WHERE status='PENDING') is not touched. Same predicate as manual 2a.
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

-- 2b) Delete the now-orphaned phantom IOU. Guarded: only when NOTHING
--     references it (source_transaction_id was repointed above;
--     closing_transaction_id never pointed at a phantom; a PENDING IOU has no
--     invoice signature) AND — the security-review fix (round 1, MED),
--     carried over verbatim — only when the row was ACTUALLY backed up in
--     STEP 1. Same predicate as manual 2b, including the backup-exists guard.
DELETE FROM transactions t
WHERE t.type IN ('SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT')
  AND t.status = 'PENDING_PAYMENT'
  AND NOT EXISTS (SELECT 1 FROM pending_obligations o WHERE o.source_transaction_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM pending_obligations o WHERE o.closing_transaction_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM invoice_signatures s WHERE s.transaction_id = t.id)
  AND EXISTS (SELECT 1 FROM _settle_phantom_backup_20260715 b WHERE b.id = t.id);

-- 2c) FAIL-LOUD assert — replaces the manual file's "eyeball the SELECT, type
--     COMMIT only if 0" step. If remaining≠0, RAISE EXCEPTION aborts this DO
--     block, which aborts the enclosing transaction (never reaches COMMIT
--     below), and — because psql runs with -v ON_ERROR_STOP=1 — the whole
--     script exits non-zero. The deploy.yml apply-step (and the deploy job)
--     then fails loudly instead of silently leaving phantoms half-cleaned.
DO $$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining
  FROM pending_obligations o
  JOIN transactions src ON src.id = o.source_transaction_id
  WHERE o.status = 'PAID'
    AND src.type IN ('SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT')
    AND src.status = 'PENDING_PAYMENT';

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'phantom-cleanup verify failed: % phantom(s) remain (expected 0)', v_remaining;
  END IF;

  RAISE NOTICE 'phantom-cleanup: verify passed — remaining=0';
END $$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3 (optional) — drop the backup once the fix is confirmed good on prod.
--          Left commented out, same as the manual file — recoverability.
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS _settle_phantom_backup_20260715;
