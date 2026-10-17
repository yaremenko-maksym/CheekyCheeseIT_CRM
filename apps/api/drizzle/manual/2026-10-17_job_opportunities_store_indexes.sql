-- =============================================================================
-- job_opportunities store (r5 Phase 1) — prod forward DDL, part 2 of 2: indexes
-- =============================================================================
--
-- Apply AFTER 2026-10-17_job_opportunities_store.sql, which creates the tables these
-- 44 indexes sit on. Separate file because every statement here is
-- `CREATE INDEX CONCURRENTLY`, which Postgres refuses inside a transaction block, and
-- because a failed concurrent build is the one thing in this task that leaves an
-- object behind. See part 1's header for the idempotency contract and the deploy
-- mechanics; everything there applies here too. Both files are wired into
-- .github/workflows/deploy.yml as hard-required apply steps, part 1 then this one, so
-- the next deploy after the merge applies them — this is not a hand-run script.
--
-- The 15 UNIQUE and PRIMARY KEY indexes of the new tables are NOT here: they are
-- declared inline in part 1's `CREATE TABLE` as constraints, which is how
-- `db:push` declares them too, and a constraint-backing index cannot be built
-- concurrently. On a fresh database that costs nothing — the table is empty.
--
-- Why CONCURRENTLY at all, when the tables are empty on first apply
-- ----------------------------------------------------------------
-- Because the first apply is not the only apply. This file runs on EVERY deploy, and
-- the run that matters is the one where an index is missing from a table that by then
-- holds rows — a restored database, an index dropped by hand while diagnosing, or an
-- earlier deploy that failed in the middle of this file. A plain `CREATE INDEX` there
-- takes a write lock on a live table for the duration of the build.
--
-- INVALID leftovers, and the repair path
-- --------------------------------------
-- A `CREATE INDEX CONCURRENTLY` that is interrupted (lock timeout, a cancelled
-- deploy, a crash) leaves the index in place and `indisvalid = false`. That index is
-- NOT used by the planner, and it is NOT enforcing — a half-built UNIQUE index
-- enforces nothing — but `IF NOT EXISTS` sees the NAME and skips. So without the
-- sweep below, the ONE failure mode of concurrent building would persist silently
-- across every subsequent deploy, and a UNIQUE index that the store's correctness
-- depends on would quietly not be there.
--
-- The sweep drops any INVALID index AMONG EXACTLY THE 44 NAMES THIS FILE CREATES —
-- never anything else, so another feature's interrupted build is not collateral — and
-- the statement that follows rebuilds it. Hence: RE-RUNNING THIS FILE IS THE REPAIR —
-- and section 18 at the bottom is what makes that claim true rather than merely
-- intended: a run that leaves one of these indexes invalid with nothing building it
-- FAILS, instead of exiting 0 on a half-repaired database (SR-M-5).
-- No manual step, no runbook entry. `DROP INDEX` (non-concurrent) is used on purpose:
-- it needs a brief ACCESS EXCLUSIVE lock, which is correct for a nonfunctional index,
-- and unlike `DROP INDEX CONCURRENTLY` it is allowed inside the `DO` block that
-- selects the names. None of the 44 backs a constraint, so none can be undroppable.
--
-- THE GUARANTEE THE SWEEP GIVES, and why `NOT indisvalid` alone was not it (SR-M-2)
-- --------------------------------------------------------------------------------
-- `indisvalid = false` is NOT only the state of an abandoned build. It is also the
-- state of a `CREATE INDEX CONCURRENTLY` that is still RUNNING: the index row exists
-- from the first phase onward and only turns valid at the very end. Measured on a
-- 2,000,000-row `job_opportunities` with the build parked in its "waiting for old
-- snapshots" phase, the first version of this sweep dropped a LIVE build — no lock
-- wait, no error, and the building session then failed with `relation ... does not
-- exist`. Two deploys can overlap for real: the workflow's `concurrency` block uses
-- `cancel-in-progress: true`, so a cancelled deploy's build can still be running while
-- the next one reaches this file.
--
-- So the predicate now excludes anything `pg_stat_progress_create_index` reports for
-- this database, matching BOTH the index being built and any build or REINDEX on the
-- same TABLE (a REINDEX reports the new index's OID, not the old one's). The guarantee
-- is therefore: *the sweep drops an index that is invalid AND has no build in progress
-- for it or its table* — i.e. an ABANDONED one. A build that is merely slow is left
-- alone; `CREATE INDEX CONCURRENTLY IF NOT EXISTS` below then sees the name, skips, and
-- the other session finishes it. If that session dies instead, the index becomes a
-- genuine leftover and the NEXT deploy sweeps it. The one case this cannot see is a
-- build from a backend that has already gone away — which is exactly an abandoned
-- index, and exactly what should be swept.
--
-- A DEPENDENCY ON THE DATABASE ROLE MODEL, stated because it is load-bearing (SR-M-4)
-- ----------------------------------------------------------------------------------
-- That exclusion only works while the applying role can READ the progress rows.
-- `pg_stat_progress_create_index` does not hide a foreign session's row; it NULLs the
-- columns (`relid`, `index_relid`, `phase`) for a build started by a role the reader is
-- not a member of. `NULL = oid` is NULL, not TRUE, so a naive `NOT EXISTS` comes back
-- TRUE and the guard evaporates — silently, in exactly the situation it exists for.
-- Measured: as a non-superuser with a foreign build parked, `count(*) = 1` and
-- `count(relid) = 0`.
-- Today the deploy connects as `crm_user`, a SUPERUSER, so every row is readable — an
-- invariant that was written down nowhere until this paragraph. **r5 Task 1.3c, which
-- this file's part 1 names, introduces least-privileged roles (ADR in PR #1018). The
-- day the applying role stops being a superuser, this guard would have gone quiet.**
-- So the sweep does not rely on the invariant: it counts the rows it cannot attribute
-- and, if there are any, sweeps NOTHING and says so. Refusing on "cannot verify"
-- instead of acting on "did not see a problem" is the same rule as this repo's
-- WORKTREE-OPAQUE refusal (rules/common/agent-isolation.md): where the majority of
-- affected operations are destructive and the bypass is cheap, unverifiability is
-- treated as danger.
--
-- To see whether a leftover exists before deploying:
--   SELECT c.relname, i.indisvalid,
--          EXISTS (SELECT 1 FROM pg_stat_progress_create_index p
--                   WHERE p.index_relid = c.oid OR p.relid = i.indrelid) AS building
--     FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--    WHERE NOT i.indisvalid AND c.relname LIKE '%job%';
--
-- `statement_timeout` is deliberately LOOSER here than in part 1: a concurrent build
-- makes two passes over the table and waits out transactions older than itself, so a
-- tight bound would turn a slow deploy into a failed one. `lock_timeout` stays tight —
-- the lock a concurrent build takes is brief, and waiting for it is what blocks others.
--
-- THIS FILE CANNOT RUN ALONGSIDE AN INDEX BUILD ON ONE OF ITS OWN TABLES, and that is
-- worth knowing before it surprises someone mid-deploy. Measured while writing the
-- sweep's tests: `CREATE INDEX CONCURRENTLY IF NOT EXISTS` acquires ShareUpdateExclusive
-- on the TABLE **before** it notices the index already exists, and that lock conflicts
-- with itself — so if any concurrent build is in flight on, say, `job_opportunities`,
-- the very next `CREATE INDEX CONCURRENTLY` here blocks and `lock_timeout` fails the
-- apply, even for an index that is already present and valid. The outcome is correct
-- (fail loudly, re-run when the other build is done) and it is why the tests for the
-- sweep run the `DO` blocks directly rather than the whole file: the sweep takes no
-- table lock, so it is the part that CAN be exercised under those conditions.
-- =============================================================================

