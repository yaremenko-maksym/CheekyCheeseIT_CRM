-- Senior technical roles (plan docs/superpowers/plans/2026-11-16-senior-roles.md, PR 2 Task 2.1).
--
-- WHAT THIS FILE DOES
--   1. users.technical_roles text[] NOT NULL DEFAULT '{}' — a SENIOR's roles, CHECK: only the 33
--      senior-selectable ids (SENIOR_SELECTABLE_ROLES, no SOFTWARE_ENGINEER). Existing rows get '{}'.
--   2. job_opportunities gets technical_roles text[] NOT NULL DEFAULT '{}' (CHECK: the 34
--      TECHNICAL_ROLES ids), role_status text NULL (RULE | AI | PENDING | UNCLEAR | NON_IT; NULL =
--      not classified by any version yet), role_classifier_version text NULL, a CHECK that roles are
--      non-empty exactly when the status is RULE or AI, and a GIN index on technical_roles.
--   3. job_role_classifications — the AI role-classification cache, keyed by
--      (title_key, description_sha256, classifier_version).
--   The id lists below are literal copies of TECHNICAL_ROLES / SENIOR_SELECTABLE_ROLES
--   (packages/shared/src/schemas/technical-roles.ts); technical-roles-forward-ddl.integration.spec.ts
--   holds them to each other.
--
-- The Drizzle declarations are users.technicalRoles (schema/users.ts),
-- jobOpportunities.technicalRoles / roleStatus / roleClassifierVersion (schema/job-opportunities.ts)
-- and jobRoleClassifications (schema/job-role-classifications.ts); dev/CI get them by db:push.
--
-- BACKFILL: NOT HERE. Every existing opportunity has role_status NULL; the recompute re-derives a
-- row whose role_classifier_version is not the current one, under the recompute lock, and the
-- EVALUATION_RECORD_VERSION bump ('rf.2') makes the reconciliation sweep re-enqueue every
-- OPEN/UNKNOWN opportunity.
--
-- PRIVILEGE CLASS
--   job_role_classifications: class A (PRIVILEGE_CLASSES); its grants are in
--   2026-10-18_db_grants.sql, which runs after this file. The new columns inherit their tables'
--   existing grants.
--
-- APPLY
--   The API selects the new columns, so this MUST run before the container swap.
--   psql -v ON_ERROR_STOP=1 --single-transaction < 2026-11-17_technical_roles.sql
--   Re-runnable: IF NOT EXISTS everywhere, constraints under a pg_constraint existence guard.
--   ADD COLUMN with a constant default is catalog-only; each ADD CONSTRAINT scans its table once.
--   Rollback: ALTER TABLE job_opportunities DROP COLUMN technical_roles, DROP COLUMN role_status,
--   DROP COLUMN role_classifier_version; ALTER TABLE users DROP COLUMN technical_roles;
--   DROP TABLE job_role_classifications. Nothing else reads them in this PR.

SET LOCAL lock_timeout = '10s';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS technical_roles text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE job_opportunities
  ADD COLUMN IF NOT EXISTS technical_roles text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS role_status text,
  ADD COLUMN IF NOT EXISTS role_classifier_version text;

CREATE INDEX IF NOT EXISTS idx_job_opportunities_technical_roles
  ON job_opportunities USING gin (technical_roles);

