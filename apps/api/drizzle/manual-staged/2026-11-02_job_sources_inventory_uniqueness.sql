-- =============================================================================
-- Inventory-scoped (type, namespace) uniqueness (SR-M-4) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. `job_sources.inventory_enabled boolean NOT NULL DEFAULT false` (ADD COLUMN appends, so it
--      stays LAST). Every existing row gets false — today's behaviour, where no source is
--      inventory-scoped.
--   2. Backfills `inventory_enabled = true` for the FULL_INVENTORY-capable source types: the seven
--      ATS board adapters. DERIVATION: a source produces a `FULL_INVENTORY` run
--      (reporting-provider.ts `deriveCoverage`) only when its `SourceCoverageScope` has
--      `query IS NULL AND window IS NULL`; the only providers that build such a scope are
--      greenhouse / lever / ashby / workable / smartrecruiters / recruitee / personio
--      (providers/sources/*.provider.ts). Every other provider sets a non-null scope `query` (or a
--      `window`) marker to force WINDOW — including the three seeded JSearch queries
--      (`JSEARCH_API`, namespace='') that legitimately share `(type, namespace)` and must stay
--      allowed. WORKINGNOMADS_API (also an ATS-less "feed") is a BLOCKED STUB with no entries and
--      no fetch path, so it never produces a run and is deliberately not backfilled.
--   3. `uq_job_sources_inventory_type_namespace`: a PARTIAL unique index on `(type, namespace)`
--      WHERE `inventory_enabled`, so the availability worker's `(source_type, namespace)` JOIN
--      resolves to exactly one row; global WINDOW sources are outside the predicate.
--   4. `ck_job_sources_inventory_namespace_nonempty`: a PARTIAL CHECK
--      `NOT inventory_enabled OR length(namespace) > 0` — an inventory-enabled source must carry a
--      real board namespace.
--
-- No grant: `job_sources` is class A in `privilege-classes.ts`, so `crm_app`'s existing table-level
-- grants already cover the new column, and `2026-10-18_db_privileges_check.sql` needs no change.
-- This is an ALTER to an existing relation, not a new table, so it is NOT in STAGED_RELATIONS
-- (which guards GRANTs for whole new tables); the forward-DDL integration spec is its coverage.
--
-- The Drizzle declaration is `jobSources` (schema/job-sourcing.ts);
-- job-sources-inventory-uniqueness-ddl.integration.spec.ts applies this file twice into a scratch
-- schema, compares the new objects with `db:push`, and exercises the index + CHECK as crm_app.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- Production DDL ships staged (backlog 337). It is DARK: `manual-staged/` is never applied in prod.
-- The promote + deploy wiring is a SEPARATE later step, gated on a prod `(type, namespace)`
-- duplicate audit among would-be inventory_enabled sources (two sources already sharing a board key
-- would make `CREATE UNIQUE INDEX` fail), and on the flag-flip of JOB_AVAILABILITY_RECONCILE_ENABLED
-- this constraint is a precondition for.
--
-- RE-RUNNABLE: the column is `ADD COLUMN IF NOT EXISTS`, the backfill is idempotent (it only ever
-- sets the flag on the derived types), the index is `IF NOT EXISTS`, the CHECK is added under a
-- `pg_constraint` existence guard (ADD CONSTRAINT IF NOT EXISTS is not native PG), and the closing
-- block refuses to finish unless the result is exactly the intended state (a same-named column of
-- another type, or a same-named index/CHECK with another definition, fails the apply).
-- ADD COLUMN ... DEFAULT false on PostgreSQL >= 11 is a catalog-only change (no table rewrite).
-- =============================================================================

SET LOCAL lock_timeout = '10s';

ALTER TABLE "job_sources" ADD COLUMN IF NOT EXISTS "inventory_enabled" boolean DEFAULT false NOT NULL;

-- Backfill: the FULL_INVENTORY-capable ATS board types (derivation in the header).
UPDATE "job_sources"
   SET "inventory_enabled" = true
 WHERE "type" IN (
    'GREENHOUSE_ATS',
    'LEVER_ATS',
    'ASHBY_ATS',
    'WORKABLE_ATS',
    'SMARTRECRUITERS_ATS',
    'RECRUITEE_ATS',
    'PERSONIO_ATS'
  )
   AND "inventory_enabled" = false;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_job_sources_inventory_type_namespace"
  ON "job_sources" USING btree ("type", "namespace")
  WHERE "inventory_enabled";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'job_sources'::regclass
                    AND conname = 'ck_job_sources_inventory_namespace_nonempty') THEN
    ALTER TABLE "job_sources" ADD CONSTRAINT "ck_job_sources_inventory_namespace_nonempty"
      CHECK (NOT "inventory_enabled" OR length("namespace") > 0);
  END IF;
END $$;

-- The closing check: the intended state, exactly, or the apply fails (and, applied with
-- --single-transaction, rolls back everything above).
DO $$
DECLARE
  nonempty_check constant text :=
    'CHECK (((NOT inventory_enabled) OR (length(namespace) > 0)))';
  index_def constant text :=
    'CREATE UNIQUE INDEX uq_job_sources_inventory_type_namespace ON public.job_sources USING btree (type, namespace) WHERE inventory_enabled';
  problems text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                   JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'job_sources'::regclass AND a.attname = 'inventory_enabled'
                    AND NOT a.attisdropped AND a.attnotnull AND a.atttypid = 'boolean'::regtype
                    AND pg_get_expr(d.adbin, d.adrelid) = 'false') THEN
    problems := problems || 'column job_sources.inventory_enabled is missing, nullable, not boolean or not DEFAULT false'::text;
  END IF;
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
