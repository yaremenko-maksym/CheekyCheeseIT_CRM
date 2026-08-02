-- =============================================================================
-- Vacancy salary range — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-vacancy-salary-range: Google Search Console flagged every vacancy's
-- structured data as missing `baseSalary` and was substituting its OWN market
-- estimate instead — owner decision 2026-07-31: a public salary range is now
-- MANDATORY on every vacancy going forward. Adds 4 columns to the existing
-- `vacancies` table — fully additive, no existing column/type touched.
--
--   salary_min       numeric(12,2)          nullable
--   salary_max       numeric(12,2)          nullable
--   salary_currency  currency (EXISTING enum, already shared by
--                     users.salary_currency / transactions.currency)
--   salary_period     vacancy_salary_period (NEW enum: HOUR/DAY/WEEK/MONTH/YEAR
--                     — matches Google's JobPosting baseSalary.value.unitText)
--
-- Columns are NULLABLE even though the app enforces the range as mandatory at
-- create-time and at publish-time (packages/shared createVacancySchema +
-- VacanciesService.assertSalaryFilled): there are already 3 vacancies
-- PUBLISHED on prod before this change, and a NOT NULL constraint cannot be
-- retrofitted onto existing rows without inventing values (explicitly out of
-- scope — the owner fills these in through the CRM UI after this ships). The
-- public page/JobPosting markup both keep working with the range absent
-- (`baseSalary` is simply omitted from the JSON-LD until filled in).
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
--     < apps/api/drizzle/manual/2026-08-01_vacancy_salary_range.sql
--
-- Add this file to .github/workflows/deploy.yml ("Pull, up, migrate,
-- health-check" step) and apply it BEFORE the new image serves traffic (same
-- convention as the vacancy i18n/SEO DDL tail before it). DevOps/PM own that
-- wiring — this PR only ships the script + this note (see PR body).
--
-- Idempotent: guarded `CREATE TYPE` (duplicate_object exception swallowed) +
-- `ADD COLUMN IF NOT EXISTS` — safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. New enum (guarded CREATE for idempotency). `currency` already exists —
--    reused as-is, no CREATE TYPE needed for it.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE vacancy_salary_period AS ENUM ('HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 2. vacancies — 4 new nullable columns
-- -----------------------------------------------------------------------------
ALTER TABLE vacancies
  ADD COLUMN IF NOT EXISTS salary_min      numeric(12, 2),
  ADD COLUMN IF NOT EXISTS salary_max      numeric(12, 2),
  ADD COLUMN IF NOT EXISTS salary_currency currency,
  ADD COLUMN IF NOT EXISTS salary_period   vacancy_salary_period;

-- =============================================================================
-- VERIFY (after applying):
--   \d+ vacancies
--   SELECT unnest(enum_range(NULL::vacancy_salary_period));
--   SELECT slug, salary_min, salary_max, salary_currency, salary_period FROM vacancies;
-- =============================================================================
--
-- Rollback (feature-level, safe even with prod data — purely additive columns):
--   ALTER TABLE vacancies
--     DROP COLUMN IF EXISTS salary_min,
--     DROP COLUMN IF EXISTS salary_max,
--     DROP COLUMN IF EXISTS salary_currency,
--     DROP COLUMN IF EXISTS salary_period;
--   DROP TYPE IF EXISTS vacancy_salary_period;
-- =============================================================================
