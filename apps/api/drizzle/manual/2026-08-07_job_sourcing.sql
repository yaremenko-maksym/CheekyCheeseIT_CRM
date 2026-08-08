-- =============================================================================
-- Job sourcing (slice 1) — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-job-sourcing-slice1: semi-automatic applying to EXTERNAL vacancies.
-- Vacancies are collected from a third-party feed (DOU RSS), filtered per
-- senior (so a senior is never offered a job at their own client), shown in a
-- modal, and the outcome is recorded. Four brand-new tables + 3 new enums —
-- fully additive, no existing table/column touched.
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
--     < apps/api/drizzle/manual/2026-08-07_job_sourcing.sql
--
-- DevOps must add this file to the "Pull, up, migrate, health-check" step of
-- .github/workflows/deploy.yml and apply it BEFORE the new image serves
-- traffic (same pattern as the telemetry / vacancies DDL tail). That wiring is
-- a separate DevOps PR — this PR only ships the script + the note in its body.
--
-- Idempotent: guarded `CREATE TYPE` (duplicate_object swallowed) +
-- `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` — safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enums (guarded CREATE for idempotency)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE job_source_type AS ENUM ('DOU_RSS');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE job_suggestion_status AS ENUM ('NEW', 'APPLIED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE job_exclusion_kind AS ENUM ('COMPANY', 'KEYWORD');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 2. job_sources — configured feeds
-- -----------------------------------------------------------------------------
-- `config` holds source-specific knobs ONLY (for DOU: `{"category": "..."}`,
-- validated against an allow-list in code). It deliberately does NOT hold a
-- URL: an admin-writable URL would turn the collector into an SSRF primitive.
-- The endpoint is a constant inside the provider implementation.
CREATE TABLE IF NOT EXISTS job_sources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type               job_source_type NOT NULL,
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled            boolean NOT NULL DEFAULT true,
  last_collected_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_job_sources_type_config UNIQUE (type, config)
);

-- -----------------------------------------------------------------------------
-- 3. job_postings — one row per external vacancy
-- -----------------------------------------------------------------------------
-- UNTRUSTED third-party content: `url` is https-only, `description_md` is
-- markdown with NO raw HTML (converted + stripped at ingest).
CREATE TABLE IF NOT EXISTS job_postings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type              job_source_type NOT NULL,
  source_id                uuid REFERENCES job_sources(id) ON DELETE SET NULL,
  external_id              text NOT NULL,
  url                      text NOT NULL,
  title                    text NOT NULL,
  company_name             text NOT NULL,
  company_name_normalized  text NOT NULL,
  location                 text,
  description_md           text NOT NULL,
  published_at             timestamptz,
  -- sha256(source_type|canonical url). Canonical = query string stripped:
  -- DOU's <guid> carries a fresh timestamp query on every fetch, so a raw-URL
  -- fingerprint would re-insert the same vacancy on every collection run.
  fingerprint              text NOT NULL,
  collected_at             timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_postings_fingerprint
  ON job_postings (fingerprint);
-- `DESC NULLS LAST` (not bare `DESC`, whose Postgres default is NULLS FIRST) —
-- byte-for-byte what drizzle-kit emits for `.desc()`, so prod created by this
-- script and dev created by `db:push` end up with the IDENTICAL index.
CREATE INDEX IF NOT EXISTS idx_job_postings_published_at
  ON job_postings (published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_job_postings_company_normalized
  ON job_postings (company_name_normalized);

-- -----------------------------------------------------------------------------
-- 4. job_suggestions — posting × senior, with the outcome
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_suggestions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id         uuid NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  senior_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status             job_suggestion_status NOT NULL DEFAULT 'NEW',
  status_changed_at  timestamptz,
  status_changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- One suggestion per (posting, senior): what makes a REJECTED posting STAY
-- rejected — a later collection run cannot insert a second NEW row for the pair.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_suggestions_posting_senior
  ON job_suggestions (posting_id, senior_id);
CREATE INDEX IF NOT EXISTS idx_job_suggestions_senior_status
  ON job_suggestions (senior_id, status);

-- -----------------------------------------------------------------------------
-- 5. job_exclusion_filters — manual exclusions (GLOBAL when senior_id IS NULL)
-- -----------------------------------------------------------------------------
-- Exclusions DERIVED from a senior's own projects are NOT stored here — they
-- are recomputed on every read so they can never go stale.
CREATE TABLE IF NOT EXISTS job_exclusion_filters (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  kind              job_exclusion_kind NOT NULL,
  value             text NOT NULL,
  normalized_value  text NOT NULL,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Two PARTIAL unique indexes, not one plain index: Postgres treats NULLs as
-- distinct, so a plain unique index over a nullable senior_id would accept the
-- same GLOBAL entry any number of times.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_exclusions_global
  ON job_exclusion_filters (kind, normalized_value)
  WHERE senior_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_exclusions_senior
  ON job_exclusion_filters (senior_id, kind, normalized_value)
  WHERE senior_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_exclusions_senior
  ON job_exclusion_filters (senior_id);

-- -----------------------------------------------------------------------------
-- 6. Seed the one source slice 1 ships with (idempotent)
-- -----------------------------------------------------------------------------
-- Empty config = the feed's default category mix. Adding narrower categories is
-- an ADMIN action later; this row only guarantees the collector has something
-- to run against on a fresh prod database.
INSERT INTO job_sources (type, config)
VALUES ('DOU_RSS', '{}'::jsonb)
ON CONFLICT ON CONSTRAINT uq_job_sources_type_config DO NOTHING;
