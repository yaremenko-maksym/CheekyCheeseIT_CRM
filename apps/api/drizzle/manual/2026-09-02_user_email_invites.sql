-- =============================================================================
-- user_email_invites table + user_emails.google_id column — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-user-emails-invite (position 2, continued from PR #623 — see
-- docs/superpowers/specs/2026-09-01-notifications-and-confirmations-design.md
-- §5, §9 position 2). PR #623 shipped the address table and the login
-- lookup, but nothing in it ever set `can_login = true` for a PERSONAL row
-- (spec-reviewer PR #623, SPEC-H-1) — a personal address an admin entered
-- there could never actually become a way to sign in. This file adds the
-- two pieces that close that gap:
--
--   1. `user_emails.google_id` — see the column's own comment in
--      `database/schema.ts` for the full rationale. Short version: WORK
--      identity binding stays on `users.googleId`, unchanged; PERSONAL
--      identity binding gets its OWN column on its OWN row, because a
--      personal address is, by construction, a different Google account
--      than the corporate WORK one, and the two must not be forced to
--      share one slot.
--   2. `user_email_invites` — the one-time, hashed, 7-day token a PERSONAL
--      row's invite email carries. See that table's comment in
--      `database/schema.ts` for the full rationale.
--
-- Ordering / zero-downtime
-- -------------------------
-- PURE ADDITIVE — one new nullable column on an EXISTING table (via `ADD
-- COLUMN IF NOT EXISTS`, no default needed since every existing row has no
-- Google identity to record yet) and one brand-new table. Nothing here
-- rewrites or locks existing data at more than a metadata level; nothing
-- here changes what the OLD (pre-deploy) app code reads or writes. The NEW
-- app code (AuthController's invite-accept branch, UsersService's invite
-- methods) only starts running once THIS file has already been applied —
-- same ordering guarantee `2026-09-01_user_emails.sql` documents for the
-- table it builds on.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml \
--     --env-file .env.production exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-09-02_user_email_invites.sql
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` + `CREATE TABLE IF NOT EXISTS` +
-- `CREATE UNIQUE INDEX IF NOT EXISTS` — safe to re-run on every deploy,
-- forever. No backfill (a table with no pre-existing rows, a column no
-- pre-existing row can have a value for), so no fail-loud verify block is
-- needed the way `2026-09-01_user_emails.sql`'s backfill needed one.
--
-- =============================================================================

ALTER TABLE user_emails ADD COLUMN IF NOT EXISTS google_id varchar(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_emails_google_id ON user_emails (google_id);

CREATE TABLE IF NOT EXISTS user_email_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email_id uuid NOT NULL REFERENCES user_emails(id) ON DELETE CASCADE,
  token_hash varchar(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One active invite per address row — resending overwrites in place
-- (application-level UPDATE, not a second row here).
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_invites_user_email ON user_email_invites (user_email_id);

-- The accept-flow lookup key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_invites_token_hash ON user_email_invites (token_hash);

-- =============================================================================
-- VERIFY (manual re-check):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'user_emails' AND column_name = 'google_id';
--
--   SELECT count(*) FROM user_email_invites;
--   -- Expected 0 immediately after first apply (no PERSONAL rows have been
--   -- invited yet at the moment this file first lands) — non-zero after
--   -- the app has actually issued invites, never a sign of a problem.
-- =============================================================================
--
-- Rollback (feature-level; only if this feature is being reverted entirely —
-- and only BEFORE the app code that reads user_email_invites is deployed,
-- since dropping it after that point would 500 the invite-accept endpoint):
--   DROP TABLE IF EXISTS user_email_invites;
--   DROP INDEX IF EXISTS idx_user_emails_google_id;
--   ALTER TABLE user_emails DROP COLUMN IF EXISTS google_id;
-- =============================================================================
