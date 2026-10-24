-- =============================================================================
-- job_collection_runs single flight (r5 Task 2.5 T1) — prod forward DDL (STAGED)
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
-- apps/api/src/database/schema/job-collection.ts; `db:push` on a fresh database produces
-- the same three objects, and job-opportunities-store-forward-ddl.integration.spec.ts
-- proves it by applying this file and comparing catalogs.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- Same reason as manual-staged/2026-10-24_job_sources_manifest_delta.sql:
-- scripts/devops/check-prod-ddl-wiring.py fails a build holding a manual/ file the deploy
-- does not copy and apply, and wiring the deploy is DevOps work (backlog 337's list).
-- DevOps moves this file to manual/ together with those edits. The text names no
-- directory, so the move changes no byte of it.
--
-- HOW TO APPLY (load-bearing)
-- ---------------------------
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
-- as the migration role (`crm_user`), AFTER 2026-10-17_job_opportunities_store.sql and
-- 2026-10-17_job_opportunities_store_indexes.sql (they create the table and the index
-- this file sits beside). --single-transaction is REQUIRED: it makes the apply
-- all-or-nothing, so a refusal in section 2 also undoes section 1, and a failed index
-- build leaves no object behind. That is also why there is no INVALID-index sweep here,
-- unlike the store's index file: a non-concurrent build inside a transaction either
-- commits a valid index or rolls back entirely.
--
-- THE PRICE, recorded: these builds are NOT `CONCURRENTLY` (Postgres refuses that inside a
-- transaction block). Each takes a SHARE lock on `job_collection_runs` for the length of
-- its build, and the ALTER in section 1 holds ACCESS EXCLUSIVE until the transaction
-- commits. Today no production code writes the table (ADR fact F3), so the build covers no
-- rows and blocks no writer. On a later re-apply where both indexes already exist,
-- `IF NOT EXISTS` skips the build.
--
-- PRIVILEGES: none change. `job_collection_runs` is class A in
-- apps/api/src/database/privileges/privilege-classes.ts, granted at TABLE level, so the new
-- column is covered by the grants `crm_app` already holds and receives no grant of its own.
-- Indexes carry no privileges. Every object here is created by the applying role, so
-- `crm_app` owns nothing new (the catalog check's part 7 stays true).
--
-- IDEMPOTENT: safe to re-run on every deploy.
--
-- ROLLBACK (additive; one transaction):
--   DROP INDEX IF EXISTS uq_job_collection_runs_one_started_per_account;
--   DROP INDEX IF EXISTS uq_job_collection_runs_one_started_per_source;
--   ALTER TABLE job_collection_runs DROP COLUMN IF EXISTS account_key;
--
-- WHAT THE DATABASE STILL CANNOT SEE: that a writer derived `account_key` correctly. A
-- CHECK reads only its own row and the key has no FK (it names a meter OR a source). The
-- run ledger (Task 2.5 T3) derives it under the claim's row locks; a writer that stored the
-- source id for a metered source would get a per-source lock only.
-- =============================================================================

SET lock_timeout = '10s';
SET statement_timeout = '5min';


-- ---------------------------------------------------------------------------
-- 1. The column, backfilled, then NOT NULL
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
ALTER TABLE "job_collection_runs" ADD COLUMN IF NOT EXISTS "account_key" uuid;

UPDATE "job_collection_runs" r
   SET "account_key" = COALESCE(s."account_meter_id", s."id")
  FROM "job_sources" s
 WHERE s."id" = r."source_id"
   AND r."account_key" IS NULL;

ALTER TABLE "job_collection_runs" ALTER COLUMN "account_key" SET NOT NULL;


-- ---------------------------------------------------------------------------
-- 2. Preflight: refuse to build over live contention
-- ---------------------------------------------------------------------------
--
-- If two STARTED runs already share a source or an account, a UNIQUE build cannot
-- succeed. Which of the two runs should lose is a decision about live collection state
-- (production data), so this file does NOT resolve it: it names the contended keys and
-- stops, and --single-transaction rolls section 1 back with it. Resolve them (let the
-- runs end, or mark the stale one terminal), then re-run.
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
-- 3. The two single-flight indexes
-- ---------------------------------------------------------------------------
--
-- The key ALONE, no config_version: a config bump must not open a second slot for the
-- same source.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_job_collection_runs_one_started_per_source" ON "job_collection_runs" USING btree ("source_id") WHERE "job_collection_runs"."outcome" = 'STARTED';

CREATE UNIQUE INDEX IF NOT EXISTS "uq_job_collection_runs_one_started_per_account" ON "job_collection_runs" USING btree ("account_key") WHERE "job_collection_runs"."outcome" = 'STARTED';


-- ---------------------------------------------------------------------------
-- 4. Final check: the intended state, or a failed apply
-- ---------------------------------------------------------------------------
--
-- `IF NOT EXISTS` matches on the NAME only, so an index of the right name and the wrong
-- shape (a hand-made one, a stale definition) would let section 3 succeed while enforcing
-- something else. This check asserts the SHAPE: valid, unique, exactly the one intended
-- key column, the STARTED predicate — plus the column's NOT NULL. Anything else raises,
-- and ON_ERROR_STOP=1 with --single-transaction rolls the whole apply back.
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

  -- A VALID index of the right name and the wrong shape is not repaired by a re-run
  -- (IF NOT EXISTS skips by name): it has to be dropped by hand first, deliberately — it
  -- may be someone's diagnostic index, and this file does not drop what it cannot
  -- attribute.
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'job_collection_runs single flight is NOT in the intended state: % — if an index of that NAME exists with another shape, drop it, then re-run this file',
      array_to_string(problems, '; ');
  END IF;
END $$;
