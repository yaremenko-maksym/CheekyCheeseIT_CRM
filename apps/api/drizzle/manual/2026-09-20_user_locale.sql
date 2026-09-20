-- =============================================================================
-- users.locale — interface language per user (backlog task-i18n-stage2, §4.1)
-- =============================================================================
--
-- Context
-- -------
-- CRM internationalization design (docs/superpowers/specs/2026-09-19-crm-i18n-
-- design.md §4.1) — uk (default) + en. Every user gets a stored interface
-- language: `/auth/me` reads it into `SessionUser.locale`, and the request-
-- locale resolver (`apps/api/src/i18n/request-locale.ts`) prefers it over the
-- `pref_locale` cookie and `Accept-Language`. This migration adds ONE new
-- column (`locale`) backed by a new two-value enum (`user_locale`).
--
-- Idempotent; no data rewritten — every existing user gets 'uk' (the column
-- default), matching `DEFAULT_LOCALE` in packages/shared/src/i18n/locales.ts.
--
-- Why a top-level `DO $$` block for the enum, not top-level `CREATE TYPE`
-- ----------------------------------------------------------------------------
-- `CREATE TYPE` has no `IF NOT EXISTS` form — re-running this file on a
-- database that already has `user_locale` would fail with "type already
-- exists" on the SECOND deploy (every subsequent one, since deploy.yml applies
-- every manual/*.sql file on EVERY deploy — there is no applied-migrations
-- registry). The `DO $$ … END $$` guard checks `to_regtype('user_locale')`,
-- NOT `SELECT 1 FROM pg_type WHERE typname = …` — the latter matches the
-- name in ANY schema (namespace-blind), so on a database whose `search_path`
-- has been narrowed away from `public` (exactly what
-- `user-locale-migration.integration.spec.ts` does to prove this file in
-- isolation) it would see the type that already exists in `public` and skip
-- the CREATE, leaving the ALTER TABLE below unable to resolve `user_locale`
-- at all. `to_regtype` resolves the name exactly the way the ALTER TABLE
-- below will — the condition that actually matters. Same fix, same reason,
-- as `2026-09-12_notification_emails.sql`'s own comment on this exact
-- mistake (caught there by executing the file twice, not by reading it).
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-09-20_user_locale.sql
--
-- Wired into .github/workflows/deploy.yml (rollback-preflight file list, SCP
-- copy step, psql apply step) in this SAME PR — same reason as every DDL file
-- in this directory: without the new column, `AuthController.me`'s
-- `sessionUserSchema.parse({ ..., locale: fresh.locale })` would read
-- `undefined` off a Drizzle row that has no such column yet, and Zod would
-- reject the (now-required) `locale` field, 500ing every `/auth/me` call the
-- moment this PR's image ships. `scripts/devops/check-prod-ddl-wiring.py`
-- verifies both the COPY and the APPLY step exist.
--
-- Data risk: none. Existing rows keep no prior value (the column is new);
-- every row backfills to 'uk' via the column default at ADD COLUMN time.
-- =============================================================================

DO $$
BEGIN
  IF to_regtype('user_locale') IS NULL THEN
    CREATE TYPE user_locale AS ENUM ('uk', 'en');
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS locale user_locale NOT NULL DEFAULT 'uk';

-- =============================================================================
-- VERIFY (after applying):
--   SELECT column_name, data_type, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'users' AND column_name = 'locale';
--
-- Expected: one row — data_type='USER-DEFINED' (enum), column_default carries
-- 'uk'::user_locale, is_nullable='NO'. No query above returns any row
-- CONTENT belonging to a real user — no personal data is read or printed by
-- this migration or its verification.
-- =============================================================================
