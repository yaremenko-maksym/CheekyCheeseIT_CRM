-- =============================================================================
-- Senior resume — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-resume-base: one canonical, structured resume per SENIOR. The uploaded
-- PDF/DOCX is only an INPUT — after a single AI extraction the app works with
-- the JSONB structure, never with the file. Fully additive: one new enum, one
-- new table, no existing table/column touched.
--
-- The dev/CI database gets these changes via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push, see `.github/workflows/ci.yml`). The prod image does NOT
-- ship drizzle-kit, so prod is migrated with THIS script.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-07_senior_resume.sql
--
-- This file must be wired into .github/workflows/deploy.yml ("Pull, up,
-- migrate, health-check" step) BEFORE the new image serves traffic. DevOps
-- owns that wiring — this PR does NOT touch deploy.yml (task §Границы).
--
-- Idempotent: guarded `CREATE TYPE` + `CREATE TABLE IF NOT EXISTS` +
-- `CREATE INDEX IF NOT EXISTS` — safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enum (guarded CREATE for idempotency)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE resume_extraction_status AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 2. senior_resumes — one row per senior
-- -----------------------------------------------------------------------------
-- `user_id UNIQUE` is the concurrency guard: two simultaneous "create my
-- resume" requests cannot produce two rows — the loser gets a unique
-- violation, which SeniorResumesService turns into a re-read.
--
-- `ON DELETE CASCADE` on user_id: a hard-deleted user takes their resume
-- (PII) with them, no orphan rows.
--
-- `updated_by_user_id ON DELETE SET NULL`: the "who last edited" attribution
-- must never block deleting that editor's account.
CREATE TABLE IF NOT EXISTS senior_resumes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  content                  jsonb NOT NULL DEFAULT '{"summary":"","skills":[],"experience":[],"education":[],"languages":[],"links":[]}'::jsonb,
  status                   resume_extraction_status NOT NULL DEFAULT 'READY',
  error_code               text,
  error_message            text,
  quota_resets_at          timestamptz,
  extraction_started_at    timestamptz,
  last_extraction_tokens   integer,
  source_s3_key            text,
  source_file_name         text,
  source_file_size_bytes   integer,
  source_mime_type         text,
  version                  integer NOT NULL DEFAULT 0,
  updated_by_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- The stuck-RUNNING sweep (ResumeExtractionCronService) filters on exactly
-- this pair: status = 'RUNNING' AND extraction_started_at < cutoff.
CREATE INDEX IF NOT EXISTS idx_senior_resumes_status
  ON senior_resumes (status, extraction_started_at);

-- -----------------------------------------------------------------------------
-- 3. Extraction ownership token
-- -----------------------------------------------------------------------------
-- Which attempt owns the row right now. A run stamps this when it claims the
-- row and its terminal write requires the value to be unchanged; a newer
-- upload / pasted text / manual save clears it. Without it, a slow extraction
-- could finish last and overwrite a manual save — or the result of a file the
-- user has already replaced.
--
-- Nullable and unindexed on purpose: it is only ever read as an equality
-- predicate on a row already located by primary key.
ALTER TABLE senior_resumes ADD COLUMN IF NOT EXISTS extraction_run_id uuid;

-- -----------------------------------------------------------------------------
-- 4. Index for the abandoned-QUEUED sweep
-- -----------------------------------------------------------------------------
-- The index above serves `status = 'RUNNING' AND extraction_started_at < cutoff`.
-- The other half of the sweep asks a DIFFERENT question — `status = 'QUEUED'
-- AND updated_at < cutoff` — because a QUEUED row was never claimed and so has
-- no extraction_started_at to age it by. That query had no index at all.
CREATE INDEX IF NOT EXISTS idx_senior_resumes_status_updated_at
  ON senior_resumes (status, updated_at);
