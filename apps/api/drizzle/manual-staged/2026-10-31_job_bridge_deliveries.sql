-- =============================================================================
-- DOU bridge delivery ledger (r5 Task 4.6 S6b) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
-- Creates `job_bridge_deliveries` (ADR docs/architecture/2026-10-31-dou-bridge-run-ownership.md,
-- decision D-3): one row per (consumer, posting identity, content version) the DOU bridge must hand
-- to a legacy consumer — the `job_postings` insert (LEGACY_POSTING) and the senior suggestions
-- (LEGACY_SUGGESTION). The row survives a crash between the store write and the legacy write, so a
-- retry delivers it exactly once.
--
--   * Key: UNIQUE (consumer, identity_key, content_version) — the delivery identity.
--   * Drain: a partial index over PENDING rows, per source.
--   * FKs: source SET NULL (postings outlive a deleted source, and so must this evidence);
--     posting CASCADE (retention purges unanswered postings; the row of a purged posting means
--     nothing, and its removal lets the next collection re-offer the item); both run FKs RESTRICT
--     (no retention path deletes `job_collection_runs`, and a run purge must not erase delivery
--     evidence silently).
--   * CHECKs: DOU only; a suggestion row names its posting; a DONE posting row (CREATED or
--     DUPLICATE) names its posting — otherwise a DUPLICATE row would survive the purge and its key
--     would block the re-offer; `delivered_at` is set exactly when the row is not PENDING; the
--     payload is at most 64 KiB.
--   * `consumer` / `status` are text + CHECK over the ADR's closed sets (no CREATE TYPE, so the
--     file stays re-appliable and the rollback drops one table).
--
-- No row is written: the table starts empty, and nothing reads or writes it until slice S6d.
--
-- The Drizzle declaration of the same objects is `jobBridgeDeliveries` in
-- apps/api/src/database/schema/job-bridge.ts; job-bridge-deliveries-forward-ddl.integration.spec.ts
-- applies this file (twice) and compares the catalog with `db:push`.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- scripts/devops/check-prod-ddl-wiring.py fails a build holding a manual/ file the deploy does not
-- copy and apply, and wiring the deploy is DevOps work (slice S6f, after an owner A3 go and after
-- S6d is merged and green with the flag on). The text names no directory, so the move changes no
-- byte of it.
--
-- APPLY ORDER (load-bearing)
-- --------------------------
-- AFTER 2026-10-17_job_opportunities_store.sql (it creates `job_collection_runs`; `job_sources`,
-- `job_postings` and the `job_source_type` enum are older) and after
-- 2026-10-25_job_record_store.sql; BEFORE 2026-10-18_db_grants.sql, which grants this table ONLY
-- where it exists (it is in STAGED_RELATIONS in privilege-classes.ts). Every deploy re-runs the
-- grants file, so the order fixes itself on the next deploy either way.
--
-- HOW TO APPLY
-- ------------
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
-- as the migration role (`crm_user`). Idempotent: every statement is IF NOT EXISTS, and the final
-- check raises if the result is not the intended shape.
--
-- PRIVILEGES: this file grants nothing. The table is class A in
-- apps/api/src/database/privileges/privilege-classes.ts (STAGED_RELATIONS), granted by the
-- generated grants file: crm_app SELECT / INSERT / UPDATE / DELETE, crm_collector nothing.
--
-- WHEN DEVOPS WIRES IT: move the file to manual/, remove the name from STAGED_RELATIONS and
-- regenerate the privilege files (`pnpm --filter @crm/api db:privileges:generate`) in the same PR.
--
-- ROLLBACK (owner-run, only after the bridge flag has been off for a full cycle):
--   DROP TABLE IF EXISTS job_bridge_deliveries;
-- Nothing else references it.
-- =============================================================================

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS job_bridge_deliveries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  source_id uuid,
  provider job_source_type NOT NULL,
  consumer text NOT NULL,
  identity_key text NOT NULL,
  content_version text NOT NULL,
  payload jsonb NOT NULL,
  status text DEFAULT 'PENDING' NOT NULL,
  outcome text,
  posting_id uuid,
  suggestions_created integer,
  enqueued_by_run uuid NOT NULL,
  delivered_by_run uuid,
  attempts integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  delivered_at timestamp with time zone,
  CONSTRAINT job_bridge_deliveries_pkey PRIMARY KEY (id),
  CONSTRAINT fk_job_bridge_deliveries_source FOREIGN KEY (source_id)
    REFERENCES job_sources (id) ON DELETE SET NULL,
  CONSTRAINT fk_job_bridge_deliveries_posting FOREIGN KEY (posting_id)
    REFERENCES job_postings (id) ON DELETE CASCADE,
  CONSTRAINT fk_job_bridge_deliveries_enqueued_by_run FOREIGN KEY (enqueued_by_run)
    REFERENCES job_collection_runs (id) ON DELETE RESTRICT,
  CONSTRAINT fk_job_bridge_deliveries_delivered_by_run FOREIGN KEY (delivered_by_run)
    REFERENCES job_collection_runs (id) ON DELETE RESTRICT,
  CONSTRAINT ck_job_bridge_consumer CHECK (consumer IN ('LEGACY_POSTING', 'LEGACY_SUGGESTION')),
  CONSTRAINT ck_job_bridge_status CHECK (status IN ('PENDING', 'DONE', 'INVALID')),
  CONSTRAINT ck_job_bridge_legacy_only CHECK (provider = 'DOU_RSS'),
  CONSTRAINT ck_job_bridge_suggestion_post
    CHECK (consumer <> 'LEGACY_SUGGESTION' OR posting_id IS NOT NULL),
  CONSTRAINT ck_job_bridge_posting_done_has_posting
    CHECK (consumer <> 'LEGACY_POSTING' OR status <> 'DONE' OR posting_id IS NOT NULL),
  CONSTRAINT ck_job_bridge_done_stamped CHECK ((status = 'PENDING') = (delivered_at IS NULL)),
  CONSTRAINT ck_job_bridge_payload_size CHECK (pg_column_size(payload) <= 65536)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_bridge_delivery
  ON job_bridge_deliveries USING btree (consumer, identity_key, content_version);

