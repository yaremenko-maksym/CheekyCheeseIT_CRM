-- =============================================================================
-- Vacancy sourcing v1 — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- Vacancy-sourcing phase 1 (docs/superpowers/plans/2026-10-04-vacancy-sourcing-plan.md,
-- Task 1.2). Turns `job_postings` into an HR-facing work queue and widens the
-- source catalogue from 1 to 31 types:
--   * 30 new `job_source_type` members (DOU_RSS already exists);
--   * three new enums: job_queue_status, job_seniority, job_posting_signal_kind;
--   * cadence + auto-disable columns on `job_sources`;
--   * queue / dedupe / ranking columns + indexes on `job_postings`;
--   * `job_posting_signals` — one row per HR action on a posting.
--
-- Additive only: no existing column is altered, no data is rewritten. Existing
-- postings get `dedupe_key = NULL` (legacy rows, invisible to the queue) and
-- `queue_status = 'NEW'`.
--
-- Idempotent — safe to re-run. deploy.yml applies every manual/*.sql file on
-- EVERY deploy (there is no applied-migrations registry).
--
-- Constraints worth knowing
-- -------------------------
--   * `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block together
--     with later USE of the new value. Apply this file WITHOUT `psql -1` /
--     `--single-transaction`. This file contains DDL only (no row uses a new
--     value); seed data lives in 2026-10-05_vacancy_sources_seed.sql and must be
--     applied AFTER this one.
--   * CREATE TYPE has no IF NOT EXISTS form, so each new enum is created in a
--     `DO $$ ... EXCEPTION WHEN duplicate_object` guard.
--
-- The dev/CI database gets these changes via `pnpm --filter @crm/api db:push`.
-- The prod image does NOT ship drizzle-kit, so prod is migrated with THIS script.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-10-05_vacancy_sourcing_schema.sql

ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'REMOTEOK_API';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'REMOTIVE_API';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'HIMALAYAS_API';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'JOBICY_API';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'ARBEITNOW_API';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'WORKINGNOMADS_API';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'JOBGETHER_API';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'HN_HIRING';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'GREENHOUSE_ATS';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'LEVER_ATS';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'ASHBY_ATS';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'WORKABLE_ATS';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'SMARTRECRUITERS_ATS';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'RECRUITEE_ATS';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'PERSONIO_ATS';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'JOOBLE_API';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'JSEARCH_API';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'THEIRSTACK_API';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'MUSE_API';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'REED_API';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'DJINNI_RSS';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'WWR_RSS';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'EUREMOTEJOBS_RSS';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'JUSTJOIN_HTML';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'NOFLUFF_HTML';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'LANDINGJOBS_HTML';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'NEXTLEVELJOBS_HTML';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'DICE_HTML';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'THEHUB_HTML';
ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'WTTJ_HTML';

DO $$ BEGIN CREATE TYPE job_queue_status AS ENUM ('NEW', 'IN_PROGRESS', 'DISMISSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE job_seniority AS ENUM ('MIDDLE', 'SENIOR', 'LEAD', 'UNKNOWN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE job_posting_signal_kind AS ENUM ('OPENED', 'TAKEN', 'DEAD_LINK', 'SPAM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE job_sources
  ADD COLUMN IF NOT EXISTS min_interval_hours integer,
  ADD COLUMN IF NOT EXISTS disabled_reason text;

ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS also_seen_on jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS matched_senior_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS matched_keywords text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS seniority job_seniority NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS stack_unknown boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rank_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS queue_status job_queue_status NOT NULL DEFAULT 'NEW',
  ADD COLUMN IF NOT EXISTS taken_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS taken_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_postings_dedupe_key ON job_postings (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_postings_queue ON job_postings (queue_status, rank_score DESC, collected_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_job_postings_matched_seniors ON job_postings USING gin (matched_senior_ids);

CREATE TABLE IF NOT EXISTS job_posting_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id uuid NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind job_posting_signal_kind NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_posting_signals_posting ON job_posting_signals (posting_id, kind);
