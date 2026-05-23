-- Migration: Add per-project SENIOR share % override column on `projects`.
--
-- ADMIN and ACCOUNTANT can override the SENIOR's share percent for a single
-- project; NULL means "use the senior's global users.seniorSharePercent
-- default". This complements the existing project_finance_settings table
-- (kept in sync from ProjectsService.update) so the existing finance
-- snapshot logic in transactions.service.ts keeps working.
--
-- Nullable integer; idempotent guard so re-running on a partially-applied DB
-- is safe.

--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "senior_share_percent_override" integer;