SET lock_timeout = '10s';
SET statement_timeout = '30min';


-- ---------------------------------------------------------------------------
-- 0. Drop ABANDONED invalid leftovers of the 44 indexes below, so the rebuild
--    can happen — but never an index whose build is still in progress (SR-M-2)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  leftover text;
  building text;
  total_builds int;
  attributable_builds int;
BEGIN
  -- FAIL-SAFE ON UNVERIFIABILITY (SR-M-4). `pg_stat_progress_create_index` does not
  -- hide another session's ROW from a non-superuser — it masks the columns this block
  -- reads. A build started by a role this one is not a member of therefore shows up
  -- with `relid`, `index_relid` and `phase` all NULL, and `NULL = oid` is NULL rather
  -- than TRUE, so the `NOT EXISTS` below would evaluate to TRUE and the sweep would
  -- drop a LIVE build. Measured: as a non-superuser with a foreign build parked,
  -- `count(*) = 1` while `count(relid) = 0`, and the old predicate's EXISTS was FALSE.
  -- So: a row that cannot be attributed means NOTHING is swept this run. Refusing on
  -- "could not verify" rather than on "verified dangerous" is the same rule as this
  -- repo's WORKTREE-OPAQUE refusal — see rules/common/agent-isolation.md.
  SELECT count(*), count(p.relid)
    INTO total_builds, attributable_builds
    FROM pg_stat_progress_create_index p
   WHERE p.datid = (SELECT oid FROM pg_database WHERE datname = current_database());

  IF total_builds <> attributable_builds THEN
    RAISE NOTICE
      'pg_stat_progress_create_index reports % index build(s) in this database and % of them are masked from role % — cannot prove no build is in progress, so NOTHING is swept this run; re-run when no build is in flight',
      total_builds, total_builds - attributable_builds, current_user;
    RETURN;
  END IF;

  -- Reported first and separately: if a build is in flight, the operator should see
  -- why an invalid index was left in place rather than wonder why nothing happened.
  FOR building IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND NOT i.indisvalid
       AND EXISTS (
             SELECT 1
               FROM pg_stat_progress_create_index p
              WHERE p.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND (p.index_relid = c.oid OR p.relid = i.indrelid)
           )
  LOOP
    RAISE NOTICE 'index % is invalid because a build is IN PROGRESS — leaving it alone', building;
  END LOOP;

  FOR leftover IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND NOT i.indisvalid
       -- An in-flight `CREATE INDEX CONCURRENTLY` (or `REINDEX CONCURRENTLY`) is also
       -- `indisvalid = false`. Dropping one kills a live build in another session; see
       -- the header's "THE GUARANTEE THE SWEEP GIVES" for the measurement.
       AND NOT EXISTS (
             SELECT 1
               FROM pg_stat_progress_create_index p
              WHERE p.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND (p.index_relid = c.oid OR p.relid = i.indrelid)
           )
       AND c.relname = ANY (ARRAY[
         'idx_job_account_meter_reservations_cycle',
         'idx_job_account_meter_reservations_meter_status',
         'idx_job_account_meter_reservations_run',
         'idx_job_collection_cycles_html_meter',
         'idx_job_collection_cycles_requested_by',
         'idx_job_collection_cycles_status',
         'idx_job_collection_runs_cycle',
         'idx_job_collection_runs_source_started',
         'idx_job_dirty_work_cycle',
         'idx_job_dirty_work_entity',
         'idx_job_dirty_work_pending',
         'idx_job_opportunities_application_url_key',
         'idx_job_opportunities_availability',
         'idx_job_opportunities_candidate_key',
         'idx_job_opportunities_description',
         'idx_job_opportunities_stack_keywords',
         'idx_job_opportunity_matches_senior',
         'idx_job_opportunity_sources_opportunity',
         'idx_job_opportunity_sources_record',
         'idx_job_opportunity_team_triage_assigned_by',
         'idx_job_opportunity_team_triage_team',
         'idx_job_queue_actions_opportunity',
         'idx_job_queue_actions_source_record',
         'idx_job_queue_actions_subject_team',
         'idx_job_queue_actions_subscription',
         'idx_job_queue_actions_team',
         'idx_job_queue_assignments_assignee',
         'idx_job_queue_assignments_team',
         'idx_job_queue_dismissals_team',
         'idx_job_queue_generation_entries_opportunity',
         'idx_job_queue_generations_status_expiry',
         'idx_job_queue_generations_team',
         'idx_job_source_record_revisions_description',
         'idx_job_source_record_revisions_record_seq',
         'idx_job_source_records_last_observed',
         'idx_job_sources_account_meter',
         'idx_job_sources_next_attempt',
         'idx_job_team_triage_subscriptions_team',
         'uq_job_collection_runs_running_owner',
         'uq_job_opportunity_sources_active_record',
         'uq_job_queue_actions_opened_once',
         'uq_job_queue_generations_published_studio',
         'uq_job_queue_generations_published_team',
         'uq_job_sources_manifest_id'
       ])
  LOOP
    RAISE NOTICE 'dropping INVALID index % (interrupted CONCURRENTLY build); it is rebuilt below', leftover;
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', current_schema(), leftover);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 1. job_account_meter_reservations
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_account_meter_reservations_cycle" ON "job_account_meter_reservations" USING btree ("cycle_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_account_meter_reservations_meter_status" ON "job_account_meter_reservations" USING btree ("meter_id","status");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_account_meter_reservations_run" ON "job_account_meter_reservations" USING btree ("run_id");

