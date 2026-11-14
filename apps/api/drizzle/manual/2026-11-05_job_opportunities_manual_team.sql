-- =============================================================================
-- Manual job card owner team + submission resume (r5 Phase 6) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
--   Gives `job_opportunities` the team a MANUAL card belongs to:
--     1. adds `manual_team_id uuid`, NULLABLE with NO default: NULL means "a sourced opportunity"
--        (every existing row); a value means "an HR / ADMIN created this card by hand for that team
--        through POST /job-queue/manual";
--     2. adds `fk_job_opportunities_manual_team`: REFERENCES teams(id) ON DELETE RESTRICT, so a team
--        holding a manual card cannot be hard-deleted out from under it (teams are archived, not
--        deleted, in normal operation).
--   Gives `job_queue_assignments` the resume a submission was made with:
--     3. adds `resume_id uuid`, NULLABLE with NO default: an ordinary submission (POST
--        /job-queue/:id/submit) names no resume and stays NULL, as does every existing row; the
--        manual card's submission records the resume the creator chose;
--     4. adds `fk_job_queue_assignments_resume`: REFERENCES senior_resumes(id) ON DELETE SET NULL.
--        NOT RESTRICT: a senior's resume delete (ResumesService.deleteResume) erases the stored
--        files first and then hard-deletes the row, so a RESTRICT FK would fail that delete AFTER
--        the files are gone. SET NULL keeps the submission (a recorded fact) and drops only the
--        pointer; the resume id stays in the card's audit row (`job_queue_actions.reason`).
--
-- WHY. A manual card has no source record, so no automatic branch of `visibleOpportunityPredicate`
-- can ever show it. The MANUAL branch shows it to `manual_team_id` only (while that team is live),
-- and the three automatic branches refuse any row whose `manual_team_id` is set, so a manual card is
-- never visible to another team. The creator is the `actor_id` of the card's audit row in
-- `job_queue_actions`, so it is not stored twice here.
--
-- BACKFILL: none. Every existing row is a sourced opportunity and stays NULL, which is correct.
--
-- ORDER (owner step): apply this file BEFORE a build carrying this code serves the queue. The queue
-- visibility predicate and the list/card row joins name `manual_team_id`, so with the column absent
-- EVERY TEAM-scope list, card and write fails with 42703 (STUDIO scope binds `TRUE` and is not
-- affected by the predicate, but the row joins still read the column). It depends on the
-- 2026-11-05 role-family file only by date order; it reads none of its objects.
--
-- POST /job-queue/manual also writes `job_queue_assignments.resume_id`, so with that column absent
-- the manual create fails with 42703; ordinary submits do not name it.
--
-- No grant: `job_opportunities` and `job_queue_assignments` are class A in `privilege-classes.ts`
-- (table-level grants cover a new column), and these are ALTERs of existing relations, so neither
-- is in STAGED_RELATIONS.
--
-- The Drizzle declarations are `jobOpportunities.manualTeamId` (schema/job-opportunities.ts) and
-- `jobQueueAssignments.resumeId` (schema/job-queue.ts), each declared last so the column rank
-- matches an ADD COLUMN.
-- job-opportunities-manual-team-ddl.integration.spec.ts applies this file twice into a scratch
-- schema and compares the objects with `db:push`; job-opportunities-store-forward-ddl.integration.spec.ts
-- chains it after the role-family file.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- Production DDL ships staged. It is DARK: `manual-staged/` is never applied in prod (deploy.yml
-- refuses a file out of manual-staged/). Promotion and deploy wiring are an OWNER-ONLY later step.
--
-- APPLY WITH `psql -v ON_ERROR_STOP=1 --single-transaction -f <this file>`: `SET LOCAL
-- lock_timeout` only binds inside a transaction, and the closing check is all-or-nothing only if
-- a failure rolls back everything above it.
--
-- COST: ADD COLUMN without a default is catalog-only. ADD CONSTRAINT ... FOREIGN KEY validates
-- every row under a SHARE ROW EXCLUSIVE lock on `job_opportunities` (and on `teams`); every row is
-- NULL, so the validation is one sequential scan with no lookups. No index is added: the visibility
-- predicate reaches the column through the primary key, and the RESTRICT probe runs only on a team
-- hard-delete, which normal operation does not do. The same holds for `resume_id`: catalog-only
-- ADD COLUMN, one sequential scan of `job_queue_assignments` (all NULL) under SHARE ROW EXCLUSIVE
-- on it and on `senior_resumes`. No index: the SET NULL probe runs only on a resume delete, a rare
-- per-user action, and `job_queue_assignments` is small (one row per submission).
--
-- RE-RUNNABLE: `ADD COLUMN IF NOT EXISTS`, each FK under a `pg_constraint` existence guard; the
-- closing block refuses to finish unless the result is exactly the intended state.
--
-- ROLLBACK (by hand, one transaction; first revert the code, since the queue visibility predicate,
-- the queue row joins and POST /job-queue/manual name these columns). Dropping `manual_team_id`
-- turns every manual card into an opportunity no team can see (it has no source and no match);
-- dropping `resume_id` loses which resume each manual submission used (the audit row keeps it):
--   ALTER TABLE "job_queue_assignments" DROP CONSTRAINT IF EXISTS "fk_job_queue_assignments_resume";
--   ALTER TABLE "job_queue_assignments" DROP COLUMN IF EXISTS "resume_id";
--   ALTER TABLE "job_opportunities" DROP CONSTRAINT IF EXISTS "fk_job_opportunities_manual_team";
--   ALTER TABLE "job_opportunities" DROP COLUMN IF EXISTS "manual_team_id";
-- =============================================================================

