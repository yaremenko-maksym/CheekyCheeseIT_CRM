-- =============================================================================
-- Admin-income drop-share backfill — DETAIL (standalone, READ-ONLY, no writes)
-- MANUAL / PRIVATE ONLY — DO NOT WIRE THIS FILE INTO deploy.yml OR ANY CI JOB.
-- task-admin-income-drop-backfill
-- =============================================================================
--
-- security-review round 2 (PR #517, HIGH-3). This file is the row-level
-- counterpart of `2026-08-12_admin_income_drop_backfill_report.sql`, which
-- prints only aggregate counts because it runs inside the automated,
-- deploy-wired pipeline whose logs are PUBLIC (this repository is public,
-- and so are its GitHub Actions logs). Client names, drop display names, and
-- per-transaction USDT amounts are exactly the kind of data that must never
-- land there.
--
-- This file exists so an owner can still SEE that row-level breakdown when
-- they actually need it — WHICH incomes, WHICH projects, WHICH drop — without
-- inventing a new delivery channel for it. Run it the SAME way the project
-- already runs any one-off prod inspection: directly, by one of the two
-- admins with prod DB access (see project-state.md — prod DB access is
-- already restricted to migrations + those two people), in a private
-- terminal session:
--
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_detail.sql
--
-- The output stays in that local terminal / SSH session — never in a CI log,
-- never posted anywhere automated. `scripts/devops/check-prod-ddl-wiring.py`
-- must NOT be told about this file (it is not deploy-time DDL and must never
-- become part of the deploy step's `source:`/migrate list); if a future PR
-- wants a durable, non-interactive way to deliver this same row-level detail
-- to a private audience, the existing private channel this repo already has
-- is `scripts/devops/post-merge-alert.sh` (posts to the private
-- `cheekycheese-telemetry` repo) — but that is a DevOps-owned bash script,
-- outside Coder's zone-of-write, and it does not currently know how to run
-- an arbitrary SQL file and forward its NOTICE output; wiring the two
-- together is a deliberate follow-up decision for a separate infra PR, not
-- something this file does for itself. See this PR's body for the proposal.
--
-- Selection predicate — IDENTICAL to the automated report/apply files (same
-- CTEs, same WHERE clauses, same cutoff, same currency filter, same
-- ambiguity rules) so the row-level breakdown here can never disagree with
-- what the aggregate counts in the public log say or with what the apply
-- file would actually do. See `2026-08-12_admin_income_drop_backfill_report
-- .sql`'s header for the full reasoning behind every clause.
--
-- 100% read-only: no CREATE/INSERT/UPDATE/DELETE of any kind, not even a
-- temp table — proven by admin-income-drop-backfill.integration.spec.ts
-- (AC3-detail): table row counts are identical before and after running it.
-- =============================================================================

DO $$
DECLARE
  rec RECORD;
  v_candidates integer := 0;
  v_ambiguous integer := 0;
BEGIN
  FOR rec IN
    WITH bounds AS (
      SELECT '2026-08-13 00:00:00+00'::timestamptz AS cutoff
    ),
    usdt_drop_incomes AS (
      SELECT
        t.id AS income_id,
        t.project_id,
        t.amount,
        COALESCE(t.tx_date, t.created_at) AS effective_date,
        p.name AS project_name,
        p.drop_id,
        p.drop_share_percent_override
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
      u.project_name,
      u.effective_date,
      u.amount,
      u.drop_id,
      d.display_name AS drop_name,
      COALESCE(u.drop_share_percent_override, d.drop_share_percent, 5) AS resolved_percent,
      CASE
        WHEN u.drop_share_percent_override IS NOT NULL THEN 'PROJECT'
        ELSE 'USER_DEFAULT'
      END AS percent_source,
      (
        round(round(u.amount * 1000000) * COALESCE(u.drop_share_percent_override, d.drop_share_percent, 5) / 100)
        / 1000000
      )::numeric(18, 6) AS share_amount,
      EXISTS (SELECT 1 FROM ambiguous_projects ap WHERE ap.project_id = u.project_id) AS is_ambiguous
    FROM usdt_drop_incomes u
    JOIN users d ON d.id = u.drop_id
    WHERE NOT EXISTS (SELECT 1 FROM linked l WHERE l.income_id = u.income_id)
    ORDER BY u.effective_date
  LOOP
    IF rec.is_ambiguous THEN
      v_ambiguous := v_ambiguous + 1;
      RAISE NOTICE 'AMBIGUOUS — income=% project=% (%) date=% amount=% USDT drop=% (%) — project already carries an untagged drop-share row or a DROP_INCOME row, origin cannot be determined; SKIPPED on both the report and the apply file, resolve manually',
        rec.income_id, rec.project_name, rec.project_id, rec.effective_date, rec.amount, rec.drop_name, rec.drop_id;
    ELSE
      v_candidates := v_candidates + 1;
      RAISE NOTICE 'CANDIDATE — income=% project=% (%) date=% amount=% USDT drop=% (%) percent=% source=% share=% USDT',
        rec.income_id, rec.project_name, rec.project_id, rec.effective_date, rec.amount, rec.drop_name, rec.drop_id, rec.resolved_percent, rec.percent_source, rec.share_amount;
    END IF;
  END LOOP;

  RAISE NOTICE 'admin-income-drop-backfill DETAIL (read-only, private, run manually — never in CI): % candidate(s), % ambiguous row(s) — nothing has been written yet',
    v_candidates, v_ambiguous;
END $$;
