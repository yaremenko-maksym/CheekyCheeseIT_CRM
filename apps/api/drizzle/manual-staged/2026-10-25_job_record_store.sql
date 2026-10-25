-- =============================================================================
-- Record store side tables (r5 Task 4.5) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
-- -------------------
-- Creates the two tables the source-record and canonical repositories
-- (apps/api/src/job-sourcing/store/) write next to the Phase-1 store:
--
--   1. `job_run_records` — run membership: which run observed which source record, and the
--      revision it observed. PK (run_id, source_record_id), so a retried page writes nothing
--      twice, and two discovery configurations that see one native job write two rows here
--      and still share ONE `job_source_records` row. Minimal columns: the three keys and
--      `observed_at`. All three foreign keys CASCADE: membership is derived bookkeeping and
--      has no meaning once its run, record or revision is gone. Two child indexes serve the
--      cascade probes from a record and from a revision.
--   2. `job_opportunity_identity_tokens` — a trusted cross-source job key, owned by exactly
--      ONE opportunity: UNIQUE (namespace_kind, token_key). Claiming is `INSERT … ON CONFLICT
--      DO NOTHING`, then reading the owner (chosen over sorted advisory locks: the constraint
--      is the arbiter, so no code path can claim without it, and nothing must remember to
--      take a lock). `namespace_kind` admits only 'ATS_JOB_KEY' — vendor-hosted ATS job keys;
--      never an apply URL, a homepage or a company name. `source_record_id` is the evidence
--      (the record whose key made the claim), `rule_version` the identity rules that trusted
--      it. Tokens are never moved: a split keeps the token with the opportunity and history
--      lives in `job_opportunity_sources`. CASCADE from both parents.
--
-- No row is written: both tables start empty.
--
-- The Drizzle declaration of the same objects is `jobRunRecords` /
-- `jobOpportunityIdentityTokens` in apps/api/src/database/schema/job-identity.ts;
-- job-record-store-forward-ddl.integration.spec.ts applies this file (twice) and compares the
-- catalog with `db:push`.
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
-- ---------------------------------------
-- Same reason as the T1 and T8 files before their wiring: scripts/devops/check-prod-ddl-wiring.py
-- fails a build holding a manual/ file the deploy does not copy and apply, and wiring the deploy
-- is DevOps work. The text names no directory, so the move changes no byte of it.
--
-- APPLY ORDER (load-bearing)
-- --------------------------
-- AFTER 2026-10-17_job_opportunities_store.sql (it creates `job_source_records`,
-- `job_source_record_revisions`, `job_opportunities` and `job_collection_runs`). The grants
-- file `2026-10-18_db_grants.sql` grants these two tables ONLY where they exist (they are
-- STAGED_RELATIONS in privilege-classes.ts), so it may run before or after this file; re-run
-- it after this file to grant them (every deploy does).
--
-- HOW TO APPLY
-- ------------
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
-- as the migration role (`crm_user`). Idempotent: every statement is IF NOT EXISTS, and the
-- final check raises if the result is not the intended shape.
--
-- PRIVILEGES: this file grants nothing. Both tables are class A in
-- apps/api/src/database/privileges/privilege-classes.ts (STAGED_RELATIONS), granted by the
-- generated grants file. Every object here is created by the applying role, so `crm_app` owns
-- nothing new.
--
-- WHEN DEVOPS WIRES IT: move the file to manual/, remove both names from STAGED_RELATIONS and
-- regenerate the privilege files (`pnpm --filter @crm/api db:privileges:generate`) in the same PR.
--
-- ROLLBACK (one transaction):
--   DROP TABLE IF EXISTS job_opportunity_identity_tokens;
--   DROP TABLE IF EXISTS job_run_records;
-- Nothing else references them.
-- =============================================================================

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS job_run_records (
  run_id uuid NOT NULL,
  source_record_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  observed_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT pk_job_run_records PRIMARY KEY (run_id, source_record_id),
  CONSTRAINT fk_job_run_records_run FOREIGN KEY (run_id)
    REFERENCES job_collection_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_job_run_records_record FOREIGN KEY (source_record_id)
    REFERENCES job_source_records (id) ON DELETE CASCADE,
  CONSTRAINT fk_job_run_records_revision FOREIGN KEY (revision_id)
    REFERENCES job_source_record_revisions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_run_records_record ON job_run_records USING btree (source_record_id);
CREATE INDEX IF NOT EXISTS idx_job_run_records_revision ON job_run_records USING btree (revision_id);

CREATE TABLE IF NOT EXISTS job_opportunity_identity_tokens (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  namespace_kind text NOT NULL,
  token_key text NOT NULL,
  opportunity_id uuid NOT NULL,
  source_record_id uuid NOT NULL,
  rule_version text NOT NULL,
  claimed_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT job_opportunity_identity_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT uq_job_opportunity_identity_tokens_key UNIQUE (namespace_kind, token_key),
  CONSTRAINT fk_job_opportunity_identity_tokens_opportunity FOREIGN KEY (opportunity_id)
    REFERENCES job_opportunities (id) ON DELETE CASCADE,
  CONSTRAINT fk_job_opportunity_identity_tokens_record FOREIGN KEY (source_record_id)
    REFERENCES job_source_records (id) ON DELETE CASCADE,
  CONSTRAINT ck_job_opportunity_identity_tokens_kind CHECK (namespace_kind IN ('ATS_JOB_KEY')),
  CONSTRAINT ck_job_opportunity_identity_tokens_key_bounded
    CHECK (token_key ~ '[^[:space:]]' AND length(token_key) <= 1024),
  CONSTRAINT ck_job_opportunity_identity_tokens_rule_version_bounded
    CHECK (rule_version ~ '[^[:space:]]' AND length(rule_version) <= 100)
);

CREATE INDEX IF NOT EXISTS idx_job_opportunity_identity_tokens_opportunity
  ON job_opportunity_identity_tokens USING btree (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_job_opportunity_identity_tokens_record
  ON job_opportunity_identity_tokens USING btree (source_record_id);

-- Final check: a same-named table created by something else would make every IF NOT EXISTS
-- above a silent no-op, so the intended constraints are asserted by name.
DO $check$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(v.name, ', ' ORDER BY v.name)
    INTO missing
    FROM (VALUES
      ('pk_job_run_records'),
      ('fk_job_run_records_run'),
      ('fk_job_run_records_record'),
      ('fk_job_run_records_revision'),
      ('uq_job_opportunity_identity_tokens_key'),
      ('fk_job_opportunity_identity_tokens_opportunity'),
      ('fk_job_opportunity_identity_tokens_record'),
      ('ck_job_opportunity_identity_tokens_kind'),
      ('ck_job_opportunity_identity_tokens_key_bounded'),
      ('ck_job_opportunity_identity_tokens_rule_version_bounded')
    ) AS v(name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = v.name AND n.nspname = current_schema()
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'job record store DDL: constraint(s) % missing — a same-named table predates this file', missing;
  END IF;
END
$check$;
