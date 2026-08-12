-- =============================================================================
-- Admin-income drop-share backfill — prod DATA-FIX (manual apply)
-- task-admin-income-drop-backfill
-- =============================================================================
--
-- REQUIRED apply order (see the column file's header for the full sequencing
-- rationale):
--   1. `2026-08-12_admin_income_drop_backfill_column.sql`  — schema: new column.
--   2. `2026-08-12_admin_income_drop_backfill_report.sql`  — READ-ONLY report;
--      OWNER reads the candidate + ambiguous lists, decides whether to proceed.
--   3. THIS file — the actual backfill, only after step 2's go-ahead.
--
-- Selection predicate — mirrors the report file EXACTLY (same CTEs, same
-- WHERE clauses; see that file's header for the full reasoning behind every
-- clause, including why a project with ANY untagged existing drop-share row
-- is entirely excluded as ambiguous rather than guessed at):
--   type = 'ADMIN_INCOME' AND deleted_at IS NULL
--   AND project.drop_id IS NOT NULL AND project.payment_type = 'USDT'
--   AND NOT already linked (an existing DROP_PENDING_PAYOUT/PAYOUT_DROP row's
--       source_income_transaction_id already names this income)
--   AND project NOT IN the ambiguous set (any UNLINKED existing drop-share
--       row on the same project).
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
--     OWNER-APPROVED ASSUMPTION note below), source_income_transaction_id=
--     the ADMIN_INCOME row's id (the entire reason this column exists),
--     created_by=the income row's OWN created_by (no "current actor" exists
--     for a backfill; attributing to whoever registered the income is the
--     least-invented choice available — never an accountant/system id that
--     did not actually create anything).
--   amount = roundShareAmount(income.amount, resolved_percent) — see the
--     "money-critical" note in the report file for how this SQL expression
--     is pinned against the TS function it must equal.
-- Paired 1:1 with a `pending_obligations` row (creditor=drop, debtor_type=
-- COMPANY, status=PENDING) — WITHOUT it settleByCompany can never find the
-- obligation to close (the SAME "anti-BIZ-02: never an income row without
-- its obligations" invariant `bookCompanyObligations` documents on itself).
--
-- OWNER-APPROVED ASSUMPTION (say it out loud, per the task) — no historical
-- drop-share % was ever recorded for these incomes (the snapshot columns
-- were added later). This backfill applies TODAY's resolveDropShare rule. If
-- a project's or drop's share % ever changed over time, the backfilled
-- amount will NOT match what would have been booked back when the income
-- was originally declared. This is a deliberate, disclosed approximation,
-- not a bug.
--
-- Idempotency
-- -----------
-- The selection predicate excludes any income already linked via
-- `source_income_transaction_id` — a created row IS that link, so a re-run
-- selects ZERO targets on the second pass: 0 candidates, 0 rows created, 0
-- obligations, verify asserts targets=created=obligations=0, exits 0.
--
-- Revert (if ever needed) — nothing pre-existing is mutated (this script
-- only INSERTs brand-new rows, unlike the drop-share-pending-parity
-- precedent which flips rows in place), so reverting needs no backup table —
-- a plain delete by the income ids the report logged as CANDIDATE suffices:
--   DELETE FROM pending_obligations
--     WHERE source_transaction_id IN (
--       SELECT id FROM transactions WHERE source_income_transaction_id = ANY($1::uuid[]));
--   DELETE FROM transactions WHERE source_income_transaction_id = ANY($1::uuid[]);
-- (with $1 = the income ids from the report's log for this run).
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_apply.sql
--
-- REQUIRED DevOps wiring — this PR does NOT touch .github/workflows/**
-- (Coder zone-of-write; called out explicitly in this PR's body). See the
-- column file's header for the required order alongside its two siblings.
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
WITH usdt_drop_incomes AS (
  SELECT
    t.id AS income_id,
    t.project_id,
    t.amount,
    t.created_by
  FROM transactions t
  JOIN projects p ON p.id = t.project_id
  WHERE t.type = 'ADMIN_INCOME'
    AND t.deleted_at IS NULL
    AND p.drop_id IS NOT NULL
    AND p.payment_type = 'USDT'
),
linked AS (
  SELECT DISTINCT source_income_transaction_id AS income_id
  FROM transactions
  WHERE type IN ('DROP_PENDING_PAYOUT', 'PAYOUT_DROP')
    AND deleted_at IS NULL
    AND source_income_transaction_id IS NOT NULL
),
ambiguous_projects AS (
  SELECT DISTINCT project_id
  FROM transactions
  WHERE type IN ('DROP_PENDING_PAYOUT', 'PAYOUT_DROP')
    AND deleted_at IS NULL
    AND source_income_transaction_id IS NULL
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
WHERE u.income_id NOT IN (SELECT income_id FROM linked)
  AND u.project_id NOT IN (SELECT project_id FROM ambiguous_projects);

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
-- that could drift from what was actually written.
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
