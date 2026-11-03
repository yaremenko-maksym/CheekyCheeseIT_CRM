-- =============================================================================
-- Reason-partition partial indexes for the pending claim (backlog 347 (1)) — prod forward DDL (STAGED)
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
--   changes `dirtyConsumerPredicate` and therefore requires a NEW staged index (the old one would
--   silently stop matching); job-dirty-work-partition-partial-ddl.integration.spec.ts EXPLAINs
--   the real claim SQL against this file and fails on that drift.
--
-- The Drizzle declaration is `jobDirtyWork` (schema/job-collection.ts, the two indexes above);
-- the same spec applies this file into a scratch schema and asserts each index equals what
-- `db:push` declares in `public`.
--
-- WHY CONCURRENTLY, AND WHY NO TRANSACTION / NO CLOSING CHECK BLOCK
-- ----------------------------------------------------------------
-- `job_dirty_work` is a hot queue; building these must not take an exclusive lock on it, so they
-- are `CREATE INDEX CONCURRENTLY`, as in manual-staged/2026-11-02_job_dirty_work_pending_partial.sql.
-- `CREATE INDEX CONCURRENTLY` CANNOT run inside a transaction block, so this file carries NO
-- `SET LOCAL` / `BEGIN` / `DO $$` wrapper and each statement MUST be applied in autocommit
-- (psql without --single-transaction / -1). A CONCURRENTLY build waits for every transaction
-- holding a snapshot to finish (twice); a long-running transaction delays it, it does not block
-- writers. A failed / cancelled build leaves an INVALID index of that name that `IF NOT EXISTS`
-- would then keep: check `pg_index.indisvalid` after apply, and on an invalid one run the
-- rollback statement for it and re-apply.
--
-- RE-RUNNABLE: `IF NOT EXISTS` makes a second apply a no-op. (A same-named index of ANOTHER shape
-- would be left in place; the drift spec's equality-with-db:push assertion guards that, in CI.)
--
-- ROLLBACK (autocommit, each on its own):
--   DROP INDEX CONCURRENTLY IF EXISTS "idx_job_dirty_work_pending_match";
--   DROP INDEX CONCURRENTLY IF EXISTS "idx_job_dirty_work_pending_availability";
-- Dropping them only returns the claim to the pre-347 scan; no data is touched.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- Production DDL ships staged (backlog 337). It is DARK: `manual-staged/` is never applied in prod.
-- The owner promotes it to `manual/` with its deploy wiring (check-prod-ddl-wiring.py then requires
-- the wiring); needed before `JOB_AVAILABILITY_RECONCILE_ENABLED` is turned on in production, or
-- earlier if match-claim latency rises.
--
-- No grant: `job_dirty_work` is an existing relation; `crm_app`'s table-level grants already cover
-- its indexes. Additive indexes on an existing table, not a new table, so NOT in STAGED_RELATIONS;
-- the forward-DDL integration specs are their coverage.
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_dirty_work_pending_match"
  ON "job_dirty_work" USING btree ("status", "created_at")
  WHERE NOT (("reason" = 'DETAIL_FETCH') OR (starts_with("reason", 'AVAILABILITY:') OR starts_with("reason", 'RECORD_RELISTED:') OR "reason" IN ('RECORD_INVENTORY_CLOSED', 'RECORD_REOPENED', 'RECORD_WINDOW_EXPIRED')));

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_job_dirty_work_pending_availability"
  ON "job_dirty_work" USING btree ("status", "created_at")
  WHERE (starts_with("reason", 'AVAILABILITY:') OR starts_with("reason", 'RECORD_RELISTED:') OR "reason" IN ('RECORD_INVENTORY_CLOSED', 'RECORD_REOPENED', 'RECORD_WINDOW_EXPIRED'));
