-- Resume header overrides: header on senior_resumes.
--
-- WHAT THIS FILE DOES
--   Adds header (jsonb, NULL) to senior_resumes: HR's per-resume overrides of the name, email,
--   phone and Telegram printed at the top of the resume PDF. NULL, or a null field inside it, prints
--   the owner's profile value, so every existing row keeps printing exactly what it prints today.
--   Fully additive, re-runnable: ADD COLUMN IF NOT EXISTS.
--
-- The Drizzle declaration of the same column is seniorResumes.header in
-- apps/api/src/database/schema/resumes.ts; dev/CI get it by db:push.
--
-- PRIVILEGE CLASS
--   No new relation: the column inherits senior_resumes' existing grants.
--
-- APPLY
--   Every senior-resume read selects this column, so it MUST exist before the container swap.
--   Needs 2026-11-16_senior_resumes_recheck_needed.sql applied first (same table, same deploy step).
--   psql -v ON_ERROR_STOP=1 --single-transaction < 2026-11-24_senior_resumes_header.sql
--   Rollback: ALTER TABLE senior_resumes DROP COLUMN header.

SET LOCAL lock_timeout = '10s';

ALTER TABLE senior_resumes
  ADD COLUMN IF NOT EXISTS header jsonb;
