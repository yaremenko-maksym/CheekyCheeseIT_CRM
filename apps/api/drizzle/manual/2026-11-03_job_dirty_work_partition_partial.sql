-- =============================================================================
-- Reason-partition partial indexes for the pending claim (backlog 347 (1)) — prod forward DDL
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
--   Two PARTIAL btree indexes on `(status, created_at)`, one per `claimDirtyBatch` consumer
--   (REASON PARTITIONS, ADR 2026-11-02-dirty-work-reason-partitioned-claim):
--     `idx_job_dirty_work_pending_match`        WHERE the row is in the MATCH partition;
--     `idx_job_dirty_work_pending_availability` WHERE the row is in the AVAILABILITY partition.
--   While `JOB_AVAILABILITY_RECONCILE_ENABLED` is off nobody claims the availability rows and
--   nothing prunes `job_dirty_work`, so the match claim (`ORDER BY created_at, id`) walked the
--   oldest unclaimed availability rows on every claim on `idx_job_dirty_work_pending(_generic)`
--   (the ADR's "Growth while availability is off"). With these the match claim never sees that
--   pile, and the availability worker, once on, never walks the match pile.
--
-- WHY THE PLANNER CAN USE THEM
-- ----------------------------
--   Each WHERE clause is, character for character, what `dirtyConsumerPredicate(consumer, reason,
--   { inline: true })` renders, and `dirtyWorkStatements.claim` carries that conjunct with INLINE
--   LITERALS (not bound parameters), so the index predicate is implied by the query's own
--   conjuncts in a custom AND a generic plan (the CR-M-4 rule). The extra MATCH-side
--   `reason = 'DETAIL_FETCH'` term keeps the predicate exactly the classifier's; the claim's
--   separate `reason <> 'DETAIL_FETCH'` conjunct stays for `idx_job_dirty_work_pending_generic`.
--   `starts_with` is IMMUTABLE, which an index predicate requires. A new availability reason
--   changes `dirtyConsumerPredicate` and therefore requires a NEW index (the old one would
--   silently stop matching); job-dirty-work-partition-partial-ddl.integration.spec.ts EXPLAINs
--   the real claim SQL against this file and fails on that drift.
--
-- The Drizzle declaration is `jobDirtyWork` (schema/job-collection.ts, the two indexes above);
-- the same spec applies this file into a scratch schema and asserts each index equals what
-- `db:push` declares in `public`.
--
-- APPLIED BY THE DEPLOY, AUTOCOMMIT (promoted to manual/ by backlog 434)
-- -----------------------------------------------------------------------
-- Promoted from manual-staged/ by backlog 434. `deploy-stack-on-vps.sh` applies this file on
-- EVERY deploy, right after manual/2026-11-02_job_dirty_work_pending_partial.sql, as
--   psql -v ON_ERROR_STOP=1 < <this file>
-- WITHOUT `--single-transaction`: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction
-- block. psql sends each statement on its own, so the two `DO` blocks below run in autocommit
-- too (a `DO` block is allowed there; only the CONCURRENTLY statement may not sit inside one).
-- This file was not hand-applied in production before the promotion: the first deploy builds
-- the indexes, every later one is a no-op. Needed before `JOB_AVAILABILITY_RECONCILE_ENABLED` is
-- turned on in production.
--
-- WHY CONCURRENTLY, LOCK TIMEOUT, AND DEPLOY BOUNDS (CR-M-4 / SR-M-2, SR-M-3)
-- -------------------------------------------------------------------------
-- `job_dirty_work` is a hot queue; building these must not take an exclusive lock on it, so they
-- are `CREATE INDEX CONCURRENTLY`, as in manual/2026-11-02_job_dirty_work_pending_partial.sql.
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
-- A CONCURRENTLY build waits for every transaction holding an old snapshot (twice). In a deploy through
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
-- A failed or cancelled build leaves that index in place with `indisvalid = false`. The planner
-- never uses it, writes still maintain it, and `IF NOT EXISTS` sees the name and skips, so without
-- the two blocks below every later deploy would print success over a dead index. They are the
-- pattern of the store-indexes file (its section 0 sweep and section 18 check), scoped to the two
-- names this file creates:
--   1. the sweep drops one of them when it is INVALID and no build is in progress for it or its
--      table (an in-flight CONCURRENTLY build is INVALID too; dropping it would kill a live build).
--      If a build in this database is masked from the applying role, it sweeps NOTHING (SR-M-4 of
--      the store-indexes file). The CREATE then rebuilds a swept index;
--   2. the closing check RAISEs when either index is missing or still INVALID, so the deploy fails
--      loud instead of reporting success. Repair: re-run the file once no index build is in flight
--      on `job_dirty_work`; by hand, the ROLLBACK statement for it below and then a re-apply.
--
-- RE-RUNNABLE: `IF NOT EXISTS` makes a second apply a no-op. (A same-named VALID index of ANOTHER
-- shape would be left in place; the drift spec's equality-with-db:push assertion guards that, in CI.)
--
-- ROLLBACK (autocommit, each on its own):
--   DROP INDEX CONCURRENTLY IF EXISTS "idx_job_dirty_work_pending_match";
--   DROP INDEX CONCURRENTLY IF EXISTS "idx_job_dirty_work_pending_availability";
-- Dropping them only returns the claim to the pre-347 scan; no data is touched.
--
-- No grant: `job_dirty_work` is an existing relation; `crm_app`'s table-level grants already cover
-- its indexes. Additive indexes on an existing table, not a new table; the forward-DDL
-- integration specs are their coverage.
-- =============================================================================

-- The sweep's bound (see TWO LOCK TIMEOUTS above); section 2 raises it for the CREATE.
SET lock_timeout = '10s';
SET statement_timeout = '30min';

-- 1. Drop ABANDONED invalid leftovers of the indexes below, never one whose build is in progress.
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
       AND c.relname = ANY (ARRAY['idx_job_dirty_work_pending_match',
                                  'idx_job_dirty_work_pending_availability'])
  LOOP
    RAISE NOTICE 'dropping INVALID index % (interrupted CONCURRENTLY build); it is rebuilt below', leftover;
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', current_schema(), leftover);
  END LOOP;
END $$;

-- 2. The indexes.
-- The CREATE's bound (see TWO LOCK TIMEOUTS above): long enough for normal transactions to end;
-- one wait fits inside the 30-minute ssh-action cut, but waits add up (see above).
SET lock_timeout = '5min';
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_dirty_work_pending_match"
  ON "job_dirty_work" USING btree ("status", "created_at")
  WHERE NOT (("reason" = 'DETAIL_FETCH') OR (starts_with("reason", 'AVAILABILITY:') OR starts_with("reason", 'RECORD_RELISTED:') OR "reason" IN ('RECORD_INVENTORY_CLOSED', 'RECORD_REOPENED', 'RECORD_WINDOW_EXPIRED')));

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_dirty_work_pending_availability"
  ON "job_dirty_work" USING btree ("status", "created_at")
  WHERE (starts_with("reason", 'AVAILABILITY:') OR starts_with("reason", 'RECORD_RELISTED:') OR "reason" IN ('RECORD_INVENTORY_CLOSED', 'RECORD_REOPENED', 'RECORD_WINDOW_EXPIRED'));

-- 3. Closing check: both indexes exist and are VALID, or this apply fails.
DO $$
DECLARE
  expected text;
  valid boolean;
  problems text[] := '{}';
BEGIN
  FOREACH expected IN ARRAY ARRAY['idx_job_dirty_work_pending_match',
                                  'idx_job_dirty_work_pending_availability'] LOOP
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
