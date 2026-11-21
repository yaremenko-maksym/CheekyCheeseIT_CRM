-- =============================================================================
-- Tailored resumes (tailored-resume design §8) — prod forward DDL
-- =============================================================================
--
-- WHAT THIS FILE DOES
--   Creates `tailored_resumes`: one row per (job opportunity, senior) holding a resume and cover
--   letter tailored to that opportunity.
--     id                        uuid PRIMARY KEY DEFAULT gen_random_uuid();
--     job_opportunity_id        uuid NOT NULL, FK job_opportunities ON DELETE CASCADE;
--     senior_user_id            uuid NOT NULL, FK users ON DELETE CASCADE;
--                               UNIQUE (job_opportunity_id, senior_user_id);
--     base_resume_id            uuid, FK senior_resumes ON DELETE CASCADE (null until the first
--                               publish), with base_version and opportunity_revision for the
--                               "base changed" hint;
--     content / cover_letter    the published variant, both NULL or both set (CHECK);
--     layout, template_name, verification (gate results only, never posting or model text);
--     run_*                     the generation run, separate from the published variant:
--                               run_status NULL or QUEUED / RUNNING / SUCCEEDED / FAILED (CHECK),
--                               an active run always has its run_id (CHECK);
--     pdf_*                     the PDF, separate from the run (an HR edit re-renders without one):
--                               pdf_status NOT NULL DEFAULT 'IDLE', in the resume render statuses;
--     generated_* / edited_*    who and when, the user FKs ON DELETE SET NULL.
--   Three partial indexes, one per read that must not scan the table (a row per opportunity ×
--   senior):
--     idx_tailored_resumes_active_run     run_status WHERE QUEUED / RUNNING: the run sweep and the
--                                         slot gate read the active runs;
--     idx_tailored_resumes_active_render  pdf_status WHERE QUEUED / RUNNING: the run sweep also
--                                         reads the in-flight renders (an OR, so both are needed);
--     idx_tailored_resumes_pdf_key        pdf_s3_key WHERE NOT NULL: the orphan sweep looks up each
--                                         listing page's candidate keys.
--
-- WHO WRITES IT. The tailored-resumes module (apps/api/src/tailored-resumes/), and only once
-- TAILORED_RESUME_ENABLED is true. Until then the table is empty and nothing reads it.
--
-- BACKFILL: none. A senior starts with no row per opportunity.
--
-- ORDER: applied by the deploy BEFORE the grants file (the grant on this table is unconditional
-- and fails on a missing table), after every file that creates job_opportunities, users and
-- senior_resumes (the FK targets).
--
-- PRIVILEGE CLASS
--   Class A: crm_app inserts, updates and deletes its rows, so SELECT+INSERT+UPDATE+DELETE; the
--   collector has no grant. The grant lives in the generated manual/2026-10-18_db_grants.sql.
--
-- APPLIED BY THE DEPLOY ON EVERY RUN
--   Lives in manual/ so scripts/devops/deploy-stack-on-vps.sh applies it on every deploy, before the
--   grants, with --single-transaction. The first deploy creates the table, every later one is a
--   no-op.
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
--
-- The Drizzle declaration is `tailoredResumes` (schema/tailored-resumes.ts).
-- tailored-resumes-ddl.integration.spec.ts applies this file twice into a scratch schema and
-- compares the columns, constraints and indexes with `db:push`.
--
-- APPLY WITH `psql -v ON_ERROR_STOP=1 --single-transaction -f <this file>`: `SET LOCAL
-- lock_timeout` only binds inside a transaction, and the closing check is all-or-nothing only if a
-- failure rolls back everything above it.
--
-- COST: CREATE TABLE plus FKs to job_opportunities, users and senior_resumes, each taking SHARE ROW
-- EXCLUSIVE on its target for the moment of the CREATE (no rows to validate), and four indexes (the
-- unique pair and three partial ones) on an empty table.
--
-- RE-RUNNABLE: CREATE TABLE / CREATE INDEX IF NOT EXISTS; the closing block refuses to finish
-- unless every named constraint is present and validated and every partial index exists.
--
-- ROLLBACK (by hand; first revert the code that reads the table). Loses every tailored variant:
--   DROP TABLE IF EXISTS "tailored_resumes";
-- The PDFs under the S3 prefix tailored-resumes/ are not removed by the DROP: delete that prefix in
-- the same step (docs/runbooks/deployment.md, "Dropping `tailored_resumes`").
-- =============================================================================

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS tailored_resumes (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_opportunity_id" uuid NOT NULL,
  "senior_user_id" uuid NOT NULL,
  "base_resume_id" uuid,
  "base_version" integer,
  "opportunity_revision" integer,
  "content" jsonb,
  "cover_letter" text,
  "layout" jsonb,
  "template_name" text,
  "verification" jsonb,
  "run_status" text,
  "run_id" uuid,
  "run_base_version" integer,
  "run_stage" text,
  "run_queued_at" timestamp with time zone,
  "run_started_at" timestamp with time zone,
  "run_error_code" text,
  "run_requested_by_user_id" uuid,
  "pdf_status" text DEFAULT 'IDLE' NOT NULL,
  "pdf_render_id" uuid,
  "pdf_render_started_at" timestamp with time zone,
  "pdf_render_error" text,
  "pdf_s3_key" text,
  "pdf_fingerprint" text,
  "generated_by_user_id" uuid,
  "edited_by_user_id" uuid,
  "generated_at" timestamp with time zone,
  "edited_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "uq_tailored_resumes_opportunity_senior" UNIQUE ("job_opportunity_id", "senior_user_id"),
  CONSTRAINT "tailored_resumes_job_opportunity_id_job_opportunities_id_fk" FOREIGN KEY ("job_opportunity_id") REFERENCES "job_opportunities"("id") ON DELETE cascade,
  CONSTRAINT "tailored_resumes_senior_user_id_users_id_fk" FOREIGN KEY ("senior_user_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "tailored_resumes_base_resume_id_senior_resumes_id_fk" FOREIGN KEY ("base_resume_id") REFERENCES "senior_resumes"("id") ON DELETE cascade,
  CONSTRAINT "tailored_resumes_run_requested_by_user_id_users_id_fk" FOREIGN KEY ("run_requested_by_user_id") REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "tailored_resumes_generated_by_user_id_users_id_fk" FOREIGN KEY ("generated_by_user_id") REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "tailored_resumes_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "ck_tailored_resumes_run_status" CHECK ("tailored_resumes"."run_status" IS NULL OR "tailored_resumes"."run_status" IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  CONSTRAINT "ck_tailored_resumes_pdf_status" CHECK ("tailored_resumes"."pdf_status" IN ('IDLE', 'QUEUED', 'RUNNING', 'READY', 'FAILED')),
  CONSTRAINT "ck_tailored_resumes_active_run_id" CHECK ("tailored_resumes"."run_status" IS NULL OR "tailored_resumes"."run_status" NOT IN ('QUEUED', 'RUNNING') OR "tailored_resumes"."run_id" IS NOT NULL),
  CONSTRAINT "ck_tailored_resumes_content_cover_letter" CHECK (("tailored_resumes"."content" IS NULL) = ("tailored_resumes"."cover_letter" IS NULL))
);

CREATE INDEX IF NOT EXISTS "idx_tailored_resumes_active_run" ON tailored_resumes ("run_status")
  WHERE "run_status" IN ('QUEUED', 'RUNNING');
CREATE INDEX IF NOT EXISTS "idx_tailored_resumes_active_render" ON tailored_resumes ("pdf_status")
  WHERE "pdf_status" IN ('QUEUED', 'RUNNING');
CREATE INDEX IF NOT EXISTS "idx_tailored_resumes_pdf_key" ON tailored_resumes ("pdf_s3_key")
  WHERE "pdf_s3_key" IS NOT NULL;

-- The closing check: every named constraint present and validated, and every partial index there,
-- or the apply fails (and, applied in one transaction, rolls back everything above). It does not
-- compare definitions: the DDL spec does that against `db:push`.
DO $$
DECLARE
  problems text[] := '{}';
  expected text[] := ARRAY[
    'tailored_resumes_pkey',
    'uq_tailored_resumes_opportunity_senior',
    'tailored_resumes_job_opportunity_id_job_opportunities_id_fk',
    'tailored_resumes_senior_user_id_users_id_fk',
    'tailored_resumes_base_resume_id_senior_resumes_id_fk',
    'tailored_resumes_run_requested_by_user_id_users_id_fk',
    'tailored_resumes_generated_by_user_id_users_id_fk',
    'tailored_resumes_edited_by_user_id_users_id_fk',
    'ck_tailored_resumes_run_status',
    'ck_tailored_resumes_pdf_status',
    'ck_tailored_resumes_active_run_id',
    'ck_tailored_resumes_content_cover_letter'
  ];
  partial_indexes text[] := ARRAY[
    'idx_tailored_resumes_active_run',
    'idx_tailored_resumes_active_render',
    'idx_tailored_resumes_pdf_key'
  ];
  c text;
BEGIN
  IF to_regclass('tailored_resumes') IS NULL THEN
    problems := problems || 'table tailored_resumes is missing'::text;
  ELSE
    FOREACH c IN ARRAY expected LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'tailored_resumes'::regclass AND conname = c AND convalidated
      ) THEN
        problems := problems || format('constraint %s is missing or not validated', c);
      END IF;
    END LOOP;
    FOREACH c IN ARRAY partial_indexes LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        WHERE i.indrelid = 'tailored_resumes'::regclass
          AND i.indexrelid = to_regclass(c)
          AND i.indisvalid AND i.indpred IS NOT NULL
      ) THEN
        problems := problems || format('index %s is missing, invalid or not partial', c);
      END IF;
    END LOOP;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'tailored_resumes DDL is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;
