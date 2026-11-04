-- =============================================================================
-- Per-senior queue submissions (r5 Phase 6, T0) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
--   Widens the shipped STUDIO-WIDE claim `UNIQUE(opportunity_id)` on `job_queue_assignments` into a
--   PER-SENIOR submission (owner queue-model decision 2026-10-18, plan r5 §4 "Queue model"):
--     1. adds `senior_id uuid NOT NULL`;
--     2. adds `fk_job_queue_assignments_senior` -> `users(id)` ON DELETE RESTRICT;
--     3. drops `uq_job_queue_assignments_opportunity`;
--     4. adds `uq_job_queue_assignments_opportunity_senior` UNIQUE(opportunity_id, senior_id).
--   After it, two seniors may be submitted to one opportunity independently; the same senior twice
--   is a 23505 on the new constraint.
--
-- WHY `senior_id` ON THIS TABLE, NOT A FK TO `job_opportunity_matches`
-- --------------------------------------------------------------------
--   A match row is a recomputable projection (input versions + outcome; it cascades away with its
--   senior), and a triage item may be submitted with no match row at all. A submission is a recorded
--   fact that must survive a recompute, so it names the senior directly and carries the same
--   (opportunity, senior) key the match row is keyed on — the two join on it, neither owns the other.
--
-- DATA: NONE MOVES. All six queue tables were measured EMPTY on production (plan r5 §4). The NOT
-- NULL column has no default on purpose: a non-empty table would need a per-row senior nobody can
-- derive, so the guard below refuses to run on one instead of inventing a value.
--
-- No grant: `job_queue_assignments` is class A in `privilege-classes.ts` (table-level grants cover a
-- new column), and this is an ALTER of an existing relation, so it is NOT in STAGED_RELATIONS.
--
-- The Drizzle declaration is `jobQueueAssignments` (schema/job-queue.ts);
-- job-queue-submissions-per-senior-ddl.integration.spec.ts applies this file TWICE into a scratch
-- schema, compares the objects with `db:push`, and proves the per-senior uniqueness.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- Production DDL ships staged. It is DARK: `manual-staged/` is never applied in prod (deploy.yml
-- refuses a file out of manual-staged/). Promotion and deploy wiring are an OWNER-ONLY later step.
--
-- PROMOTION GATE — DO NOT PROMOTE UNTIL BOTH HOLD
-- -----------------------------------------------
--   1. OWNER DECISION (A3, open): `team_members` lets one senior belong to SEVERAL teams. With
--      UNIQUE(opportunity_id, senior_id), team B submitting a senior that team A already submitted
--      gets 23505 — which itself discloses A's activity — and B could re-submit (UPDATE) A's
--      cancelled row. The owner must choose:
--        (a) a submission is a fact about the SENIOR, shown to every team the senior is an active
--            member of (as a bare "submitted elsewhere" marker, never A's row) — this key stands;
--        (b) per-team submissions — the KEY CHANGES to UNIQUE(opportunity_id, senior_id, team_id)
--            and `team_id` must become NOT NULL for team rows (a STUDIO row has none), i.e. this
--            file is rewritten before promotion, not after.
--      Until the owner answers, this file must not be promoted and Phase 6 must not ship the
--      submit path.
--   2. `SELECT count(*) FROM job_queue_assignments` = 0 on production, re-measured immediately
--      before the apply.
--
-- APPLY WITH `psql -v ON_ERROR_STOP=1 --single-transaction -f <this file>`: `SET LOCAL
-- lock_timeout` only binds inside a transaction, and the closing check is all-or-nothing only if
-- a failure rolls back everything above it.
--
-- NO `db:push` BEFORE THIS FILE: `senior_id` is NOT NULL without a default, so a `drizzle-kit push`
-- of the current Drizzle schema against a non-empty table would fail or prompt to truncate.
-- Checked 2026-11-04: deploy.yml and scripts/devops/deploy-stack-on-vps.sh run no `db:push` /
-- `drizzle-kit` at all (production DDL is the manual/ SQL list only); `db:push` runs only in CI
-- and local scratch databases, behind `seed-db-guard.ts`.
--
-- RE-RUNNABLE: `ADD COLUMN IF NOT EXISTS`, the FK and UNIQUE under `pg_constraint` existence guards,
-- `DROP CONSTRAINT IF EXISTS`; the closing block refuses to finish unless the result is exactly the
-- intended state.
--
-- ROLLBACK (by hand, one transaction; valid only while no opportunity has two submissions):
--   ALTER TABLE "job_queue_assignments" DROP CONSTRAINT IF EXISTS "uq_job_queue_assignments_opportunity_senior";
--   ALTER TABLE "job_queue_assignments" DROP CONSTRAINT IF EXISTS "fk_job_queue_assignments_senior";
--   ALTER TABLE "job_queue_assignments" DROP COLUMN IF EXISTS "senior_id";
--   ALTER TABLE "job_queue_assignments" ADD CONSTRAINT "uq_job_queue_assignments_opportunity" UNIQUE ("opportunity_id");
-- =============================================================================

SET LOCAL lock_timeout = '10s';

-- Refuse a non-empty table that has not been migrated yet (see DATA above). Once the column exists
-- the re-run is a no-op and rows are fine.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema()
                    AND table_name = 'job_queue_assignments'
                    AND column_name = 'senior_id')
     AND EXISTS (SELECT 1 FROM "job_queue_assignments") THEN
    RAISE EXCEPTION 'job_queue_assignments is not empty: a per-senior submission cannot be derived for existing rows';
  END IF;