CREATE TABLE IF NOT EXISTS job_role_classifications (
  title_key text NOT NULL,
  description_sha256 text NOT NULL,
  classifier_version text NOT NULL,
  outcome text NOT NULL,
  technical_roles text[] NOT NULL DEFAULT '{}'::text[],
  confidence numeric(4, 3),
  model text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT job_role_classifications_pkey
    PRIMARY KEY (title_key, description_sha256, classifier_version)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'users'::regclass
                    AND conname = 'ck_users_technical_roles_known') THEN
    ALTER TABLE users ADD CONSTRAINT ck_users_technical_roles_known CHECK (technical_roles <@ ARRAY[
    'BACKEND_ENGINEER', 'FRONTEND_ENGINEER', 'FULLSTACK_ENGINEER', 'DESKTOP_ENGINEER',
    'BUSINESS_APPLICATIONS_ENGINEER', 'IOS_ENGINEER', 'ANDROID_ENGINEER',
    'CROSS_PLATFORM_MOBILE_ENGINEER', 'DATA_ENGINEER', 'DATABASE_ENGINEER', 'DATA_ANALYST',
    'DATA_SCIENTIST', 'ML_ENGINEER', 'AI_ENGINEER', 'DEVOPS_ENGINEER', 'SITE_RELIABILITY_ENGINEER',
    'SYSTEM_ADMINISTRATOR', 'NETWORK_ENGINEER', 'SUPPORT_ENGINEER', 'QA_ENGINEER',
    'QA_AUTOMATION_ENGINEER', 'SECURITY_ENGINEER', 'SECURITY_ANALYST', 'PENETRATION_TESTER',
    'EMBEDDED_ENGINEER', 'HARDWARE_ENGINEER', 'GAME_DEVELOPER', 'BLOCKCHAIN_ENGINEER',
    'SOFTWARE_ARCHITECT', 'ENGINEERING_MANAGER', 'CTO', 'BUSINESS_ANALYST', 'UI_UX_DESIGNER'
  ]::text[]);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_opportunities'::regclass
                    AND conname = 'ck_job_opportunities_technical_roles_known') THEN
    ALTER TABLE job_opportunities ADD CONSTRAINT ck_job_opportunities_technical_roles_known
      CHECK (technical_roles <@ ARRAY[
    'SOFTWARE_ENGINEER', 'BACKEND_ENGINEER', 'FRONTEND_ENGINEER', 'FULLSTACK_ENGINEER',
    'DESKTOP_ENGINEER', 'BUSINESS_APPLICATIONS_ENGINEER', 'IOS_ENGINEER', 'ANDROID_ENGINEER',
    'CROSS_PLATFORM_MOBILE_ENGINEER', 'DATA_ENGINEER', 'DATABASE_ENGINEER', 'DATA_ANALYST',
    'DATA_SCIENTIST', 'ML_ENGINEER', 'AI_ENGINEER', 'DEVOPS_ENGINEER', 'SITE_RELIABILITY_ENGINEER',
    'SYSTEM_ADMINISTRATOR', 'NETWORK_ENGINEER', 'SUPPORT_ENGINEER', 'QA_ENGINEER',
    'QA_AUTOMATION_ENGINEER', 'SECURITY_ENGINEER', 'SECURITY_ANALYST', 'PENETRATION_TESTER',
    'EMBEDDED_ENGINEER', 'HARDWARE_ENGINEER', 'GAME_DEVELOPER', 'BLOCKCHAIN_ENGINEER',
    'SOFTWARE_ARCHITECT', 'ENGINEERING_MANAGER', 'CTO', 'BUSINESS_ANALYST', 'UI_UX_DESIGNER'
  ]::text[]);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_opportunities'::regclass
                    AND conname = 'ck_job_opportunities_role_status') THEN
    ALTER TABLE job_opportunities ADD CONSTRAINT ck_job_opportunities_role_status
      CHECK (role_status IS NULL OR role_status IN ('RULE', 'AI', 'PENDING', 'UNCLEAR', 'NON_IT'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_opportunities'::regclass
                    AND conname = 'ck_job_opportunities_roles_iff_status') THEN
    ALTER TABLE job_opportunities ADD CONSTRAINT ck_job_opportunities_roles_iff_status
      CHECK (role_status IS NULL
             OR ((cardinality(technical_roles) > 0) = (role_status IN ('RULE', 'AI'))));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_role_classifications'::regclass
                    AND conname = 'ck_job_role_classifications_outcome') THEN
    ALTER TABLE job_role_classifications ADD CONSTRAINT ck_job_role_classifications_outcome
      CHECK (outcome IN ('AI', 'UNCLEAR', 'FAILED'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_role_classifications'::regclass
                    AND conname = 'ck_job_role_classifications_technical_roles_known') THEN
    ALTER TABLE job_role_classifications ADD CONSTRAINT ck_job_role_classifications_technical_roles_known
      CHECK (technical_roles <@ ARRAY[
    'SOFTWARE_ENGINEER', 'BACKEND_ENGINEER', 'FRONTEND_ENGINEER', 'FULLSTACK_ENGINEER',
    'DESKTOP_ENGINEER', 'BUSINESS_APPLICATIONS_ENGINEER', 'IOS_ENGINEER', 'ANDROID_ENGINEER',
    'CROSS_PLATFORM_MOBILE_ENGINEER', 'DATA_ENGINEER', 'DATABASE_ENGINEER', 'DATA_ANALYST',
    'DATA_SCIENTIST', 'ML_ENGINEER', 'AI_ENGINEER', 'DEVOPS_ENGINEER', 'SITE_RELIABILITY_ENGINEER',
    'SYSTEM_ADMINISTRATOR', 'NETWORK_ENGINEER', 'SUPPORT_ENGINEER', 'QA_ENGINEER',
    'QA_AUTOMATION_ENGINEER', 'SECURITY_ENGINEER', 'SECURITY_ANALYST', 'PENETRATION_TESTER',
    'EMBEDDED_ENGINEER', 'HARDWARE_ENGINEER', 'GAME_DEVELOPER', 'BLOCKCHAIN_ENGINEER',
    'SOFTWARE_ARCHITECT', 'ENGINEERING_MANAGER', 'CTO', 'BUSINESS_ANALYST', 'UI_UX_DESIGNER'
  ]::text[]);
  END IF;
END $$;
