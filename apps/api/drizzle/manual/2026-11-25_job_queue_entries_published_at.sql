-- Vacancy queue sort by publication date: published_at on job_queue_generation_entries.
--
-- WHAT THIS FILE DOES
--   Adds published_at (timestamptz, NULL) to job_queue_generation_entries: the opportunity's
--   publication date snapshotted when the generation is published, so the «за датою публікації»
--   order (published_at DESC NULLS LAST, first_seen_at DESC, opportunity_id DESC) cannot move
--   under a cursor. NULL is an unknown date, ordered last. Fully additive, re-runnable:
--   ADD COLUMN IF NOT EXISTS. No backfill: entries are immutable (the 2026-10-18 append-only
--   triggers refuse UPDATE) and live for one generation (15 minutes); a generation published
--   before the deploy orders its entries by first_seen_at under the new sort until it expires.
--
-- The Drizzle declaration of the same column is jobQueueGenerationEntries.publishedAt in
-- apps/api/src/database/schema/job-queue.ts; dev/CI get it by db:push.
--
-- PRIVILEGE CLASS
--   No new relation: the column inherits job_queue_generation_entries' existing grants.
--
-- APPLY
--   Every generation publish writes this column, so it MUST exist before the container swap.
--   psql -v ON_ERROR_STOP=1 --single-transaction < 2026-11-25_job_queue_entries_published_at.sql
--   Rollback: ALTER TABLE job_queue_generation_entries DROP COLUMN published_at.

SET LOCAL lock_timeout = '10s';

ALTER TABLE job_queue_generation_entries
  ADD COLUMN IF NOT EXISTS published_at timestamptz;
