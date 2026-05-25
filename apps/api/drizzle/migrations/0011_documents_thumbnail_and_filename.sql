-- Migration: PHASE 6 — Documents thumbnail + filename normalization.
--
-- 1. Adds `thumbnail_s3_key` (nullable VARCHAR) to track the S3 key of the
--    generated 256x256 JPEG thumbnail. Image documents now upload a
--    thumbnail synchronously together with the main object; PDFs (and any
--    other non-image MIME types) leave the column NULL and the UI falls
--    back to a category icon.
--
-- 2. Adds `original_name` (nullable VARCHAR) preserving the original
--    upload filename as provided by the user, before sanitization. This
--    powers the UI display + restores cyrillic / unicode characters in
--    the download-as filename. Existing rows backfill from `name`.
--
-- The legacy `name` column is kept and now stores the *sanitized*
-- filename used inside the S3 key (variant 3 "hybrid": strict s3_key,
-- preserved original, ui shows original, download = normalized).
--
-- Migration is idempotent (IF NOT EXISTS guards) so re-running against an
-- already-migrated dev DB is safe.

--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "thumbnail_s3_key" varchar(512);

--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "original_name" varchar(255);

--> statement-breakpoint
-- Backfill original_name = name for pre-existing rows (best effort — the
-- legacy sanitized name is the only history we have).
UPDATE "documents" SET "original_name" = "name" WHERE "original_name" IS NULL;
