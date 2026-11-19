-- =============================================================================
-- `interview_stage` gains SUBMITTED, before HR_SCREEN (task-sources-07c) — prod forward DDL
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
--   Adds ONE value to the `interview_stage` enum:
--     ALTER TYPE interview_stage ADD VALUE IF NOT EXISTS 'SUBMITTED' BEFORE 'HR_SCREEN';
--   so the senior's Interviews board gains a first column meaning "HR submitted you to this
--   vacancy, nobody has answered yet".
--
-- WHY A NEW VALUE AND NOT `HR_SCREEN`
-- -----------------------------------
--   An HR submission out of the vacancy queue is not a screen: nobody has screened anybody.
--   Landing a fresh submission in `HR_SCREEN` would be free, and would say something untrue in
--   the first column of a board that ADMIN, HR and the senior all read. Owner decision
--   2026-11-19 (task file `.claude/tasks/task-sources-07c-senior-queue-closed.md`, "Owner answers",
--   Q2): add the value, placed before HR_SCREEN.
--
-- WHY ITS OWN FILE, SEPARATE FROM THE COLUMN DDL
-- ----------------------------------------------
--   Same split as 2026-09-04_approval_status_cancelled.sql: an enum-value add is the one DDL in
--   this repo that CANNOT be rolled back (Postgres has no `ALTER TYPE … DROP VALUE`), so it is
--   kept alone, auditable on its own line in the deploy log, and never mixed with reversible DDL.
--
-- DATA: NONE MOVES, NONE CHANGES. The value is additive and inert until the application code that
-- writes it ships. No existing row has its stage rewritten by this file. `interviews.stage` keeps
-- its `DEFAULT 'HR_SCREEN'` — an interview created by hand on the board still starts in HR_SCREEN;
-- only the queue submit path writes SUBMITTED.
--
-- No grant: `interviews` is class A in `privileges/privilege-classes.ts` (table-level grants), and
-- an enum value is not a relation, so this file adds nothing to STAGED_RELATIONS.
--
-- The Drizzle declaration is `interviewStageEnum` (`schema/enums.ts`), where 'SUBMITTED' is listed
-- FIRST — the same position this file inserts it into, so a `db:push` of the Drizzle schema and
-- this file agree on `enum_range`. `interview-stage-submitted-forward-ddl.integration.spec.ts`
-- applies this file TWICE into a scratch database and pins both the membership and the ORDER.
--
-- The closing check asserts only the DURABLE invariant: SUBMITTED exists and sorts IMMEDIATELY
-- BEFORE HR_SCREEN. It deliberately does NOT pin the value count or SUBMITTED's absolute index:
-- deploy re-applies this file on every deploy, forever, so an assertion on the total number of
-- interview_stage values would turn the NEXT additive enum migration into a permanently failing
-- deploy step.
--
-- NOTHING HERE USES THE NEW VALUE
-- -------------------------------
--   Deploy applies this file with `--single-transaction`. Since PG12 `ALTER TYPE … ADD VALUE` is
--   allowed inside a transaction block, but the value it adds cannot be USED until that
--   transaction commits. This file therefore never writes, compares or casts to 'SUBMITTED' — the
--   closing check reads `pg_enum` catalog rows by label, which needs no cast and is always safe.
--
-- APPLY WITH (one transaction, stop on first error):
--   psql -v ON_ERROR_STOP=1 --single-transaction \
--     -f apps/api/drizzle/manual/2026-11-19_interview_stage_submitted.sql
--
-- RE-RUNNABLE: `ADD VALUE IF NOT EXISTS` is a no-op when the value is present (native Postgres
-- syntax, PG 9.6+), so this file is safe on every deploy, forever. The closing check then simply
-- re-confirms the intended state.
--
-- ROLLBACK: NOT POSSIBLE. Postgres cannot drop an enum value without recreating the type and
-- rewriting every column that uses it. Accepted, and the same accepted limitation as every other
-- additive enum-value migration in this repository (2026-09-04_approval_status_cancelled.sql,
-- 2026-09-02_project_status.sql): the value is inert until the code that writes it is deployed, and
-- an unused enum value is harmless to leave in place. Rolling back the FEATURE means rolling back
-- the application code, not this file.
-- =============================================================================

SET LOCAL lock_timeout = '10s';

ALTER TYPE "interview_stage" ADD VALUE IF NOT EXISTS 'SUBMITTED' BEFORE 'HR_SCREEN';

-- The closing check: the intended state, exactly, or the apply fails (and, applied in one
-- transaction, rolls back everything above it). Read from the catalog — never by using the value.
DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
  labels text[];
  pos_submitted float8;
  pos_hr_screen float8;
  between_count bigint;
BEGIN
  SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
    INTO labels
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'interview_stage';

  IF labels IS NULL THEN
    RAISE EXCEPTION 'the interview_stage enum type does not exist';
  END IF;

  SELECT e.enumsortorder INTO pos_submitted
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'interview_stage' AND e.enumlabel = 'SUBMITTED';
  SELECT e.enumsortorder INTO pos_hr_screen
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'interview_stage' AND e.enumlabel = 'HR_SCREEN';

  IF pos_submitted IS NULL THEN
    problems := problems || 'the value SUBMITTED is missing from interview_stage'::text;
  ELSIF pos_hr_screen IS NULL THEN
    problems := problems || 'the value HR_SCREEN is missing from interview_stage'::text;
  ELSE
    SELECT count(*) INTO between_count
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'interview_stage'
       AND e.enumsortorder > pos_submitted AND e.enumsortorder < pos_hr_screen;
    IF pos_submitted >= pos_hr_screen OR between_count > 0 THEN
      problems := problems || format(
        'SUBMITTED does not sort immediately before HR_SCREEN (sort order is: %s)',
        array_to_string(labels, ', ')
      )::text;
    END IF;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'interview_stage is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;

-- =============================================================================
-- VERIFY (after applying):
--   SELECT unnest(enum_range(NULL::interview_stage));  -- SUBMITTED immediately before HR_SCREEN
-- =============================================================================
