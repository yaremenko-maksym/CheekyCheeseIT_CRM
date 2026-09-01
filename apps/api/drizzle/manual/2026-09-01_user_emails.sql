-- =============================================================================
-- user_emails table — prod DDL + backfill (manual apply)
-- task-user-emails-dual-login — notifications-and-confirmations spec §4.4/§5
-- =============================================================================
--
-- Context
-- -------
-- Today a user has ONE email (`users.email`, UNIQUE) and logs in through it
-- via Google. This task adds a SECOND address per user (personal, entered by
-- ADMIN at creation) that can also become a login method later (invite-accept
-- flow, separate task). See `apps/api/src/database/schema.ts`'s comment on
-- `userEmails` for why this is a whole table and not a second column: a
-- per-column UNIQUE constraint cannot express "no personal address equals
-- anyone else's work address" — this table's single index across every row
-- (both kinds, every user) is what makes that guarantee structural instead of
-- a property every caller has to remember to check.
--
-- Ordering / zero-downtime
-- -------------------------
-- This file is PURE ADDITIVE — new type, new table, new indexes, plus a
-- backfill INSERT that only ever adds rows to the NEW table. `users.email` is
-- untouched. The OLD app code (still reading `users.email` directly for
-- login) keeps working unmodified for as long as it runs against this schema.
-- The NEW app code (reading `user_emails` for login — see
-- `UsersService.findLoginableUserByEmail`) only starts running once THIS
-- file has already been applied (deploy.yml applies manual SQL before
-- swapping the API container), by which point the backfill below has already
-- populated a WORK row for every existing user. There is no window where the
-- login lookup can fail to find a WORK row for someone who could log in
-- yesterday.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-09-01_user_emails.sql
--
-- DEPENDENCY (DevOps zone, NOT wired by this PR): add this file's path to
-- deploy.yml's manual-migration SOURCE list (same pattern as every other
-- file in this directory) and to the apply-order block. No ordering
-- dependency on any other pending manual migration.
--
-- Idempotent: `CREATE TYPE` / `CREATE TABLE` / `CREATE INDEX` all use
-- IF NOT EXISTS (or are wrapped so a second run no-ops instead of erroring
-- on "already exists" — Postgres has no native `CREATE TYPE IF NOT EXISTS`
-- for enums, so that one is guarded with a DO block). The backfill INSERT
-- uses `ON CONFLICT (user_id, kind) DO NOTHING` — safe to re-run on every
-- deploy, forever; a user created AFTER this file's first apply already got
-- their own WORK row from `UsersService.createUser`/`createDrop`, so the
-- backfill's `ON CONFLICT DO NOTHING` is a true no-op for them.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_email_kind') THEN
    CREATE TYPE user_email_kind AS ENUM ('WORK', 'PERSONAL');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email varchar(255) NOT NULL,
  kind user_email_kind NOT NULL,
  verified_at timestamptz,
  can_login boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The structural guarantee this table exists for (see module comment above).
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_emails_email ON user_emails (email);

-- One WORK + one PERSONAL row per user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_emails_user_kind ON user_emails (user_id, kind);

-- Backfill: every EXISTING user's current `users.email` becomes their WORK
-- row, already verified (they have been logging in with it), already able
-- to log in (`can_login = true`) — this is the "existing login must not
-- break for a single minute" requirement: after this INSERT, every user who
-- could log in yesterday has a matching, login-enabled WORK row today.
INSERT INTO user_emails (user_id, email, kind, verified_at, can_login)
SELECT id, email, 'WORK', created_at, true
FROM users
ON CONFLICT (user_id, kind) DO NOTHING;

-- =============================================================================
-- VERIFY (after applying):
--   SELECT typname FROM pg_type WHERE typname = 'user_email_kind';
--   SELECT count(*) FROM user_emails WHERE kind = 'WORK';
--   -- must equal: SELECT count(*) FROM users;
--   SELECT count(*) FROM user_emails WHERE kind = 'WORK' AND can_login = false;
--   -- must be 0 — every backfilled WORK row can log in.
-- =============================================================================
--
-- Rollback (feature-level; only if this feature is being reverted entirely —
-- and only BEFORE the app code that reads user_emails for login is deployed,
-- since dropping this table after that point would lock everyone out):
--   DROP TABLE IF EXISTS user_emails;
--   DROP TYPE IF EXISTS user_email_kind;
-- =============================================================================
