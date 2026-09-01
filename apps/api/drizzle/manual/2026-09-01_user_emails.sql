-- =============================================================================
-- user_emails table — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- security-review PR #623 (SR-H-1, HIGH): mail is case-insensitive
-- (RFC 5321 makes the local part *technically* case-sensitive, but no real
-- mail provider treats it that way, and neither did this app's own
-- personalEmail!==email check before this fix — it already compared via
-- .toLowerCase()). A plain `UNIQUE (email)` btree index is case-SENSITIVE,
-- so `Alice@corp.com` and `alice@corp.com` used to be two different rows —
-- one real mailbox, reachable through two case variants, landing on TWO
-- different accounts. Proven by direct experiment against a real Postgres
-- before this fix:
--   Bob.PERSONAL    = 'alice@corp.com'    -> rejected (exact-match existing row)
--   Bob.PERSONAL    = 'Alice@corp.com'    -> ACCEPTED (bug)
--   Carol.PERSONAL  = 'ALICE@CORP.COM'    -> ACCEPTED (bug)
-- This file folds case in the UNIQUE INDEX itself (`lower(email)`), not just
-- in application code — matching the Drizzle-documented pattern for a
-- case-insensitive unique email column. The column keeps whatever case the
-- admin/OAuth provider typed (unchanged for display); only the uniqueness
-- constraint and every lookup fold it away. See `UsersService.lowerEmail`
-- usage in `assertEmailAvailable` / `findLoginableUserByEmail` for the
-- application-side half — an index alone does not make
-- `.where(eq(userEmails.email, rawEmail))` case-insensitive; every query
-- MUST go through the same fold.
--
-- Why fold NOW, in the first-ever apply of this table, not later: once this
-- table carries real rows, retrofitting a case-folded unique index requires
-- first proving no two EXISTING rows collide under folding — a manual data
-- cleanup this repo has no tooling for. Folding from the table's very first
-- migration means that cleanup can never become necessary.
--
-- A user can log in through TWO addresses: a WORK address (ours, always a
-- login method) and a PERSONAL address (entered by ADMIN at creation, a
-- login method only after the holder accepts an invite — separate task).
--
-- Why a TABLE and not a second column on `users`. A per-column UNIQUE
-- constraint (like `users.email`) can only guarantee "work addresses don't
-- repeat" and, separately, "personal addresses don't repeat" — it cannot
-- express "no personal address equals anyone else's work address", because
-- the two values live in two different columns Postgres never compares
-- against each other. That gap is a direct account-takeover path. A single
-- table with ONE case-folded unique index across every row — both kinds,
-- every user — makes that guarantee a property of the schema instead of a
-- property of every caller remembering to check two places AND fold case.
--
-- Ordering / zero-downtime
-- -------------------------
-- This file is PURE ADDITIVE — new type, new table, new indexes, plus a
-- backfill INSERT that only ever adds rows to the NEW table. `users.email`
-- is untouched. The OLD app code (still reading `users.email` directly for
-- login) keeps working unmodified for as long as it runs against this
-- schema. The NEW app code (reading `user_emails` for login) only starts
-- running once THIS file has already been applied (deploy.yml applies
-- manual SQL before swapping the API container), by which point the
-- backfill below has already populated a WORK row for every existing user
-- it safely could (see "Case collisions in existing data" below for the
-- one exception). There is no window where the login lookup can fail to
-- find a WORK row for someone who could log in yesterday, UNLESS that
-- person's existing `users.email` already collided (case-insensitively)
-- with another existing user's `users.email` before this migration ever
-- ran — a pre-existing data-quality problem this migration cannot silently
-- resolve on someone's behalf (see below).
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
-- dependency on any other pending manual migration. See the PR discussion
-- (SR-H-2) for the exact lines to add.
--
-- Idempotent: `CREATE TYPE` / `CREATE TABLE` / `CREATE INDEX` all use
-- IF NOT EXISTS (or are wrapped so a second run no-ops instead of erroring
-- on "already exists" — Postgres has no native `CREATE TYPE IF NOT EXISTS`
-- for enums, so that one is guarded with a DO block). The backfill INSERT
-- uses a BARE `ON CONFLICT DO NOTHING` (no target list) — safe to re-run on
-- every deploy, forever: it now catches a conflict on EITHER unique index
-- on this table (`(user_id, kind)` for a genuine re-run, `lower(email)` for
-- a case collision — see below), not just the first one.
--
-- Case collisions in existing data
-- ---------------------------------
-- `users.email` has ALWAYS been case-SENSITIVE unique (a plain btree, same
-- gap this migration closes for user_emails). It is therefore possible —
-- unlikely, but not provably absent without reading production data this
-- migration does not have — that two EXISTING users already have
-- `users.email` values that only differ by case. Backfilling BOTH verbatim
-- would violate the new `idx_user_emails_email_lower` index. Rather than
-- fail the whole migration (bricking every OTHER user's login) or silently
-- decide a winner, this file:
--   1. Orders the backfill deterministically (`created_at, id`) so a repeat
--      apply always resolves a collision the SAME way.
--   2. Lets the bare `ON CONFLICT DO NOTHING` skip the LATER-ordered user
--      in any such pair — they get NO WORK row, and (until manually fixed)
--      cannot log in through the new path.
--   3. Ships a VERIFY query below that lists exactly who was skipped, so
--      the owner can resolve the two real underlying addresses (rename one)
--      before it is ever a live incident, rather than discovering it from a
--      support ticket.
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

-- The structural guarantee this table exists for (see module comment
-- above) — CASE-FOLDED (SR-H-1). Strictly stronger than a plain unique
-- index on `email`: case-insensitive uniqueness implies case-sensitive
-- uniqueness, never the reverse.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_emails_email_lower ON user_emails (lower(email));

-- One WORK + one PERSONAL row per user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_emails_user_kind ON user_emails (user_id, kind);

-- Backfill: every EXISTING user's current `users.email` becomes their WORK
-- row, already verified (they have been logging in with it), already able
-- to log in (`can_login = true`) — this is the "existing login must not
-- break for a single minute" requirement for everyone NOT caught in a case
-- collision (see above): after this INSERT, every such user who could log
-- in yesterday has a matching, login-enabled WORK row today.
INSERT INTO user_emails (user_id, email, kind, verified_at, can_login)
SELECT id, email, 'WORK', created_at, true
FROM users
ORDER BY created_at, id
ON CONFLICT DO NOTHING;

-- =============================================================================
-- VERIFY (after applying):
--   SELECT typname FROM pg_type WHERE typname = 'user_email_kind';
--
--   SELECT count(*) FROM user_emails WHERE kind = 'WORK';
--   SELECT count(*) FROM users;
--   -- the two counts above should match. If they do NOT, run the query
--   -- below to find out who was skipped and why, BEFORE telling anyone
--   -- the migration "succeeded" — a mismatch here means someone existing
--   -- cannot log in until fixed by hand.
--
--   SELECT u.id, u.email, u.display_name
--   FROM users u
--   WHERE NOT EXISTS (
--     SELECT 1 FROM user_emails ue WHERE ue.user_id = u.id AND ue.kind = 'WORK'
--   );
--   -- Expected: zero rows. Any row here is a real case-collision with
--   -- another EXISTING user's email (or some other unique_violation this
--   -- backfill's bare ON CONFLICT DO NOTHING swallowed) — cross-reference
--   -- with `SELECT email FROM users WHERE lower(email) = lower('<that
--   -- user's email>')` to find who they collided with, then resolve by
--   -- correcting whichever of the two addresses is the actual typo/dupe.
--
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
