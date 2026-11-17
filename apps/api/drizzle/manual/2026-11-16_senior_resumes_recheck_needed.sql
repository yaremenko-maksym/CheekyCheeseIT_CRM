-- Resume re-check flag: recheck_needed_at on senior_resumes (backlog 442).
--
-- WHAT THIS FILE DOES
--   Adds recheck_needed_at (timestamptz, NULL) to senior_resumes. The API sets it when the owner's
--   display name, legal name or Telegram handle changes while the resume is VERIFIED: those values
--   are the redaction inputs of the verification run, so the verified text may now carry the new
--   name or handle. A confirmed verification clears it. NULL on every existing row: nothing is
--   flagged retroactively. Fully additive, re-runnable: ADD COLUMN IF NOT EXISTS.
--
-- The Drizzle declaration of the same column is seniorResumes.recheckNeededAt in
-- apps/api/src/database/schema/resumes.ts; dev/CI get it by db:push.
--
-- PRIVILEGE CLASS
--   No new relation: the column inherits senior_resumes' existing grants.
--
-- APPLY
--   Every senior-resume read selects this column, so it MUST exist before the container swap.
--   Needs 2026-11-11_senior_resumes_verification.sql applied first (same table, same deploy step).
--   psql -v ON_ERROR_STOP=1 --single-transaction < 2026-11-16_senior_resumes_recheck_needed.sql
--   Rollback: ALTER TABLE senior_resumes DROP COLUMN recheck_needed_at.

SET LOCAL lock_timeout = '10s';

ALTER TABLE senior_resumes
  ADD COLUMN IF NOT EXISTS recheck_needed_at timestamp with time zone;
