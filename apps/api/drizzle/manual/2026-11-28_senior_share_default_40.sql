-- Default senior share 26 -> 40 (owner decision 2026-11-28).
--
-- WHAT THIS FILE DOES
--   While users.senior_share_percent still defaults to 26 (the state before this file ran):
--     UPDATE users SET senior_share_percent = 40
--      WHERE senior_share_percent = 26 AND pending_senior_share_percent IS NULL;
--     one user_audit_log row per moved user (actor NULL = system, action 'salary_change',
--       changes {seniorSharePercent: 26 -> 40, reason: the owner decision});
--     ALTER TABLE users ALTER COLUMN senior_share_percent SET DEFAULT 40;
--   RAISE NOTICE prints the moved COUNT only, never ids (deploy logs are public).
--   Rows holding any other value keep it. A user with a live share proposal
--   (pending_senior_share_percent set) keeps 26: the active share is never written while a
--   proposal is live; the approve / reject flow decides it. Project and team overrides are untouched, so the
--   resolver order PROJECT > TEAM > USER_DEFAULT is unchanged.
--   Past transactions are NOT recomputed: every SENIOR_INCOME snapshots its share into
--   transactions.senior_share_percent at creation.
--
-- ONE-SHOT, REPLAY-SAFE
--   The deploy applies this file on every run. The UPDATE runs only while the column default is
--   still 26, and the same transaction moves the default to 40, so a replay changes nothing: a
--   user an admin later sets back to 26 keeps 26. A default that is neither 26 nor 40 refuses
--   (someone changed it by hand; the owner decides first).
--
-- The Drizzle declaration is users.seniorSharePercent in apps/api/src/database/schema/users.ts
-- (.default(40)); dev/CI get it by db:push.
--
-- PRIVILEGE CLASS
--   No new relation, grants nothing.
--
-- APPLY
--   Before the container swap (the new image creates users without an explicit share).
--   psql -v ON_ERROR_STOP=1 --single-transaction < 2026-11-28_senior_share_default_40.sql
--   Rollback: none needed for the previous image (it reads the column, never its default). The
--   UPDATE is data: the ids it moved are the audit rows it wrote:
--     SELECT target_id FROM user_audit_log
--      WHERE action = 'salary_change' AND actor_id IS NULL
--        AND changes->'reason'->>'after' = 'owner decision 2026-11-28: senior default share 40';

SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  current_default text;
  moved integer;
BEGIN
  SELECT pg_get_expr(d.adbin, d.adrelid)
    INTO current_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = to_regclass('users')
     AND a.attname = 'senior_share_percent'
     AND NOT a.attisdropped;

  IF current_default = '40' THEN
    RETURN;
  ELSIF current_default = '26' THEN
    WITH moved_users AS (
      UPDATE users SET senior_share_percent = 40
       WHERE senior_share_percent = 26 AND pending_senior_share_percent IS NULL
      RETURNING id
    )
    INSERT INTO user_audit_log (actor_id, target_id, action, changes)
    SELECT NULL, id, 'salary_change', jsonb_build_object(
             'seniorSharePercent', jsonb_build_object('before', 26, 'after', 40),
             'reason', jsonb_build_object(
               'before', NULL,
               'after', 'owner decision 2026-11-28: senior default share 40'))
      FROM moved_users;
    GET DIAGNOSTICS moved = ROW_COUNT;
    ALTER TABLE users ALTER COLUMN senior_share_percent SET DEFAULT 40;
    RAISE NOTICE 'senior default share 26 -> 40: % users moved', moved;
  ELSE
    RAISE EXCEPTION 'users.senior_share_percent default is %, expected 26 or 40', current_default;
  END IF;
END $$;
