-- =============================================================================
-- Vacancy i18n + JobPosting SEO enrichment — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-vacancy-i18n-jobposting (Block C of the "Лендинг i18n + SEO" wave,
-- plan-landing-i18n-seo.md §3/§4 Block C). Adds 7 columns to the existing
-- `vacancies` table — fully additive, no existing column/type touched.
--
--   translations        jsonb    nullable  — 5-locale i18n (en default + uk/ru/es/pt
--                                             optional overrides, plan §3 contract)
--   skills               text[]  nullable  — JobPosting `skills` (C3)
--   experience_months    integer nullable  — JobPosting `experienceRequirements.monthsOfExperience`
--   qualifications        text   nullable  — JobPosting `qualifications`
--   responsibilities      text   nullable  — JobPosting `responsibilities`
--   job_benefits          text   nullable  — JobPosting `jobBenefits`
--   work_hours            text   nullable  — JobPosting `workHours`
--
-- `industry` / `occupationalCategory` are NOT stored columns — computed at the
-- apps/landing seo.ts JSON-LD-builder layer (derived from `domain` / a
-- business-wide constant respectively) — see that file's header comment.
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
--     < apps/api/drizzle/manual/2026-07-25_vacancy_i18n_seo.sql
--
-- Add this file to .github/workflows/deploy.yml ("Pull, up, migrate,
-- health-check" step) and apply it BEFORE the new image serves traffic (like
-- the vacancies/telemetry DDL tails before it). DevOps/PM own that wiring —
-- this PR only ships the script + this note.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` — safe to re-run.
-- =============================================================================

ALTER TABLE vacancies
  ADD COLUMN IF NOT EXISTS translations       jsonb,
  ADD COLUMN IF NOT EXISTS skills              text[],
  ADD COLUMN IF NOT EXISTS experience_months   integer,
  ADD COLUMN IF NOT EXISTS qualifications      text,
  ADD COLUMN IF NOT EXISTS responsibilities    text,
  ADD COLUMN IF NOT EXISTS job_benefits        text,
  ADD COLUMN IF NOT EXISTS work_hours          text;

-- =============================================================================
-- VERIFY (after applying):
--   \d+ vacancies
--   SELECT slug, translations, skills, experience_months FROM vacancies LIMIT 5;
-- =============================================================================
--
-- Rollback (feature-level, safe even with prod data — purely additive columns):
--   ALTER TABLE vacancies
--     DROP COLUMN IF EXISTS translations,
--     DROP COLUMN IF EXISTS skills,
--     DROP COLUMN IF EXISTS experience_months,
--     DROP COLUMN IF EXISTS qualifications,
--     DROP COLUMN IF EXISTS responsibilities,
--     DROP COLUMN IF EXISTS job_benefits,
--     DROP COLUMN IF EXISTS work_hours;
-- =============================================================================
