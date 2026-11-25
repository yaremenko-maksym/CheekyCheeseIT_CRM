-- Vacancy queue sort by publication date: published_at and published_order_key on
-- job_queue_generation_entries.
--
-- WHAT THIS FILE DOES
--   Adds published_at (timestamptz, NULL) to job_queue_generation_entries: the opportunity's
--   publication date snapshotted when the generation is published, so the «спочатку нові»
--   order (published_at DESC NULLS LAST, first_seen_at DESC, opportunity_id DESC) cannot move
--   under a cursor. NULL is an unknown date, ordered last.
--   Adds published_order_key (integer, NULL, >= 0): the dense position of the entry in that
--   order, written by the same publish INSERT as order_key, and the unique index
--   uq_job_queue_generation_entries_published_order (generation_id, published_order_key), so a
--   one-team published page reads the index the way the relevance page reads order_key.
--   Fully additive, re-runnable: ADD COLUMN IF NOT EXISTS, CREATE UNIQUE INDEX IF NOT EXISTS.
--   No backfill: entries are immutable (the 2026-10-18 append-only triggers refuse UPDATE) and
--   live for one generation (15 minutes); a generation published before the deploy has both
--   columns NULL, and its published read numbers the order on the fly (by first_seen_at) until it
--   expires. The unique index allows those NULLs.
--
-- The Drizzle declaration of the same columns and index is jobQueueGenerationEntries.publishedAt
-- and .publishedOrderKey in apps/api/src/database/schema/job-queue.ts; dev/CI get them by db:push.
--
-- PRIVILEGE CLASS
--   No new relation: the columns and the index inherit job_queue_generation_entries' grants.
--
-- APPLY
--   Every generation publish writes both columns, so they MUST exist before the container swap.
--   psql -v ON_ERROR_STOP=1 --single-transaction < 2026-11-25_job_queue_entries_published_at.sql
--   Rollback: the previous image neither reads nor writes these columns, so leaving them is safe.
--   To remove them, run this after the previous image is back:
--     DROP INDEX IF EXISTS uq_job_queue_generation_entries_published_order;
--     ALTER TABLE job_queue_generation_entries
--       DROP COLUMN IF EXISTS published_order_key,
--       DROP COLUMN IF EXISTS published_at;

SET LOCAL lock_timeout = '10s';

ALTER TABLE job_queue_generation_entries
  ADD COLUMN IF NOT EXISTS published_at timestamptz;

ALTER TABLE job_queue_generation_entries
  ADD COLUMN IF NOT EXISTS published_order_key integer
    CONSTRAINT ck_job_queue_generation_entries_published_order_key_nonneg
    CHECK (published_order_key >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_queue_generation_entries_published_order
  ON job_queue_generation_entries (generation_id, published_order_key);
