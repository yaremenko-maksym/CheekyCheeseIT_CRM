-- =============================================================================
-- job_collection_runs single flight (r5 Task 2.5 T1) — prod forward DDL
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
-- One active fetch per source, and one per paid account, as database facts:
--
--   1. `account_key uuid NOT NULL` on `job_collection_runs` — the account a run spends
--      against: the source's `account_meter_id`, or the source's own id when it has no
--      meter. Backfilled from `job_sources` for every existing row.
--   2. `uq_job_collection_runs_one_started_per_source`  — UNIQUE (source_id)   WHERE STARTED
--   3. `uq_job_collection_runs_one_started_per_account` — UNIQUE (account_key) WHERE STARTED
--
-- `uq_job_collection_runs_running_owner` (UNIQUE (source_id, config_version) WHERE
-- STARTED, from 2026-10-17_job_opportunities_store_indexes.sql) is KEPT. Index 2 subsumes
-- it; dropping it is a separate decision and not this file's.
--
-- Design: docs/architecture/2026-10-24-job-source-run-ownership.md (Option A, task T1).
-- The Drizzle declaration of the same objects is `jobCollectionRuns` in
-- apps/api/src/database/schema/job-collection.ts — this file and that one describe one
-- catalog, and `db:push` on a fresh database produces the same three objects.
--
-- Apply AFTER 2026-10-17_job_opportunities_store.sql and ..._store_indexes.sql (the table
-- and the index this file sits beside). Apply as the migration role (`crm_user`), with
-- `psql -v ON_ERROR_STOP=1`, NOT inside `--single-transaction`: section 4 is
-- `CREATE INDEX CONCURRENTLY`, which Postgres refuses inside a transaction block.
--
-- PRIVILEGES: none change. `job_collection_runs` is class A in
-- apps/api/src/database/privileges/privilege-classes.ts, granted at TABLE level, so the new
-- column is covered by the grants `crm_app` already holds and receives no grant of its own.
-- Indexes carry no privileges. Every object here is created by the applying role, so
-- `crm_app` owns nothing new (the catalog check's part 7 stays true).
--
-- IDEMPOTENT: every section is safe to re-run on every deploy. RE-RUNNING THIS FILE IS THE
-- REPAIR for an interrupted run, exactly as for the store's index file.
--
-- ROLLBACK (additive; through the same path):
--   DROP INDEX CONCURRENTLY IF EXISTS uq_job_collection_runs_one_started_per_account;
--   DROP INDEX CONCURRENTLY IF EXISTS uq_job_collection_runs_one_started_per_source;
--   ALTER TABLE job_collection_runs DROP COLUMN IF EXISTS account_key;
--
-- WHAT THE DATABASE STILL CANNOT SEE: that a writer derived `account_key` correctly. A
-- CHECK reads only its own row and the key has no FK (it names a meter OR a source). The
-- run ledger (Task 2.5 T3) derives it under the claim's row locks; a writer that stored the
-- source id for a metered source would get a per-source lock only.
-- =============================================================================

SET lock_timeout = '10s';
SET statement_timeout = '30min';


-- ---------------------------------------------------------------------------
-- 1. The column, backfilled, then NOT NULL — one transaction
-- ---------------------------------------------------------------------------
--
-- No production code writes runs yet (ADR fact F3), so on production the UPDATE is
-- expected to touch no rows. It is written for rows anyway: a restored database, a
-- scratch copy, or a later re-apply after T3 has shipped must not depend on emptiness.
-- Every run has a source (`source_id` is NOT NULL with a RESTRICT FK), so the join
-- reaches every row and SET NOT NULL cannot meet a NULL left behind by the backfill.
--
-- A terminal run's key is historical only — terminal rows never contend — so deriving it
-- from today's meter assignment is harmless.
BEGIN;

ALTER TABLE "job_collection_runs" ADD COLUMN IF NOT EXISTS "account_key" uuid;

UPDATE "job_collection_runs" r
   SET "account_key" = COALESCE(s."account_meter_id", s."id")
  FROM "job_sources" s
 WHERE s."id" = r."source_id"
   AND r."account_key" IS NULL;

ALTER TABLE "job_collection_runs" ALTER COLUMN "account_key" SET NOT NULL;

COMMIT;


-- ---------------------------------------------------------------------------
-- 2. Preflight: refuse to build over live contention
-- ---------------------------------------------------------------------------
--
-- If two STARTED runs already share a source or an account, a UNIQUE build cannot
-- succeed, and a failed CONCURRENTLY build leaves an INVALID index behind. Which of the
-- two runs should lose is a decision about live collection state (production data), so
-- this file does NOT resolve it: it names the contended keys and stops before building
-- anything. Resolve them (let the runs end, or mark the stale one terminal), then re-run.
DO $$
DECLARE
  contended_sources int;
  contended_accounts int;
  sample text;
BEGIN
  SELECT count(*) INTO contended_sources
    FROM (SELECT "source_id" FROM "job_collection_runs"
           WHERE "outcome" = 'STARTED' GROUP BY "source_id" HAVING count(*) > 1) x;
  SELECT count(*) INTO contended_accounts
    FROM (SELECT "account_key" FROM "job_collection_runs"
           WHERE "outcome" = 'STARTED' GROUP BY "account_key" HAVING count(*) > 1) x;

  IF contended_sources > 0 OR contended_accounts > 0 THEN
    SELECT string_agg(k, ', ') INTO sample FROM (
      SELECT 'source ' || "source_id"::text AS k FROM "job_collection_runs"
       WHERE "outcome" = 'STARTED' GROUP BY "source_id" HAVING count(*) > 1
      UNION ALL
      SELECT 'account ' || "account_key"::text FROM "job_collection_runs"
       WHERE "outcome" = 'STARTED' GROUP BY "account_key" HAVING count(*) > 1
      LIMIT 10) y;
    RAISE EXCEPTION
      'job_collection_runs: % source(s) and % account(s) already hold more than one STARTED run (%) — the single-flight indexes cannot be built over that; end or recover those runs, then re-run this file. Nothing was built.',
      contended_sources, contended_accounts, sample;
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 3. Drop ABANDONED invalid leftovers of the two indexes below
-- ---------------------------------------------------------------------------
--
-- Same contract as section 0 of 2026-10-17_job_opportunities_store_indexes.sql, whose
-- header carries the measurements (SR-M-2 / SR-M-4): an interrupted CONCURRENTLY build
-- leaves an INVALID index that `IF NOT EXISTS` would then skip forever; an index that is
-- invalid because a build is still RUNNING must not be dropped; and a build this role
-- cannot attribute (masked progress columns) means nothing is swept this run. The name
-- list is EXACTLY the two indexes this file creates.
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
      'pg_stat_progress_create_index reports % index build(s) in this database and % of them are masked from role % — cannot prove no build is in progress, so NOTHING is swept this run; re-run when no build is in flight',
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
       AND c.relname = ANY (ARRAY[
         'uq_job_collection_runs_one_started_per_account',
         'uq_job_collection_runs_one_started_per_source'
       ])
  LOOP
    RAISE NOTICE 'dropping INVALID index % (interrupted CONCURRENTLY build); it is rebuilt below', leftover;
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', current_schema(), leftover);
  END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- 4. The two single-flight indexes
-- ---------------------------------------------------------------------------
--
-- CONCURRENTLY for the reason the store's index file gives: the first apply is not the
-- only apply, and a re-apply onto a table that by then holds rows must not take a write
-- lock for the length of the build. The key ALONE, no config_version: a config bump must
-- not open a second slot for the same source.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_job_collection_runs_one_started_per_source" ON "job_collection_runs" USING btree ("source_id") WHERE "job_collection_runs"."outcome" = 'STARTED';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_job_collection_runs_one_started_per_account" ON "job_collection_runs" USING btree ("account_key") WHERE "job_collection_runs"."outcome" = 'STARTED';


-- ---------------------------------------------------------------------------
-- 5. Final check: the intended state, or a failed apply
-- ---------------------------------------------------------------------------
--
-- `IF NOT EXISTS` matches on the NAME only, so an index of the right name and the wrong
-- shape (a hand-made one, a stale definition) would let sections 3-4 exit 0 while
-- enforcing something else. This check asserts the SHAPE: valid, unique, exactly the one
-- intended key column, the STARTED predicate — plus the column's NOT NULL. Anything else
-- raises, and `ON_ERROR_STOP=1` turns that into a failed deploy instead of a quietly
-- unenforced invariant. An in-flight build of one of these very indexes still raises here
-- (it is not usable yet); re-run when it has finished.
DO $$
DECLARE
  expected record;
  problems text[] := ARRAY[]::text[];
  ok boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'job_collection_runs'::regclass
       AND attname = 'account_key' AND attnotnull AND NOT attisdropped
       AND atttypid = 'uuid'::regtype
  ) THEN
    problems := problems || 'column account_key is missing, nullable or not uuid'::text;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('uq_job_collection_runs_one_started_per_source', 'source_id'),
      ('uq_job_collection_runs_one_started_per_account', 'account_key')
    ) v(index_name, key_column)
  LOOP
    SELECT EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_index i ON i.indexrelid = c.oid
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE n.nspname = current_schema()
         AND c.relname = expected.index_name
         AND i.indrelid = 'job_collection_runs'::regclass
         AND i.indisvalid
         AND i.indisunique
         AND i.indnatts = 1
         AND a.attname = expected.key_column
         AND pg_get_expr(i.indpred, i.indrelid) = '(outcome = ''STARTED''::job_collection_outcome)'
    ) INTO ok;
    IF NOT ok THEN
      problems := problems || format('index %s is missing, invalid, or not UNIQUE (%s) WHERE outcome = STARTED',
                                     expected.index_name, expected.key_column);
    END IF;
  END LOOP;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'job_collection_runs single flight is NOT in the intended state: % — re-run this file',
      array_to_string(problems, '; ');
  END IF;
END $$;
