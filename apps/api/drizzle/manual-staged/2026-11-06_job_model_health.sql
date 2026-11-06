-- The extraction model's health on the collection side (ADR 2026-11-03 §5.3, task r5-5.4c-4).
--
-- WHAT THIS FILE DOES
--   Creates job_model_route_daily (per-day counts of floor falls and of each hosted provider's
--   codes) and job_model_health_flags (MODEL_UNREACHABLE, HOSTED_ROUTES_DEAD and the worker's health
--   codes, raised while cleared_at is null). Both hold codes only: the CHECKs make page text
--   unstorable. Re-runnable.
--
-- PRIVILEGE CLASS
--   Class A: crm_app upserts counters and flips flags, so SELECT+INSERT+UPDATE+DELETE; the collector
--   has no grant. The grant lives in the generated manual/2026-10-18_db_grants.sql, guarded by
--   to_regclass while this file is staged.
--
-- WHY THIS FILE IS STAGED
--   Nothing reads or writes these tables until the collection-run call site (task 5.5b). The owner
--   applies this DDL then; that PR moves the file to manual/ and drops its STAGED_RELATIONS entries.
--   Rollback: drop the two tables.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS job_model_route_daily (
  "day" date NOT NULL,
  "route" text NOT NULL,
  "code" text NOT NULL,
  "count" integer NOT NULL,
  CONSTRAINT "job_model_route_daily_day_route_code_pk" PRIMARY KEY ("day", "route", "code"),
  CONSTRAINT "ck_job_model_route_daily_route" CHECK ("job_model_route_daily"."route" IN ('gemini', 'groq', 'local')),
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

-- A re-run over a half-built or drifted table must fail loudly, not report success.
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
