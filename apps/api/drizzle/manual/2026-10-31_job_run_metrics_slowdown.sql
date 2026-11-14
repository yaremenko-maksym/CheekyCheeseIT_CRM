-- =============================================================================
-- Run metrics and the slow-down (source fetch strategy U2) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. Six run metric columns on `job_collection_runs` (ADR 2026-10-25 section 10), all
--      NULLABLE with NO default — NULL means "not written" (a run ended by recovery, or one
--      that predates U2):
--        request_count integer, bytes_read bigint, last_http_status smallint,
--        newest_item_published_at timestamptz, envelope_fingerprint text,
--        validators_seen boolean
--      and one CHECK, `ck_job_collection_runs_metrics_bounded` (non-negative counts, an HTTP
--      status in 100..599, a fingerprint of 64 lowercase hex characters).
--   2. `job_sources.slowdown_level smallint NOT NULL DEFAULT 0` with
--      `ck_job_sources_slowdown_level_range` (0..4) (ADR section 4). Every existing row gets
--      0, which is exactly today's behaviour (`nextSlot` at level 0).
--
-- No row is written beyond the default. No index. No grant: both tables are class A in
-- `privilege-classes.ts`, so `crm_app`'s existing table-level grants already cover the new
-- columns, and `2026-10-18_db_privileges_check.sql` needs no change.
--
-- Design: docs/architecture/2026-10-25-source-fetch-strategy.md (sections 4 and 10, unit U2).
-- The Drizzle declaration is `jobCollectionRuns` (job-collection.ts) and `jobSources`
-- (job-sourcing.ts); job-opportunities-store-forward-ddl.integration.spec.ts applies this file
-- after the T8 file and compares the catalog with `db:push`;
-- job-run-metrics-ddl.integration.spec.ts applies it twice and checks crm_app's access.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- Production DDL ships staged (backlog 337). The DevOps companion U2-D moves it to manual/,
-- adds its apply step to scripts/devops/deploy-stack-on-vps.sh AFTER the store migration,
-- with --single-transaction, adds it to the hard-required and scp lists and the runbook.
--
-- RE-RUNNABLE: every step is IF NOT EXISTS or guarded by a catalog lookup, and the closing
-- block refuses to finish unless the result is exactly the intended state (a same-named
-- column of another type, or a same-named CHECK with another definition, fails the apply).
-- ADD COLUMN ... DEFAULT 0 on PostgreSQL >= 11 is a catalog-only change (no table rewrite).
-- =============================================================================

SET LOCAL lock_timeout = '10s';

ALTER TABLE "job_collection_runs" ADD COLUMN IF NOT EXISTS "request_count" integer;
ALTER TABLE "job_collection_runs" ADD COLUMN IF NOT EXISTS "bytes_read" bigint;
ALTER TABLE "job_collection_runs" ADD COLUMN IF NOT EXISTS "last_http_status" smallint;
ALTER TABLE "job_collection_runs" ADD COLUMN IF NOT EXISTS "newest_item_published_at" timestamp with time zone;
ALTER TABLE "job_collection_runs" ADD COLUMN IF NOT EXISTS "envelope_fingerprint" text;
ALTER TABLE "job_collection_runs" ADD COLUMN IF NOT EXISTS "validators_seen" boolean;
ALTER TABLE "job_sources" ADD COLUMN IF NOT EXISTS "slowdown_level" smallint DEFAULT 0 NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_collection_runs'::regclass
                    AND conname = 'ck_job_collection_runs_metrics_bounded') THEN
    ALTER TABLE "job_collection_runs" ADD CONSTRAINT "ck_job_collection_runs_metrics_bounded" CHECK (("job_collection_runs"."request_count" IS NULL OR "job_collection_runs"."request_count" >= 0)
        AND ("job_collection_runs"."bytes_read" IS NULL OR "job_collection_runs"."bytes_read" >= 0)
        AND ("job_collection_runs"."last_http_status" IS NULL OR "job_collection_runs"."last_http_status" BETWEEN 100 AND 599)
        AND ("job_collection_runs"."envelope_fingerprint" IS NULL OR "job_collection_runs"."envelope_fingerprint" ~ '^[0-9a-f]{64}$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_sources'::regclass
                    AND conname = 'ck_job_sources_slowdown_level_range') THEN
    ALTER TABLE "job_sources" ADD CONSTRAINT "ck_job_sources_slowdown_level_range" CHECK ("job_sources"."slowdown_level" BETWEEN 0 AND 4);
  END IF;
END $$;

-- The closing check: the intended state, exactly, or the apply fails (and, applied with
-- --single-transaction, rolls back everything above).
DO $$
DECLARE
  metrics_check constant text :=
    'CHECK ((((request_count IS NULL) OR (request_count >= 0)) AND ((bytes_read IS NULL) OR (bytes_read >= 0)) AND ((last_http_status IS NULL) OR ((last_http_status >= 100) AND (last_http_status <= 599))) AND ((envelope_fingerprint IS NULL) OR (envelope_fingerprint ~ ''^[0-9a-f]{64}$''::text))))';
  level_check constant text :=
    'CHECK (((slowdown_level >= 0) AND (slowdown_level <= 4)))';
  expected record;
  problems text[] := ARRAY[]::text[];
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('request_count', 'integer'::regtype),
      ('bytes_read', 'bigint'::regtype),
      ('last_http_status', 'smallint'::regtype),
      ('newest_item_published_at', 'timestamp with time zone'::regtype),
      ('envelope_fingerprint', 'text'::regtype),
      ('validators_seen', 'boolean'::regtype)
    ) v(col, typ)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = 'job_collection_runs'::regclass AND a.attname = expected.col
                      AND NOT a.attisdropped AND NOT a.attnotnull AND a.atttypid = expected.typ
                      AND NOT a.atthasdef) THEN
      problems := problems || format('column job_collection_runs.%s is missing, NOT NULL, defaulted or not %s',
                                     expected.col, expected.typ);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                   JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'job_sources'::regclass AND a.attname = 'slowdown_level'
                    AND NOT a.attisdropped AND a.attnotnull AND a.atttypid = 'smallint'::regtype
                    AND pg_get_expr(d.adbin, d.adrelid) = '0') THEN
    problems := problems || 'column job_sources.slowdown_level is missing, nullable, not smallint or not DEFAULT 0'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_collection_runs'::regclass
                    AND conname = 'ck_job_collection_runs_metrics_bounded'
                    AND contype = 'c' AND convalidated
                    AND pg_get_constraintdef(oid) = metrics_check) THEN
    problems := problems || 'CHECK ck_job_collection_runs_metrics_bounded is missing, not validated or not exactly the intended definition'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_sources'::regclass
                    AND conname = 'ck_job_sources_slowdown_level_range'
                    AND contype = 'c' AND convalidated
                    AND pg_get_constraintdef(oid) = level_check) THEN
    problems := problems || 'CHECK ck_job_sources_slowdown_level_range is missing, not validated or not exactly the intended definition'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'run metrics / slow-down DDL is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;
