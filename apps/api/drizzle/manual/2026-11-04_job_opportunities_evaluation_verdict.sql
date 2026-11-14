-- =============================================================================
-- Opportunity evaluated revision + verdict (r5 Task 6.1 SR-M-2) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
--   Gives `job_opportunities` the persisted statement "this opportunity was evaluated at revision
--   N against inputs version D, and the opportunity-level result was V" (owner decisions
--   2026-11-04: option 1, then the inputs version for SR-M-1):
--     1. creates the enum `job_opportunity_verdict` ('OPEN', 'EXCLUDED');
--     2. adds `evaluated_revision integer`, `evaluation_verdict job_opportunity_verdict` and
--        `evaluated_inputs_version text`, all NULLABLE with NO default: NULL means "never evaluated";
--     3. adds `ck_job_opportunities_evaluation_pair`: the three are NULL together or set together.
--
-- WHY. The triage-grant branch of queue visibility must not show an opportunity that became
-- restricted between a revision bump and its recompute, or for good with an empty roster (the match
-- rows are per senior, and an empty roster writes none). `installMatches` writes all three columns
-- in the transaction of the match rows; `visibleOpportunityPredicate` requires evaluated_revision =
-- revision, evaluation_verdict = 'OPEN' AND evaluated_inputs_version = the live digest of the rule
-- version and the studio-wide keyword exclusions, so a NULL fails closed.
--
-- THE COST, STATED PLAINLY. Any change to a studio-wide keyword exclusion, and any deploy that
-- changes the match rule version, hides EVERY granted opportunity at once, until its recompute
-- lands at the new digest. The sweep re-enqueues them under `RECONCILE:EVAL:`, at most 2,000 per
-- 6-hour tick, so N granted-or-not opportunities take up to N / 2,000 ticks to show again.
--
-- BACKFILL: NONE HERE. After promotion EVERY existing row is NULL, so every granted opportunity is
-- HIDDEN from its team until its recompute (STUDIO and the LEAD branch do not read these columns).
-- The recompute is triggered by the match reconciliation sweep (`reconcileOnce`), which treats an
-- OPEN or UNKNOWN opportunity whose evaluated_revision differs from its revision, or whose
-- evaluated_inputs_version differs from the live digest, as stale under its own `RECONCILE:EVAL:`
-- dirty reason, even when the match rows are fresh or a DONE row already exists. CLOSED and EXPIRED rows
-- stay NULL: a grant hides them anyway, and a reopen bumps the revision and enqueues a recompute.
-- That needs JOB_MATCH_RECONCILIATION_ENABLED=true, and it drains at most 2,000 opportunities per
-- 6-hour tick, so N opportunities take about N / 2,000 ticks.
--
-- SIZE IT FIRST (owner step): read `SELECT count(*) FROM job_opportunities` before promoting. The
-- backfill shares the one MATCH FIFO at 2,000 per 6-hour tick, so revision recomputes and exclusion
-- fan-outs queue behind it: about 12.5 days at 100,000 opportunities.
--
-- ORDER (owner step): apply this file BEFORE JOB_MATCH_RECONCILIATION_ENABLED is true on a build
-- carrying this code. With the flag on and the columns absent, the sweep's SELECT fails with 42703,
-- the whole tick aborts, and matches stop being recomputed until this file is applied. With the flag
-- off nothing reads or writes these columns in production: nothing injects the queue visibility
-- service yet, and every other read of `job_opportunities` names its columns. Apply it also before
-- the queue is exposed.
--
-- No grant: `job_opportunities` is class A in `privilege-classes.ts` (table-level grants cover a new
-- column), and this is an ALTER of an existing relation, so it is NOT in STAGED_RELATIONS.
--
-- The Drizzle declaration is `jobOpportunities` (schema/job-opportunities.ts) and
-- `jobOpportunityVerdictEnum` (schema/enums.ts). job-opportunities-evaluation-verdict-ddl.integration.spec.ts
-- applies this file twice into a scratch schema and compares the objects with `db:push`;
-- job-opportunities-store-forward-ddl.integration.spec.ts chains it after the 2026-11-04
-- submissions file.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- Production DDL ships staged. It is DARK: `manual-staged/` is never applied in prod (deploy.yml
-- refuses a file out of manual-staged/). Promotion and deploy wiring are an OWNER-ONLY later step.
--
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
-- APPLY WITH `psql -v ON_ERROR_STOP=1 --single-transaction -f <this file>`: `SET LOCAL
-- lock_timeout` only binds inside a transaction, and the closing check is all-or-nothing only if
-- a failure rolls back everything above it. ADD COLUMN without a default is catalog-only; ADD
-- CONSTRAINT scans the table once under the ACCESS EXCLUSIVE lock (a NULL test per row).
--
-- RE-RUNNABLE: `CREATE TYPE` under `duplicate_object`, `ADD COLUMN IF NOT EXISTS`, the CHECK under a
-- `pg_constraint` existence guard; the closing block refuses to finish unless the result is exactly
-- the intended state.
--
-- ROLLBACK (by hand, one transaction; first turn JOB_MATCH_RECONCILIATION_ENABLED off, or revert the
-- code, since the sweep and `installMatches` name these columns):
--   ALTER TABLE "job_opportunities" DROP CONSTRAINT IF EXISTS "ck_job_opportunities_evaluation_pair";
--   ALTER TABLE "job_opportunities" DROP COLUMN IF EXISTS "evaluated_inputs_version";
--   ALTER TABLE "job_opportunities" DROP COLUMN IF EXISTS "evaluation_verdict";
--   ALTER TABLE "job_opportunities" DROP COLUMN IF EXISTS "evaluated_revision";
--   DROP TYPE IF EXISTS "job_opportunity_verdict";
-- =============================================================================

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  CREATE TYPE "job_opportunity_verdict" AS ENUM('OPEN', 'EXCLUDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "job_opportunities" ADD COLUMN IF NOT EXISTS "evaluated_revision" integer;
ALTER TABLE "job_opportunities" ADD COLUMN IF NOT EXISTS "evaluation_verdict" "job_opportunity_verdict";
ALTER TABLE "job_opportunities" ADD COLUMN IF NOT EXISTS "evaluated_inputs_version" text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_opportunities'::regclass
                    AND conname = 'ck_job_opportunities_evaluation_pair') THEN
    ALTER TABLE "job_opportunities" ADD CONSTRAINT "ck_job_opportunities_evaluation_pair"
      CHECK (("job_opportunities"."evaluated_revision" IS NULL) = ("job_opportunities"."evaluation_verdict" IS NULL)
             AND ("job_opportunities"."evaluated_revision" IS NULL) = ("job_opportunities"."evaluated_inputs_version" IS NULL));
  END IF;