CREATE INDEX IF NOT EXISTS ix_job_bridge_pending
  ON job_bridge_deliveries USING btree (source_id, consumer, created_at) WHERE (status = 'PENDING');

-- FK child index: the posting purge's CASCADE probes it.
CREATE INDEX IF NOT EXISTS idx_job_bridge_deliveries_posting
  ON job_bridge_deliveries USING btree (posting_id);

-- Final check: a same-named table created by something else would make every IF NOT EXISTS
-- above a silent no-op, so the intended constraints and indexes are asserted by name.
DO $check$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(v.name, ', ' ORDER BY v.name)
    INTO missing
    FROM (VALUES
      ('job_bridge_deliveries_pkey'),
      ('fk_job_bridge_deliveries_source'),
      ('fk_job_bridge_deliveries_posting'),
      ('fk_job_bridge_deliveries_enqueued_by_run'),
      ('fk_job_bridge_deliveries_delivered_by_run'),
      ('ck_job_bridge_consumer'),
      ('ck_job_bridge_status'),
      ('ck_job_bridge_legacy_only'),
      ('ck_job_bridge_suggestion_post'),
      ('ck_job_bridge_posting_done_has_posting'),
      ('ck_job_bridge_done_stamped'),
      ('ck_job_bridge_payload_size')
    ) AS v(name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = v.name AND t.relname = 'job_bridge_deliveries'
        AND n.nspname = current_schema()
   );
  IF to_regclass(current_schema() || '.uq_job_bridge_delivery') IS NULL THEN
    missing := concat_ws(', ', missing, 'uq_job_bridge_delivery');
  END IF;
  IF to_regclass(current_schema() || '.ix_job_bridge_pending') IS NULL THEN
    missing := concat_ws(', ', missing, 'ix_job_bridge_pending');
  END IF;
  IF to_regclass(current_schema() || '.idx_job_bridge_deliveries_posting') IS NULL THEN
    missing := concat_ws(', ', missing, 'idx_job_bridge_deliveries_posting');
  END IF;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'job_bridge_deliveries DDL: constraint(s) % missing — a same-named table predates this file', missing;
  END IF;
END
$check$;
