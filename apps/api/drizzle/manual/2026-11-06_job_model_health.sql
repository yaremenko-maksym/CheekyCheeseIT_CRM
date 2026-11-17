-- The extraction model's health on the collection side (ADR 2026-11-03 §5.3, task r5-5.4c-4).
--
-- WHAT THIS FILE DOES
--   Creates job_model_route_daily (per-day counts of floor falls and of each hosted provider's
--   codes) and job_model_health_flags (MODEL_UNREACHABLE, HOSTED_ROUTES_DEAD and the worker's health
--   codes, raised while cleared_at is null). Both are meant for codes only. The CHECKs hold the
--   format, which an upper-snake string can still pass; the closed list of codes is the handler's.
--   Re-runnable.
--
-- PRIVILEGE CLASS
--   Class A: crm_app upserts counters and flips flags, so SELECT+INSERT+UPDATE+DELETE; the collector
--   has no grant. The grant lives in the generated manual/2026-10-18_db_grants.sql and is
--   unconditional and required since backlog 434 (the deploy applies this file BEFORE the grants).
--
-- PROMOTED TO manual/ BY BACKLOG 434
--   Applied by scripts/devops/deploy-stack-on-vps.sh on EVERY deploy, after the source_id DDL and
--   before the grants, with --single-transaction; its STAGED_RELATIONS entries are gone. It was not
--   applied in production before the promotion; the first deploy creates the two tables, every
--   later one is a no-op.
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
--   Rollback: drop the two tables.
--
-- AMENDMENT 2026-11-17 (ADR 2026-11-03, "Amendment 2026-11-17 — Cloudflare provider")
--   The route list gained 'cloudflare'. A table created before that still holds the narrower route
--   CHECK, and the block after CREATE TABLE widens it in place when deploy-stack-on-vps.sh (run by
--   deploy.yml) applies this file on the next deploy; later deploys
--   find the wide CHECK and do nothing. Widening only: every row the old CHECK admitted passes the
--   new one, so the re-validation scan (one pass under ACCESS EXCLUSIVE, a small counter table)
--   cannot fail. Rollback of the amendment: none needed, the old code never writes 'cloudflare'.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS job_model_route_daily (
  "day" date NOT NULL,
  "route" text NOT NULL,
  "code" text NOT NULL,
  "count" integer NOT NULL,
  CONSTRAINT "job_model_route_daily_day_route_code_pk" PRIMARY KEY ("day", "route", "code"),
  CONSTRAINT "ck_job_model_route_daily_route" CHECK ("job_model_route_daily"."route" IN ('gemini', 'groq', 'cloudflare', 'local')),
  CONSTRAINT "ck_job_model_route_daily_code_format" CHECK ("job_model_route_daily"."code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT "ck_job_model_route_daily_count_positive" CHECK ("job_model_route_daily"."count" > 0)
);

CREATE TABLE IF NOT EXISTS job_model_health_flags (
  "flag" text PRIMARY KEY NOT NULL,
  "raised_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cleared_at" timestamp with time zone,
  "last_emitted_cycle_id" uuid,
  CONSTRAINT "ck_job_model_health_flags_flag" CHECK ("job_model_health_flags"."flag" IN ('MODEL_UNREACHABLE', 'HOSTED_ROUTES_DEAD', 'MODEL_LIST_STALE', 'FAILED_JOB_DAILY', 'FAILED_JOB_CHAIN'))
);

-- Amendment 2026-11-17: widen a route CHECK that predates 'cloudflare' (see the header).
DO $$
BEGIN
  IF to_regclass('job_model_route_daily') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'job_model_route_daily'::regclass AND conname = 'ck_job_model_route_daily_route'
      AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%''cloudflare''%'
  ) THEN
    ALTER TABLE job_model_route_daily DROP CONSTRAINT IF EXISTS "ck_job_model_route_daily_route";
    ALTER TABLE job_model_route_daily ADD CONSTRAINT "ck_job_model_route_daily_route"
      CHECK ("route" IN ('gemini', 'groq', 'cloudflare', 'local'));
  END IF;
END $$;

-- A re-run fails loudly if a named CHECK below is missing or not validated. It does not compare
-- columns or a CHECK's definition: other drift in an existing table passes this block.
DO $$
DECLARE
  problems text[] := '{}';
  expected_route_checks text[] := ARRAY[
    'ck_job_model_route_daily_route',
    'ck_job_model_route_daily_code_format',
    'ck_job_model_route_daily_count_positive'
  ];
  c text;
BEGIN
  IF to_regclass('job_model_route_daily') IS NULL THEN
    problems := problems || 'table job_model_route_daily is missing'::text;
  ELSE
    FOREACH c IN ARRAY expected_route_checks LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'job_model_route_daily'::regclass AND conname = c AND contype = 'c' AND convalidated
      ) THEN
        problems := problems || format('CHECK %s is missing or not validated', c);
      END IF;
    END LOOP;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'job_model_route_daily'::regclass AND conname = 'ck_job_model_route_daily_route'
        AND pg_get_constraintdef(oid) LIKE '%''cloudflare''%'
    ) THEN
      problems := problems || 'CHECK ck_job_model_route_daily_route does not admit cloudflare'::text;
    END IF;
  END IF;

  IF to_regclass('job_model_health_flags') IS NULL THEN
    problems := problems || 'table job_model_health_flags is missing'::text;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'job_model_health_flags'::regclass AND conname = 'ck_job_model_health_flags_flag'
      AND contype = 'c' AND convalidated
  ) THEN
    problems := problems || 'CHECK ck_job_model_health_flags_flag is missing or not validated'::text;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'job_model_health DDL is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;
