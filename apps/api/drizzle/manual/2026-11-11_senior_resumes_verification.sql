-- Verified base resume: facts, verification state and staged columns on senior_resumes (spec §8, Task 13).
--
-- WHAT THIS FILE DOES
--   Creates the enum resume_verification_status and adds to senior_resumes: facts (JSONB, NULL = a legacy
--   row whose facts are mapped from content on read), verification_status (default DRAFT, so every existing
--   row starts as DRAFT, spec §3), the run columns (run id, kind, target path, base version, queued/started
--   timestamps, error code, report), verified_version/at/by, and the staged columns written only by a check
--   run (staged_content, staged_layout, staged_template_name, staged_pdf_s3_key, staged_edited_paths
--   default '[]'). Fully additive: no existing column is touched. Re-runnable: guarded CREATE TYPE and
--   ADD COLUMN IF NOT EXISTS.
--
-- The Drizzle declaration of the same objects is seniorResumes in apps/api/src/database/schema/resumes.ts
-- and resumeVerificationStatusEnum in apps/api/src/database/schema/enums.ts; dev/CI get them by db:push.
--
-- PRIVILEGE CLASS
--   No new relation: the columns inherit senior_resumes' existing grants.
--
-- WHY THIS FILE WAS STAGED
--   It sat in manual-staged/ until the deploy wired it. It now lives in manual/: the deploy copies and
--   applies it (.github/workflows/deploy.yml, DevOps' zone) before the image that reads these columns
--   serves traffic.
--   Rollback: drop the added columns, then the type.

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  CREATE TYPE resume_verification_status AS ENUM (
    'DRAFT', 'QUEUED', 'CHECKING', 'AWAITING_CONFIRM', 'VERIFIED', 'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE senior_resumes
  ADD COLUMN IF NOT EXISTS facts jsonb,
  ADD COLUMN IF NOT EXISTS verification_status resume_verification_status DEFAULT 'DRAFT' NOT NULL,
  ADD COLUMN IF NOT EXISTS verification_run_id uuid,
  ADD COLUMN IF NOT EXISTS verification_kind text,
  ADD COLUMN IF NOT EXISTS verification_target_path text,
  ADD COLUMN IF NOT EXISTS verification_base_version integer,
  ADD COLUMN IF NOT EXISTS verification_queued_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS verification_started_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS verification_error_code text,
  ADD COLUMN IF NOT EXISTS verification_report jsonb,
  ADD COLUMN IF NOT EXISTS verified_version integer,
  ADD COLUMN IF NOT EXISTS verified_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS verified_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS staged_content jsonb,
  ADD COLUMN IF NOT EXISTS staged_layout jsonb,
  ADD COLUMN IF NOT EXISTS staged_template_name text,
  ADD COLUMN IF NOT EXISTS staged_pdf_s3_key text,
  ADD COLUMN IF NOT EXISTS staged_edited_paths jsonb DEFAULT '[]'::jsonb NOT NULL;

-- Drizzle's FK name for verified_by_user_id, so db:push and this file agree.
DO $$
BEGIN
  ALTER TABLE senior_resumes
    ADD CONSTRAINT senior_resumes_verified_by_user_id_users_id_fk
    FOREIGN KEY (verified_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
