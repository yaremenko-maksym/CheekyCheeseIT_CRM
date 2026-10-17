-- =============================================================================
-- job_opportunities store (r5 Phase 1) — prod forward DDL, part 1 of 2: objects
-- =============================================================================
--
-- Context
-- -------
-- r5 Task 1.3a. Task 1.2 landed this store as DRIZZLE SCHEMA ONLY (#1011, #1015,
-- #1017): the dev and CI databases get it from `pnpm --filter @crm/api db:push`,
-- the prod image does not ship drizzle-kit, so production has none of it. The
-- newest job-sourcing DDL on production is 2026-10-05_vacancy_sourcing_schema.sql,
-- which belongs to the LEGACY `job_postings` path. This file creates the new store
-- beside it. The legacy path is untouched and is never read by the new store (C-01).
--
-- What it creates — derived from the schema, not from prose. Both sides were
-- produced with `drizzle-kit generate`, once from `src/database/schema.ts` and once
-- from the pre-Task-1.2 tree, and diffed:
--   * 19 brand-new enum types (every one `job_*`);
--   * 18 new tables;
--   * the extension of the existing `job_sources`: 18 columns, 11 CHECKs, 1 FK;
--   * 45 foreign keys.
-- Indexes are part 2 (see "Why two files").
--
-- Additive only. Nothing is dropped, no existing column is retyped, and — the part
-- worth stating because it decides the file count — NO EXISTING ENUM GAINS A VALUE.
-- Every one of the 19 types is created whole. So there is no `ALTER TYPE ... ADD
-- VALUE` anywhere in this task, and therefore none of the "add a value in one file,
-- use it in the next" split that 2026-10-05_vacancy_sourcing_schema.sql needed.
--
-- Idempotency contract
-- --------------------
-- `deploy.yml` applies EVERY `manual/*.sql` file on EVERY deploy (there is no
-- applied-migrations registry), as `psql -v ON_ERROR_STOP=1 < file` — statement-level
-- autocommit, no surrounding transaction. So every statement here is independently
-- applicable and a second apply is a no-op:
--   * `CREATE TYPE` has no `IF NOT EXISTS` form -> `DO $$ ... EXCEPTION WHEN
--     duplicate_object THEN NULL`;
--   * `CREATE TABLE IF NOT EXISTS` carries each table's own PK / UNIQUE / CHECK
--     inline, so a fresh database gets the table complete in one statement;
--   * `ADD COLUMN IF NOT EXISTS` for the `job_sources` columns;
--   * `ADD CONSTRAINT` has no `IF NOT EXISTS` form -> the same `duplicate_object`
--     guard for every CHECK and every foreign key.
-- Proven by execution, not by reading: the file is applied TWICE in a row and the
-- catalog is diffed between the runs — see
-- `src/database/job-opportunities-store-forward-ddl.integration.spec.ts`.
--
-- WHAT THE `duplicate_object` GUARD DOES NOT CHECK (SR-L-3)
-- --------------------------------------------------------
-- It keys on the NAME, not the definition. If a constraint of the same name already
-- exists with a DIFFERENT expression — hand-applied during an incident, or left by an
-- earlier revision of this file — the guard swallows the error and the old definition
-- stays, silently. The file is then "applied" while the database disagrees with it. The
-- same is true of `CREATE TABLE IF NOT EXISTS` (a table that exists with the wrong
-- columns is left alone) and of `ADD COLUMN IF NOT EXISTS` (an existing column of the
-- wrong type is kept). That is a deliberate trade: the alternative — dropping and
-- recreating to be sure — is destructive on a live database, and this file must be safe
-- to re-run on every deploy. What closes the gap is not the guard but the catalog
-- equivalence spec named above, which compares DEFINITIONS and not names, and would
-- fail on exactly this divergence. If it ever does fail that way on production, the
-- remedy is a new, dated migration that drops and recreates the offending object by
-- name — never an edit to this file, which is immutable once merged.
--
-- Locks
-- -----
-- `lock_timeout` is set below so this file FAILS FAST rather than queueing behind a
-- long transaction and blocking every reader of `job_sources` behind itself. A deploy
-- that trips it is re-run; nothing here is half-applicable.
-- The 18 added columns are all either nullable or constant-defaulted, so PG11+ adds
-- them without rewriting the table. The 11 CHECKs are added VALIDATED (not `NOT VALID`
-- + `VALIDATE`): validating scans the table under ACCESS EXCLUSIVE, and `job_sources`
-- is an admin-managed catalogue of a few dozen rows. `NOT VALID` would also leave
-- `convalidated = false` in the catalog, which is a real difference from what
-- `db:push` produces, and the equivalence spec would (correctly) fail on it.
--
-- TEN of the eleven CHECKs read only columns this file ADDS, with constant defaults, so
-- no existing row can fail them. `ck_job_sources_config_bounded` is the EXCEPTION: it
-- reads `config`, which predates this store, and it requires a JSON OBJECT of at most
-- 8192 bytes. A row whose `config` is an array or a scalar aborts the file AT THAT
-- STATEMENT — and because the CHECK block precedes the foreign keys, the deploy stops
-- with the 18 tables created but no FK and no index applied. It fails loudly and a
-- re-run after fixing the row recovers completely, but an operator should not discover
-- it mid-deploy. RUN THIS PREFLIGHT FIRST (it must return zero rows):
--
--   SELECT id, type, jsonb_typeof(config) AS kind, length(config::text) AS bytes
--     FROM job_sources
--    WHERE jsonb_typeof(config) <> 'object' OR length(config::text) > 8192;
--
-- Expected to be empty: the 16 rows seeded by 2026-10-05_vacancy_sources_seed.sql are
-- all small objects, and no application code path writes `config`. The equivalence spec
-- now applies this file to a `job_sources` that HAS rows (previously it had none, so
-- all 11 CHECKs validated against an empty table and CI could not have caught this),
-- and it pins the abort and this very query as a test.
--
-- Why two files
-- -------------
-- Part 2 (`..._indexes.sql`) holds the 44 standalone indexes and nothing else,
-- because those are the only statements here that MUST NOT run inside a transaction
-- (`CREATE INDEX CONCURRENTLY`) and the only ones that can leave a half-built object
-- behind. Keeping them apart means a retry after a lock timeout re-walks 94 guards
-- instead of 138, and the INVALID-index repair path stays in the one file it concerns.
-- Part 1 must be applied BEFORE part 2.
--
-- NOT in this file (deliberately, not forgotten)
-- ----------------------------------------------
--   * TRIGGERS — append-only on `job_queue_actions`, immutability on
--     `job_queue_generation_entries`, and the generation team-boundary controls. They
--     are enumerated, with the measurements behind them, in the
--     "TASK 1.3 OBLIGATION" section of `src/database/schema/job-queue.ts`, and they
--     are r5 Task 1.3b — gated on two decisions still open with the owner (the
--     database role model, PR #1018; the erasure design, PR #1019).
--   * GRANTS — r5 Task 1.3c, and worth adding only once the API connects as a
--     non-superuser role, which is part of the same open decision.
-- Until 1.3b lands, both tables accept UPDATE and DELETE exactly as they do on the
-- `db:push` schema today. This file does not widen that gap and does not hide it.
--
-- WHAT THIS MAKES HARDER LATER, recorded on purpose (SR-L-5)
-- ---------------------------------------------------------
-- Twelve of the 45 foreign keys point at `users` with `ON DELETE RESTRICT` — every
-- actor column of the queue audit log and of the collection tables. That is deliberate:
-- no parent delete may erase audit rows through a cascade. The consequence is that
-- DELETING A USER becomes impossible once they have acted on the queue, and the
-- erasure design (PR #1019) is still open. The application archives users rather than
-- deleting them, so nothing is blocked today — but whoever settles #1019 should know
-- that "delete the user row" is not among the options this schema leaves open, and that
-- an erasure path will have to anonymise in place or re-point these FKs. Filed as a
-- consequence to see, NOT as a change requested here: weakening them to SET NULL would
-- give up the audit guarantee the store is being built for.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-10-17_job_opportunities_store.sql
--
-- On production this is not run by hand: BOTH FILES ARE WIRED INTO
-- .github/workflows/deploy.yml (part 1 then part 2) as hard-required apply steps, in
-- the same commit series as this file — so merging the PR that adds this file also
-- changes the deploy pipeline, and the next deploy applies it. The command above is for
-- a manual re-run or a preflight on a copy.
-- =============================================================================

SET lock_timeout = '10s';
SET statement_timeout = '5min';


-- ---------------------------------------------------------------------------
-- 1. Enum types (19). Guarded CREATE — Postgres has no CREATE TYPE IF NOT EXISTS
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "job_availability" AS ENUM('OPEN', 'UNKNOWN', 'CLOSED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_collection_coverage" AS ENUM('FULL_INVENTORY', 'WINDOW', 'PARTIAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_collection_cycle_status" AS ENUM('OPEN', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_collection_outcome" AS ENUM('STARTED', 'PARTIAL', 'SUCCEEDED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_collection_trigger" AS ENUM('SCHEDULED', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_dirty_work_entity_kind" AS ENUM('SOURCE_RECORD', 'OPPORTUNITY', 'SENIOR', 'EXCLUSION', 'PROJECT_CLIENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_dirty_work_status" AS ENUM('PENDING', 'CLAIMED', 'DONE', 'FAILED', 'DEFERRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_identity_kind" AS ENUM('NATIVE_ID', 'URL_FALLBACK');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_meter_reservation_status" AS ENUM('RESERVED', 'SENT', 'USED', 'RELEASED', 'UNCERTAIN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_meter_unit" AS ENUM('REQUEST', 'RECORD', 'MODEL_CALL', 'USD_MICROS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_meter_window" AS ENUM('DAY', 'MONTH', 'LIFETIME');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_opportunity_link_decision" AS ENUM('AUTO', 'CONFIRMED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_opportunity_match_outcome" AS ENUM('LEAD', 'TRIAGE', 'EXCLUDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_queue_action_kind" AS ENUM('OPENED', 'TAKEN', 'DEAD_LINK', 'SPAM', 'DISMISSED', 'UNDONE', 'RELEASED', 'REASSIGNED', 'SUPPRESSED', 'TRIAGE_GRANTED', 'TRIAGE_REVOKED', 'TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_queue_assignment_state" AS ENUM('TAKEN', 'RELEASED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_queue_generation_status" AS ENUM('BUILDING', 'PUBLISHED', 'INVALIDATED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_queue_scope_kind" AS ENUM('TEAM', 'STUDIO');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_source_admin_state" AS ENUM('ACTIVE', 'PAUSED', 'RETIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "job_source_readiness" AS ENUM('CANDIDATE', 'VERIFIED', 'BLOCKED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Tables (18), each complete with its own PK / UNIQUE / CHECK
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The found opportunity (schema/job-opportunities.ts)
-- ---------------------------------------------------------------------------
--
-- Provider-native identity, not the legacy fingerprint: a source record is
-- identified by (source type, namespace, identity kind, identity value), and several
-- records collapse into one canonical opportunity through job_opportunity_sources. All of
-- it originated in a third party and is UNTRUSTED — stored navigation URLs are https-only
-- by CHECK, hashes are 64-hex by CHECK, and text bodies live content-addressed in
-- job_text_blobs so an identical description is stored once.

CREATE TABLE IF NOT EXISTS "job_text_blobs" (
	"sha256" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_job_text_blobs_sha256_hex" CHECK ("job_text_blobs"."sha256" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS "job_source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" "job_source_type" NOT NULL,
	"namespace" text DEFAULT '' NOT NULL,
	"identity_kind" "job_identity_kind" NOT NULL,
	"identity_key" text NOT NULL,
	"original_url" text,
	"display_url" text,
	"source_url" text,
	"application_url" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latest_revision_id" uuid,
	"availability" "job_availability" DEFAULT 'UNKNOWN' NOT NULL,
	"availability_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"availability_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_job_source_records_identity" UNIQUE("source_type","namespace","identity_key"),
	CONSTRAINT "ck_job_source_records_identity_key_nonempty" CHECK ("job_source_records"."identity_key" ~ '[^[:space:]]'),
	CONSTRAINT "ck_job_source_records_original_url_https" CHECK ("job_source_records"."original_url" IS NULL OR "job_source_records"."original_url" ~* '^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'),
	CONSTRAINT "ck_job_source_records_display_url_https" CHECK ("job_source_records"."display_url" IS NULL OR "job_source_records"."display_url" ~* '^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'),
	CONSTRAINT "ck_job_source_records_source_url_https" CHECK ("job_source_records"."source_url" IS NULL OR "job_source_records"."source_url" ~* '^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'),
	CONSTRAINT "ck_job_source_records_application_url_https" CHECK ("job_source_records"."application_url" IS NULL OR "job_source_records"."application_url" ~* '^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$')
);

CREATE TABLE IF NOT EXISTS "job_source_record_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_record_id" uuid NOT NULL,
	"adapter_version" text NOT NULL,
	"normalizer_version" text NOT NULL,
	"content_hash" text NOT NULL,
	"normalized" jsonb NOT NULL,
	"original_identity" jsonb NOT NULL,
	"field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description_sha256" text,
	"published_at_raw" text,
	"published_at" timestamp with time zone,
	"received_seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "job_source_record_revisions_received_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sample_ref" text,
	CONSTRAINT "uq_job_source_record_revisions_content" UNIQUE("source_record_id","normalizer_version","content_hash"),
	CONSTRAINT "ck_job_source_record_revisions_content_hash_hex" CHECK ("job_source_record_revisions"."content_hash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS "job_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"title_key" text NOT NULL,
	"employer_name" text,
	"employer_key" text,
	"employer_verified" boolean DEFAULT false NOT NULL,
	"location" text,
	"seniority" "job_seniority" DEFAULT 'UNKNOWN' NOT NULL,
	"stack_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"application_url" text,
	"application_url_key" text,
	"published_at" timestamp with time zone,
	"description_sha256" text,
	"field_revisions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"availability" "job_availability" DEFAULT 'UNKNOWN' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_job_opportunities_revision_positive" CHECK ("job_opportunities"."revision" > 0),
	CONSTRAINT "ck_job_opportunities_verified_has_key" CHECK (NOT "job_opportunities"."employer_verified" OR "job_opportunities"."employer_key" IS NOT NULL),
	CONSTRAINT "ck_job_opportunities_application_url_https" CHECK ("job_opportunities"."application_url" IS NULL OR "job_opportunities"."application_url" ~* '^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$')
);

CREATE TABLE IF NOT EXISTS "job_opportunity_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_record_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"decision" "job_opportunity_link_decision" DEFAULT 'AUTO' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rule_version" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unlinked_at" timestamp with time zone,
	"unlink_reason" text,
	CONSTRAINT "ck_job_opportunity_sources_unlink_pair" CHECK (("job_opportunity_sources"."unlinked_at" IS NULL) = ("job_opportunity_sources"."unlink_reason" IS NULL))
);

CREATE TABLE IF NOT EXISTS "job_opportunity_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"senior_id" uuid NOT NULL,
	"opportunity_revision" integer NOT NULL,
	"senior_profile_version" text NOT NULL,
	"exclusion_version" text NOT NULL,
	"rule_version" text NOT NULL,
	"outcome" "job_opportunity_match_outcome" NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_job_opportunity_matches_opportunity_senior" UNIQUE("opportunity_id","senior_id")
);

CREATE TABLE IF NOT EXISTS "job_opportunity_team_triage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_version" integer NOT NULL,
	"opportunity_revision" integer NOT NULL,
	"grant_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_job_opportunity_team_triage_opportunity_team" UNIQUE("opportunity_id","team_id")
);

-- ---------------------------------------------------------------------------
-- What a collection may spend (schema/job-metering.ts)
-- ---------------------------------------------------------------------------
--
-- An account meter carries NO secrets, and two CHECKs are the mechanical part
-- of that promise: account_key is a short lowercase id over an alphabet that excludes
-- every uppercase letter and the base64 characters, and any unbroken 24-character run is
-- refused outright — which is what a pasted raw API key looks like inside that alphabet.
-- A key therefore cannot be stored here even by accident.

CREATE TABLE IF NOT EXISTS "job_account_meters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_key" text NOT NULL,
	"unit" "job_meter_unit" NOT NULL,
	"window_kind" "job_meter_window" NOT NULL,
	"limit_amount" bigint,
	"used" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	"uncertain" bigint DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone,
	"resets_at" timestamp with time zone,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_job_account_meters_identity" UNIQUE("account_key","unit","window_kind"),
	CONSTRAINT "ck_job_account_meters_spend_within_limit" CHECK ("job_account_meters"."limit_amount" IS NULL OR "job_account_meters"."used" + "job_account_meters"."reserved" + "job_account_meters"."uncertain" <= "job_account_meters"."limit_amount"),
	CONSTRAINT "ck_job_account_meters_counters_nonneg" CHECK ("job_account_meters"."used" >= 0 AND "job_account_meters"."reserved" >= 0 AND "job_account_meters"."uncertain" >= 0),
	CONSTRAINT "ck_job_account_meters_limit_nonneg" CHECK ("job_account_meters"."limit_amount" IS NULL OR "job_account_meters"."limit_amount" >= 0),
	CONSTRAINT "ck_job_account_meters_account_key_format" CHECK ("job_account_meters"."account_key" ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'),
	CONSTRAINT "ck_job_account_meters_account_key_segmented" CHECK ("job_account_meters"."account_key" !~ '[a-z0-9]{24}'),
	CONSTRAINT "ck_job_account_meters_lifetime_never_resets" CHECK ("job_account_meters"."window_kind" <> 'LIFETIME' OR ("job_account_meters"."resets_at" IS NULL AND "job_account_meters"."window_started_at" IS NULL)),
	CONSTRAINT "ck_job_account_meters_windowed_has_start" CHECK ("job_account_meters"."window_kind" = 'LIFETIME' OR "job_account_meters"."window_started_at" IS NOT NULL),
	CONSTRAINT "ck_job_account_meters_policy_version_positive" CHECK ("job_account_meters"."policy_version" > 0)
);

-- ---------------------------------------------------------------------------
-- How it was collected (schema/job-collection.ts)
-- ---------------------------------------------------------------------------
--
-- A cycle groups the runs of one triggering; a run is one source attempt; the
-- reservation is the spend a run holds against a meter before it knows the outcome. The
-- composite FKs (run -> (cycle, trigger), reservation -> (run, cycle)) exist so that a row
-- cannot name a cycle through one parent and a different cycle through another: Postgres
-- refuses the disagreement that a CHECK, which sees one row, could not.

CREATE TABLE IF NOT EXISTS "job_collection_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" "job_collection_trigger" NOT NULL,
	"trigger_key" text NOT NULL,
	"requested_by" uuid,
	"html_call_meter_id" uuid,
	"html_call_reservation" integer DEFAULT 20 NOT NULL,
	"status" "job_collection_cycle_status" DEFAULT 'OPEN' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_job_collection_cycles_trigger_key" UNIQUE("trigger","trigger_key"),
	CONSTRAINT "uq_job_collection_cycles_id_trigger" UNIQUE("id","trigger"),
	CONSTRAINT "ck_job_collection_cycles_trigger_key_nonempty" CHECK ("job_collection_cycles"."trigger_key" ~ '[^[:space:]]'),
	CONSTRAINT "ck_job_collection_cycles_trigger_key_bounded" CHECK (length("job_collection_cycles"."trigger_key") <= 200),
	CONSTRAINT "ck_job_collection_cycles_closed_pair" CHECK (("job_collection_cycles"."status" = 'CLOSED') = ("job_collection_cycles"."closed_at" IS NOT NULL)),
	CONSTRAINT "ck_job_collection_cycles_manual_has_actor" CHECK (("job_collection_cycles"."trigger" = 'MANUAL') = ("job_collection_cycles"."requested_by" IS NOT NULL)),
	CONSTRAINT "ck_job_collection_cycles_html_reservation_positive" CHECK ("job_collection_cycles"."html_call_reservation" > 0)
);

CREATE TABLE IF NOT EXISTS "job_collection_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"config_version" integer NOT NULL,
	"source_config_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"adapter_version" text NOT NULL,
	"trigger" "job_collection_trigger" NOT NULL,
	"outcome" "job_collection_outcome" DEFAULT 'STARTED' NOT NULL,
	"coverage" "job_collection_coverage" DEFAULT 'PARTIAL' NOT NULL,
	"owner_token" text,
	"fencing_epoch" bigint DEFAULT 1 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"revised" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"invalid" integer DEFAULT 0 NOT NULL,
	"persistence_errors" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_job_collection_runs_attempt" UNIQUE("source_id","attempt_id"),
	CONSTRAINT "uq_job_collection_runs_id_cycle" UNIQUE("id","cycle_id"),
	CONSTRAINT "ck_job_collection_runs_attempt_id_nonempty" CHECK ("job_collection_runs"."attempt_id" ~ '[^[:space:]]'),
	CONSTRAINT "ck_job_collection_runs_attempt_id_bounded" CHECK (length("job_collection_runs"."attempt_id") <= 200),
	CONSTRAINT "ck_job_collection_runs_owner_token_bounded" CHECK ("job_collection_runs"."owner_token" IS NULL OR length("job_collection_runs"."owner_token") <= 200),
	CONSTRAINT "ck_job_collection_runs_adapter_version_bounded" CHECK (length("job_collection_runs"."adapter_version") <= 100),
	CONSTRAINT "ck_job_collection_runs_checkpoint_bounded" CHECK (jsonb_typeof("job_collection_runs"."checkpoint") = 'object' AND length("job_collection_runs"."checkpoint"::text) <= 8192),
	CONSTRAINT "ck_job_collection_runs_config_snapshot_bounded" CHECK (jsonb_typeof("job_collection_runs"."source_config_snapshot") = 'object' AND length("job_collection_runs"."source_config_snapshot"::text) <= 8192),
	CONSTRAINT "ck_job_collection_runs_config_version_positive" CHECK ("job_collection_runs"."config_version" > 0),
	CONSTRAINT "ck_job_collection_runs_fencing_epoch_positive" CHECK ("job_collection_runs"."fencing_epoch" > 0),
	CONSTRAINT "ck_job_collection_runs_terminal_pair" CHECK (("job_collection_runs"."outcome" = 'STARTED') = ("job_collection_runs"."ended_at" IS NULL)),
	CONSTRAINT "ck_job_collection_runs_running_has_lease" CHECK ("job_collection_runs"."outcome" <> 'STARTED' OR ("job_collection_runs"."owner_token" IS NOT NULL AND "job_collection_runs"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "ck_job_collection_runs_counts_nonneg" CHECK ("job_collection_runs"."received" >= 0 AND "job_collection_runs"."created" >= 0 AND "job_collection_runs"."revised" >= 0 AND "job_collection_runs"."unchanged" >= 0 AND "job_collection_runs"."duplicates" >= 0 AND "job_collection_runs"."invalid" >= 0 AND "job_collection_runs"."persistence_errors" >= 0),
	CONSTRAINT "ck_job_collection_runs_dispositions_bounded" CHECK ("job_collection_runs"."created" + "job_collection_runs"."revised" + "job_collection_runs"."unchanged" + "job_collection_runs"."duplicates" + "job_collection_runs"."invalid" + "job_collection_runs"."persistence_errors" <= "job_collection_runs"."received"),
	CONSTRAINT "ck_job_collection_runs_succeeded_complete" CHECK ("job_collection_runs"."outcome" <> 'SUCCEEDED' OR ("job_collection_runs"."persistence_errors" = 0 AND "job_collection_runs"."created" + "job_collection_runs"."revised" + "job_collection_runs"."unchanged" + "job_collection_runs"."duplicates" + "job_collection_runs"."invalid" = "job_collection_runs"."received")),
	CONSTRAINT "ck_job_collection_runs_error_message_bounded" CHECK ("job_collection_runs"."error_message" IS NULL OR length("job_collection_runs"."error_message") <= 500),
	CONSTRAINT "ck_job_collection_runs_error_code_format" CHECK ("job_collection_runs"."error_code" IS NULL OR "job_collection_runs"."error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

CREATE TABLE IF NOT EXISTS "job_account_meter_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meter_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"run_id" uuid,
	"cycle_id" uuid NOT NULL,
	"status" "job_meter_reservation_status" DEFAULT 'RESERVED' NOT NULL,
	"amount" bigint NOT NULL,
	"used_amount" bigint DEFAULT 0 NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "uq_job_account_meter_reservations_attempt" UNIQUE("meter_id","attempt_id"),
	CONSTRAINT "ck_job_account_meter_reservations_attempt_id_nonempty" CHECK ("job_account_meter_reservations"."attempt_id" ~ '[^[:space:]]'),
	CONSTRAINT "ck_job_account_meter_reservations_attempt_id_bounded" CHECK (length("job_account_meter_reservations"."attempt_id") <= 200),
	CONSTRAINT "ck_job_account_meter_reservations_amount_positive" CHECK ("job_account_meter_reservations"."amount" > 0),
	CONSTRAINT "ck_job_account_meter_reservations_used_within_amount" CHECK ("job_account_meter_reservations"."used_amount" >= 0 AND "job_account_meter_reservations"."used_amount" <= "job_account_meter_reservations"."amount"),
	CONSTRAINT "ck_job_account_meter_reservations_released_unused" CHECK ("job_account_meter_reservations"."status" <> 'RELEASED' OR "job_account_meter_reservations"."used_amount" = 0),
	CONSTRAINT "ck_job_account_meter_reservations_sent_pair" CHECK ("job_account_meter_reservations"."status" IN ('RESERVED', 'RELEASED') OR "job_account_meter_reservations"."sent_at" IS NOT NULL),
	CONSTRAINT "ck_job_account_meter_reservations_released_unsent" CHECK ("job_account_meter_reservations"."status" <> 'RELEASED' OR "job_account_meter_reservations"."sent_at" IS NULL),
	CONSTRAINT "ck_job_account_meter_reservations_used_settled" CHECK ("job_account_meter_reservations"."status" <> 'USED' OR ("job_account_meter_reservations"."settled_at" IS NOT NULL AND "job_account_meter_reservations"."used_amount" > 0))
);

CREATE TABLE IF NOT EXISTS "job_dirty_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_kind" "job_dirty_work_entity_kind" NOT NULL,
	"entity_id" uuid NOT NULL,
	"target_version" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" "job_dirty_work_status" DEFAULT 'PENDING' NOT NULL,
	"claim_owner" text,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"fencing_epoch" bigint DEFAULT 1 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cycle_id" uuid,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "uq_job_dirty_work_entity_target" UNIQUE("entity_kind","entity_id","target_version","reason"),
	CONSTRAINT "ck_job_dirty_work_target_version_positive" CHECK ("job_dirty_work"."target_version" > 0),
	CONSTRAINT "ck_job_dirty_work_reason_nonempty" CHECK ("job_dirty_work"."reason" ~ '[^[:space:]]'),
	CONSTRAINT "ck_job_dirty_work_reason_bounded" CHECK (length("job_dirty_work"."reason") <= 100),
	CONSTRAINT "ck_job_dirty_work_claim_owner_bounded" CHECK ("job_dirty_work"."claim_owner" IS NULL OR length("job_dirty_work"."claim_owner") <= 200),
	CONSTRAINT "ck_job_dirty_work_checkpoint_bounded" CHECK (jsonb_typeof("job_dirty_work"."checkpoint") = 'object' AND length("job_dirty_work"."checkpoint"::text) <= 8192),
	CONSTRAINT "ck_job_dirty_work_retry_count_nonneg" CHECK ("job_dirty_work"."retry_count" >= 0),
	CONSTRAINT "ck_job_dirty_work_fencing_epoch_positive" CHECK ("job_dirty_work"."fencing_epoch" > 0),
	CONSTRAINT "ck_job_dirty_work_claim_pair" CHECK (("job_dirty_work"."status" = 'CLAIMED' AND "job_dirty_work"."claim_owner" IS NOT NULL AND "job_dirty_work"."lease_expires_at" IS NOT NULL)
          OR ("job_dirty_work"."status" <> 'CLAIMED' AND "job_dirty_work"."claim_owner" IS NULL AND "job_dirty_work"."lease_expires_at" IS NULL)),
	CONSTRAINT "ck_job_dirty_work_last_error_code_format" CHECK ("job_dirty_work"."last_error_code" IS NULL OR "job_dirty_work"."last_error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "ck_job_dirty_work_terminal_pair" CHECK (("job_dirty_work"."status" IN ('DONE', 'FAILED', 'DEFERRED')) = ("job_dirty_work"."completed_at" IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- What HR and ADMIN do with it (schema/job-queue.ts)
-- ---------------------------------------------------------------------------
--
-- The cross-team disclosure surface of the store. Every scoped row carries
-- scope_kind + team_id with a CHECK making a TEAM scope name exactly one team and a STUDIO
-- scope name none, so a scoped read always has a column to filter on. What the schema
-- cannot see is the ACTOR'S ROLE — those remain Phase-6 service obligations, enumerated per
-- table in schema/job-queue.ts. Note also what this file does NOT create: the append-only
-- and immutability triggers for job_queue_actions and job_queue_generation_entries. See the
-- header.

CREATE TABLE IF NOT EXISTS "job_queue_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"state" "job_queue_assignment_state" DEFAULT 'TAKEN' NOT NULL,
	"scope_kind" "job_queue_scope_kind" NOT NULL,
	"team_id" uuid,
	"assignee_id" uuid NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"release_reason" text,
	"reassigned_at" timestamp with time zone,
	"reassigned_by" uuid,
	"reassigned_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_job_queue_assignments_opportunity" UNIQUE("opportunity_id"),
	CONSTRAINT "ck_job_queue_assignments_scope_shape" CHECK (("job_queue_assignments"."scope_kind" = 'TEAM' AND "job_queue_assignments"."team_id" IS NOT NULL) OR ("job_queue_assignments"."scope_kind" = 'STUDIO' AND "job_queue_assignments"."team_id" IS NULL)),
	CONSTRAINT "ck_job_queue_assignments_version_positive" CHECK ("job_queue_assignments"."version" > 0),
	CONSTRAINT "ck_job_queue_assignments_release_pair" CHECK (("job_queue_assignments"."state" = 'TAKEN' AND "job_queue_assignments"."released_at" IS NULL AND "job_queue_assignments"."released_by" IS NULL AND "job_queue_assignments"."release_reason" IS NULL)
          OR ("job_queue_assignments"."state" = 'RELEASED' AND "job_queue_assignments"."released_at" IS NOT NULL AND "job_queue_assignments"."released_by" IS NOT NULL)),
	CONSTRAINT "ck_job_queue_assignments_release_reason_bounded" CHECK ("job_queue_assignments"."release_reason" IS NULL OR ("job_queue_assignments"."release_reason" ~ '[^[:space:]]' AND length("job_queue_assignments"."release_reason") <= 500)),
	CONSTRAINT "ck_job_queue_assignments_reassign_triple" CHECK (("job_queue_assignments"."reassigned_at" IS NULL AND "job_queue_assignments"."reassigned_by" IS NULL AND "job_queue_assignments"."reassigned_from_id" IS NULL)
          OR ("job_queue_assignments"."reassigned_at" IS NOT NULL AND "job_queue_assignments"."reassigned_by" IS NOT NULL AND "job_queue_assignments"."reassigned_from_id" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "job_queue_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"scope_kind" "job_queue_scope_kind" NOT NULL,
	"team_id" uuid,
	"reason" text NOT NULL,
	"dismissed_by" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_job_queue_dismissals_opportunity_scope" UNIQUE NULLS NOT DISTINCT("opportunity_id","scope_kind","team_id"),
	CONSTRAINT "ck_job_queue_dismissals_scope_shape" CHECK (("job_queue_dismissals"."scope_kind" = 'TEAM' AND "job_queue_dismissals"."team_id" IS NOT NULL) OR ("job_queue_dismissals"."scope_kind" = 'STUDIO' AND "job_queue_dismissals"."team_id" IS NULL)),
	CONSTRAINT "ck_job_queue_dismissals_version_positive" CHECK ("job_queue_dismissals"."version" > 0),
	CONSTRAINT "ck_job_queue_dismissals_reason_bounded" CHECK ("job_queue_dismissals"."reason" ~ '[^[:space:]]' AND length("job_queue_dismissals"."reason") <= 500),
	CONSTRAINT "ck_job_queue_dismissals_undo_pair" CHECK (("job_queue_dismissals"."undone_at" IS NULL AND "job_queue_dismissals"."undone_by" IS NULL) OR ("job_queue_dismissals"."undone_at" IS NOT NULL AND "job_queue_dismissals"."undone_by" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "job_team_triage_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"role_family" text NOT NULL,
	"source_types" "job_source_type"[] DEFAULT '{}'::job_source_type[] NOT NULL,
	"policy_version" integer NOT NULL,
	"subscription_version" integer DEFAULT 1 NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_job_team_triage_subscriptions_role_family_bounded" CHECK ("job_team_triage_subscriptions"."role_family" ~ '[^[:space:]]' AND length("job_team_triage_subscriptions"."role_family") <= 100),
	CONSTRAINT "ck_job_team_triage_subscriptions_source_types_bounded" CHECK (cardinality("job_team_triage_subscriptions"."source_types") <= cardinality(enum_range(NULL::job_source_type))),
	CONSTRAINT "ck_job_team_triage_subscriptions_source_types_shape" CHECK (CASE WHEN COALESCE(array_ndims("job_team_triage_subscriptions"."source_types"), 1) <> 1 THEN false ELSE array_position("job_team_triage_subscriptions"."source_types", NULL) IS NULL END),
	CONSTRAINT "ck_job_team_triage_subscriptions_policy_version_nonneg" CHECK ("job_team_triage_subscriptions"."policy_version" >= 0),
	CONSTRAINT "ck_job_team_triage_subscriptions_version_positive" CHECK ("job_team_triage_subscriptions"."subscription_version" > 0),
	CONSTRAINT "ck_job_team_triage_subscriptions_reason_bounded" CHECK ("job_team_triage_subscriptions"."reason" ~ '[^[:space:]]' AND length("job_team_triage_subscriptions"."reason") <= 500),
	CONSTRAINT "ck_job_team_triage_subscriptions_revoke_triple" CHECK (("job_team_triage_subscriptions"."revoked_at" IS NULL AND "job_team_triage_subscriptions"."revoked_by" IS NULL AND "job_team_triage_subscriptions"."revoke_reason" IS NULL)
          OR ("job_team_triage_subscriptions"."revoked_at" IS NOT NULL AND "job_team_triage_subscriptions"."revoked_by" IS NOT NULL AND "job_team_triage_subscriptions"."revoke_reason" IS NOT NULL AND "job_team_triage_subscriptions"."revoke_reason" ~ '[^[:space:]]' AND length("job_team_triage_subscriptions"."revoke_reason") <= 500))
);

CREATE TABLE IF NOT EXISTS "job_queue_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "job_queue_action_kind" NOT NULL,
	"opportunity_id" uuid,
	"source_record_id" uuid,
	"subscription_id" uuid,
	"actor_id" uuid NOT NULL,
	"scope_kind" "job_queue_scope_kind" NOT NULL,
	"team_id" uuid,
	"subject_team_id" uuid,
	"subject_user_id" uuid,
	"before_version" integer,
	"after_version" integer,
	"idempotency_key" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_job_queue_actions_actor_idempotency" UNIQUE("actor_id","idempotency_key"),
	CONSTRAINT "ck_job_queue_actions_scope_shape" CHECK (("job_queue_actions"."scope_kind" = 'TEAM' AND "job_queue_actions"."team_id" IS NOT NULL) OR ("job_queue_actions"."scope_kind" = 'STUDIO' AND "job_queue_actions"."team_id" IS NULL)),
	CONSTRAINT "ck_job_queue_actions_target" CHECK (("job_queue_actions"."kind" IN ('TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED') AND "job_queue_actions"."opportunity_id" IS NULL AND "job_queue_actions"."subscription_id" IS NOT NULL AND "job_queue_actions"."source_record_id" IS NULL)
          OR ("job_queue_actions"."kind" NOT IN ('TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED') AND "job_queue_actions"."opportunity_id" IS NOT NULL AND "job_queue_actions"."subscription_id" IS NULL)),
	CONSTRAINT "ck_job_queue_actions_clicked_source" CHECK ("job_queue_actions"."kind" NOT IN ('OPENED', 'DEAD_LINK', 'SPAM') OR "job_queue_actions"."source_record_id" IS NOT NULL),
	CONSTRAINT "ck_job_queue_actions_subject_team" CHECK (("job_queue_actions"."kind" IN ('TRIAGE_GRANTED', 'TRIAGE_REVOKED', 'TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED') AND "job_queue_actions"."subject_team_id" IS NOT NULL)
          OR ("job_queue_actions"."kind" NOT IN ('TRIAGE_GRANTED', 'TRIAGE_REVOKED', 'TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED') AND "job_queue_actions"."subject_team_id" IS NULL)),
	CONSTRAINT "ck_job_queue_actions_subject_user" CHECK (("job_queue_actions"."kind" = 'REASSIGNED' AND "job_queue_actions"."subject_user_id" IS NOT NULL)
          OR ("job_queue_actions"."kind" <> 'REASSIGNED' AND "job_queue_actions"."subject_user_id" IS NULL)),
	CONSTRAINT "ck_job_queue_actions_versions" CHECK (("job_queue_actions"."kind" IN ('OPENED', 'DEAD_LINK', 'SPAM') AND "job_queue_actions"."before_version" IS NULL AND "job_queue_actions"."after_version" IS NULL)
          OR ("job_queue_actions"."kind" = 'SUPPRESSED' AND "job_queue_actions"."before_version" IS NULL AND "job_queue_actions"."after_version" IS NULL)
          OR ("job_queue_actions"."kind" NOT IN ('OPENED', 'DEAD_LINK', 'SPAM') AND "job_queue_actions"."before_version" IS NOT NULL AND "job_queue_actions"."after_version" IS NOT NULL AND "job_queue_actions"."before_version" >= 0 AND "job_queue_actions"."after_version" > "job_queue_actions"."before_version")),
	CONSTRAINT "ck_job_queue_actions_idempotency_key_bounded" CHECK ("job_queue_actions"."idempotency_key" ~ '[^[:space:]]' AND length("job_queue_actions"."idempotency_key") <= 200),
	CONSTRAINT "ck_job_queue_actions_reason_bounded" CHECK ("job_queue_actions"."reason" IS NULL OR ("job_queue_actions"."reason" ~ '[^[:space:]]' AND length("job_queue_actions"."reason") <= 500))
);

CREATE TABLE IF NOT EXISTS "job_queue_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_kind" "job_queue_scope_kind" NOT NULL,
	"team_id" uuid,
	"policy_signature" text NOT NULL,
	"rule_version" text NOT NULL,
	"status" "job_queue_generation_status" DEFAULT 'BUILDING' NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_job_queue_generations_scope_shape" CHECK (("job_queue_generations"."scope_kind" = 'TEAM' AND "job_queue_generations"."team_id" IS NOT NULL) OR ("job_queue_generations"."scope_kind" = 'STUDIO' AND "job_queue_generations"."team_id" IS NULL)),
	CONSTRAINT "ck_job_queue_generations_status_instants" CHECK (("job_queue_generations"."status" = 'BUILDING' AND "job_queue_generations"."published_at" IS NULL AND "job_queue_generations"."invalidated_at" IS NULL)
          OR ("job_queue_generations"."status" = 'PUBLISHED' AND "job_queue_generations"."published_at" IS NOT NULL AND "job_queue_generations"."invalidated_at" IS NULL)
          OR ("job_queue_generations"."status" = 'INVALIDATED' AND "job_queue_generations"."invalidated_at" IS NOT NULL)),
	CONSTRAINT "ck_job_queue_generations_expiry_after_evaluation" CHECK ("job_queue_generations"."expires_at" > "job_queue_generations"."evaluated_at"),
	CONSTRAINT "ck_job_queue_generations_policy_signature_bounded" CHECK ("job_queue_generations"."policy_signature" ~ '[^[:space:]]' AND length("job_queue_generations"."policy_signature") <= 200),
	CONSTRAINT "ck_job_queue_generations_rule_version_bounded" CHECK ("job_queue_generations"."rule_version" ~ '[^[:space:]]' AND length("job_queue_generations"."rule_version") <= 100)
);

CREATE TABLE IF NOT EXISTS "job_queue_generation_entries" (
	"generation_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"rank_score" integer NOT NULL,
	"order_key" integer NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"opportunity_revision" integer NOT NULL,
	CONSTRAINT "pk_job_queue_generation_entries" PRIMARY KEY("generation_id","opportunity_id"),
	CONSTRAINT "uq_job_queue_generation_entries_order" UNIQUE("generation_id","order_key"),
	CONSTRAINT "ck_job_queue_generation_entries_order_key_nonneg" CHECK ("job_queue_generation_entries"."order_key" >= 0),
	CONSTRAINT "ck_job_queue_generation_entries_revision_positive" CHECK ("job_queue_generation_entries"."opportunity_revision" > 0)
);

-- ---------------------------------------------------------------------------
-- 3. job_sources — the extension of the EXISTING source catalogue
-- ---------------------------------------------------------------------------
--
-- The one pre-existing table this store touches. The manifest columns carry the
-- source's declared identity and its policy / config versions; the readiness and
-- admin_state columns carry the operational state the collector reads. Rows that predate the
-- store (the 16 seeded by 2026-10-05_vacancy_sources_seed.sql, plus any an ADMIN added)
-- take the defaults: manifest_id NULL, namespace '', every version 1, readiness
-- CANDIDATE, admin_state ACTIVE, consecutive_failures 0, admin_state_history '[]'. That
-- is what makes all 11 CHECKs below validate against the existing data with no backfill
-- step — verified by applying this file to a database carrying that very seed.

ALTER TABLE job_sources
  ADD COLUMN IF NOT EXISTS "manifest_id" text,
  ADD COLUMN IF NOT EXISTS "namespace" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "manifest_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "policy_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "config_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "account_meter_id" uuid,
  ADD COLUMN IF NOT EXISTS "readiness" "job_source_readiness" DEFAULT 'CANDIDATE' NOT NULL,
  ADD COLUMN IF NOT EXISTS "readiness_reason" text,
  ADD COLUMN IF NOT EXISTS "admin_state" "job_source_admin_state" DEFAULT 'ACTIVE' NOT NULL,
  ADD COLUMN IF NOT EXISTS "admin_state_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_success_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_nonempty_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "cooldown_until" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "consecutive_failures" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "last_error_code" text,
  ADD COLUMN IF NOT EXISTS "last_error_message" text;

DO $$ BEGIN
  ALTER TABLE job_sources ADD CONSTRAINT "ck_job_sources_manifest_id_format" CHECK ("job_sources"."manifest_id" IS NULL OR "job_sources"."manifest_id" ~ '^[a-z0-9][a-z0-9._:-]{0,99}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE job_sources ADD CONSTRAINT "ck_job_sources_manifest_id_segmented" CHECK ("job_sources"."manifest_id" IS NULL OR "job_sources"."manifest_id" !~ '[a-z0-9]{24}');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE job_sources ADD CONSTRAINT "ck_job_sources_namespace_bounded" CHECK (length("job_sources"."namespace") <= 200);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE job_sources ADD CONSTRAINT "ck_job_sources_versions_positive" CHECK ("job_sources"."manifest_version" > 0 AND "job_sources"."policy_version" > 0 AND "job_sources"."config_version" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE job_sources ADD CONSTRAINT "ck_job_sources_consecutive_failures_nonneg" CHECK ("job_sources"."consecutive_failures" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE job_sources ADD CONSTRAINT "ck_job_sources_blocked_has_reason" CHECK ("job_sources"."readiness" <> 'BLOCKED' OR "job_sources"."readiness_reason" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE job_sources ADD CONSTRAINT "ck_job_sources_last_error_bounded" CHECK ("job_sources"."last_error_message" IS NULL OR length("job_sources"."last_error_message") <= 500);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE job_sources ADD CONSTRAINT "ck_job_sources_last_error_code_format" CHECK ("job_sources"."last_error_code" IS NULL OR "job_sources"."last_error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE job_sources ADD CONSTRAINT "ck_job_sources_readiness_reason_bounded" CHECK ("job_sources"."readiness_reason" IS NULL OR length("job_sources"."readiness_reason") <= 500);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE job_sources ADD CONSTRAINT "ck_job_sources_config_bounded" CHECK (jsonb_typeof("job_sources"."config") = 'object' AND length("job_sources"."config"::text) <= 8192);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE job_sources ADD CONSTRAINT "ck_job_sources_admin_state_history_array" CHECK (jsonb_typeof("job_sources"."admin_state_history") = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Foreign keys (45), guarded
-- ---------------------------------------------------------------------------
--
-- Declared apart from the tables so the 18 CREATE TABLE statements above have no
-- order dependency between them. The ON DELETE action is per relation and carries
-- meaning: RESTRICT on every parent of the action log (no parent delete may erase audit
-- rows through a cascade), CASCADE where the child has no life of its own (a generation's
-- entries), SET NULL where the reference is provenance rather than structure.

DO $$ BEGIN
  ALTER TABLE "job_account_meter_reservations" ADD CONSTRAINT "fk_job_account_meter_reservations_cycle" FOREIGN KEY ("cycle_id") REFERENCES "job_collection_cycles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_account_meter_reservations" ADD CONSTRAINT "fk_job_account_meter_reservations_meter" FOREIGN KEY ("meter_id") REFERENCES "job_account_meters"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_account_meter_reservations" ADD CONSTRAINT "fk_job_account_meter_reservations_run" FOREIGN KEY ("run_id") REFERENCES "job_collection_runs"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_account_meter_reservations" ADD CONSTRAINT "fk_job_account_meter_reservations_run_cycle" FOREIGN KEY ("run_id","cycle_id") REFERENCES "job_collection_runs"("id","cycle_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_collection_cycles" ADD CONSTRAINT "fk_job_collection_cycles_html_meter" FOREIGN KEY ("html_call_meter_id") REFERENCES "job_account_meters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_collection_cycles" ADD CONSTRAINT "fk_job_collection_cycles_requested_by" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_collection_runs" ADD CONSTRAINT "fk_job_collection_runs_cycle" FOREIGN KEY ("cycle_id") REFERENCES "job_collection_cycles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_collection_runs" ADD CONSTRAINT "fk_job_collection_runs_cycle_trigger" FOREIGN KEY ("cycle_id","trigger") REFERENCES "job_collection_cycles"("id","trigger") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_collection_runs" ADD CONSTRAINT "fk_job_collection_runs_source" FOREIGN KEY ("source_id") REFERENCES "job_sources"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_dirty_work" ADD CONSTRAINT "fk_job_dirty_work_cycle" FOREIGN KEY ("cycle_id") REFERENCES "job_collection_cycles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_opportunities" ADD CONSTRAINT "job_opportunities_description_sha256_job_text_blobs_sha256_fk" FOREIGN KEY ("description_sha256") REFERENCES "job_text_blobs"("sha256") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_opportunity_matches" ADD CONSTRAINT "job_opportunity_matches_opportunity_id_job_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "job_opportunities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_opportunity_matches" ADD CONSTRAINT "job_opportunity_matches_senior_id_users_id_fk" FOREIGN KEY ("senior_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_opportunity_sources" ADD CONSTRAINT "fk_job_opportunity_sources_opportunity" FOREIGN KEY ("opportunity_id") REFERENCES "job_opportunities"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_opportunity_sources" ADD CONSTRAINT "fk_job_opportunity_sources_record" FOREIGN KEY ("source_record_id") REFERENCES "job_source_records"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_opportunity_team_triage" ADD CONSTRAINT "fk_job_opportunity_team_triage_opportunity" FOREIGN KEY ("opportunity_id") REFERENCES "job_opportunities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_opportunity_team_triage" ADD CONSTRAINT "job_opportunity_team_triage_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_opportunity_team_triage" ADD CONSTRAINT "job_opportunity_team_triage_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_actions" ADD CONSTRAINT "fk_job_queue_actions_actor" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_actions" ADD CONSTRAINT "fk_job_queue_actions_opportunity" FOREIGN KEY ("opportunity_id") REFERENCES "job_opportunities"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_actions" ADD CONSTRAINT "fk_job_queue_actions_source_record" FOREIGN KEY ("source_record_id") REFERENCES "job_source_records"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_actions" ADD CONSTRAINT "fk_job_queue_actions_subject_team" FOREIGN KEY ("subject_team_id") REFERENCES "teams"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_actions" ADD CONSTRAINT "fk_job_queue_actions_subject_user" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_actions" ADD CONSTRAINT "fk_job_queue_actions_subscription" FOREIGN KEY ("subscription_id") REFERENCES "job_team_triage_subscriptions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_actions" ADD CONSTRAINT "fk_job_queue_actions_team" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_assignments" ADD CONSTRAINT "fk_job_queue_assignments_assignee" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_assignments" ADD CONSTRAINT "fk_job_queue_assignments_opportunity" FOREIGN KEY ("opportunity_id") REFERENCES "job_opportunities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_assignments" ADD CONSTRAINT "fk_job_queue_assignments_reassigned_by" FOREIGN KEY ("reassigned_by") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_assignments" ADD CONSTRAINT "fk_job_queue_assignments_reassigned_from" FOREIGN KEY ("reassigned_from_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_assignments" ADD CONSTRAINT "fk_job_queue_assignments_released_by" FOREIGN KEY ("released_by") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_assignments" ADD CONSTRAINT "fk_job_queue_assignments_team" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_dismissals" ADD CONSTRAINT "fk_job_queue_dismissals_dismissed_by" FOREIGN KEY ("dismissed_by") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_dismissals" ADD CONSTRAINT "fk_job_queue_dismissals_opportunity" FOREIGN KEY ("opportunity_id") REFERENCES "job_opportunities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_dismissals" ADD CONSTRAINT "fk_job_queue_dismissals_team" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_dismissals" ADD CONSTRAINT "fk_job_queue_dismissals_undone_by" FOREIGN KEY ("undone_by") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_generation_entries" ADD CONSTRAINT "fk_job_queue_generation_entries_generation" FOREIGN KEY ("generation_id") REFERENCES "job_queue_generations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_generation_entries" ADD CONSTRAINT "fk_job_queue_generation_entries_opportunity" FOREIGN KEY ("opportunity_id") REFERENCES "job_opportunities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_queue_generations" ADD CONSTRAINT "fk_job_queue_generations_team" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_source_record_revisions" ADD CONSTRAINT "fk_job_source_record_revisions_description" FOREIGN KEY ("description_sha256") REFERENCES "job_text_blobs"("sha256") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_source_record_revisions" ADD CONSTRAINT "fk_job_source_record_revisions_record" FOREIGN KEY ("source_record_id") REFERENCES "job_source_records"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_source_records" ADD CONSTRAINT "fk_job_source_records_latest_revision" FOREIGN KEY ("latest_revision_id") REFERENCES "job_source_record_revisions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_sources" ADD CONSTRAINT "fk_job_sources_account_meter" FOREIGN KEY ("account_meter_id") REFERENCES "job_account_meters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_team_triage_subscriptions" ADD CONSTRAINT "fk_job_team_triage_subscriptions_actor" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_team_triage_subscriptions" ADD CONSTRAINT "fk_job_team_triage_subscriptions_revoked_by" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "job_team_triage_subscriptions" ADD CONSTRAINT "fk_job_team_triage_subscriptions_team" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
