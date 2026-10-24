-- =============================================================================
-- job_collection_runs single flight (r5 Task 2.5 T1 + T1b) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
-- One active fetch per source, and one per paid account, as database facts:
--
--   1. `account_key text NOT NULL` on `job_collection_runs` — the paid account a run
--      spends against: the TEXT `account_key` of the source's meter
--      (`job_account_meters`, through `job_sources.account_meter_id`), or the synthetic
--      `'#source:' || source_id` when the source has no meter. Backfilled for every
--      existing row. Bounded by `ck_job_collection_runs_account_key_format`: a real meter
--      key (`JOB_PUBLIC_ID_PATTERN`, which has no `#`) or `#source:<uuid>`, so a synthetic
--      key can never equal a real one. That CHECK is NOT in the ADR; it is an addition
--      (one-constraint rollback). Its first regex is a hard-coded copy of
--      `JOB_PUBLIC_ID_PATTERN` (job-patterns.ts); job-collection-schema.spec.ts fails if
--      the copy here and the constant drift apart.
--   2. `uq_job_collection_runs_one_started_per_source`  — UNIQUE (source_id)   WHERE STARTED
--   3. `uq_job_collection_runs_one_started_per_account` — UNIQUE (account_key) WHERE STARTED
--
-- T1b (folded in before T1 merged, per the ADR's fold rule): T1 as first written keyed
-- the account on the meter ROW id (uuid). A meter row is unique per (account_key, unit,
-- window), so one paid account has several rows, and two sources bound to different rows
-- of one account got different keys — the index did not exclude them. The key is now the
-- meter's text `account_key`. A database that already holds the uuid column (only scratch
-- databases ever did; production never received T1) has it dropped and recomputed: the
-- column is derived data, nothing else reads it.
--
-- TWO WAYS A METERED SOURCE GETS THE SYNTHETIC KEY, i.e. a per-source lock only. The
-- database cannot tell either from a genuinely unmetered source, so both are the run
-- ledger's (Task 2.5 T3) to refuse at claim time (`METER_MISSING`, fail-closed):
--   - a type whose manifest declares a quota but whose row has a NULL `account_meter_id`;
--   - a source whose meter ROW WAS DELETED: `job_sources.account_meter_id` is
--     ON DELETE SET NULL, so the source silently becomes "unmetered" here, and a run of it
--     that is STARTED at that moment, or backfilled afterwards, carries `#source:<id>`.
-- T3's brief inherits both.
--
-- `uq_job_collection_runs_running_owner` (UNIQUE (source_id, config_version) WHERE
-- STARTED, from 2026-10-17_job_opportunities_store_indexes.sql) is KEPT. Index 2 subsumes
-- it; dropping it is a separate decision and not this file's.
--
-- Design: docs/architecture/2026-10-24-job-source-run-ownership.md (Option A, T1 and T1b).
-- The Drizzle declaration of the same objects is `jobCollectionRuns` in
-- apps/api/src/database/schema/job-collection.ts; `db:push` on a fresh database produces
-- the same objects, and job-opportunities-store-forward-ddl.integration.spec.ts proves it
-- by applying this file and comparing catalogs.
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
-- all-or-nothing, so a refusal anywhere (contention, a key the CHECK refuses, a wrong-shape
-- object) also undoes the column, and a failed index build leaves no object behind. That
-- is also why there is no INVALID-index sweep here, unlike the store's index file.
--
-- APPLY ONCE; A RE-RUN IS IDEMPOTENT AND LOCK-LIGHT
-- -------------------------------------------------
-- The file is meant to be applied ONCE, the first time a deploy carries it. It is safe to
-- run again, and a re-run is lock-light: section 1 first checks the CATALOG for the
-- complete intended state (column, CHECK definition, both index shapes), and when
-- everything is there it RETURNS before any DDL. It then takes NO LOCK THAT CONFLICTS WITH
-- DML — only a momentary ACCESS SHARE on `job_collection_runs` for catalog introspection
-- (`pg_get_constraintdef`), which every writer coexists with. Only an incomplete or drifted
-- state reaches the DDL.
--
-- What a re-run can still hit (SR-L-3, measured by the security review): ACCESS SHARE
-- queues behind a PENDING ACCESS EXCLUSIVE request from another session (a VACUUM FULL, an
-- ALTER, a TRUNCATE). In that window a re-run waits `lock_timeout` (10s) and FAILS the
-- deploy step. That is the reason the file is meant to be applied once rather than on
-- every deploy: a deploy list that re-applies every run inherits that (rare) failure mode.
--
-- THE PRICE OF THE FIRST APPLY, recorded: the builds are NOT `CONCURRENTLY` (Postgres
-- refuses that inside a transaction block). The ALTERs take ACCESS EXCLUSIVE and each
-- index build a SHARE lock on `job_collection_runs`, held until the transaction commits.
-- Today no production code writes the table (ADR fact F3), so the first apply covers no
-- rows and blocks no writer. Once T3 writes the table, a REPAIR apply (the catalog
-- pre-check failed, e.g. an index dropped by hand) blocks run writers for the length of
-- the build; `lock_timeout` (10s, transaction-local) bounds the wait for the lock.
--
-- PRIVILEGES: none change. `job_collection_runs` is class A in
-- apps/api/src/database/privileges/privilege-classes.ts, granted at TABLE level, so the new
-- column is covered by the grants `crm_app` already holds and receives no grant of its own.
-- Indexes and CHECKs carry no privileges. Every object here is created by the applying
-- role, so `crm_app` owns nothing new (the catalog check's part 7 stays true).
--
-- ROLLBACK (additive; one transaction; dropping the column drops its CHECK and index too):
--   DROP INDEX IF EXISTS uq_job_collection_runs_one_started_per_account;
--   DROP INDEX IF EXISTS uq_job_collection_runs_one_started_per_source;
--   ALTER TABLE job_collection_runs DROP COLUMN IF EXISTS account_key;
--
-- WHAT THE DATABASE STILL CANNOT SEE: that a writer derived `account_key` correctly. A
-- CHECK reads only its own row and the key has no FK (it names a meter OR a source). The
-- run ledger (Task 2.5 T3) derives it under the claim's row locks; a writer that stored the
-- synthetic key for a metered source would get a per-source lock only.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Everything, behind a catalog pre-check
-- ---------------------------------------------------------------------------
--
-- One DO block, so that the pre-check can skip ALL of the DDL. Its steps, when it does not:
--   a. a uuid-typed `account_key` (T1's superseded key) is dropped — its index goes with it;
--   b. the column is added and backfilled from the meter's text key or `#source:<id>`;
--      no production code writes runs yet (F3), so on production the UPDATE is expected
--      to touch no rows, and it is written for rows anyway (a restored database, a scratch
--      copy, a repair after T3 has shipped). Every run has a source (`source_id` NOT NULL,
--      RESTRICT FK) and a named meter always exists (ON DELETE SET NULL), so the LEFT JOIN
--      reaches every row and SET NOT NULL cannot meet a NULL the backfill left behind;
--   c. the format CHECK is added (a key outside it aborts the whole apply);
--   d. preflight: two STARTED runs that already share a source or an account abort the
--      apply, naming the keys — which run should lose is a decision about live collection
--      state (production data), so this file does not make it;
--   e. both indexes. The key ALONE, no config_version: a config bump must not open a
--      second slot for the same source.
-- `lock_timeout` is set with `set_config(..., true)`: transaction-local, so it bounds this
-- apply and does not leak into the caller's session after the transaction ends.
DO $$
DECLARE
  expected_check constant text :=
    'CHECK (((account_key ~ ''^[a-z0-9][a-z0-9._:-]{0,99}$''::text) OR (account_key ~ ''^#source:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''::text)))';
  complete boolean;
  contended_sources int;
  contended_accounts int;
  sample text;
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);

  SELECT
    EXISTS (SELECT 1 FROM pg_attribute
             WHERE attrelid = 'job_collection_runs'::regclass AND attname = 'account_key'
               AND NOT attisdropped AND attnotnull AND atttypid = 'text'::regtype)
    AND EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'job_collection_runs'::regclass
                   AND conname = 'ck_job_collection_runs_account_key_format'
                   AND contype = 'c' AND convalidated
                   AND pg_get_constraintdef(oid) = expected_check)
    AND (SELECT count(*) FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_index i ON i.indexrelid = c.oid
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE n.nspname = current_schema()
            AND i.indrelid = 'job_collection_runs'::regclass
            AND i.indisvalid AND i.indisunique AND i.indnatts = 1
            AND pg_get_expr(i.indpred, i.indrelid) = '(outcome = ''STARTED''::job_collection_outcome)'
            AND ((c.relname = 'uq_job_collection_runs_one_started_per_source' AND a.attname = 'source_id')
              OR (c.relname = 'uq_job_collection_runs_one_started_per_account' AND a.attname = 'account_key'))
        ) = 2
  INTO complete;

  IF complete THEN
    RAISE NOTICE 'job_collection_runs single flight is already in the intended state — no DDL, no lock that conflicts with DML (only a momentary ACCESS SHARE for catalog introspection)';
    RETURN;
  END IF;

  -- a. T1's superseded uuid key.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'job_collection_runs'::regclass AND attname = 'account_key'
                AND NOT attisdropped AND atttypid = 'uuid'::regtype) THEN
    RAISE NOTICE 'job_collection_runs.account_key is the superseded uuid key (T1) — dropping it to recompute the meter text key (T1b)';
    ALTER TABLE "job_collection_runs" DROP COLUMN "account_key";
  END IF;

  -- b. The column, backfilled, then NOT NULL.
  ALTER TABLE "job_collection_runs" ADD COLUMN IF NOT EXISTS "account_key" text;

  UPDATE "job_collection_runs" r
     SET "account_key" = COALESCE(m."account_key", '#source:' || s."id"::text)
    FROM "job_sources" s
    LEFT JOIN "job_account_meters" m ON m."id" = s."account_meter_id"
   WHERE s."id" = r."source_id"
     AND r."account_key" IS NULL;

  ALTER TABLE "job_collection_runs" ALTER COLUMN "account_key" SET NOT NULL;

  -- c. The format CHECK. A same-named CHECK of another shape is left in place here and
  --    fails the final check below (this file does not drop what it cannot attribute).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_collection_runs'::regclass
                    AND conname = 'ck_job_collection_runs_account_key_format') THEN
    ALTER TABLE "job_collection_runs" ADD CONSTRAINT "ck_job_collection_runs_account_key_format" CHECK ("job_collection_runs"."account_key" ~ '^[a-z0-9][a-z0-9._:-]{0,99}$' OR "job_collection_runs"."account_key" ~ '^#source:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  END IF;

  -- d. Preflight: refuse to build over live contention.
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
      SELECT 'account ' || "account_key" FROM "job_collection_runs"
       WHERE "outcome" = 'STARTED' GROUP BY "account_key" HAVING count(*) > 1
      LIMIT 10) y;
    RAISE EXCEPTION
      'job_collection_runs: % source(s) and % account(s) already hold more than one STARTED run (%) — the single-flight indexes cannot be built over that; end or recover those runs, then re-run this file. Nothing was built.',
      contended_sources, contended_accounts, sample;
  END IF;

  -- e. The two single-flight indexes.
  CREATE UNIQUE INDEX IF NOT EXISTS "uq_job_collection_runs_one_started_per_source" ON "job_collection_runs" USING btree ("source_id") WHERE "job_collection_runs"."outcome" = 'STARTED';
  CREATE UNIQUE INDEX IF NOT EXISTS "uq_job_collection_runs_one_started_per_account" ON "job_collection_runs" USING btree ("account_key") WHERE "job_collection_runs"."outcome" = 'STARTED';
