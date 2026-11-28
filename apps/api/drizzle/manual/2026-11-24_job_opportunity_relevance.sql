-- Queue relevance via Jev, PR1 (plan docs/superpowers/plans/2026-11-24-queue-jev-relevance.md,
-- Task 1) — prod forward DDL.
--
-- WHAT THIS FILE DOES
--   Creates job_opportunity_relevance: Jev's raw fit grade (0..1) of one (vacancy, senior) pair,
--   one row per pair, keyed for staleness by (grader_version, title_key, description_sha256,
--   opportunity_roles, senior_profile_version). status is GRADED (fit set) or FAILED (fit NULL,
--   attempts + next_attempt_at back off). The opportunity_roles id list below is a literal copy of
--   TECHNICAL_ROLES (packages/shared/src/schemas/technical-roles.ts).
--
--   INERT until JOB_RELEVANCE_AI_ENABLED: only the relevance pass writes the table, and nothing
--   reads a fit into the rank in this PR.
--
-- The Drizzle declaration is `jobOpportunityRelevance` (schema/job-opportunity-relevance.ts); dev
-- and CI get it by db:push. job-opportunity-relevance-forward-ddl.integration.spec.ts applies this
-- file twice into a scratch schema and compares columns, constraints and indexes with db:push.
--
-- PRIVILEGE CLASS
--   class A (PRIVILEGE_CLASSES): the pass upserts it. Its grants are in 2026-10-18_db_grants.sql,
--   which runs after this file.
--
-- APPLY WITH `psql -v ON_ERROR_STOP=1 --single-transaction -f <this file>`: `SET LOCAL
-- lock_timeout` only binds inside a transaction, and the closing check is all-or-nothing only if a
-- failure rolls back everything above it.
--
-- COST: CREATE TABLE plus FKs to job_opportunities and users, each taking SHARE ROW EXCLUSIVE on its
-- target for the moment of the CREATE (no rows to validate), and one index on an empty table.
--
-- RE-RUNNABLE: CREATE TABLE / CREATE INDEX IF NOT EXISTS; the closing block refuses to finish unless
-- every named constraint is present and validated and the senior index exists.
--
-- ROLLBACK: none needed; the table is inert without the flag. To remove it by hand (first revert
-- the code that writes it; loses every grade, which the pass re-creates):
--   DROP TABLE IF EXISTS job_opportunity_relevance;
-- =============================================================================

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS job_opportunity_relevance (
  "opportunity_id" uuid NOT NULL,
  "senior_id" uuid NOT NULL,
  "grader_version" text NOT NULL,
  "title_key" text NOT NULL,
  "description_sha256" text,
  "opportunity_roles" text[] NOT NULL,
  "senior_profile_version" text NOT NULL,
  "status" text NOT NULL,
  "fit" real,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_opportunity_relevance_pkey" PRIMARY KEY ("opportunity_id", "senior_id"),
  -- Postgres cuts an identifier at 63 bytes; this is the name db:push ends up with.
  CONSTRAINT "job_opportunity_relevance_opportunity_id_job_opportunities_id_f"
    FOREIGN KEY ("opportunity_id") REFERENCES job_opportunities ("id") ON DELETE CASCADE,
  CONSTRAINT "job_opportunity_relevance_senior_id_users_id_fk"
    FOREIGN KEY ("senior_id") REFERENCES users ("id") ON DELETE CASCADE,
  CONSTRAINT "ck_job_opportunity_relevance_status" CHECK ("status" IN ('GRADED', 'FAILED')),
  CONSTRAINT "ck_job_opportunity_relevance_fit"
    CHECK (("status" = 'GRADED') = ("fit" IS NOT NULL) AND ("fit" IS NULL OR "fit" BETWEEN 0 AND 1)),
  CONSTRAINT "ck_job_opportunity_relevance_roles" CHECK ("opportunity_roles" <@ ARRAY[
    'SOFTWARE_ENGINEER', 'BACKEND_ENGINEER', 'FRONTEND_ENGINEER', 'FULLSTACK_ENGINEER',
    'DESKTOP_ENGINEER', 'BUSINESS_APPLICATIONS_ENGINEER', 'IOS_ENGINEER', 'ANDROID_ENGINEER',
    'CROSS_PLATFORM_MOBILE_ENGINEER', 'DATA_ENGINEER', 'DATABASE_ENGINEER', 'DATA_ANALYST',
    'DATA_SCIENTIST', 'ML_ENGINEER', 'AI_ENGINEER', 'DEVOPS_ENGINEER', 'SITE_RELIABILITY_ENGINEER',
    'SYSTEM_ADMINISTRATOR', 'NETWORK_ENGINEER', 'SUPPORT_ENGINEER', 'QA_ENGINEER',
    'QA_AUTOMATION_ENGINEER', 'SECURITY_ENGINEER', 'SECURITY_ANALYST', 'PENETRATION_TESTER',
    'EMBEDDED_ENGINEER', 'HARDWARE_ENGINEER', 'GAME_DEVELOPER', 'BLOCKCHAIN_ENGINEER',
    'SOFTWARE_ARCHITECT', 'ENGINEERING_MANAGER', 'CTO', 'BUSINESS_ANALYST', 'UI_UX_DESIGNER'
  ]::text[])
);

-- The FK cascade from users scans by senior.
CREATE INDEX IF NOT EXISTS "idx_job_opportunity_relevance_senior"
  ON job_opportunity_relevance ("senior_id");

DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
  expected text[] := ARRAY[
    'job_opportunity_relevance_pkey',
    'job_opportunity_relevance_opportunity_id_job_opportunities_id_f',
    'job_opportunity_relevance_senior_id_users_id_fk',
    'ck_job_opportunity_relevance_status',
    'ck_job_opportunity_relevance_fit',
    'ck_job_opportunity_relevance_roles'
  ];
  c text;
BEGIN
  IF to_regclass('job_opportunity_relevance') IS NULL THEN
    problems := problems || 'table job_opportunity_relevance is missing'::text;
  ELSE
    FOREACH c IN ARRAY expected LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'job_opportunity_relevance'::regclass AND conname = c AND convalidated
      ) THEN
        problems := problems || format('constraint %s is missing or not validated', c);
      END IF;
    END LOOP;
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = 'job_opportunity_relevance'::regclass
        AND i.indexrelid = to_regclass('idx_job_opportunity_relevance_senior')
        AND i.indisvalid
    ) THEN
      problems := problems || 'index idx_job_opportunity_relevance_senior is missing or invalid'::text;
    END IF;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'job_opportunity_relevance DDL is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;