-- ---------------------------------------------------------------------------
-- 2. job_collection_cycles
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_collection_cycles_html_meter" ON "job_collection_cycles" USING btree ("html_call_meter_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_collection_cycles_requested_by" ON "job_collection_cycles" USING btree ("requested_by");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_collection_cycles_status" ON "job_collection_cycles" USING btree ("status","started_at");

-- ---------------------------------------------------------------------------
-- 3. job_collection_runs
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_collection_runs_cycle" ON "job_collection_runs" USING btree ("cycle_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_collection_runs_source_started" ON "job_collection_runs" USING btree ("source_id","started_at" DESC NULLS LAST);

-- Partial: at most one STARTED run per (source, config version) — the lock that keeps
-- two schedulers from collecting the same source at once.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_job_collection_runs_running_owner" ON "job_collection_runs" USING btree ("source_id","config_version") WHERE "job_collection_runs"."outcome" = 'STARTED';

-- ---------------------------------------------------------------------------
-- 4. job_dirty_work
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_dirty_work_cycle" ON "job_dirty_work" USING btree ("cycle_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_dirty_work_entity" ON "job_dirty_work" USING btree ("entity_kind","entity_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_dirty_work_pending" ON "job_dirty_work" USING btree ("status","created_at");

-- ---------------------------------------------------------------------------
-- 5. job_opportunities
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_opportunities_application_url_key" ON "job_opportunities" USING btree ("application_url_key");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_opportunities_availability" ON "job_opportunities" USING btree ("availability");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_opportunities_candidate_key" ON "job_opportunities" USING btree ("employer_key","title_key");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_opportunities_description" ON "job_opportunities" USING btree ("description_sha256");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_opportunities_stack_keywords" ON "job_opportunities" USING gin ("stack_keywords");