END $$;


-- ---------------------------------------------------------------------------
-- 2. Final check: the intended state, or a failed apply
-- ---------------------------------------------------------------------------
--
-- `IF NOT EXISTS` matches on the NAME only, so an object of the right name and the wrong
-- shape (a hand-made one, a stale definition) would let section 1 succeed while enforcing
-- something else. This check asserts the SHAPE of every object the file owns: the column
-- (text, NOT NULL), the CHECK (its FULL normalised definition, compared exactly, and
-- validated) and both indexes (valid, unique, exactly the one intended key column, the
-- STARTED predicate). Anything else raises, and ON_ERROR_STOP=1 with --single-transaction
-- rolls the whole apply back.
DO $$
DECLARE
  expected_check constant text :=
    'CHECK (((account_key ~ ''^[a-z0-9][a-z0-9._:-]{0,99}$''::text) OR (account_key ~ ''^#source:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''::text)))';
  expected record;
  problems text[] := ARRAY[]::text[];
  ok boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'job_collection_runs'::regclass
       AND attname = 'account_key' AND attnotnull AND NOT attisdropped
       AND atttypid = 'text'::regtype
  ) THEN
    problems := problems || 'column account_key is missing, nullable or not text'::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_collection_runs'::regclass
       AND conname = 'ck_job_collection_runs_account_key_format'
       AND contype = 'c' AND convalidated
       AND pg_get_constraintdef(oid) = expected_check
  ) THEN
    problems := problems || 'CHECK ck_job_collection_runs_account_key_format is missing, not validated or not exactly the intended definition'::text;
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

  -- An object of the right NAME and the wrong shape is not repaired by a re-run (IF NOT
  -- EXISTS skips by name): it has to be dropped by hand first, deliberately — it may be
  -- someone's diagnostic object, and this file does not drop what it cannot attribute.
  --
  -- SR-L-4. The CHECK is compared as EXACT TEXT of `pg_get_constraintdef`, measured on
  -- PostgreSQL 16.15 only. That fails CLOSED: if a major upgrade or other tooling renders
  -- the same CHECK differently, every re-apply stops here until the constraint is dropped
  -- and this file re-applied (which re-adds it in this Postgres's own rendering). The
  -- message names that step exactly, so the fix is mechanical rather than an investigation.
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'job_collection_runs single flight is NOT in the intended state: % — if an object of that NAME exists with another shape, drop it, then re-run this file. For the CHECK (compared as exact text, measured on PostgreSQL 16.15): ALTER TABLE job_collection_runs DROP CONSTRAINT ck_job_collection_runs_account_key_format; then re-apply this file with psql -v ON_ERROR_STOP=1 --single-transaction',
      array_to_string(problems, '; ');
  END IF;
END $$;