END $$;

-- The closing check: the intended state, exactly, or the apply fails (and, applied in one
-- transaction, rolls back everything above). Expected definitions are the normalised forms
-- Postgres stores, as a `db:push` of the Drizzle schema produces them.
DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
BEGIN
  IF (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
        FROM pg_enum e WHERE e.enumtypid = 'job_opportunity_verdict'::regtype)
     IS DISTINCT FROM ARRAY['OPEN', 'EXCLUDED'] THEN
    problems := problems || 'enum job_opportunity_verdict is not exactly (OPEN, EXCLUDED)'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'job_opportunities'::regclass
                    AND a.attname = 'evaluated_revision' AND NOT a.attisdropped
                    AND a.atttypid = 'integer'::regtype AND NOT a.attnotnull AND NOT a.atthasdef) THEN
    problems := problems || 'column evaluated_revision is missing or not a nullable integer without a default'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'job_opportunities'::regclass
                    AND a.attname = 'evaluation_verdict' AND NOT a.attisdropped
                    AND a.atttypid = 'job_opportunity_verdict'::regtype AND NOT a.attnotnull AND NOT a.atthasdef) THEN
    problems := problems || 'column evaluation_verdict is missing or not a nullable job_opportunity_verdict without a default'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'job_opportunities'::regclass
                    AND a.attname = 'evaluated_inputs_version' AND NOT a.attisdropped
                    AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND NOT a.atthasdef) THEN
    problems := problems || 'column evaluated_inputs_version is missing or not a nullable text without a default'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_opportunities'::regclass
                    AND conname = 'ck_job_opportunities_evaluation_pair'
                    AND contype = 'c' AND convalidated
                    AND pg_get_constraintdef(oid) = 'CHECK ((((evaluated_revision IS NULL) = (evaluation_verdict IS NULL)) AND ((evaluated_revision IS NULL) = (evaluated_inputs_version IS NULL))))') THEN
    problems := problems || 'CHECK ck_job_opportunities_evaluation_pair is missing, not validated or not exactly the intended definition'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'job_opportunities evaluation DDL is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;