-- ---------------------------------------------------------------------------
-- 6. job_opportunity_matches
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_opportunity_matches_senior" ON "job_opportunity_matches" USING btree ("senior_id","outcome");

-- ---------------------------------------------------------------------------
-- 7. job_opportunity_sources
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_opportunity_sources_opportunity" ON "job_opportunity_sources" USING btree ("opportunity_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_opportunity_sources_record" ON "job_opportunity_sources" USING btree ("source_record_id");

-- Partial: a source record is linked to at most one opportunity AT A TIME, while the
-- unlinked history rows beside it stay.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_job_opportunity_sources_active_record" ON "job_opportunity_sources" USING btree ("source_record_id") WHERE "job_opportunity_sources"."unlinked_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 8. job_opportunity_team_triage
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_opportunity_team_triage_assigned_by" ON "job_opportunity_team_triage" USING btree ("assigned_by");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_opportunity_team_triage_team" ON "job_opportunity_team_triage" USING btree ("team_id","expires_at");

-- ---------------------------------------------------------------------------
-- 9. job_queue_actions
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_queue_actions_opportunity" ON "job_queue_actions" USING btree ("opportunity_id","created_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_queue_actions_source_record" ON "job_queue_actions" USING btree ("source_record_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_queue_actions_subject_team" ON "job_queue_actions" USING btree ("subject_team_id","created_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_queue_actions_subscription" ON "job_queue_actions" USING btree ("subscription_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_queue_actions_team" ON "job_queue_actions" USING btree ("team_id","created_at");