END $$;

ALTER TABLE "job_queue_assignments" ADD COLUMN IF NOT EXISTS "senior_id" uuid NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_queue_assignments'::regclass
                    AND conname = 'fk_job_queue_assignments_senior') THEN
    ALTER TABLE "job_queue_assignments" ADD CONSTRAINT "fk_job_queue_assignments_senior"
      FOREIGN KEY ("senior_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;

ALTER TABLE "job_queue_assignments" DROP CONSTRAINT IF EXISTS "uq_job_queue_assignments_opportunity";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_queue_assignments'::regclass
                    AND conname = 'uq_job_queue_assignments_opportunity_senior') THEN
    ALTER TABLE "job_queue_assignments" ADD CONSTRAINT "uq_job_queue_assignments_opportunity_senior"
      UNIQUE ("opportunity_id", "senior_id");
  END IF;
END $$;

-- The closing check: the intended state, exactly, or the apply fails (and, applied in one
-- transaction, rolls back everything above). Expected definitions are the normalised forms
-- Postgres stores, as a `db:push` of the Drizzle schema produces them.
DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema()
                    AND table_name = 'job_queue_assignments'
                    AND column_name = 'senior_id'
                    AND data_type = 'uuid' AND is_nullable = 'NO' AND column_default IS NULL) THEN
    problems := problems || 'column senior_id is missing or not uuid NOT NULL without a default'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_queue_assignments'::regclass
                    AND conname = 'fk_job_queue_assignments_senior'
                    AND contype = 'f' AND convalidated
                    AND pg_get_constraintdef(oid) = 'FOREIGN KEY (senior_id) REFERENCES users(id) ON DELETE RESTRICT') THEN
    problems := problems || 'FK fk_job_queue_assignments_senior is missing, not validated or not exactly the intended definition'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_queue_assignments'::regclass
                    AND conname = 'uq_job_queue_assignments_opportunity_senior'
                    AND contype = 'u'
                    AND pg_get_constraintdef(oid) = 'UNIQUE (opportunity_id, senior_id)') THEN
    problems := problems || 'UNIQUE uq_job_queue_assignments_opportunity_senior is missing or not exactly (opportunity_id, senior_id)'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'job_queue_assignments'::regclass
                AND conname = 'uq_job_queue_assignments_opportunity') THEN
    problems := problems || 'the studio-wide UNIQUE uq_job_queue_assignments_opportunity still exists'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'job_queue_assignments per-senior DDL is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;
