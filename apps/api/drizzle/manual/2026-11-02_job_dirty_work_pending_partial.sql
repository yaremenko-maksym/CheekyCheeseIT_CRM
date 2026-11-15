-- =============================================================================
-- Generic-pending partial index excluding the detail backlog (CR-M-4) — prod forward DDL
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
--   `idx_job_dirty_work_pending_generic`: a PARTIAL btree index on `(status, created_at)` WHERE
--   `reason <> 'DETAIL_FETCH'` — a mirror of `idx_job_dirty_work_pending` that omits the detail
--   backlog. After the ON_DEMAND flip (step #10) the generic pending claimers filter
--   `reason <> 'DETAIL_FETCH'` and would otherwise scan over every queued DETAIL_FETCH row on the
--   full `(status, created_at)` index; this partial index lets the planner skip that backlog.
--
-- The Drizzle declaration is `jobDirtyWork` (schema/job-collection.ts, index
-- `idx_job_dirty_work_pending_generic`); job-dirty-work-pending-partial-ddl.integration.spec.ts
-- applies this file into a scratch schema and asserts the index exists with exactly this partial
-- predicate and equals what `db:push` declares in `public`.
--
-- APPLIED BY THE DEPLOY, AUTOCOMMIT (promoted to manual/ by backlog 434)
-- -----------------------------------------------------------------------
-- Promoted from manual-staged/ by backlog 434. `deploy-stack-on-vps.sh` applies this file on
-- EVERY deploy, after the store indexes and before the container swap, as
--   psql -v ON_ERROR_STOP=1 < <this file>
-- WITHOUT `--single-transaction`: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction
-- block. psql sends each statement on its own, so the two `DO` blocks below run in autocommit
-- too (a `DO` block is allowed there; only the CONCURRENTLY statement may not sit inside one).
-- This file was not hand-applied in production before the promotion: the first deploy builds
-- the index, every later one is a no-op.
--
-- WHY CONCURRENTLY, LOCK TIMEOUT, AND DEPLOY BOUNDS (CR-M-4 / SR-M-2, SR-M-3)
-- -------------------------------------------------------------------------
-- `job_dirty_work` is a hot queue; building this index must not take an exclusive lock on it, so it
-- is `CREATE INDEX CONCURRENTLY`, exactly as the other `job_dirty_work` indexes are built in
-- manual/2026-10-17_job_opportunities_store_indexes.sql.
--
-- TWO LOCK TIMEOUTS, ONE PER STATEMENT KIND (CR-M-1 / SR-M-1 of PR #1333). `lock_timeout` bounds
-- EVERY lock wait, and a CONCURRENTLY build's waits for older transactions are lock waits too, so
-- one session-wide value cannot serve both:
--   * the sweep (section 1) runs under `lock_timeout = '10s'`: its non-concurrent `DROP INDEX`
--     takes ACCESS EXCLUSIVE on `job_dirty_work` while the old API still serves, and a DROP queued
--     behind a reader queues the hot queue behind itself, so it fails fast instead;
--   * the CREATE (section 2) runs under `lock_timeout = '5min'`, set right before it: it takes only
--     ShareUpdateExclusive (no reader or writer of the queue waits on it) and then waits out every
--     transaction older than its own snapshot. 5 min tolerates normal transactions, and ONE such wait fits
--     inside the 30-minute ssh-action cut below: a transaction still open 5 min after the build starts
--     waiting on it fails the build loudly inside the deploy window (INVALID index, section 3 fails the
--     deploy, the next deploy's sweep drops and rebuilds it) instead of the step being killed mid-build. The
--     timeout bounds each wait, not the statement; `statement_timeout` bounds the whole build. Waits add up:
--     the two dirty-work files run three builds in one deploy step, and each build waits at several points
--     and once per older transaction. Each single wait is at most 5 min, but the total has no fixed cap
--     below `statement_timeout = '30min'` per build, so a chain of transactions each open just under 5 min
--     can still pass the 30-minute ssh-action cut. The 30-minute cut covers the realistic case (about one
--     long transaction per build); if the step is cut anyway, the next deploy's sweep drops the INVALID
--     index and rebuilds it.
--
-- A CONCURRENTLY build waits for every transaction holding an old snapshot. In a deploy through
-- GitHub Actions ssh-action (which pins `command_timeout: 30m`, PR #1338), the step has an explicit
-- 30-minute cut, which cuts the step if a build stalls and may leave the build running in the
-- background. `statement_timeout = '30min'` bounds a manual apply. If a cut deploy or interrupted
-- build leaves an INVALID index, section 3's closing check fails the deploy loudly before the
-- container swap, and the deployment runbook's INVALID-index query (docs/runbooks/deployment.md §9)
-- identifies it for the operator; the next deploy's sweep drops and rebuilds the abandoned index
-- once no build is in flight.
--
-- INVALID LEFTOVERS, AND WHY RE-RUNNING THIS FILE IS THE REPAIR (CR-M-1 / SR-M-1, PR #1333)
-- -------------------------------------------------------------------------------------------
-- A failed or cancelled build leaves the index in place with `indisvalid = false`. The planner
-- never uses it, writes still maintain it, and `IF NOT EXISTS` sees the name and skips, so without
-- the two blocks below every later deploy would print success over a dead index. They are the
-- pattern of the store-indexes file (its section 0 sweep and section 18 check), scoped to the one
-- name this file creates:
--   1. the sweep drops this index when it is INVALID and no build is in progress for it or its
--      table (an in-flight CONCURRENTLY build is INVALID too; dropping it would kill a live build).
--      If a build in this database is masked from the applying role, it sweeps NOTHING (SR-M-4 of
--      the store-indexes file). The CREATE then rebuilds a swept index;
--   2. the closing check RAISEs when the index is missing or still INVALID, so the deploy fails
--      loud instead of reporting success. Repair: re-run the file once no index build is in flight
--      on `job_dirty_work`; by hand, the ROLLBACK statement below and then a re-apply.
--
-- RE-RUNNABLE: `IF NOT EXISTS` makes a second apply a no-op. (A same-named VALID index of ANOTHER
-- shape would be left in place; the drift spec's equality-with-db:push assertion guards that, in CI.)
--
-- ROLLBACK (autocommit, on its own):
--   DROP INDEX CONCURRENTLY IF EXISTS "idx_job_dirty_work_pending_generic";
-- Dropping it only returns the generic claim to the full `(status, created_at)` index; no data is
-- touched.
--
-- No grant: `job_dirty_work` is an existing relation; `crm_app`'s table-level grants already cover
-- its indexes. This is an additive index on an existing table, not a new table; the forward-DDL
-- integration spec is its coverage.
-- =============================================================================

-- The sweep's bound (see TWO LOCK TIMEOUTS above); section 2 raises it for the CREATE.
SET lock_timeout = '10s';
SET statement_timeout = '30min';

-- 1. Drop an ABANDONED invalid leftover of the index below, never one whose build is in progress.
DO $$
DECLARE
  leftover text;
  total_builds int;
  attributable_builds int;
BEGIN
  SELECT count(*), count(p.relid)
    INTO total_builds, attributable_builds
    FROM pg_stat_progress_create_index p
   WHERE p.datid = (SELECT oid FROM pg_database WHERE datname = current_database());

  IF total_builds <> attributable_builds THEN
    RAISE NOTICE
      'pg_stat_progress_create_index reports % index build(s) in this database and % of them are masked from role % — cannot prove no build is in progress, so NOTHING is swept this run',
      total_builds, total_builds - attributable_builds, current_user;
    RETURN;
  END IF;

  FOR leftover IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND NOT i.indisvalid
       AND NOT EXISTS (
             SELECT 1
               FROM pg_stat_progress_create_index p
              WHERE p.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND (p.index_relid = c.oid OR p.relid = i.indrelid)
           )
       AND c.relname = ANY (ARRAY['idx_job_dirty_work_pending_generic'])
  LOOP
    RAISE NOTICE 'dropping INVALID index % (interrupted CONCURRENTLY build); it is rebuilt below', leftover;
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', current_schema(), leftover);
  END LOOP;
END $$;

-- 2. The index.
-- The CREATE's bound (see TWO LOCK TIMEOUTS above): long enough for normal transactions to end;
-- one wait fits inside the 30-minute ssh-action cut, but waits add up (see above).
SET lock_timeout = '5min';
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_dirty_work_pending_generic"
  ON "job_dirty_work" USING btree ("status", "created_at")
  WHERE "reason" <> 'DETAIL_FETCH';

-- 3. Closing check: the index exists and is VALID, or this apply fails.
DO $$
DECLARE
  expected text;
  valid boolean;
  problems text[] := '{}';
BEGIN
  FOREACH expected IN ARRAY ARRAY['idx_job_dirty_work_pending_generic'] LOOP
    SELECT i.indisvalid
      INTO valid
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = expected;
    IF NOT FOUND THEN
      problems := problems || format('%s is MISSING', expected);
    ELSIF NOT valid THEN
      problems := problems || format('%s is INVALID', expected);
    END IF;
  END LOOP;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION
      'job_dirty_work index check failed: % — this apply did not reach the intended state; re-run this file once no index build is in flight on job_dirty_work (the sweep drops an abandoned INVALID index and the CREATE rebuilds it), or by hand: DROP INDEX CONCURRENTLY IF EXISTS <name>; then re-apply',
      array_to_string(problems, '; ');
  END IF;
END $$;