-- Partial: OPENED is idempotent click telemetry per (actor, opportunity, source record).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_job_queue_actions_opened_once" ON "job_queue_actions" USING btree ("actor_id","opportunity_id","source_record_id") WHERE "job_queue_actions"."kind" = 'OPENED';

-- ---------------------------------------------------------------------------
-- 10. job_queue_assignments
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_queue_assignments_assignee" ON "job_queue_assignments" USING btree ("assignee_id","state");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_queue_assignments_team" ON "job_queue_assignments" USING btree ("team_id","state");

-- ---------------------------------------------------------------------------
-- 11. job_queue_dismissals
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_queue_dismissals_team" ON "job_queue_dismissals" USING btree ("team_id");

-- ---------------------------------------------------------------------------
-- 12. job_queue_generation_entries
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_queue_generation_entries_opportunity" ON "job_queue_generation_entries" USING btree ("opportunity_id");

-- ---------------------------------------------------------------------------
-- 13. job_queue_generations
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_queue_generations_status_expiry" ON "job_queue_generations" USING btree ("status","expires_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_queue_generations_team" ON "job_queue_generations" USING btree ("team_id");

-- Two partial indexes, not one over (scope_kind, team_id): a plain UNIQUE treats every
-- STUDIO NULL as distinct, so it would allow any number of published STUDIO snapshots.
-- Together they are what makes the publish atomic — two publishers racing for one scope
-- both reach the index and exactly one commits.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_job_queue_generations_published_studio" ON "job_queue_generations" USING btree ("scope_kind") WHERE "job_queue_generations"."status" = 'PUBLISHED' AND "job_queue_generations"."scope_kind" = 'STUDIO';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_job_queue_generations_published_team" ON "job_queue_generations" USING btree ("team_id") WHERE "job_queue_generations"."status" = 'PUBLISHED' AND "job_queue_generations"."scope_kind" = 'TEAM';

