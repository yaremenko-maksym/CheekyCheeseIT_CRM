-- =============================================================================
-- The health event log (source fetch strategy U4) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. Creates the append-only table `job_source_health_events` (ADR 2026-10-25 section 10):
--      one row per change of a source's health `(state, reason)`, plus ADMIN notes. The
--      current state of a source is the `to_state` of its latest TRANSITION row; no state
--      column is stored.
--   2. Installs ENABLE ALWAYS triggers refusing every UPDATE, DELETE and TRUNCATE (the
--      `job_queue_actions` append-only pattern — `2026-10-18_job_queue_append_only_triggers.sql`).
--      UNLIKE `job_queue_actions`, there is NO retention exception: these events are evidence
--      and are never pruned (ADR "Rollback"), so the refusal is unconditional.
--
-- The privilege manifest class is `A-log` (SELECT, INSERT; `privilege-classes.ts`), so `crm_app`
-- can append and read, never rewrite — the grant is the floor, the triggers are the second lock
-- that also binds the table owner. The crm_app grant is emitted guarded by `to_regclass`
-- (STAGED_RELATIONS), so applying `2026-10-18_db_grants.sql` on a database that does not yet have
-- this table is a no-op rather than a 42P01.
--
-- WHY A-log AND NOT class B: class B inherits the `crm_retention_owner` SELECT+DELETE grant
-- (RETENTION_OWNER_CLASSES), and this log has no retention path. A-log is SELECT+INSERT with no
-- such inheritance. The catalog check's part 9 asserts triggers on class B tables only, so these
-- triggers are not pinned by the generated check while A-log; U4-D promotes the table to B and
-- declares the trigger names in `appendOnlyTriggers` when it moves this file to `manual/`.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- Production DDL ships staged (backlog 337). The DevOps companion U4-D moves it to manual/, adds
-- its apply step to scripts/devops/deploy-stack-on-vps.sh AFTER U2's file (section 10's metric
-- columns are a sibling, not a dependency, but the order is fixed by the chain), with
-- --single-transaction, adds it to the hard-required and scp lists and the runbook.
--
-- RE-RUNNABLE: the table is `CREATE TABLE IF NOT EXISTS` (its inline constraints and FKs come with
-- it, or are skipped whole on a second apply), the index is `IF NOT EXISTS`, every function is
-- `CREATE OR REPLACE`, every trigger is `CREATE OR REPLACE TRIGGER` followed by `ENABLE ALWAYS`
-- (which `OR REPLACE` resets, so the enable is required after every create), and the closing block
-- refuses to finish unless the intended objects are present and the triggers are ENABLE ALWAYS.
--
-- The Drizzle declaration is `jobSourceHealthEvents` (schema/job-health.ts);
-- job-source-health-events-ddl.integration.spec.ts applies this file twice into a scratch schema,
-- compares its catalog with `db:push`, and checks the trigger refusals and the bounds as crm_app.
-- =============================================================================

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS job_source_health_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  source_id uuid NOT NULL,
  at timestamp with time zone DEFAULT now() NOT NULL,
  kind text NOT NULL,
  from_state text,
  to_state text,
  reason_code text,
  evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
  first_bad_run_id uuid,
  last_good_run_id uuid,
  adapter_version text,
  config_version integer,
  http_status smallint,
  error_sample text,
  actor_id uuid,
  note text,
  CONSTRAINT fk_job_source_health_events_source
    FOREIGN KEY (source_id) REFERENCES job_sources (id) ON DELETE RESTRICT,
  CONSTRAINT fk_job_source_health_events_first_bad_run
    FOREIGN KEY (first_bad_run_id) REFERENCES job_collection_runs (id) ON DELETE RESTRICT,
  CONSTRAINT fk_job_source_health_events_last_good_run
    FOREIGN KEY (last_good_run_id) REFERENCES job_collection_runs (id) ON DELETE RESTRICT,
  CONSTRAINT fk_job_source_health_events_actor
    FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT ck_job_source_health_events_kind
    CHECK (kind IN ('TRANSITION', 'NOTE')),
  CONSTRAINT ck_job_source_health_events_states
    CHECK ((from_state IS NULL OR from_state IN ('BLOCKED', 'CAPPED', 'PAUSED', 'FAILING', 'EMPTY', 'DEGRADED', 'SILENT', 'HEALTHY'))
      AND (to_state IS NULL OR to_state IN ('BLOCKED', 'CAPPED', 'PAUSED', 'FAILING', 'EMPTY', 'DEGRADED', 'SILENT', 'HEALTHY'))
      AND (reason_code IS NULL OR reason_code IN ('VOLUME_DROP', 'NO_NEW_ITEMS', 'EMPTY_RESPONSE', 'SCHEMA_DRIFT', 'ACCESS_CHANGED', 'THROTTLED', 'SLOW', 'PAYLOAD_GROWTH', 'STALE_FEED', 'BOARD_GONE', 'DEADLINE_NEAR'))),
  CONSTRAINT ck_job_source_health_events_kind_shape
    CHECK ((kind = 'TRANSITION' AND to_state IS NOT NULL AND actor_id IS NULL AND note IS NULL)
      OR (kind = 'NOTE' AND actor_id IS NOT NULL AND note IS NOT NULL AND from_state IS NULL AND to_state IS NULL AND reason_code IS NULL)),
  CONSTRAINT ck_job_source_health_events_evidence_bounded
    CHECK (jsonb_typeof(evidence) = 'object' AND length(evidence::text) <= 8192),
  CONSTRAINT ck_job_source_health_events_error_sample_bounded
    CHECK (error_sample IS NULL OR length(error_sample) <= 500),
  CONSTRAINT ck_job_source_health_events_http_status_range
    CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT ck_job_source_health_events_adapter_version_bounded
    CHECK (adapter_version IS NULL OR length(adapter_version) <= 100),
  CONSTRAINT ck_job_source_health_events_config_version_positive
    CHECK (config_version IS NULL OR config_version > 0),
  CONSTRAINT ck_job_source_health_events_note_bounded
    CHECK (note IS NULL OR length(note) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_job_source_health_events_source_at
  ON job_source_health_events (source_id, at DESC);

-- ---------------------------------------------------------------------------
-- Append-only: UPDATE and DELETE refused unconditionally (no retention exception).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION job_source_health_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'job_source_health_events is append-only: % refused (row %)',
    TG_OP, COALESCE(OLD.id, NEW.id)
    USING
      ERRCODE = 'restrict_violation',
      DETAIL  = 'Health events are evidence and are never rewritten or pruned (ADR 2026-10-25 '
                'section 10, "Rollback"). A corrected reading is a NEW event.';
END
$fn$;

CREATE OR REPLACE FUNCTION job_source_health_events_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  -- A row-level DELETE trigger does NOT fire on TRUNCATE; without this statement trigger,
  -- TRUNCATE empties the log silently.
  RAISE EXCEPTION 'job_source_health_events is append-only: TRUNCATE refused'
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE OR REPLACE TRIGGER trg_job_source_health_events_append_only
  BEFORE UPDATE OR DELETE ON job_source_health_events
  FOR EACH ROW EXECUTE FUNCTION job_source_health_events_append_only();
ALTER TABLE job_source_health_events
  ENABLE ALWAYS TRIGGER trg_job_source_health_events_append_only;

CREATE OR REPLACE TRIGGER trg_job_source_health_events_no_truncate
  BEFORE TRUNCATE ON job_source_health_events
  FOR EACH STATEMENT EXECUTE FUNCTION job_source_health_events_no_truncate();
ALTER TABLE job_source_health_events
  ENABLE ALWAYS TRIGGER trg_job_source_health_events_no_truncate;

-- The closing check: the intended objects exist and both guards are ENABLE ALWAYS, or the apply
-- fails (and, applied with --single-transaction, rolls back everything above).
DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
  expected_checks text[] := ARRAY[
    'ck_job_source_health_events_kind',
    'ck_job_source_health_events_states',
    'ck_job_source_health_events_kind_shape',
    'ck_job_source_health_events_evidence_bounded',
    'ck_job_source_health_events_error_sample_bounded',
    'ck_job_source_health_events_http_status_range',
    'ck_job_source_health_events_adapter_version_bounded',
    'ck_job_source_health_events_config_version_positive',
    'ck_job_source_health_events_note_bounded'
  ];
  c text;
  trg record;
BEGIN
  IF to_regclass('job_source_health_events') IS NULL THEN
    problems := problems || 'table job_source_health_events is missing'::text;
  END IF;
  FOREACH c IN ARRAY expected_checks LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'job_source_health_events'::regclass
                      AND conname = c AND contype = 'c' AND convalidated) THEN
      problems := problems || format('CHECK %s is missing or not validated', c);
    END IF;
  END LOOP;
  FOR trg IN
    SELECT * FROM (VALUES
      ('trg_job_source_health_events_append_only'),
      ('trg_job_source_health_events_no_truncate')
    ) v(name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'job_source_health_events'::regclass
                      AND t.tgname = trg.name AND NOT t.tgisinternal AND t.tgenabled = 'A') THEN
      problems := problems || format('trigger %s is missing or not ENABLE ALWAYS', trg.name);
    END IF;
  END LOOP;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'job_source_health_events DDL is not in the intended state: %',
      array_to_string(problems, '; ');
  END IF;
END $$;
