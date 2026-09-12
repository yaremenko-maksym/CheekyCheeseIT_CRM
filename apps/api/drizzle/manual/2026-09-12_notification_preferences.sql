-- =============================================================================
-- Notification channel preferences — prod DDL (position 7a)
-- =============================================================================
--
-- Context
-- -------
-- Owner decision 6 in docs/superpowers/specs/2026-09-01-notifications-and-
-- confirmations-design.md §3: "каналы настраивает сам сотрудник". One row per
-- (user, notification type) recording ONE thing — whether email is on.
--
-- Absence of a row means "default", and the default is ON. Only the deviation
-- is stored, so the table stays nearly empty and a new notification type needs
-- neither a migration nor a backfill. An OFF default would have meant the whole
-- subsystem does nothing for anyone until every employee visits a settings
-- screen and switches it on.
--
-- The three action-required types (PROJECT_CONFIRM_REQUIRED,
-- SHARE_CONFIRM_REQUIRED, DOCUMENT_SIGN_REQUIRED) cannot be switched off at
-- all — §3, "Допущения": "иначе процесс встаёт молча: проект висит в
-- черновике, потому что галочку сняли год назад". That ban is enforced by Zod
-- BEFORE the database (`updateNotificationPreferencesSchema`) and derived from
-- ACTION_REQUIRED_NOTIFICATION_TYPES, so adding a fourth such type is a
-- one-line registry change rather than a migration. No CHECK constraint here
-- would stay in sync with that list without a second source of truth.
--
-- `type` is a plain varchar for the same reason `notifications.type` is: the
-- closed set lives in Zod, where the client sees it too; closing it at the DB
-- level would demand a migration for every new type.
--
-- Data risk: none. New table, nothing backfilled, nothing rewritten.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-09-12_notification_preferences.sql
--
-- Wired into .github/workflows/deploy.yml (rollback-preflight file list, SCP
-- copy step, psql apply step) in this SAME PR — see the sibling migration
-- 2026-09-12_notification_emails.sql for the full reasoning (CR-H-2, PR #624).
-- `scripts/devops/check-prod-ddl-wiring.py` verifies both the COPY and the
-- APPLY step exist (not just a comment naming the file).
--
-- Idempotent: `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT
-- EXISTS` — safe to re-run on every deploy, forever.
-- =============================================================================

CREATE TABLE IF NOT EXISTS notification_preferences (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type           varchar(50) NOT NULL,
  email_enabled  boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per (user, type). Also the index the upsert's conflict target and
-- the sender's per-notification lookup both ride on.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_preferences_user_type
  ON notification_preferences (user_id, type);

-- =============================================================================
-- VERIFY (after applying):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'notification_preferences';
--   SELECT indexname FROM pg_indexes
--     WHERE tablename = 'notification_preferences'
--       AND indexname = 'uq_notification_preferences_user_type';
--
-- Expected: six columns, one row from the second query. Neither query returns
-- any row CONTENT — no personal data is read or printed.
-- =============================================================================