-- ---------------------------------------------------------------------------
-- 14. job_source_record_revisions
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_source_record_revisions_description" ON "job_source_record_revisions" USING btree ("description_sha256");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_source_record_revisions_record_seq" ON "job_source_record_revisions" USING btree ("source_record_id","received_seq" DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- 15. job_source_records
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_source_records_last_observed" ON "job_source_records" USING btree ("last_observed_at");

-- ---------------------------------------------------------------------------
-- 16. job_sources
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_sources_account_meter" ON "job_sources" USING btree ("account_meter_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_sources_next_attempt" ON "job_sources" USING btree ("next_attempt_at");

-- Partial: manifest_id is unique when present and unconstrained while NULL (every row
-- that predates the manifest).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_job_sources_manifest_id" ON "job_sources" USING btree ("manifest_id") WHERE "job_sources"."manifest_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 17. job_team_triage_subscriptions
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_team_triage_subscriptions_team" ON "job_team_triage_subscriptions" USING btree ("team_id","expires_at");


-- ---------------------------------------------------------------------------
-- 18. Final check: no index this file owns may be left invalid and unattended
-- ---------------------------------------------------------------------------
--
-- SR-M-5. The sweep above deliberately spares an invalid index while a build is in
-- progress — including a build on the SAME TABLE but a DIFFERENT index, which is the
-- collateral case that makes the spare too generous for one run: the abandoned index
-- is skipped, `CREATE INDEX CONCURRENTLY IF NOT EXISTS` then sees the name and skips
-- too, and the file would exit 0 having left it invalid. Six of the 44 are UNIQUE, so
-- that is a store invariant silently unenforced until some later deploy.
--
-- So the file does not get to claim success in that state. This check keys on the
-- index ITSELF (`p.index_relid = c.oid`, not `p.relid`), so a genuine in-flight build
-- of that very index is still fine; anything else invalid is an error and
-- `ON_ERROR_STOP=1` turns it into a failed deploy. "RE-RUNNING THIS FILE IS THE
-- REPAIR" is true again, because a run that did not repair now fails.
--
-- The deliberate false positive: under a role that cannot read the progress columns
-- (see the sweep's own note), a real in-flight build of one of these indexes is
-- invisible here too, so this raises when it need not have. That is the direction to
-- err in — a failed deploy an operator re-runs, rather than a UNIQUE index that is
-- quietly not enforcing. The name list is repeated rather than shared because every
-- statement in this file must be independently applicable; no temp table, no session
-- state carried between statements.
DO $$
DECLARE
  unusable text;
  found int := 0;
BEGIN
  FOR unusable IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = current_schema()
       AND NOT i.indisvalid
       AND NOT EXISTS (
             SELECT 1
               FROM pg_stat_progress_create_index p
              WHERE p.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND p.index_relid = c.oid
           )
       AND c.relname = ANY (ARRAY[
         'idx_job_account_meter_reservations_cycle',
         'idx_job_account_meter_reservations_meter_status',
         'idx_job_account_meter_reservations_run',
         'idx_job_collection_cycles_html_meter',
         'idx_job_collection_cycles_requested_by',
         'idx_job_collection_cycles_status',
         'idx_job_collection_runs_cycle',
         'idx_job_collection_runs_source_started',
         'idx_job_dirty_work_cycle',
         'idx_job_dirty_work_entity',
         'idx_job_dirty_work_pending',
         'idx_job_opportunities_application_url_key',
         'idx_job_opportunities_availability',
         'idx_job_opportunities_candidate_key',
         'idx_job_opportunities_description',
         'idx_job_opportunities_stack_keywords',
         'idx_job_opportunity_matches_senior',
         'idx_job_opportunity_sources_opportunity',
         'idx_job_opportunity_sources_record',
         'idx_job_opportunity_team_triage_assigned_by',
         'idx_job_opportunity_team_triage_team',
         'idx_job_queue_actions_opportunity',
         'idx_job_queue_actions_source_record',
         'idx_job_queue_actions_subject_team',
         'idx_job_queue_actions_subscription',
         'idx_job_queue_actions_team',
         'idx_job_queue_assignments_assignee',
         'idx_job_queue_assignments_team',
         'idx_job_queue_dismissals_team',
         'idx_job_queue_generation_entries_opportunity',
         'idx_job_queue_generations_status_expiry',
         'idx_job_queue_generations_team',
         'idx_job_source_record_revisions_description',
         'idx_job_source_record_revisions_record_seq',
         'idx_job_source_records_last_observed',
         'idx_job_sources_account_meter',
         'idx_job_sources_next_attempt',
         'idx_job_team_triage_subscriptions_team',
         'uq_job_collection_runs_running_owner',
         'uq_job_opportunity_sources_active_record',
         'uq_job_queue_actions_opened_once',
         'uq_job_queue_generations_published_studio',
         'uq_job_queue_generations_published_team',
         'uq_job_sources_manifest_id'
       ])
  LOOP
    found := found + 1;
    RAISE WARNING 'index % is INVALID and no build is in progress for it', unusable;
  END LOOP;

  IF found > 0 THEN
    RAISE EXCEPTION
      '% index(es) of this store are INVALID with no build in progress — this run did not reach the intended state; re-run this file (it drops and rebuilds them)',
      found;
  END IF;
END $$;
