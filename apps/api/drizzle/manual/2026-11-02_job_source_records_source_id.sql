-- =============================================================================
-- Explicit source_id on job_source_records (r5 Task 4.6 SR-H-2) — prod forward DDL (PROMOTED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
-- Adds `job_source_records.source_id` (nullable uuid) + a RESTRICT FK to `job_sources(id)` + the
-- child index `idx_job_source_records_source`, then backfills existing rows.
--
-- WHY (PR #1227 review, SR-H-2): the availability-reconcile worker resolved a record onto its
-- source by `JOIN job_sources s ON s.type = r.source_type AND s.namespace = r.namespace ... ORDER BY
-- s.id LIMIT 1` — an ARBITRARY pick whenever two sources share `(type, namespace)`. SR-M-4's unique
-- index only constrains the FULL_INVENTORY ATS types, so the ambiguity stays for global sources
-- (e.g. the three seeded JSearch queries share `(JSEARCH_API, '')`, differing only by `config`). With
-- an explicit `source_id` the resolver reads `s.id = r.source_id` and FAILS CLOSED on a NULL — no
-- guessing. The Drizzle declaration of the same objects is `jobSourceRecords` in
-- apps/api/src/database/schema/job-opportunities.ts.
--
--   * Column: nullable uuid. NULLABLE on purpose — a NOT NULL tightening is a follow-up once every
--     row carries one (backfill below is best-effort). A NULL means "unknown source": the resolver
--     treats such a record as an orphan and completes its dirty row as a no-op.
--   * FK: source_id -> job_sources(id) ON DELETE RESTRICT (retiring a source is an administrative
--     state, never a DELETE — the same rule job_collection_runs' FK encodes).
--   * Index: idx_job_source_records_source on (source_id) — the RESTRICT child probe, and the
--     resolver's join key.
--
-- BACKFILL (runs on a POPULATED prod table): each existing NULL row is set to the source of the
-- EARLIEST run that observed it, read through the run<->record link table `job_run_records`
-- (source-record.store.ts step 6 inserts `(run_id, source_record_id, revision_id)` there). The
-- going-forward writer stamps `source_id` from the creating run's source on the NEW-record insert,
-- so "earliest observing run" is the same choice as "the source that created the record".
--
-- ONE-SOURCE-PER-RECORD INVARIANT — verified and NOT strictly held, by design. A record's identity
-- is `(source_type, namespace, identity_key)`; two global sources sharing `(type, namespace)` can
-- each observe the SAME native posting and so the same record, meaning a record MAY be observed by
-- runs of more than one source. That is exactly the ambiguity SR-H-2 removes: the resolver no longer
-- needs the invariant to hold, because `source_id` names ONE source deterministically. The backfill
-- tie-break (`ORDER BY run.started_at LIMIT 1`) is therefore deterministic rather than "the only
-- possible" source, and it matches the writer's first-creator semantics. For ATS (FULL_INVENTORY)
-- types SR-M-4's unique index does make `(type, namespace)` unique, so there the invariant does hold.
--
-- APPLY ORDER
-- -----------
-- AFTER 2026-10-25_job_record_store.sql / 2026-10-17_job_opportunities_store.sql (they create
-- `job_source_records`) and after the `job_sources` tables exist (FK target). BEFORE
-- 2026-10-18_db_grants.sql is not required — this file creates no grantable relation (an ALTER on an
-- already-granted table and an index inherit the table's privileges), so it grants nothing.
--
-- HOW TO APPLY
-- ------------
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
-- as the migration role (`crm_user`). Idempotent: the column/index are IF NOT EXISTS, the FK is
-- guarded by a pg_constraint existence check, the backfill only touches NULL rows, and the final
-- check raises if the result is not the intended shape.
--
-- PRIVILEGES: this file grants nothing (see APPLY ORDER). No new GRANT.
--
-- ROLLBACK (owner-run; loses backfilled links):
--   ALTER TABLE job_source_records DROP CONSTRAINT IF EXISTS fk_job_source_records_source;
--   DROP INDEX IF EXISTS idx_job_source_records_source;
--   ALTER TABLE job_source_records DROP COLUMN IF EXISTS source_id;
-- =============================================================================

SET LOCAL lock_timeout = '10s';

ALTER TABLE job_source_records ADD COLUMN IF NOT EXISTS source_id uuid;

-- FK guarded by name: a second apply (or a db:push that already added it) must be a no-op, and
-- ADD CONSTRAINT has no IF NOT EXISTS.
DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_source_records_source'
  ) THEN
    ALTER TABLE job_source_records
      ADD CONSTRAINT fk_job_source_records_source FOREIGN KEY (source_id)
      REFERENCES job_sources (id) ON DELETE RESTRICT;
  END IF;
END
$fk$;

CREATE INDEX IF NOT EXISTS idx_job_source_records_source ON job_source_records (source_id);

-- Backfill existing rows from the earliest run that observed each record.
UPDATE job_source_records r
   SET source_id = (
     SELECT run.source_id
       FROM job_run_records jrr
       JOIN job_collection_runs run ON run.id = jrr.run_id
      WHERE jrr.source_record_id = r.id
      ORDER BY run.started_at
      LIMIT 1
   )
 WHERE r.source_id IS NULL;

-- Final check: a column/index/constraint created by something else would make the guards above
-- silent no-ops, so the intended objects are asserted by name.
DO $check$
DECLARE
  missing text := '';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'job_source_records'::regclass AND attname = 'source_id' AND NOT attisdropped
  ) THEN
    missing := missing || 'column source_id, ';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_source_records_source'
  ) THEN
    missing := missing || 'constraint fk_job_source_records_source, ';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'idx_job_source_records_source' AND relkind = 'i'
  ) THEN
    missing := missing || 'index idx_job_source_records_source, ';
  END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION 'job_source_records source_id DDL: % missing — a same-named object predates this file', missing;
  END IF;
END
$check$;
