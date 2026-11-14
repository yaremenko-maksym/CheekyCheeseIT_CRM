-- =============================================================================
-- Opportunity role family (r5 Task 6.4c) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
--   Gives `job_opportunities` the persisted layer-1 role family a triage subscription keys on:
--     1. adds `role_family text`, NULLABLE with NO default: NULL means "never evaluated" or "layer 1
--        could not classify it" (UNKNOWN is written as NULL);
--     2. adds `ck_job_opportunities_role_family_bounded`: NULL, or non-blank and at most 100
--        characters, the same bound as `job_team_triage_subscriptions.role_family`.
--
-- WHY. The subscription branch of `visibleOpportunityPredicate` shows a team an opportunity whose
-- role family equals a live (not revoked, not expired) subscription's, among other conditions.
-- `installMatches` writes the column in the transaction of the evaluation record, from the same
-- verdict, so it can never describe a different revision than `evaluated_revision`. A NULL never
-- equals anything, so an unclassified or never-evaluated opportunity fails closed.
--
-- BACKFILL: NOT HERE. After promotion EVERY existing row is NULL, so no subscription shows anything
-- until the row is re-evaluated. The code carries the backfill: the default inputs version now also
-- names `EVALUATION_RECORD_VERSION` ('rf.1'), so every stored `evaluated_inputs_version` is stale at
-- once. The match reconciliation sweep (`reconcileOnce`) treats an OPEN or UNKNOWN opportunity with
-- a stale inputs version as unevaluated and re-enqueues it under a NEW `RECONCILE:EVAL:` reason
-- (the reason carries the digest, so a DONE row of the old digest does not suppress it). The
-- recompute then writes `role_family`. CLOSED and EXPIRED rows stay NULL: neither the grant nor the
-- subscription branch shows them, and a reopen bumps the revision and enqueues a recompute.
-- That needs JOB_MATCH_RECONCILIATION_ENABLED=true, and it drains at most 2,000 opportunities per
-- 6-hour tick, so N opportunities take about N / 2,000 ticks.
--
-- THE COST, STATED PLAINLY. The version bump is a rule deploy: from the moment the build carrying
-- it runs, EVERY grant-visible opportunity is hidden from its team (the grant branch requires the
-- live inputs version) until its recompute lands, exactly as a MATCH_RULE_VERSION change does.
-- STUDIO and the LEAD branch do not read these columns.
--
-- SIZE IT FIRST (owner step): read `SELECT count(*) FROM job_opportunities` before promoting. The
-- backfill shares the one MATCH FIFO at 2,000 per 6-hour tick, so revision recomputes and exclusion
-- fan-outs queue behind it: about 12.5 days at 100,000 opportunities.
--
-- ORDER (owner step): apply this file BEFORE a build carrying this code runs the recompute worker
-- or exposes the queue. `installMatches` names `role_family` in its UPDATE, so with the column
-- absent every recompute fails with 42703 and rolls back its match rows; the queue visibility
-- predicate reads it too. It also depends on the 2026-11-04 evaluation-verdict file (the sweep that
-- backfills it reads `evaluated_inputs_version`).
--
-- No grant: `job_opportunities` is class A in `privilege-classes.ts` (table-level grants cover a new
-- column), and this is an ALTER of an existing relation, so it is NOT in STAGED_RELATIONS.
--
-- The Drizzle declaration is `jobOpportunities` (schema/job-opportunities.ts).
-- job-opportunities-role-family-ddl.integration.spec.ts applies this file twice into a scratch
-- schema and compares the objects with `db:push`; job-opportunities-store-forward-ddl.integration.spec.ts
-- chains it after the 2026-11-04 evaluation-verdict file.
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
-- CONSTRAINT scans the table once under the ACCESS EXCLUSIVE lock (a NULL test per row, all NULL).
--
-- RE-RUNNABLE: `ADD COLUMN IF NOT EXISTS`, the CHECK under a `pg_constraint` existence guard; the
-- closing block refuses to finish unless the result is exactly the intended state.
--
-- ROLLBACK (by hand, one transaction; first revert the code, since `installMatches` and the queue
-- visibility predicate name this column):
--   ALTER TABLE "job_opportunities" DROP CONSTRAINT IF EXISTS "ck_job_opportunities_role_family_bounded";
--   ALTER TABLE "job_opportunities" DROP COLUMN IF EXISTS "role_family";
-- =============================================================================

SET LOCAL lock_timeout = '10s';

ALTER TABLE "job_opportunities" ADD COLUMN IF NOT EXISTS "role_family" text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_opportunities'::regclass
                    AND conname = 'ck_job_opportunities_role_family_bounded') THEN
    ALTER TABLE "job_opportunities" ADD CONSTRAINT "ck_job_opportunities_role_family_bounded"
      CHECK ("job_opportunities"."role_family" IS NULL
             OR ("job_opportunities"."role_family" ~ '[^[:space:]]' AND length("job_opportunities"."role_family") <= 100));
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
                    AND a.attname = 'role_family' AND NOT a.attisdropped
                    AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND NOT a.atthasdef) THEN
    problems := problems || 'column role_family is missing or not a nullable text without a default'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_opportunities'::regclass
                    AND conname = 'ck_job_opportunities_role_family_bounded'
                    AND contype = 'c' AND convalidated
                    AND pg_get_constraintdef(oid) = 'CHECK (((role_family IS NULL) OR ((role_family ~ ''[^[:space:]]''::text) AND (length(role_family) <= 100))))') THEN
    problems := problems || 'CHECK ck_job_opportunities_role_family_bounded is missing, not validated or not exactly the intended definition'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'job_opportunities role family DDL is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;
