-- =============================================================================
-- Vacancies module — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-vacancies-api: public vacancies (landing) + admin CRUD (CRM). Two brand
-- new tables + 5 new enums — fully additive, no existing table/column touched.
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
--     < apps/api/drizzle/manual/2026-07-22_vacancies.sql
--
-- Add this file to .github/workflows/deploy.yml ("Pull, up, migrate,
-- health-check" step) and apply it BEFORE the new image serves traffic (like
-- the mega-audit DDL tail). DevOps/PM own that wiring — this PR only ships the
-- script + this note.
--
-- Idempotent: guarded `CREATE TYPE` (duplicate_object exception swallowed) +
-- `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` — safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enums (guarded CREATE for idempotency)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE vacancy_domain AS ENUM ('AI', 'EDTECH', 'ECOMMERCE', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE vacancy_seniority AS ENUM ('SENIOR', 'LEAD');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE vacancy_employment_type AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE vacancy_status AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE vacancy_application_status AS ENUM ('NEW', 'VIEWED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 2. vacancies
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vacancies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE,
  title            text NOT NULL,
  description_md   text NOT NULL,
  domain           vacancy_domain NOT NULL,
  seniority        vacancy_seniority NOT NULL,
  employment_type  vacancy_employment_type NOT NULL,
  location         text NOT NULL,
  status           vacancy_status NOT NULL DEFAULT 'DRAFT',
  published_at     timestamptz,
  closed_at        timestamptz,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vacancies_status ON vacancies (status);

-- -----------------------------------------------------------------------------
-- 3. vacancy_applications
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vacancy_applications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vacancy_id         uuid NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  full_name          text NOT NULL,
  email              text NOT NULL,
  telegram           text,
  linkedin_url       text,
  github_url         text,
  cover_letter       text,
  resume_s3_key      text NOT NULL,
  resume_size_bytes  integer NOT NULL,
  status             vacancy_application_status NOT NULL DEFAULT 'NEW',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vacancy_applications_vacancy_created
  ON vacancy_applications (vacancy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vacancy_applications_email_vacancy
  ON vacancy_applications (email, vacancy_id);

-- =============================================================================
-- VERIFY (after applying):
--   \d+ vacancies
--   \d+ vacancy_applications
--   SELECT unnest(enum_range(NULL::vacancy_status));
-- =============================================================================
--
-- Rollback (feature-level, no prod data expected yet):
--   DROP TABLE IF EXISTS vacancy_applications;
--   DROP TABLE IF EXISTS vacancies;
--   DROP TYPE IF EXISTS vacancy_application_status;
--   DROP TYPE IF EXISTS vacancy_status;
--   DROP TYPE IF EXISTS vacancy_employment_type;
--   DROP TYPE IF EXISTS vacancy_seniority;
--   DROP TYPE IF EXISTS vacancy_domain;
-- =============================================================================
