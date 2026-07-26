-- =============================================================================
-- CSP violation reports — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-csp-reports-and-flip (Часть A): public CSP-violation report endpoint
-- (POST /api/public/csp-report). ONE brand new table + 1 new enum — fully
-- additive, no existing table/column touched.
--
-- The dev/CI database gets these changes via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push, see `.github/workflows/ci.yml`). The prod image does NOT
-- ship drizzle-kit, so prod is migrated with THIS script (same pattern as
-- apps/api/drizzle/manual/2026-07-24_telemetry.sql).
--
-- How to apply
-- ------------
-- From the VPS (or any host with Docker access to the prod stack):
--
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-07-26_csp_reports.sql
--
-- DEPENDENCY (task §Часть A item 3, flagged in the PR body): add this file to
-- .github/workflows/deploy.yml's DDL-apply step, guarded the SAME way as the
-- telemetry file (safe/no-op if this file is absent — this PR only ships the
-- script; DevOps owns the deploy.yml wiring, see infra/csp-report-wiring).
-- `scripts/devops/check-prod-ddl-wiring.py` will flag a missing wire-up.
--
-- Idempotent: guarded `CREATE TYPE` (duplicate_object exception swallowed) +
-- `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` — safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enum (guarded CREATE for idempotency)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE csp_disposition AS ENUM ('report', 'enforce');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 2. csp_reports — one row per DISTINCT (effectiveDirective, blockedUri, documentPath)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS csp_reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_directive   text NOT NULL,
  blocked_uri           text NOT NULL,
  document_path         text NOT NULL,
  disposition           csp_disposition NOT NULL DEFAULT 'report',
  user_agent            text,
  count                 integer NOT NULL DEFAULT 1,
  first_seen            timestamptz NOT NULL DEFAULT now(),
  last_seen             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_csp_reports_aggregate_key
  ON csp_reports (effective_directive, blocked_uri, document_path);

CREATE INDEX IF NOT EXISTS idx_csp_reports_last_seen
  ON csp_reports (last_seen);

-- =============================================================================
-- VERIFY (after applying):
--   \d+ csp_reports
--   SELECT unnest(enum_range(NULL::csp_disposition));
-- =============================================================================
--
-- Rollback (feature-level, no prod data expected yet):
--   DROP TABLE IF EXISTS csp_reports;
--   DROP TYPE IF EXISTS csp_disposition;
-- =============================================================================
