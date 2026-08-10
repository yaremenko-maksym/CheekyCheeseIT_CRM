-- =============================================================================
-- Senior resume — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-resume-template: one resume per SENIOR, stored as LAYOUT (a Typst
-- template) plus DATA (structured fields); a PDF is the two joined. The
-- uploaded PDF/DOCX is only an INPUT — after a single AI extraction the app
-- works with the JSONB structure, never with the file.
--
-- Fully additive: two new enums, one new table, no existing table or column
-- touched. Sections 1-4 create the table; 5-6 add the layout and the rendered
-- PDF. Written as one file because `senior_resumes` has never existed in
-- production — the branch it was drafted on (#497) was closed unmerged.
--
-- The dev/CI database gets these changes via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push, see `.github/workflows/ci.yml`). The prod image does NOT
-- ship drizzle-kit, so prod is migrated with THIS script.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-10_senior_resume_template.sql
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

-- -----------------------------------------------------------------------------
-- 5. Layout + template (task-resume-template)
-- -----------------------------------------------------------------------------
-- A resume is stored as LAYOUT (a Typst template) + DATA (the JSONB above), and
-- a PDF is the two joined by a child process.
--
-- `template_source` holds a senior's own template. NO ENDPOINT WRITES THIS
-- COLUMN: a template is executable typesetting code, and the guarantee that a
-- render cannot be steered by user- or model-supplied text is worth more than
-- the convenience of letting someone paste one. Personal templates arrive from
-- the designer's task through a path that does not exist yet. NULL means "use
-- the one template shipped in the repo".
--
-- What a human MAY change is `layout`: an enumerated set of switches (section
-- order, hidden sections, density, font scale), validated by
-- `resumeLayoutOptionsSchema` in packages/shared and normalised on every read.
ALTER TABLE senior_resumes ADD COLUMN IF NOT EXISTS template_source text;
ALTER TABLE senior_resumes ADD COLUMN IF NOT EXISTS template_name text;
ALTER TABLE senior_resumes ADD COLUMN IF NOT EXISTS layout jsonb NOT NULL
  DEFAULT '{"sectionOrder":["summary","skills","experience","education","languages","links"],"hiddenSections":[],"density":"normal","fontScale":"normal"}'::jsonb;

-- -----------------------------------------------------------------------------
-- 6. Rendered PDF, built by a job and never inside a request
-- -----------------------------------------------------------------------------
-- Typesetting is unbounded CPU driven by untrusted content, so it happens in a
-- detached job and the endpoint serves the stored artefact (or 202 + a state to
-- poll). Separate status column from the extraction one because the two run at
-- different times for different reasons: extraction once per uploaded file, a
-- render on every content or layout change.
DO $$
BEGIN
  CREATE TYPE resume_render_status AS ENUM ('IDLE', 'QUEUED', 'RUNNING', 'READY', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE senior_resumes ADD COLUMN IF NOT EXISTS pdf_s3_key text;
-- SHA-256 of the exact render input the stored PDF was built from. Freshness is
-- a COMPARISON of this against the current input's fingerprint rather than a
-- version counter: the render is deterministic (pinned creation timestamp, no
-- system fonts, single job), so equal fingerprints really do mean equal bytes.
ALTER TABLE senior_resumes ADD COLUMN IF NOT EXISTS pdf_fingerprint text;
ALTER TABLE senior_resumes ADD COLUMN IF NOT EXISTS pdf_render_status resume_render_status
  NOT NULL DEFAULT 'IDLE';
ALTER TABLE senior_resumes ADD COLUMN IF NOT EXISTS pdf_render_error text;
ALTER TABLE senior_resumes ADD COLUMN IF NOT EXISTS pdf_render_started_at timestamptz;
-- Which render attempt owns the row, exactly as extraction_run_id does for
-- extraction: a render superseded by a newer save must discard its bytes rather
-- than advertise a stale PDF as the current one.
ALTER TABLE senior_resumes ADD COLUMN IF NOT EXISTS pdf_render_run_id uuid;

-- The stuck-RENDER sweep filters on exactly this pair (same shape as the
-- extraction sweep above, different columns).
CREATE INDEX IF NOT EXISTS idx_senior_resumes_render_status
  ON senior_resumes (pdf_render_status, pdf_render_started_at);
