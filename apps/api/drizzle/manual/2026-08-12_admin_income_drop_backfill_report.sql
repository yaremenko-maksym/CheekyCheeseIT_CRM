-- =============================================================================
-- Admin-income drop-share backfill — REPORT (standalone, READ-ONLY, no writes)
-- AGGREGATE-ONLY — this file's output goes into a PUBLIC deploy log.
-- task-admin-income-drop-backfill
-- =============================================================================
--
-- Deploy sequencing (DevOps owns the wiring in .github/workflows/deploy.yml —
-- see 2026-08-12_admin_income_drop_backfill_column.sql's header):
--   1. Apply `2026-08-12_admin_income_drop_backfill_column.sql` (schema).
--   2. Apply THIS file → read the RAISE NOTICE output in the deploy log →
--      OWNER decides whether to proceed.
--   3. Only THEN apply `2026-08-12_admin_income_drop_backfill_apply.sql` (the
--      actual backfill — separate file, separate step, gated on the owner's
--      go-ahead from step 2, not auto-chained).
--
-- This file is 100% read-only: no CREATE/INSERT/UPDATE/DELETE of any kind,
-- not even a temp table. Proven by
-- apps/api/src/finance/admin-income-drop-backfill.integration.spec.ts (AC3):
-- table row counts are identical before and after running it.
--
-- security-review round 2 (PR #517, HIGH-3) — AGGREGATE-ONLY, by design.
-- ------------------------------------------------------------------------------
-- This repository is PUBLIC and its GitHub Actions logs are public with it.
-- The FIRST version of this file printed one RAISE NOTICE per candidate/
-- ambiguous row — income id, project NAME, drop DISPLAY NAME, and amount —
-- straight into that public log. That is client-identifying financial data
-- leaking into a public artifact. Fixed by narrowing this automated,
-- deploy-wired file to COUNTS + a total sum only (see the precedent this
-- should have followed from the start:
-- `2026-07-27_drop_share_pending_parity_precount.sql` prints aggregates
-- only). Row-level detail — for when an owner genuinely needs to see WHICH
-- incomes/projects/drops are involved — now lives in a SEPARATE file,
-- `2026-08-12_admin_income_drop_backfill_detail.sql`, which is NEVER wired
-- into deploy.yml and is meant to be run manually, in a private terminal
-- session, by one of the two admins with direct prod DB access (the same
-- access model already documented for prod DB operations generally — see
-- project-state.md). See that file's header for the full reasoning on why a
-- private manual run — not a new automated channel — is the right level of
-- exposure for this data.
--
-- Selection predicate (mirrors the apply file EXACTLY — same CTEs, same
-- WHERE clauses; only the SELECT list differs, this file adds human-readable
-- columns for the report, the apply file adds the columns it needs to write)
-- ------------------------------------------------------------------------------
-- A candidate is an ADMIN_INCOME row where ALL of:
--   - type = 'ADMIN_INCOME' AND deleted_at IS NULL (soft-deleted incomes are
--     never processed — task-admin-income-drop-backfill AC8);
--   - currency = 'USDT' — security-review round 2 (PR #517, HIGH-1):
--     `createAdminIncomeSchema` allows USDT | USD | EUR | UAH, and the
--     service persists whatever currency the caller supplied verbatim
--     (currency is only ever forced to USDT for a COMPANY_ACCOUNT-funded
--     income — see `transactions.service.ts` `createAdminIncome`). A
--     project's `payment_type = 'USDT'` says nothing about the CURRENCY of
--     any individual income row on it — a personal-currency UAH/USD/EUR
--     admin income can exist on a USDT-payment project. Without this filter
--     a 200 000 UAH income would be treated as 200 000 USDT and a
--     obligation for 1/40th of nothing-like-the-real-value would be booked
--     in the wrong currency entirely. `pending_obligations`/the created
--     `DROP_PENDING_PAYOUT` row are ALWAYS USDT (the drop's share of a
--     USDT-project's revenue is a USDT obligation by definition) — so this
--     filter is not optional narrowing, it is the ONLY way "amount" below
--     means what the created row claims it means;
--   - created_at is before this backfill's authorship cutoff (see BOUNDS
--     below) — security-review round 2 (PR #517, MED-B): scopes this
--     ONE-TIME script to the income rows that existed when it was written
--     and reviewed, so the set the owner approves in this report cannot
--     silently grow between this step and the apply step by a brand-new
--     declaration landing in between;
--   - its project has drop_id IS NOT NULL AND payment_type = 'USDT' — ONLY
--     USDT projects: on any other payment type the drop declares their OWN
--     income (createDropIncome) and a backfilled share here would DOUBLE the
--     obligation (AC6);
--   - the income is not already LINKED to an existing DROP_PENDING_PAYOUT /
--     PAYOUT_DROP row via `source_income_transaction_id` — that would mean
--     the fixed code (declareUsdtProjectIncome, post this task's companion
--     PR) already booked its share properly; nothing to backfill. The link
--     check does NOT require the linking row to be non-deleted — security-
--     review round 2 (PR #517, MED-E): the LINK is a permanent historical
--     fact ("this income was already processed"), independent of whether the
--     resulting obligation row is later soft-deleted by an admin. Requiring
--     `deleted_at IS NULL` here would let a soft-deleted backfilled row make
--     its income look unlinked again on a later run — a SECOND
--     DROP_PENDING_PAYOUT for the SAME income, breaking idempotency.
--
-- AMBIGUOUS (task's own rule: "сузь, а не расширяй" — narrow the selection,
-- never widen it by guessing): a project is entirely excluded — EVERY
-- ADMIN_INCOME candidate on it goes to the (aggregate) ambiguous count, none
-- are ever auto-processed — when EITHER of:
--   (a) it carries ANY existing DROP_PENDING_PAYOUT / PAYOUT_DROP row with
--       `source_income_transaction_id IS NULL` (a drop-share row whose
--       origin income cannot be determined — either pre-dates this column,
--       or was booked by some other historical path); or
--   (b) security-review round 2 (PR #517, HIGH-2) it carries ANY DROP_INCOME
--       row at all. `projects.payment_type` is a LIVE, current-state
--       snapshot, not a historical one — the enum landed 2026-07-13 with
--       EVERY existing project defaulted to 'FOP'; a project now showing
--       'USDT' may have spent part of its history as 'FOP' before someone
--       switched it. During any FOP-period a drop declares their OWN income
--       directly (`createDropIncome` → `DROP_INCOME`), entirely outside
--       `bookCompanyObligations` and this column — so a `DROP_INCOME` row
--       can represent the SAME underlying client revenue an `ADMIN_INCOME`
--       row on the SAME (now-USDT) project also records, with NO FK
--       anywhere linking the two. Backfilling a drop share for that
--       ADMIN_INCOME on top of an already-self-declared DROP_INCOME would
--       double-pay the drop for the same money — exactly the class of bug
--       AC6 already forbids for the CURRENT-state non-USDT case; this closes
--       the same hole for the HISTORICAL-state case.
-- Deliberately conservative on both — this may over-flag genuinely-unrelated
-- rows as "ambiguous" rather than trying to be clever about excluding them; a
-- human reviewing a short list is cheaper than a wrong guess on money.
--
-- Percent + amount — OWNER-APPROVED ASSUMPTION (say it out loud)
-- -----------------------------------------------------------------------------
-- No historical drop-share % was ever recorded for these incomes (the
-- snapshot columns were added later). This report — and the apply file that
-- follows it — compute the share using TODAY's `resolveDropShare` rule:
-- project override → drop's user-level default → 5%. If a project's or
-- drop's share % ever changed over time, the backfilled amount will NOT
-- match what would have been booked back when the income was originally
-- declared. This is a deliberate, disclosed approximation, not a bug — see
-- the task file (task-admin-income-drop-backfill.md) for the owner's framing.
--
-- security-review round 2 (PR #517, MED-C): the SAME today's-snapshot caveat
-- applies to WHICH drop gets the share. `projects.drop_id` is the CURRENT
-- binding, not a historical one — if a project's drop assignment ever
-- changed, this backfill attributes ALL of that project's historical
-- ADMIN_INCOME rows to whoever is bound TODAY, which may differ from who was
-- actually bound when a given income was originally declared. Disclosed here
-- for the same reason the percent assumption is disclosed above — no
-- historical drop-binding snapshot exists to consult instead.
--
-- `share_amount` below is a Postgres `numeric` (exact decimal) re-statement
-- of `roundShareAmount` (apps/api/src/finance/transactions.service.ts):
--   incomeMinor = Math.round(income * 1_000_000)
--   shareMinor  = Math.round(incomeMinor * percent / 100)
--   return shareMinor / 1_000_000  (already at 6dp)
-- `round(numeric)` rounds half AWAY FROM ZERO; `Math.round` rounds half
-- toward +Infinity — identical for the exclusively non-negative amounts this
-- script ever sees. Pinned by a real comparison test that reads this literal
-- expression OUT OF THIS FILE (not a hand-copied restatement of it) and runs
-- it against `roundShareAmount`, including genuine `.5`-tie cases:
--   apps/api/src/finance/admin-income-drop-backfill.integration.spec.ts
--   ("SQL rounding matches roundShareAmount byte-for-byte").
--
-- Run standalone:
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_report.sql
-- =============================================================================

DO $$
DECLARE
  rec RECORD;
  v_candidates integer := 0;
  v_candidate_total_usdt numeric(18, 6) := 0;
  v_ambiguous integer := 0;
BEGIN
  FOR rec IN
    WITH bounds AS (
      -- MED-B: this one-time script's scope is bounded to income rows that
      -- existed at authorship/review time — see the header note above.
      SELECT '2026-08-13 00:00:00+00'::timestamptz AS cutoff
    ),
    usdt_drop_incomes AS (
      SELECT
        t.id AS income_id,
        t.project_id,
        t.amount
      FROM transactions t
      JOIN projects p ON p.id = t.project_id
      CROSS JOIN bounds b
      WHERE t.type = 'ADMIN_INCOME'
        AND t.deleted_at IS NULL
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
    ),
    ambiguous_projects AS (
      SELECT DISTINCT project_id
      FROM transactions
      WHERE type IN ('DROP_PENDING_PAYOUT', 'PAYOUT_DROP')
        AND deleted_at IS NULL
        AND source_income_transaction_id IS NULL
        AND project_id IS NOT NULL
      UNION
      SELECT DISTINCT project_id
      FROM transactions
      WHERE type = 'DROP_INCOME'
        AND deleted_at IS NULL
        AND project_id IS NOT NULL
    )
    SELECT
      u.income_id,
      u.project_id,
      (
        round(round(u.amount * 1000000) * COALESCE(p.drop_share_percent_override, d.drop_share_percent, 5) / 100)
        / 1000000
      )::numeric(18, 6) AS share_amount,
      EXISTS (SELECT 1 FROM ambiguous_projects ap WHERE ap.project_id = u.project_id) AS is_ambiguous
    FROM usdt_drop_incomes u
    JOIN projects p ON p.id = u.project_id
    JOIN users d ON d.id = p.drop_id
    WHERE NOT EXISTS (SELECT 1 FROM linked l WHERE l.income_id = u.income_id)
  LOOP
    IF rec.is_ambiguous THEN
      v_ambiguous := v_ambiguous + 1;
    ELSE
      v_candidates := v_candidates + 1;
      v_candidate_total_usdt := v_candidate_total_usdt + rec.share_amount;
    END IF;
  END LOOP;

  RAISE NOTICE 'admin-income-drop-backfill REPORT (read-only, AGGREGATE-ONLY — row-level ids/names deliberately omitted from this public deploy log, see 2026-08-12_admin_income_drop_backfill_detail.sql for the private breakdown): % candidate(s) totalling % USDT of drop-share that would be created by the apply file, % ambiguous row(s) excluded pending manual review — nothing has been written yet',
    v_candidates, v_candidate_total_usdt, v_ambiguous;
END $$;
