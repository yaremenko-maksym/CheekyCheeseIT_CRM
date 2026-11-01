-- =============================================================================
-- Missing-inventory counter (r5 Task 4.6 S8a) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
-- Creates `job_source_record_inventory_misses` (ADR
-- docs/architecture/2026-11-01-availability-reconciliation.md, Decisions 3 and 5): the owner-frozen
-- D4 counter for closing a record by absence from a FULL_INVENTORY board. One row per
-- (source record, board, config version):
--
--   * the consecutive count of VALID FULL_INVENTORY runs that did not list the record;
--   * the first and the most recent advancing miss (run id + timestamp), for the >= 24h span test;
--   * the last inventory size, for the > 50 % drop guard.
--
-- A config bump is a different observation regime, so it opens a new row (config_version is part
-- of the key) rather than mutating an old chain.
--
--   * Key: PRIMARY KEY (source_record_id, board, config_version). Its leading column also serves
--     the cascade probe of the FK below, so no further index is needed.
--   * FK: source_record_id -> job_source_records(id) ON DELETE CASCADE (a purged record's counter
--     means nothing).
--   * CHECKs: consecutive_misses >= 0, config_version > 0, last_inventory_size >= 0, a non-blank
--     board of at most 200 characters, and last_miss_at not before first_miss_at.
--   * The run ids are NOT foreign keys: the counter is derived bookkeeping, and a run purge must
--     not be blocked by (or cascade into) it. They are evidence pointers, like the run id inside
--     `job_source_records.availability_evidence`.
--
-- No row is written: the table starts empty and nothing reads or writes it until slice S8d.
--
-- The Drizzle declaration of the same objects is `jobSourceRecordInventoryMisses` in
-- apps/api/src/database/schema/job-inventory-misses.ts;
-- job-source-record-inventory-misses-forward-ddl.integration.spec.ts applies this file (twice) and
-- compares the catalog with `db:push`.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- scripts/devops/check-prod-ddl-wiring.py fails a build holding a manual/ file the deploy does not
-- copy and apply. Wiring the deploy is DevOps work, behind an owner A3 go (ADR Decision 5: applying
-- the staged DDL in prod is an owner-A3 point). The text names no directory, so moving the file
-- changes no byte of it.
--
-- APPLY ORDER
-- -----------
-- AFTER 2026-10-25_job_record_store.sql (it creates `job_source_records`); BEFORE
-- 2026-10-18_db_grants.sql, which grants this table ONLY where it exists (it is in STAGED_RELATIONS
-- in privilege-classes.ts). Every deploy re-runs the grants file, so the order fixes itself on the
-- next deploy either way.
--
-- HOW TO APPLY
-- ------------
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
-- as the migration role (`crm_user`). Idempotent: every statement is IF NOT EXISTS, and the final
-- check raises if the result is not the intended shape.
--
-- PRIVILEGES: this file grants nothing. The table is class A in
-- apps/api/src/database/privileges/privilege-classes.ts (STAGED_RELATIONS), granted by the
-- generated grants file: crm_app SELECT / INSERT / UPDATE / DELETE, crm_collector nothing. No
-- end-user path reads or writes it.
--
-- WHEN DEVOPS WIRES IT: move the file to manual/, remove the name from STAGED_RELATIONS and
-- regenerate the privilege files (`pnpm --filter @crm/api db:privileges:generate`) in the same PR.
--
-- ROLLBACK (owner-run; loses in-flight counter chains once the table holds production state):
--   DROP TABLE IF EXISTS job_source_record_inventory_misses;
-- Nothing else references it.
-- =============================================================================

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS job_source_record_inventory_misses (
  source_record_id uuid NOT NULL,
  board text NOT NULL,
  config_version integer NOT NULL,
  consecutive_misses integer DEFAULT 0 NOT NULL,
  first_miss_run_id uuid NOT NULL,
  first_miss_at timestamp with time zone NOT NULL,
  last_miss_run_id uuid NOT NULL,
  last_miss_at timestamp with time zone NOT NULL,
  last_inventory_size integer NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT job_source_record_inventory_misses_pkey
    PRIMARY KEY (source_record_id, board, config_version),
  CONSTRAINT fk_job_source_record_inventory_misses_record FOREIGN KEY (source_record_id)
    REFERENCES job_source_records (id) ON DELETE CASCADE,
  CONSTRAINT ck_job_inventory_misses_count CHECK (consecutive_misses >= 0),
  CONSTRAINT ck_job_inventory_misses_config_version CHECK (config_version > 0),
  CONSTRAINT ck_job_inventory_misses_inventory_size CHECK (last_inventory_size >= 0),
  CONSTRAINT ck_job_inventory_misses_board
    CHECK (length(btrim(board)) > 0 AND length(board) <= 200),
  CONSTRAINT ck_job_inventory_misses_span CHECK (last_miss_at >= first_miss_at)
);

-- Final check: a same-named table created by something else would make the IF NOT EXISTS above a
-- silent no-op, so the intended constraints are asserted by name.
DO $check$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(v.name, ', ' ORDER BY v.name)
    INTO missing
    FROM (VALUES
      ('job_source_record_inventory_misses_pkey'),
      ('fk_job_source_record_inventory_misses_record'),
      ('ck_job_inventory_misses_count'),
      ('ck_job_inventory_misses_config_version'),
      ('ck_job_inventory_misses_inventory_size'),
      ('ck_job_inventory_misses_board'),
      ('ck_job_inventory_misses_span')
    ) AS v(name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = v.name AND t.relname = 'job_source_record_inventory_misses'
        AND n.nspname = current_schema()
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'job_source_record_inventory_misses DDL: constraint(s) % missing — a same-named table predates this file', missing;
  END IF;
END
$check$;
