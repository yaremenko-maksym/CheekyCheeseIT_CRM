-- =============================================================================
-- Admin-income drop-share backfill — prod DATA-FIX (manual apply)
-- task-admin-income-drop-backfill
-- =============================================================================
--
-- REQUIRED apply order (see the column file's header for the full sequencing
-- rationale):
--   1. `2026-08-12_admin_income_drop_backfill_column.sql`  — schema: new
--      column + unique index.
--   2. `2026-08-12_admin_income_drop_backfill_report.sql`  — READ-ONLY,
--      aggregate-only report; OWNER reads the counts + total in the deploy
--      log, decides whether to proceed (optionally cross-checking the
--      private `..._detail.sql` breakdown first — see that file).
--   3. THIS file — the actual backfill, only after step 2's go-ahead.
--
-- Selection predicate — mirrors the report file EXACTLY (same CTEs, same
-- WHERE clauses; see that file's header for the full reasoning behind every
-- clause):
--   type = 'ADMIN_INCOME' AND deleted_at IS NULL AND currency = 'USDT'
--   AND created_at < the authorship cutoff (see BOUNDS below)
--   AND project.drop_id IS NOT NULL AND project.payment_type = 'USDT'
--   AND NOT already linked (an existing DROP_PENDING_PAYOUT/PAYOUT_DROP row's
--       source_income_transaction_id already names this income — checked
--       WITHOUT a deleted_at filter on the linking row, so soft-deleting a
--       backfilled row can never make its income look unlinked again)
--   AND project NOT IN the ambiguous set (any UNLINKED existing drop-share
--       row on the same project, OR any DROP_INCOME ever recorded on it —
--       see the report file for why the second clause exists).
--
-- What each created row looks like — byte-shaped like a fresh
-- `bookCompanyObligations` drop IOU (the SAME row `declareUsdtProjectIncome`
-- would have created at income-creation time), except for the fields this
-- script structurally cannot know in retrospect:
--   type='DROP_PENDING_PAYOUT', status='PENDING_PAYMENT', currency='USDT',
--   sender_label='COMPANY', receiver_id/recipient_id=drop, project_id,
--   drop_cascade_origin=false (mirrors declareUsdtProjectIncome — never a
--     cascade booking), drop_share_percent/_source=resolveDropShare's
--     TODAY'S rule (project override → drop's user default → 5% — see the
--     OWNER-APPROVED ASSUMPTION note in the report file), source_income_
--     transaction_id=the ADMIN_INCOME row's id (the entire reason this
--     column exists), created_by=the income row's OWN created_by (no
--     "current actor" exists for a backfill; attributing to whoever
--     registered the income is the least-invented choice available — never
--     an accountant/system id that did not actually create anything).
--   amount = roundShareAmount(income.amount, resolved_percent) — see the
--     "money-critical" note in the report file for how this SQL expression
--     is pinned against the TS function it must equal.
-- Paired 1:1 with a `pending_obligations` row (creditor=drop, debtor_type=
-- COMPANY, status=PENDING) — WITHOUT it settleByCompany can never find the
-- obligation to close (the SAME "anti-BIZ-02: never an income row without
-- its obligations" invariant `bookCompanyObligations` documents on itself).
--
-- OWNER-APPROVED ASSUMPTIONS (say them out loud, per the task) — see the
-- report file's header for both in full: (1) no historical drop-share %
-- was ever recorded, so this applies TODAY's `resolveDropShare` rule; (2)
-- `projects.drop_id` is also a TODAY snapshot, so a historically-reassigned
-- drop binding is not reconstructed either. Both deliberate, disclosed
-- approximations, not bugs.
--
-- Idempotency
-- -----------
-- The selection predicate excludes any income already linked via
-- `source_income_transaction_id` — a created row IS that link (permanently —
-- see the `linked` CTE's comment below on why it ignores `deleted_at`), so a
-- re-run selects ZERO targets on the second pass: 0 candidates, 0 rows
-- created, 0 obligations, verify asserts targets=created=obligations=0,
-- exits 0. Structurally backstopped, not just predicate-based — security-
-- review round 2 (PR #517, MED-F): `uq_transactions_source_income_drop_link`
-- (added by the column file) makes a genuinely concurrent second run of this
-- file fail loud (23505) on STEP 2's INSERT rather than silently double-
-- booking, if it ever overlaps a still-in-flight prior run.
--
-- Revert (if ever needed) — nothing pre-existing is mutated (this script
-- only INSERTs brand-new rows, unlike the drop-share-pending-parity
-- precedent which flips rows in place), so reverting needs no backup table —
-- a plain delete by the income ids the report logged as CANDIDATE suffices:
--   DELETE FROM pending_obligations
--     WHERE source_transaction_id IN (
--       SELECT id FROM transactions WHERE source_income_transaction_id = ANY($1::uuid[]));
--   DELETE FROM transactions WHERE source_income_transaction_id = ANY($1::uuid[]);
-- (with $1 = the income ids from the detail report's log for this run).
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_apply.sql
--
-- REQUIRED DevOps wiring — this PR does NOT touch .github/workflows/**
-- (Coder zone-of-write; called out explicitly in this PR's body). See the
-- column file's header for the required order alongside its siblings (NOT
-- the detail file — that one must never run inside CI).
-- `scripts/devops/check-prod-ddl-wiring.py` fails the build until that
-- happens — by design, same as `2026-08-05_salary_paid_amount.sql`.
--
-- DE-WIRE AFTER A SUCCESSFUL APPLY (mirrors the drop-share-pending-parity /
-- counterparty-masking precedent) — this is a one-time data-fix, not a
-- recurring schema change. Once the deploy log shows "verify passed", REMOVE
-- this file's entry from deploy.yml's migrate step (leave the column file
-- and the report file wired — additive DDL / read-only respectively, safe
-- forever). DevOps owns the removal.
-- =============================================================================

BEGIN;

-- STEP 1 — capture the target set ONCE, inside the same transaction as the
-- writes below (mirrors the drop-share-pending-parity MED-1 fix: capturing
-- and acting on the SAME snapshot closes the window where a row inserted
-- between two separate statements could be missed or double-counted).
DROP TABLE IF EXISTS pg_temp._aidb_targets;
CREATE TEMP TABLE _aidb_targets AS
WITH bounds AS (
  -- MED-B (security-review round 2, PR #517): scope this one-time script to
  -- income rows that existed at authorship/review time, so a brand-new
  -- ADMIN_INCOME declared between the report step and this step can never
  -- silently join the target set the owner never saw. See the report file's
  -- header for the full reasoning.
  SELECT '2026-08-13 00:00:00+00'::timestamptz AS cutoff
),
usdt_drop_incomes AS (
  SELECT
    t.id AS income_id,
    t.project_id,
    t.amount,
    t.created_by
  FROM transactions t
  JOIN projects p ON p.id = t.project_id
  CROSS JOIN bounds b
  WHERE t.type = 'ADMIN_INCOME'
    AND t.deleted_at IS NULL
    -- HIGH-1 (security-review round 2, PR #517): `payment_type = 'USDT'` is
    -- a project-level setting, NOT the currency of any individual income row
    -- on it — `createAdminIncomeSchema` allows USDT | USD | EUR | UAH and the
    -- service persists whatever the caller supplied verbatim (forced to USDT
    -- only for a COMPANY_ACCOUNT-funded income). Without this filter a
    -- 200 000 UAH income would be treated as 200 000 USDT. The created
    -- DROP_PENDING_PAYOUT is ALWAYS a USDT obligation, so this is the ONLY
    -- filter that makes `amount` below mean what the created row claims.
    AND t.currency = 'USDT'
    AND t.created_at < b.cutoff
    AND p.drop_id IS NOT NULL
    AND p.payment_type = 'USDT'
),
linked AS (
  SELECT DISTINCT source_income_transaction_id AS income_id
  FROM transactions
  WHERE type IN ('DROP_PENDING_PAYOUT', 'PAYOUT_DROP')
    AND source_income_transaction_id IS NOT NULL
  -- MED-E (security-review round 2, PR #517): deliberately NO `deleted_at IS
  -- NULL` filter here. The LINK is a permanent historical fact ("this income
  -- was already processed"), independent of whether the resulting obligation
  -- row is later soft-deleted by an admin — requiring the linking row to be
  -- non-deleted would let a soft-deleted backfilled row make its income look
  -- unlinked again on a later run, creating a SECOND DROP_PENDING_PAYOUT for
  -- the SAME income and breaking idempotency.
),
ambiguous_projects AS (
  SELECT DISTINCT project_id
  FROM transactions
  WHERE type IN ('DROP_PENDING_PAYOUT', 'PAYOUT_DROP')
    AND deleted_at IS NULL
    AND source_income_transaction_id IS NULL
    -- MED-A (security-review round 2, PR #517): `transactions.project_id`
    -- has `ON DELETE SET NULL` on its FK — a NULL here must never enter this
    -- set (a `NOT IN` against a set containing NULL silently matches ZERO
    -- rows for EVERY candidate, which is why this predicate now uses
    -- `NOT EXISTS` throughout instead of `NOT IN`, in addition to this
    -- explicit filter).
    AND project_id IS NOT NULL
  UNION
  -- HIGH-2 (security-review round 2, PR #517): `projects.payment_type` is a
  -- LIVE, current-state snapshot — the enum landed 2026-07-13 with EVERY
  -- existing project defaulted to 'FOP', so a project now showing 'USDT' may
  -- have spent part of its history as 'FOP'. During any FOP-period a drop
  -- declares their OWN income directly (createDropIncome → DROP_INCOME),
  -- entirely outside bookCompanyObligations and this column — a DROP_INCOME
  -- row can represent the SAME underlying revenue an ADMIN_INCOME row on the
  -- SAME (now-USDT) project also records, with no FK linking the two.
  SELECT DISTINCT project_id
  FROM transactions
  WHERE type = 'DROP_INCOME'
    AND deleted_at IS NULL
    AND project_id IS NOT NULL
)
SELECT
  u.income_id,
  u.project_id,
  u.amount,
  u.created_by,
  p.drop_id,
  COALESCE(p.drop_share_percent_override, d.drop_share_percent, 5) AS resolved_percent,
  CASE
    WHEN p.drop_share_percent_override IS NOT NULL THEN 'PROJECT'
    ELSE 'USER_DEFAULT'
  END AS percent_source,
  (
    round(round(u.amount * 1000000) * COALESCE(p.drop_share_percent_override, d.drop_share_percent, 5) / 100)
    / 1000000
  )::numeric(18, 6) AS share_amount
FROM usdt_drop_incomes u
JOIN projects p ON p.id = u.project_id
JOIN users d ON d.id = p.drop_id
WHERE NOT EXISTS (SELECT 1 FROM linked l WHERE l.income_id = u.income_id)
  AND NOT EXISTS (SELECT 1 FROM ambiguous_projects ap WHERE ap.project_id = u.project_id);

DO $$
DECLARE
  v_target_count integer;
BEGIN
  SELECT count(*) INTO v_target_count FROM _aidb_targets;
  RAISE NOTICE 'admin-income-drop-backfill STEP 1: % row(s) will be created (ambiguous-project incomes excluded)', v_target_count;
END $$;

-- STEP 2 — create the DROP_PENDING_PAYOUT row for each target, byte-shaped
-- like a fresh bookCompanyObligations drop IOU (see header). Captures the
-- created id alongside the income_id it links, in a temp table, so STEP 3
-- pairs the obligation from THIS run's rows only — never a re-derivation
-- that could drift from what was actually written. A genuinely concurrent
-- second run of this whole file racing this INSERT hits
-- `uq_transactions_source_income_drop_link` (23505) instead of double-
-- booking — see MED-F in the header.
DROP TABLE IF EXISTS pg_temp._aidb_created;
CREATE TEMP TABLE _aidb_created AS
WITH ins AS (
  INSERT INTO transactions (
    type, status, amount, currency, sender_id, sender_label, receiver_id,
    recipient_id, project_id, drop_cascade_origin, drop_share_percent,
    drop_share_percent_source, notes, created_by, source_income_transaction_id
  )
  SELECT
    'DROP_PENDING_PAYOUT', 'PENDING_PAYMENT', tgt.share_amount, 'USDT', NULL,
    'COMPANY', tgt.drop_id, tgt.drop_id, tgt.project_id, false,
    tgt.resolved_percent, tgt.percent_source,
    'Backfill 2026-08-12 (task-admin-income-drop-backfill) — historical drop IOU for admin-income ' || tgt.income_id,
    tgt.created_by, tgt.income_id
  FROM _aidb_targets tgt
  RETURNING id AS created_id, source_income_transaction_id AS income_id
)
SELECT * FROM ins;

-- STEP 3 — the PAIRED pending_obligations row. WITHOUT this, settleByCompany
-- can never see the row (it queries pending_obligations, not transactions
-- directly) and the created IOU hangs in PENDING forever with nothing able
-- to close it.
INSERT INTO pending_obligations
  (creditor_user_id, debtor_type, debtor_user_id, source_transaction_id, amount, currency, status)
SELECT tgt.drop_id, 'COMPANY', NULL, c.created_id, tgt.share_amount, 'USDT', 'PENDING'
FROM _aidb_created c
JOIN _aidb_targets tgt ON tgt.income_id = c.income_id;

-- STEP 4 — FAIL-LOUD verify: the number of rows actually created AND the
-- number of paired PENDING COMPANY obligations booked must BOTH equal the
-- number of rows targeted in STEP 1 — else RAISE EXCEPTION aborts this DO
-- block, which aborts the enclosing transaction (COMMIT below is never
-- reached — nothing above survives), and — because psql runs with
-- -v ON_ERROR_STOP=1 — the whole script/deploy step exits non-zero instead
-- of silently leaving a partial backfill.
DO $$
DECLARE
  v_targets integer;
  v_created integer;
  v_obligations integer;
BEGIN
  SELECT count(*) INTO v_targets FROM _aidb_targets;
  SELECT count(*) INTO v_created FROM _aidb_created;

  SELECT count(*) INTO v_obligations
  FROM pending_obligations o
  JOIN _aidb_created c ON c.created_id = o.source_transaction_id
  WHERE o.status = 'PENDING' AND o.debtor_type = 'COMPANY';

  IF v_created <> v_targets OR v_obligations <> v_targets THEN
    RAISE EXCEPTION 'admin-income-drop-backfill verify failed: targets=%, created=%, obligations=% (all three must match)',
      v_targets, v_created, v_obligations;
  END IF;

  RAISE NOTICE 'admin-income-drop-backfill: verify passed — % row(s) created + paired obligation booked (targets=created=obligations)', v_targets;
END $$;

COMMIT;
