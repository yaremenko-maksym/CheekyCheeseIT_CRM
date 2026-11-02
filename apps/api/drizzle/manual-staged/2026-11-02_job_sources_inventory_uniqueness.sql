-- =============================================================================
-- Inventory-scoped (type, namespace) uniqueness (SR-M-4) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. `uq_job_sources_inventory_type_namespace`: a PARTIAL unique index on `(type, namespace)`
--      WHERE the source type is one of the FULL_INVENTORY-capable ATS board types, so the
--      availability worker's `(source_type, namespace)` JOIN resolves to exactly one row.
--   2. `ck_job_sources_inventory_namespace_nonempty`: a PARTIAL CHECK — an ATS board source must
--      carry a real board namespace (`type NOT IN (…) OR length(namespace) > 0`).
--
-- There is NO `inventory_enabled` column and NO backfill (SR-H-1). A stored flag set only by a
-- one-shot backfill is a maintenance hole: the manifest seed and app code never set it, so any ATS
-- source created later would default to unprotected. Both objects key DIRECTLY on the type list, so
-- they are self-maintaining — a new ATS source of these types is inside the guard the moment it is
-- inserted.
--
-- DERIVATION of the type list: a source produces a `FULL_INVENTORY` run (reporting-provider.ts
-- `deriveCoverage`) only when its `SourceCoverageScope` has `query IS NULL AND window IS NULL`; the
-- only providers that build such a scope are greenhouse / lever / ashby / workable /
-- smartrecruiters / recruitee / personio (providers/sources/*.provider.ts). Every other provider
-- sets a non-null scope `query` (or a `window`) marker to force WINDOW — including the three seeded
-- JSearch queries (`JSEARCH_API`, namespace='') that legitimately share `(type, namespace)` and are
-- outside the predicate. The Drizzle `INVENTORY_SOURCE_TYPES` (schema/job-sourcing.ts) is the same
-- list; the invariant integration spec loops over every member, so a drop or typo fails a test.
--
-- No grant: `job_sources` is class A in `privilege-classes.ts`, so `crm_app`'s existing table-level
-- grants already cover these objects, and `2026-10-18_db_privileges_check.sql` needs no change.
-- This is an ALTER to an existing relation, not a new table, so it is NOT in STAGED_RELATIONS
-- (which guards GRANTs for whole new tables); the forward-DDL integration spec is its coverage.
--
-- The Drizzle declaration is `jobSources` (schema/job-sourcing.ts);
-- job-sources-inventory-uniqueness-ddl.integration.spec.ts applies this file twice into a scratch
-- schema, compares the new objects with `db:push`, and exercises the index + CHECK.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- Production DDL ships staged (backlog 337). It is DARK: `manual-staged/` is never applied in prod.
-- The promote + deploy wiring is a SEPARATE later step, gated on a prod audit that two ATS sources
-- do not already share a `(type, namespace)` AND no ATS source already holds an empty namespace
-- (either would make this apply fail — loud and transactional), and on the flag-flip of
-- JOB_AVAILABILITY_RECONCILE_ENABLED this constraint is a precondition for.
--
-- RE-RUNNABLE: the index is `CREATE UNIQUE INDEX IF NOT EXISTS`, the CHECK is added under a
-- `pg_constraint` existence guard (ADD CONSTRAINT IF NOT EXISTS is not native PG), and the closing
-- block refuses to finish unless the result is exactly the intended state (a same-named index/CHECK
-- with another definition fails the apply).
-- =============================================================================

SET LOCAL lock_timeout = '10s';

CREATE UNIQUE INDEX IF NOT EXISTS "uq_job_sources_inventory_type_namespace"
  ON "job_sources" USING btree ("type", "namespace")
  WHERE "type" IN ('GREENHOUSE_ATS', 'LEVER_ATS', 'ASHBY_ATS', 'WORKABLE_ATS', 'SMARTRECRUITERS_ATS', 'RECRUITEE_ATS', 'PERSONIO_ATS');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_sources'::regclass
                    AND conname = 'ck_job_sources_inventory_namespace_nonempty') THEN
    ALTER TABLE "job_sources" ADD CONSTRAINT "ck_job_sources_inventory_namespace_nonempty"
      CHECK ("type" NOT IN ('GREENHOUSE_ATS', 'LEVER_ATS', 'ASHBY_ATS', 'WORKABLE_ATS', 'SMARTRECRUITERS_ATS', 'RECRUITEE_ATS', 'PERSONIO_ATS') OR length("namespace") > 0);
  END IF;
END $$;

-- The closing check: the intended state, exactly, or the apply fails (and, applied with
-- --single-transaction, rolls back everything above). The expected definitions are the normalised
-- forms Postgres stores (`type IN (…)` becomes `type = ANY (ARRAY[…])`), taken from a `db:push` of
-- the Drizzle schema so the two sides cannot drift.
DO $$
DECLARE
  nonempty_check constant text :=
    'CHECK (((type <> ALL (ARRAY[''GREENHOUSE_ATS''::job_source_type, ''LEVER_ATS''::job_source_type, ''ASHBY_ATS''::job_source_type, ''WORKABLE_ATS''::job_source_type, ''SMARTRECRUITERS_ATS''::job_source_type, ''RECRUITEE_ATS''::job_source_type, ''PERSONIO_ATS''::job_source_type])) OR (length(namespace) > 0)))';
  index_def constant text :=
    'CREATE UNIQUE INDEX uq_job_sources_inventory_type_namespace ON public.job_sources USING btree (type, namespace) WHERE (type = ANY (ARRAY[''GREENHOUSE_ATS''::job_source_type, ''LEVER_ATS''::job_source_type, ''ASHBY_ATS''::job_source_type, ''WORKABLE_ATS''::job_source_type, ''SMARTRECRUITERS_ATS''::job_source_type, ''RECRUITEE_ATS''::job_source_type, ''PERSONIO_ATS''::job_source_type]))';
  problems text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_sources'::regclass
                    AND conname = 'ck_job_sources_inventory_namespace_nonempty'
                    AND contype = 'c' AND convalidated
                    AND pg_get_constraintdef(oid) = nonempty_check) THEN
    problems := problems || 'CHECK ck_job_sources_inventory_namespace_nonempty is missing, not validated or not exactly the intended definition'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = current_schema()
                    AND indexname = 'uq_job_sources_inventory_type_namespace'
                    AND replace(indexdef, current_schema() || '.', 'public.') = index_def) THEN
    problems := problems || 'index uq_job_sources_inventory_type_namespace is missing or not exactly the intended partial-unique definition'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'job_sources inventory-uniqueness DDL is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;
