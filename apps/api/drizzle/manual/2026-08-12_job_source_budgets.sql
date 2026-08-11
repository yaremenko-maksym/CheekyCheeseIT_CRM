-- =============================================================================
-- Job source request budgets + trigger mode — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-vacancy-matching §4/§5. External job APIs meter us, each differently:
-- Adzuna 250/day, JSearch 200/MONTH (hard), Jooble 500/period, DOU's RSS feed
-- not at all. Until now nothing in the schema knew that, so the only thing
-- stopping us from burning a paid monthly quota in an afternoon was everyone
-- remembering not to. These columns make the limit mechanical: the collector
-- reads them BEFORE it goes to the network and refuses, loudly, when the
-- allowance is spent.
--
-- `trigger_mode` is the same fact from the other side: JSearch's 200/month is
-- ~6 requests a day, which is useless on a schedule but ample when an operator
-- aims it at one senior. So each source declares who may collect it.
--
-- Fully additive — two new enums and five nullable/defaulted columns on an
-- existing table. No existing column is altered, no data is rewritten, and
-- every source that exists today keeps behaving exactly as it does now: DOU
-- ends up with budget_limit NULL (= no published limit) and trigger_mode
-- 'SCHEDULED' (= the daily cron, which is what it does today).
--
-- The dev/CI database gets these changes via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push, see `.github/workflows/ci.yml`). The prod image does NOT
-- ship drizzle-kit, so prod is migrated with THIS script.
--
-- How to apply
-- ------------
-- From the VPS (or any host with Docker access to the prod stack):
--
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-12_job_source_budgets.sql
--
-- DevOps must add this file to the "Pull, up, migrate, health-check" step of
-- .github/workflows/deploy.yml and apply it BEFORE the new image serves
-- traffic (same pattern as the job-sourcing / telemetry DDL tail). That wiring
-- is a separate DevOps PR — this PR only ships the script + the note in its body.
--
-- Idempotent: guarded `CREATE TYPE` (duplicate_object swallowed) +
-- `ADD COLUMN IF NOT EXISTS` — safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enums (guarded CREATE for idempotency)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE job_source_budget_window AS ENUM ('DAY', 'MONTH');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE job_source_trigger_mode AS ENUM ('SCHEDULED', 'MANUAL', 'BOTH');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Columns on job_sources
-- -----------------------------------------------------------------------------
--
-- budget_limit stays NULLABLE on purpose. NULL is the ONE value that means "no
-- published limit"; a source that HAS a limit must carry a credible positive
-- integer. Anything else (NaN cannot reach an integer column, but a hand-edited
-- 0 or a negative can) is read by the application as a BROKEN limit and stops
-- collection outright — the safe direction. See source-budget.ts.
ALTER TABLE job_sources
  ADD COLUMN IF NOT EXISTS budget_limit integer,
  ADD COLUMN IF NOT EXISTS budget_window job_source_budget_window,
  ADD COLUMN IF NOT EXISTS budget_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_window_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS trigger_mode job_source_trigger_mode NOT NULL DEFAULT 'SCHEDULED';

-- -----------------------------------------------------------------------------
-- 3. Sanity guard on the counter
-- -----------------------------------------------------------------------------
-- The application already refuses to trust a negative counter (it reads one as
-- "fully spent"), but there is no reason to let the row hold one in the first
-- place. Cheap, and it keeps the two layers agreeing.
DO $$
BEGIN
  ALTER TABLE job_sources ADD CONSTRAINT job_sources_budget_used_non_negative
    CHECK (budget_used >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
