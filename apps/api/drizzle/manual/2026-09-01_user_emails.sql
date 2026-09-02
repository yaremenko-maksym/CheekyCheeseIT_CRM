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
-- ran — a pre-existing data-quality problem this migration cannot resolve
-- on someone's behalf, and (security-review PR #623 round 2, SR-M-6, MED)
-- no longer resolves SILENTLY either: the verify block right after the
-- backfill INSERT raises and stops the deploy job before the container
-- swap happens (that swap is ~100 lines further down deploy.yml, in the
-- SAME job) — the OLD container, still reading `users.email` directly, is
-- what keeps serving every login while the job is red, so a failure HERE
-- changes nobody's ability to log in. Silence was the unsafe choice, not
-- the loud failure.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-09-01_user_emails.sql
--
-- Idempotent: `CREATE TYPE` / `CREATE TABLE` / `CREATE INDEX` all use
-- IF NOT EXISTS (or are wrapped so a second run no-ops instead of erroring
-- on "already exists" — Postgres has no native `CREATE TYPE IF NOT EXISTS`
-- for enums, so that one is guarded with a DO block). The backfill INSERT
-- uses a BARE `ON CONFLICT DO NOTHING` (no target list) — safe to re-run on
-- every deploy, forever: it now catches a conflict on EITHER unique index
-- on this table (`(user_id, kind)` for a genuine re-run, `lower(email)` for
-- a case collision — see below), not just the first one. The verify block
-- below the backfill is itself a read-only SELECT wrapped in a DO block —
-- re-running it is always safe, and it stays silent once the underlying
-- data problem is actually fixed.
--
-- Case collisions in existing data
-- ---------------------------------
-- `users.email` has ALWAYS been case-SENSITIVE unique (a plain btree, same
-- gap this migration closes for user_emails). It is therefore possible —
-- unlikely, but not provably absent without reading production data this
-- migration does not have — that two EXISTING users already have
-- `users.email` values that only differ by case. Backfilling BOTH verbatim
-- would violate the new `idx_user_emails_email_lower` index. Rather than
-- fail the whole migration (bricking every OTHER user's login — see the
-- ordering argument above for why that fear does not actually hold) or
-- silently decide a winner, this file:
--   1. Orders the backfill deterministically (`created_at, id`) so a repeat
--      apply always resolves a collision the SAME way.
--   2. Lets the bare `ON CONFLICT DO NOTHING` skip the LATER-ordered user
--      in any such pair — Postgres, not this file, decides who "wins";
--      the loser gets no WORK row from this INSERT.
--   3. Immediately after, a verify block RAISES an exception with the COUNT
--      of users still missing a WORK row (SR-M-6) — a deploy failure the
--      owner cannot miss, instead of a support ticket days later. It never
--      prints WHICH users — this file's output is a public deploy log (see
--      the AGGREGATE-ONLY note on that block for why). The VERIFY section
--      further down is how an owner finds out who, by hand.
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

-- security-review PR #623 round 2 (SR-M-6, MED): the bare ON CONFLICT DO
-- NOTHING above silently swallows a real case-collision — `psql -v
-- ON_ERROR_STOP=1` still exits 0, deploy.yml prints "applied successfully",
-- and the skipped user only finds out from a failed login. Fail loud
-- instead: this is safe (see "Ordering / zero-downtime" above for why a
-- failure here does not change anyone's ability to log in) and it is the
-- ONLY thing standing between a silent lockout and a red, actionable
-- deploy job. Read-only until the IF fires — always safe to re-run.
--
-- AGGREGATE-ONLY — this file's output goes into a PUBLIC deploy log (this
-- repository is public and its GitHub Actions logs are public with it).
-- The message below carries a COUNT, never the affected email addresses:
-- this repo already has the row-level version of this exact mistake on
-- record — `2026-08-12_admin_income_drop_backfill_report.sql` (security-
-- review round 2, PR #517, HIGH-3) printed per-row financial detail into
-- this same public log and had to be narrowed to counts-only after the
-- fact. An email address is PII the same way that report's project/drop
-- names were client-identifying data; there is no reason to reintroduce
-- the same class of leak here. An admin who needs the actual list runs the
-- VERIFY query below BY HAND, over the same SSH-less docker-exec psql
-- session used for every other prod DB operation (see project-state.md) —
-- never auto-printed anywhere.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*)
    INTO v_count
  FROM users u
  WHERE NOT EXISTS (
    SELECT 1 FROM user_emails ue WHERE ue.user_id = u.id AND ue.kind = 'WORK'
  );

  IF v_count > 0 THEN
    RAISE EXCEPTION 'user_emails backfill: % user(s) still have no WORK row after backfill (email case-collision with another existing user? see "Case collisions in existing data" in this file''s header). Affected emails are deliberately NOT listed here — this output is a public deploy log; run the VERIFY query further down this file BY HAND to see who.',
      v_count;
  END IF;
END $$;

-- =============================================================================
-- VERIFY (manual re-check — the DO block above already raises automatically
-- when the counts below would not match; use this section to re-derive the
-- detail after the fact, e.g. once the deploy job's console output has
-- scrolled away, or to confirm a fix before re-running this file):
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
--   -- Once resolved, re-apply this file (idempotent) to clear the failure.
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
