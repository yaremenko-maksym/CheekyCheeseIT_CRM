-- =============================================================================
-- `interviews` learns which vacancy-queue opportunity it came from (task-sources-07c)
--   — prod forward DDL
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. adds `interviews.job_opportunity_id uuid` (NULLABLE, no default);
--   2. adds `fk_interviews_job_opportunity` -> `job_opportunities(id)` ON DELETE SET NULL;
--   3. adds the partial unique index `uq_interviews_job_opportunity_senior`
--      ON (job_opportunity_id, senior_id) WHERE job_opportunity_id IS NOT NULL.
--   After it, an HR submission out of the vacancy queue can become EXACTLY ONE interview card on
--   the submitted senior's board, and that one card can be found again later.
--
-- WHY A COLUMN IS NEEDED AT ALL (owner decision 2026-11-19, Q1 = YES)
-- -------------------------------------------------------------------
--   `interviews` had no job-sourcing column of any kind, so nothing could name the submission a
--   card came from. Two defects follow, and neither is cosmetic:
--     * HR cancels a submission and the senior's card keeps saying "you are submitted to X"
--       forever, because no query can find the card to correct it;
--     * the REPLACE branch of `JobQueueActionsService.submit` DELETEs a RELEASED assignment row and
--       INSERTs a fresh one with a NEW id, so `uq_job_queue_assignments_opportunity_senior` does
--       NOT make submission once-per-pair across time — a release-then-replace would hand the
--       senior a second, duplicate card for the same vacancy.
--   Design and the rejected no-DDL alternatives:
--   `~/.claude/handoffs/sources-connect-2026-11-19/task-07c-DESIGN.md`.
--
-- WHY KEYED ON THE OPPORTUNITY, NOT ON THE ASSIGNMENT
-- ---------------------------------------------------
--   An assignment-id key does not work: the REPLACE branch deletes the assignment row, so
--   ON DELETE SET NULL would null the link and the following INSERT carries a new id — a second
--   card appears anyway and the defect survives. The (opportunity, senior) pair is the thing that
--   is actually stable, and it is the same pair `uq_job_queue_assignments_opportunity_senior`
--   already guards. Verified stable: no production code path deletes a `job_opportunities` row
--   (`grep -rn "DELETE FROM job_opportunities" apps/api/src` outside specs returns only the test
--   fixture `apps/api/src/test/record-store-fixtures.ts`).
--
-- ON DELETE SET NULL, NOT CASCADE
-- -------------------------------
--   Production never deletes an opportunity today. If it ever does, a card the senior has already
--   moved forward and written notes on must NOT vanish with it: the card survives, it merely stops
--   knowing which vacancy it came from. The same choice `created_project_id` makes on this table.
--
-- WHY THE INDEX IS PARTIAL
-- ------------------------
--   Every interview created by hand on the board — the overwhelming majority — has
--   `job_opportunity_id IS NULL`, and in Postgres NULLs do not collide in a unique index anyway;
--   the `WHERE job_opportunity_id IS NOT NULL` predicate keeps the index to queue-born cards only
--   and makes "one card per (opportunity, senior)" a DATABASE fact rather than a service
--   convention. Exactly the shape `uq_interviews_created_project_id` already uses on this table.
--
-- DATA: NONE MOVES, NONE CHANGES. The column is nullable with no default, so every existing
-- `interviews` row keeps `job_opportunity_id = NULL` and is excluded from the partial index. No
-- backfill is possible or wanted: no card in production came from the queue (the queue tables were
-- measured empty, plan r5 §4), and inventing a link for an existing hand-made card would be a lie.
--
-- No grant: `interviews` is class A in `privileges/privilege-classes.ts` (table-level grants cover
-- a new column), and this is an ALTER of an existing relation, so it was never and is not in
-- STAGED_RELATIONS.
--
-- The Drizzle declaration is `interviews.jobOpportunityId` (`schema/interviews.ts`);
-- `interviews-job-opportunity-forward-ddl.integration.spec.ts` applies this file TWICE into a
-- scratch database, compares the resulting objects against a `db:push` of the Drizzle schema, and
-- proves the per-(opportunity, senior) uniqueness together with the NULL exemption.
--
-- APPLY WITH (one transaction, stop on first error):
--   psql -v ON_ERROR_STOP=1 --single-transaction \
--     -f apps/api/drizzle/manual/2026-11-19_interviews_job_opportunity.sql
--   `SET LOCAL lock_timeout` only binds inside a transaction, and the closing check is
--   all-or-nothing only if a failure rolls back everything above it.
--
-- ORDER: APPLY 2026-11-19_interview_stage_submitted.sql FIRST. That file is independent of this
-- one at the schema level, but the application code needs both, and the enum file is the
-- irreversible half — if it fails, this reversible half should not have run either.
--
-- RE-RUNNABLE: `ADD COLUMN IF NOT EXISTS`, the FK under a `pg_constraint` existence guard,
-- `CREATE UNIQUE INDEX IF NOT EXISTS`; the closing block refuses to finish unless the result is
-- exactly the intended state.
--
-- ROLLBACK (by hand, one transaction; valid only while no code reads the column):
--   DROP INDEX IF EXISTS "uq_interviews_job_opportunity_senior";
--   ALTER TABLE "interviews" DROP CONSTRAINT IF EXISTS "fk_interviews_job_opportunity";
--   ALTER TABLE "interviews" DROP COLUMN IF EXISTS "job_opportunity_id";
-- =============================================================================

SET LOCAL lock_timeout = '10s';

ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "job_opportunity_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'interviews'::regclass
                    AND conname = 'fk_interviews_job_opportunity') THEN
    ALTER TABLE "interviews" ADD CONSTRAINT "fk_interviews_job_opportunity"
      FOREIGN KEY ("job_opportunity_id") REFERENCES "job_opportunities"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_interviews_job_opportunity_senior"
  ON "interviews" ("job_opportunity_id", "senior_id")
  WHERE "job_opportunity_id" IS NOT NULL;

-- The closing check: the intended state, exactly, or the apply fails (and, applied in one
-- transaction, rolls back everything above it). Expected definitions are the normalised forms
-- Postgres stores, as a `db:push` of the Drizzle schema produces them.
DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema()
                    AND table_name = 'interviews'
                    AND column_name = 'job_opportunity_id'
                    AND data_type = 'uuid' AND is_nullable = 'YES' AND column_default IS NULL) THEN
    problems := problems || 'column job_opportunity_id is missing or not nullable uuid without a default'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'interviews'::regclass
                    AND conname = 'fk_interviews_job_opportunity'
                    AND contype = 'f' AND convalidated
                    AND pg_get_constraintdef(oid)
                        = 'FOREIGN KEY (job_opportunity_id) REFERENCES job_opportunities(id) ON DELETE SET NULL') THEN
    problems := problems || 'FK fk_interviews_job_opportunity is missing, not validated or not exactly the intended definition'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = current_schema()
                    AND tablename = 'interviews'
                    AND indexname = 'uq_interviews_job_opportunity_senior'
                    AND indexdef LIKE 'CREATE UNIQUE INDEX%(job_opportunity_id, senior_id)%WHERE (job_opportunity_id IS NOT NULL)') THEN
    problems := problems || 'the partial UNIQUE index uq_interviews_job_opportunity_senior is missing or not exactly (job_opportunity_id, senior_id) WHERE job_opportunity_id IS NOT NULL'::text;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'interviews job-opportunity DDL is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;

-- =============================================================================
-- VERIFY (after applying):
--   \d interviews                        -- job_opportunity_id uuid, nullable
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_interviews_job_opportunity_senior';
-- =============================================================================
