-- =============================================================================
-- Host-level state (r5 Task 2.5 T8) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
-- Stores the one fact the scheduler cannot keep anywhere else: a HOST is paused by a ban,
-- and when a run was last claimed on it.
--
--   1. `job_sources.host_key text NULL` — the scope a provider bans or rate-limits at
--      (`remotive.com`, a provider apex shared by every tenant), with the format CHECK
--      `ck_job_sources_host_key_format` and the index `idx_job_sources_host_key`.
--      NULLABLE, because a migration cannot run manifest code: the GENERATED seed delta
--      `2026-10-24_job_sources_host_keys.sql` backfills it AFTER this file, for every
--      manifest-owned reporting source, and never overwrites. DOU keeps NULL.
--   2. `job_source_hosts` — one row per host key: `paused_until`, `pause_reason`,
--      `pause_source_id` (a plain uuid, NO foreign key, so a ban takes no lock on
--      `job_sources`), `last_claimed_at`. Three CHECKs: the key's format, a typed reason
--      code, and "a pause says why and who".
--
-- No row is written: the table starts empty, and the claim path inserts a host's row the
-- first time it is claimed.
--
-- Design: docs/architecture/2026-10-24-job-source-run-ownership.md (Option A, T8).
-- The Drizzle declaration of the same objects is `jobSources` / `jobSourceHosts` in
-- apps/api/src/database/schema/job-sourcing.ts; job-opportunities-store-forward-ddl
-- .integration.spec.ts applies this file and compares the catalog with `db:push`.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- Same reason as manual-staged/2026-10-24_job_run_single_flight.sql:
-- scripts/devops/check-prod-ddl-wiring.py fails a build holding a manual/ file the deploy
-- does not copy and apply, and wiring the deploy is DevOps work. The text names no
-- directory, so the move changes no byte of it.
--
-- APPLY ORDER (load-bearing)
-- --------------------------
-- AFTER 2026-10-05_vacancy_sourcing_schema.sql (it creates `job_sources`) and BEFORE
-- 2026-10-18_db_grants.sql and 2026-10-18_db_privileges_check.sql: the privileges manifest
-- classifies `job_source_hosts` (class A), so the generated grants file names it and fails
-- on a database that does not have it, and the catalog check requires it to exist.
-- The seed delta `2026-10-24_job_sources_host_keys.sql` comes AFTER this file and after
-- `2026-10-24_job_sources_manifest_delta.sql` (it keys on `manifest_id`).
--
-- HOW TO APPLY
-- ------------
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
-- as the migration role (`crm_user`). --single-transaction is REQUIRED: a refusal in the
-- final check then undoes the column, the table and the index together.
--
-- APPLY ONCE; A RE-RUN IS IDEMPOTENT AND LOCK-LIGHT
-- -------------------------------------------------
-- Section 1 first reads the CATALOG for the complete intended state and RETURNS before any
-- DDL when it is there; a re-run then takes only momentary ACCESS SHARE locks for catalog
-- introspection. The first apply takes ACCESS EXCLUSIVE on `job_sources` (ADD COLUMN, ADD
-- CONSTRAINT) and SHARE for the index build, briefly: the table holds a few dozen rows and
-- the column is added without a default, so no row is rewritten. `lock_timeout` (10s,
-- transaction-local) bounds the wait.
--
-- PRIVILEGES: this file grants nothing. `job_source_hosts` is class A in
-- apps/api/src/database/privileges/privilege-classes.ts, granted by the generated
-- 2026-10-18_db_grants.sql (hence the order above). Every object here is created by the
-- applying role, so `crm_app` owns nothing new.
--
-- ROLLBACK (one transaction):
--   DROP TABLE IF EXISTS job_source_hosts;
--   ALTER TABLE job_sources DROP COLUMN IF EXISTS host_key;   -- drops its CHECK and index
-- and remove `job_source_hosts` from privilege-classes.ts (regenerate the grants files)
-- in the same deploy.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Everything, behind a catalog pre-check
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  key_check constant text :=
    'CHECK (((host_key IS NULL) OR ((length(host_key) <= 253) AND (host_key ~ ''^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$''::text))))';
  host_format_check constant text :=
    'CHECK (((length(host_key) <= 253) AND (host_key ~ ''^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$''::text)))';
  reason_check constant text :=
    'CHECK (((pause_reason IS NULL) OR (pause_reason ~ ''^[A-Z][A-Z0-9_]{0,63}$''::text)))';
  complete_check constant text :=
    'CHECK (((paused_until IS NULL) OR ((pause_reason IS NOT NULL) AND (pause_source_id IS NOT NULL))))';
  complete boolean;
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);

  SELECT
    EXISTS (SELECT 1 FROM pg_attribute
             WHERE attrelid = 'job_sources'::regclass AND attname = 'host_key'
               AND NOT attisdropped AND NOT attnotnull AND atttypid = 'text'::regtype)
    AND EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'job_sources'::regclass
                   AND conname = 'ck_job_sources_host_key_format'
                   AND contype = 'c' AND convalidated
                   AND pg_get_constraintdef(oid) = key_check)
    AND EXISTS (SELECT 1 FROM pg_index i
                  JOIN pg_class c ON c.oid = i.indexrelid
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                 WHERE n.nspname = current_schema()
                   AND c.relname = 'idx_job_sources_host_key'
                   AND i.indrelid = 'job_sources'::regclass
                   AND i.indisvalid AND NOT i.indisunique AND i.indnatts = 1
                   AND i.indpred IS NULL AND a.attname = 'host_key')
    AND to_regclass('job_source_hosts') IS NOT NULL
    AND (SELECT count(*) FROM pg_constraint
          WHERE conrelid = to_regclass('job_source_hosts') AND contype = 'c' AND convalidated
            AND ((conname = 'ck_job_source_hosts_host_key_format' AND pg_get_constraintdef(oid) = host_format_check)
              OR (conname = 'ck_job_source_hosts_pause_reason_format' AND pg_get_constraintdef(oid) = reason_check)
              OR (conname = 'ck_job_source_hosts_pause_complete' AND pg_get_constraintdef(oid) = complete_check))
        ) = 3
  INTO complete;

  IF complete THEN
    RAISE NOTICE 'job_source_hosts and job_sources.host_key are already in the intended state — no DDL';
    RETURN;
  END IF;

  -- a. The column, its CHECK and its index. A same-named object of another shape is left in
  --    place and fails the final check (this file does not drop what it cannot attribute).
  ALTER TABLE "job_sources" ADD COLUMN IF NOT EXISTS "host_key" text;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_sources'::regclass
                    AND conname = 'ck_job_sources_host_key_format') THEN
    ALTER TABLE "job_sources" ADD CONSTRAINT "ck_job_sources_host_key_format" CHECK ("job_sources"."host_key" IS NULL OR (length("job_sources"."host_key") <= 253 AND "job_sources"."host_key" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'));
  END IF;

  CREATE INDEX IF NOT EXISTS "idx_job_sources_host_key" ON "job_sources" USING btree ("host_key");

  -- b. The host table. No foreign key on pause_source_id, by design (lock order).
  CREATE TABLE IF NOT EXISTS "job_source_hosts" (
    "host_key" text PRIMARY KEY NOT NULL,
    "paused_until" timestamp with time zone,
    "pause_reason" text,
    "pause_source_id" uuid,
    "last_claimed_at" timestamp with time zone,
    CONSTRAINT "ck_job_source_hosts_host_key_format" CHECK (length("job_source_hosts"."host_key") <= 253 AND "job_source_hosts"."host_key" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
    CONSTRAINT "ck_job_source_hosts_pause_reason_format" CHECK ("job_source_hosts"."pause_reason" IS NULL OR "job_source_hosts"."pause_reason" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    CONSTRAINT "ck_job_source_hosts_pause_complete" CHECK ("job_source_hosts"."paused_until" IS NULL OR ("job_source_hosts"."pause_reason" IS NOT NULL AND "job_source_hosts"."pause_source_id" IS NOT NULL))
  );
END $$;


-- ---------------------------------------------------------------------------
-- 2. Final check: the intended state, or a failed apply
-- ---------------------------------------------------------------------------
--
-- `IF NOT EXISTS` matches on the NAME only, so an object of the right name and the wrong
-- shape would let section 1 succeed while enforcing something else. This asserts the
-- SHAPE of every object the file owns. Anything else raises, and ON_ERROR_STOP=1 with
-- --single-transaction rolls the whole apply back. CHECKs are compared as the EXACT text
-- of `pg_get_constraintdef`, measured on PostgreSQL 16.15; that fails CLOSED if another
-- version renders them differently, and the message names the mechanical fix.
DO $$
DECLARE
  key_check constant text :=
    'CHECK (((host_key IS NULL) OR ((length(host_key) <= 253) AND (host_key ~ ''^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$''::text))))';
  expected record;
  problems text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'job_sources'::regclass AND attname = 'host_key'
                    AND NOT attisdropped AND NOT attnotnull AND atttypid = 'text'::regtype) THEN
    problems := problems || 'column job_sources.host_key is missing, NOT NULL or not text'::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_sources'::regclass
                    AND conname = 'ck_job_sources_host_key_format'
                    AND contype = 'c' AND convalidated
                    AND pg_get_constraintdef(oid) = key_check) THEN
    problems := problems || 'CHECK ck_job_sources_host_key_format is missing, not validated or not exactly the intended definition'::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_index i
                   JOIN pg_class c ON c.oid = i.indexrelid
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                  WHERE n.nspname = current_schema()
                    AND c.relname = 'idx_job_sources_host_key'
                    AND i.indrelid = 'job_sources'::regclass
                    AND i.indisvalid AND NOT i.indisunique AND i.indnatts = 1
                    AND i.indpred IS NULL AND a.attname = 'host_key') THEN
    problems := problems || 'index idx_job_sources_host_key is missing, invalid, unique, partial or not on (host_key)'::text;
  END IF;

  IF to_regclass('job_source_hosts') IS NULL THEN
    problems := problems || 'table job_source_hosts is missing'::text;
  ELSE
    FOR expected IN
      SELECT * FROM (VALUES
        ('host_key', 'text'::regtype, true),
        ('paused_until', 'timestamp with time zone'::regtype, false),
        ('pause_reason', 'text'::regtype, false),
        ('pause_source_id', 'uuid'::regtype, false),
        ('last_claimed_at', 'timestamp with time zone'::regtype, false)
      ) v(col, typ, not_null)
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_attribute
                      WHERE attrelid = 'job_source_hosts'::regclass AND attname = expected.col
                        AND NOT attisdropped AND atttypid = expected.typ
                        AND attnotnull = expected.not_null) THEN
        problems := problems || format('column job_source_hosts.%s is missing or not %s%s',
                                       expected.col, expected.typ,
                                       CASE WHEN expected.not_null THEN ' NOT NULL' ELSE ' NULL' END);
      END IF;
    END LOOP;

    IF (SELECT count(*) FROM pg_attribute
         WHERE attrelid = 'job_source_hosts'::regclass AND attnum > 0 AND NOT attisdropped) <> 5 THEN
      problems := problems || 'table job_source_hosts has columns this file does not declare'::text;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint con
                     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
                    WHERE con.conrelid = 'job_source_hosts'::regclass AND con.contype = 'p'
                      AND cardinality(con.conkey) = 1 AND a.attname = 'host_key') THEN
      problems := problems || 'job_source_hosts has no PRIMARY KEY (host_key)'::text;
    END IF;

    -- No foreign key at all: pause_source_id deliberately references nothing.
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'job_source_hosts'::regclass AND contype = 'f') THEN
      problems := problems || 'job_source_hosts carries a FOREIGN KEY (the lock order forbids one)'::text;
    END IF;

    FOR expected IN
      SELECT * FROM (VALUES
        ('ck_job_source_hosts_host_key_format',
         'CHECK (((length(host_key) <= 253) AND (host_key ~ ''^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$''::text)))'),
        ('ck_job_source_hosts_pause_reason_format',
         'CHECK (((pause_reason IS NULL) OR (pause_reason ~ ''^[A-Z][A-Z0-9_]{0,63}$''::text)))'),
        ('ck_job_source_hosts_pause_complete',
         'CHECK (((paused_until IS NULL) OR ((pause_reason IS NOT NULL) AND (pause_source_id IS NOT NULL))))')
      ) v(name, def)
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = 'job_source_hosts'::regclass AND conname = expected.name
                        AND contype = 'c' AND convalidated
                        AND pg_get_constraintdef(oid) = expected.def) THEN
        problems := problems || format('CHECK %s is missing, not validated or not exactly the intended definition', expected.name);
      END IF;
    END LOOP;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'job_source_hosts / job_sources.host_key is NOT in the intended state: % — if an object of that NAME exists with another shape, drop it (for a CHECK: ALTER TABLE <table> DROP CONSTRAINT <name>), then re-apply this file with psql -v ON_ERROR_STOP=1 --single-transaction',
      array_to_string(problems, '; ');
  END IF;
END $$;
