-- =============================================================================
-- File storage hardening — document_access_log + resume retention — prod DDL
-- (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-file-storage-hardening (owner decisions 2026-08-01):
--
--   1. `document_access_log` — NEW table (§7). Mirrors the existing
--      `transaction_audit_log` shape: `target_id` has NO FK reference (the
--      audit trail must OUTLIVE the row it describes — a resume can be
--      hard-deleted or retention-purged and "who downloaded this scan" must
--      still be answerable afterwards). Records WHO fetched a presigned
--      download/preview/thumbnail link for a sensitive document (RESUME/SCAN/
--      CONTRACT/RECEIPT/INVOICE from `documents`, or a vacancy application
--      resume) and WHEN — `metadata` carries only `{ category, source? }`,
--      never the URL. `actor_id` is indexed (MED-5, security-review round 1
--      — "who accessed what" queries filter by actor at least as often as by
--      target) and the app purges rows older than 365 days daily
--      (`DocumentAccessLogRetentionCronService`) — no schema-level TTL, the
--      cron issues a plain DELETE.
--
--   2. `vacancy_applications.resume_s3_key` / `resume_size_bytes` — made
--      NULLABLE (§2). Resume retention is now 180 days from `created_at`
--      REGARDLESS of application status/vacancy state (previously only
--      REJECTED>90d or closed-vacancy applications were ever purged, so an
--      application sitting on an evergreen PUBLISHED vacancy kept its file
--      forever). `VacanciesRetentionCronService.purgeExpiredResumeFiles`
--      clears both columns to NULL once an application crosses 180 days —
--      the application ROW itself is kept (hiring-history value survives),
--      only the file is scrubbed. Existing rows are unaffected by widening
--      the columns to nullable (no data rewrite, no default needed).
--
-- The dev/CI database gets these changes via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push). The prod image does NOT ship drizzle-kit, so prod is
-- migrated with THIS script.
--
-- How to apply
-- ------------
-- From the VPS (or any host with Docker access to the prod stack):
--
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-01_file_storage_hardening.sql
--
-- Add this file to .github/workflows/deploy.yml ("Pull, up, migrate,
-- health-check" step) and apply it BEFORE the new image serves traffic (same
-- convention as every prior manual DDL in this folder). DevOps/PM own that
-- wiring — this PR only ships the script + this note (see PR body).
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS + ALTER COLUMN DROP NOT NULL
-- (a no-op if already nullable) — safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. document_access_log — new table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_id uuid NOT NULL,               -- documents.id OR vacancy_applications.id (no FK)
  action text NOT NULL,                  -- 'DOWNLOAD' | 'PREVIEW' | 'THUMBNAIL'
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_access_log_target_id_idx
  ON document_access_log (target_id);

CREATE INDEX IF NOT EXISTS document_access_log_actor_id_idx
  ON document_access_log (actor_id);

CREATE INDEX IF NOT EXISTS document_access_log_created_at_idx
  ON document_access_log (created_at);

-- -----------------------------------------------------------------------------
-- 2. vacancy_applications — widen resume_s3_key / resume_size_bytes to
--    nullable (180-day file-only retention purge, §2). Purely a constraint
--    relaxation — no existing row is touched, no default/backfill needed.
-- -----------------------------------------------------------------------------
ALTER TABLE vacancy_applications
  ALTER COLUMN resume_s3_key DROP NOT NULL,
  ALTER COLUMN resume_size_bytes DROP NOT NULL;

-- =============================================================================
-- VERIFY (after applying):
--   SELECT to_regclass('public.document_access_log');                -- not null
--   SELECT indexname FROM pg_indexes WHERE tablename = 'document_access_log';
--    -- expect: _pkey, _target_id_idx, _actor_id_idx, _created_at_idx
--   SELECT column_name, is_nullable FROM information_schema.columns
--    WHERE table_name = 'vacancy_applications'
--      AND column_name IN ('resume_s3_key', 'resume_size_bytes');    -- both YES
-- =============================================================================
--
-- Rollback (feature-level):
--   DROP TABLE IF EXISTS document_access_log;
--   -- Re-tightening resume_s3_key/resume_size_bytes to NOT NULL requires
--   -- backfilling any row the retention purge already nulled out first —
--   -- not a safe blind rollback, left as a deliberate manual decision.
-- =============================================================================