SET LOCAL lock_timeout = '10s';

ALTER TABLE "job_opportunities" ADD COLUMN IF NOT EXISTS "manual_team_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_opportunities'::regclass
                    AND conname = 'fk_job_opportunities_manual_team') THEN
    ALTER TABLE "job_opportunities" ADD CONSTRAINT "fk_job_opportunities_manual_team"
      FOREIGN KEY ("manual_team_id") REFERENCES "teams"("id") ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE "job_queue_assignments" ADD COLUMN IF NOT EXISTS "resume_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_queue_assignments'::regclass
                    AND conname = 'fk_job_queue_assignments_resume') THEN
    ALTER TABLE "job_queue_assignments" ADD CONSTRAINT "fk_job_queue_assignments_resume"
      FOREIGN KEY ("resume_id") REFERENCES "senior_resumes"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- The closing check: the intended state, exactly, or the apply fails (and, applied in one
-- transaction, rolls back everything above). The expected definition is the normalised form
-- Postgres stores, as a `db:push` of the Drizzle schema produces it.
DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'job_opportunities'::regclass
                    AND a.attname = 'manual_team_id' AND NOT a.attisdropped
                    AND a.atttypid = 'uuid'::regtype AND NOT a.attnotnull AND NOT a.atthasdef) THEN
    problems := problems || 'column manual_team_id is missing or not a nullable uuid without a default'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_opportunities'::regclass
                    AND conname = 'fk_job_opportunities_manual_team'
                    AND contype = 'f' AND convalidated
                    AND confrelid = 'teams'::regclass
                    AND pg_get_constraintdef(oid) = 'FOREIGN KEY (manual_team_id) REFERENCES teams(id) ON DELETE RESTRICT') THEN
    problems := problems || 'FK fk_job_opportunities_manual_team is missing, not validated or not exactly the intended definition'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'job_queue_assignments'::regclass
                    AND a.attname = 'resume_id' AND NOT a.attisdropped
                    AND a.atttypid = 'uuid'::regtype AND NOT a.attnotnull AND NOT a.atthasdef) THEN
    problems := problems || 'column resume_id is missing or not a nullable uuid without a default'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_queue_assignments'::regclass
                    AND conname = 'fk_job_queue_assignments_resume'
                    AND contype = 'f' AND convalidated
                    AND confrelid = 'senior_resumes'::regclass
                    AND pg_get_constraintdef(oid) = 'FOREIGN KEY (resume_id) REFERENCES senior_resumes(id) ON DELETE SET NULL') THEN
    problems := problems || 'FK fk_job_queue_assignments_resume is missing, not validated or not exactly the intended definition'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'job_opportunities manual team DDL is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;
