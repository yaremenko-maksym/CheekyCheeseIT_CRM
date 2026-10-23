-- =============================================================================
-- job_queue_actions — the reason redaction becomes callable (r5 Task 1.4b-iii),
-- prod upgrade DDL for the function signature
-- =============================================================================
--
-- WHY THIS FILE EXISTS
-- --------------------
-- `crm_retention_redact_action_reason` gains a third argument, `p_actor_id uuid`, so the
-- `REASON_REDACTED` evidence row it now appends can name the person who triggered the
-- erasure (owner decision, 2026-10-22: the actor is a parameter; `actor_id` stays NOT
-- NULL; no service principal). `CREATE OR REPLACE FUNCTION` cannot change an argument
-- list: run against a database that has the two-argument function, it creates a SECOND
-- overload and leaves the first one in place — owned by `crm_retention_owner`, EXECUTE
-- granted to `crm_app`, and, once the grants this task adds land, able to redact a reason
-- WITHOUT appending evidence. So an existing database needs an explicit `DROP FUNCTION`
-- of the old signature, which is what this file does.
--
-- WHY IT RUNS BEFORE THE GRANTS FILE, AND NOT ONLY THE TRIGGERS FILE
-- -----------------------------------------------------------------
-- `2026-10-18_job_queue_append_only_triggers.sql` performs the same DROP + CREATE (it is
-- re-applied on every deploy and must converge any database on its own). But the deploy
-- applies it AFTER `2026-10-18_db_grants.sql`, and the grants file is what gives
-- `crm_retention_owner` `UPDATE (reason)` and `INSERT`. Relying on the triggers file
-- alone leaves a window — between the grants COMMIT and the triggers COMMIT — in which
-- the OLD two-argument function is callable with the new privileges and redacts without
-- evidence. Applying this file BEFORE the grants file closes that window: by the time
-- the privilege exists, the only function that can use it is the one that writes the
-- evidence row.
--
-- WHAT IT DOES — ONE TRANSACTION, ADR §3's SIX CONDITIONS RE-APPLIED
-- ------------------------------------------------------------------
--   DROP the old signature (IF EXISTS — a no-op on every apply after the first), CREATE
--   the new one, then (1) OWNER TO crm_retention_owner, (2) the pinned
--   `SET search_path = pg_catalog, public, pg_temp` (in the CREATE), (3) static SQL in the
--   body, (4) REVOKE ALL FROM PUBLIC + GRANT EXECUTE TO crm_app by name. (5) is the
--   trigger's, and (6) the catalog check's — it pins the signature, prosecdef, proowner,
--   proconfig, proacl and the body md5, and the body below is BYTE-IDENTICAL to the
--   triggers file's, so one pinned md5 covers both copies and a drift between them fails
--   the deploy. `CREATE FUNCTION` defaults EXECUTE to PUBLIC; inside this transaction no
--   other session can observe that default before the REVOKE commits with it.
--
-- IDEMPOTENCY. Every deploy re-applies every manual file. DROP ... IF EXISTS of the OLD
-- signature, CREATE OR REPLACE of the NEW one, ALTER OWNER, REVOKE, GRANT: each converges.
-- The CHECK at the end converges too, but CONDITIONALLY rather than by repetition — see
-- its own section for why an unconditional drop-and-add was wrong here and what the
-- conditional form still guarantees.
--
-- Order: AFTER `2026-10-18_db_roles.sql` (the owner and grantee roles) and AFTER
-- `2026-10-21_job_queue_reason_redacted.sql` (the enum value and the CHECK branches the
-- evidence row needs); BEFORE `2026-10-18_db_grants.sql`. The precondition below refuses
-- to apply, with nothing changed, if a role is missing.
--
-- MUST NOT SHARE A TRANSACTION WITH 2026-10-21_job_queue_reason_redacted.sql
-- --------------------------------------------------------------------------
-- The sibling file states this about itself, for the enum value it ADDS. This file states
-- it about itself for a different reason, and the distinction is the point: it does NOT add
-- the enum value, but it USES the `'REASON_REDACTED'` literal — in the CHECK predicate at
-- the end, which resolves the label against the type at `ADD CONSTRAINT` time. A new enum
-- value cannot be used in the transaction that added it, so if the two files run inside one
-- transaction, the label is uncommitted when this file needs it.
--
-- MEASURED, not inferred from the sibling's header (PostgreSQL 16.15, 2026-10-23, scratch
-- database restored to the production catalog shape — the enum WITHOUT the label, which is
-- the only state in which this question has an answer; on a fresh database the sibling's
-- `ADD VALUE IF NOT EXISTS` is a no-op and nothing can fail):
--   * both files concatenated under `psql -1` -> the SIBLING fails first, at its own first
--     `ADD CONSTRAINT`:
--       ERROR:  unsafe use of new value "REASON_REDACTED" of enum type job_queue_action_kind
--       HINT:  New enum values must be committed before they can be used.
--   * `ALTER TYPE ... ADD VALUE` + THIS FILE alone under `psql -1`, i.e. the case the
--     sibling's header does not cover -> THIS file fails, at its own
--     `ADD CONSTRAINT ck_job_queue_actions_redaction_reason_null`, with the same error and
--     hint. Everything before it succeeded, including `CREATE FUNCTION`: a literal inside a
--     plpgsql body is not resolved at creation time, so the function is NOT the exposed
--     statement — the CHECK is.
-- Both failures are loud and atomic; nothing is left half-applied. `deploy.yml` and
-- `scripts/devops/deploy-stack-on-vps.sh` apply each file as
-- `psql -v ON_ERROR_STOP=1 < file` (statement-level autocommit, one file per session), so
-- the sibling's `ALTER TYPE` has committed long before this file opens its transaction.
--
-- This file's OWN `BEGIN`/`COMMIT` is therefore not in tension with any of the above: it
-- groups drop + create + revoke + grant so no session sees the function with default PUBLIC
-- EXECUTE, and by the time it runs the enum label is already committed. What is forbidden
-- is a transaction SPANNING this file and the sibling, which is exactly what `psql -1` over
-- both would create.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-10-22_job_queue_redaction_callable.sql
-- =============================================================================

BEGIN;

-- Same bound and the same reasoning as the triggers file: nothing should hold a lock on
-- a function this file replaces, so any wait at all is a reason to stop the deploy.
SET LOCAL lock_timeout = '5s';

DO $precondition$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crm_retention_owner') THEN
    missing := missing || 'crm_retention_owner'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crm_app') THEN
    missing := missing || 'crm_app'::text;
  END IF;

  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION
      'r5 Task 1.4b-iii cannot apply: required role(s) absent: %', array_to_string(missing, ', ')
      USING
        ERRCODE = 'undefined_object',
        HINT = 'Apply apps/api/drizzle/manual/2026-10-18_db_roles.sql FIRST. Nothing has '
               'been changed by this run.';
  END IF;
END
$precondition$;

DROP FUNCTION IF EXISTS public.crm_retention_redact_action_reason(uuid, text);

CREATE OR REPLACE FUNCTION public.crm_retention_redact_action_reason(
  p_action_id uuid,
  p_request_id text,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  subject_scope job_queue_actions.scope_kind%TYPE;
  subject_team  job_queue_actions.team_id%TYPE;
BEGIN
  IF p_action_id IS NULL THEN
    RAISE EXCEPTION 'crm_retention_redact_action_reason: action id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The person who triggered the erasure (owner decision, 2026-10-22). Checked here so
  -- the refusal names the argument rather than the NOT NULL column it would hit.
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'crm_retention_redact_action_reason: actor id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Bounded and non-blank, per ADR condition 3. 163 is the 200-character bound of
  -- `idempotency_key` minus the 37 characters of ':' || <uuid> appended below, so a
  -- request id that passes here can never make the evidence row fail its own CHECK.
  IF p_request_id IS NULL OR p_request_id !~ '[^[:space:]]' OR length(p_request_id) > 163 THEN
    RAISE EXCEPTION
      'crm_retention_redact_action_reason: request id must be non-blank and at most 163 characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- PRINTABLE ONLY, because this value reaches the SERVER LOG through the RAISE LOG at
  -- the end of this function, and that log line is the evidence channel for a redaction
  -- (legal memo section 8 item 3). A newline in the request id does not merely add noise:
  -- it appends attacker-chosen LINES to the channel, each of which can be shaped like a
  -- genuine log entry, so the record of what was erased becomes forgeable by the caller
  -- who asked for the erasure. Rejected here rather than by a CHECK on `idempotency_key`
  -- for three reasons: the refusal names the ARGUMENT (a column CHECK would raise 23514
  -- naming a constraint, from a column `crm_app` also writes for ordinary queue actions);
  -- a new CHECK on that shared column would validate against every existing row and take
  -- ACCESS EXCLUSIVE on a table r5 is about to make busy; and the log is written from
  -- here, so the guard belongs where the sink is. Measured on 16.15 (2026-10-23):
  -- `[^[:print:]]` matches newline, carriage return, tab and ESC, and does not match an
  -- ordinary id, an id containing a space, or a printable non-ASCII character.
  IF p_request_id ~ '[^[:print:]]' THEN
    RAISE EXCEPTION
      'crm_retention_redact_action_reason: request id must contain only printable characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE job_queue_actions
     SET reason = '[REASON REDACTED]'
   WHERE id = p_action_id
     AND reason IS NOT NULL
     AND reason <> '[REASON REDACTED]'
  RETURNING scope_kind, team_id INTO subject_scope, subject_team;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- The evidence row, in the same call: if it cannot be written, the error aborts the
  -- call and the UPDATE above with it — there is no redacted reason without evidence.
  -- The scope is the SUBJECT's, copied (see the header: the right scope is an open owner
  -- decision, SR-M-3). `reason` is left NULL, which the CHECK requires (SR-M-5).
  INSERT INTO job_queue_actions
    (kind, subject_action_id, actor_id, scope_kind, team_id, idempotency_key)
  VALUES
    ('REASON_REDACTED', p_action_id, p_actor_id, subject_scope, subject_team,
     p_request_id || ':' || p_action_id::text);

  RAISE LOG 'crm_retention: redacted reason of job_queue_actions % (request %, actor %, session_user %)',
    p_action_id, p_request_id, p_actor_id, session_user;

  RETURN true;
END
$fn$;

ALTER FUNCTION public.crm_retention_redact_action_reason(uuid, text, uuid) OWNER TO crm_retention_owner;
REVOKE ALL ON FUNCTION public.crm_retention_redact_action_reason(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crm_retention_redact_action_reason(uuid, text, uuid) TO crm_app;

-- ---------------------------------------------------------------------------
-- SR-M-5 of PR #1075: the evidence row carries no free text of its own.
--
-- The fresh-create file (2026-10-17_job_opportunities_store.sql) declares this CHECK
-- inline in `CREATE TABLE IF NOT EXISTS`, which reaches a NEW database only: on one that
-- already has the table, the whole statement is skipped. This is the ALTER that carries it
-- to a deployed database. The predicate is narrower only for `REASON_REDACTED` rows, which
-- nothing wrote before this task, so the validating scan cannot fail on an existing row.
-- The table name is left unqualified, as in 2026-10-21_job_queue_reason_redacted.sql, so
-- the equivalence spec can apply this file inside a scratch schema.
--
-- CONDITIONAL, NOT AN UNCONDITIONAL DROP-AND-ADD (fix round 1 of PR #1095)
-- ------------------------------------------------------------------------
-- Every manual file is re-applied on EVERY deploy. An unconditional
-- `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` therefore took ACCESS EXCLUSIVE on
-- `job_queue_actions` and re-scanned the whole table every deploy, forever — free while
-- the table is empty, and contention with r5's writers once it is not.
--
-- The guard compares the constraint's CURRENT definition with the reviewed one and does
-- the drop-and-add only when they differ (which includes "absent"). That keeps the exact
-- property the forward-DDL equivalence spec checks and does NOT weaken it: both DDL paths
-- still end with byte-identical `pg_get_constraintdef`, and `convalidated` is still true
-- on both — a freshly added CHECK is validated (measured true on 16.15), and on the skip
-- path the constraint that is already there was validated when it was added. What the
-- guard removes is only the repetition.
--
-- It also keeps the CONVERGENCE that a drop-and-add buys and an `IF NOT EXISTS` would
-- lose: a definition changed by hand under this name is still repaired, because the
-- comparison is on the definition and not on the name.
--
-- WHY A TEXT COMPARISON IS SAFE HERE. `pg_get_constraintdef` schema-qualifies a type that
-- is not visible in the session's `search_path`. Both callers have it visible — the deploy
-- runs with `public` in `search_path`, and the equivalence spec sets `search_path` to its
-- scratch schema before applying this file — so both render the enum unqualified, which is
-- the text below (read back from 16.15, 2026-10-23). And the failure mode if that ever
-- stops holding is the SAFE one: a definition that does not compare equal is re-added, so
-- the guard degrades to the unconditional behaviour it replaced, never to a wrong or
-- missing constraint.
--
-- LOCK, stated because the sibling file states its own: on a deploy where the definition
-- is absent or differs, the `ADD CONSTRAINT` takes ACCESS EXCLUSIVE on
-- `job_queue_actions` and scans it (measured: `AccessExclusiveLock`), bounded by this
-- file's `lock_timeout = 5s`. On every other deploy — the steady state, which is all of
-- them after the first — the guard takes NO relation lock at all: the catalog probe reads
-- `pg_constraint` and nothing else (measured: zero `pg_locks` rows of locktype `relation`
-- for this table). That is the whole point of the guard.
-- ---------------------------------------------------------------------------
DO $redaction_reason_null$
DECLARE
  wanted CONSTANT text :=
    'CHECK (((kind <> ''REASON_REDACTED''::job_queue_action_kind) OR (reason IS NULL)))';
  actual text;
BEGIN
  SELECT pg_get_constraintdef(con.oid)
    INTO actual
    FROM pg_constraint con
   WHERE con.conrelid = 'job_queue_actions'::regclass
     AND con.conname = 'ck_job_queue_actions_redaction_reason_null';

  IF actual IS NOT DISTINCT FROM wanted THEN
    RAISE NOTICE
      'ck_job_queue_actions_redaction_reason_null already matches the reviewed definition; no lock taken';
    RETURN;
  END IF;

  IF actual IS NOT NULL THEN
    RAISE NOTICE
      'ck_job_queue_actions_redaction_reason_null differs from the reviewed definition (found %); re-adding', actual;
  END IF;

  ALTER TABLE "job_queue_actions" DROP CONSTRAINT IF EXISTS "ck_job_queue_actions_redaction_reason_null";
  ALTER TABLE "job_queue_actions" ADD CONSTRAINT "ck_job_queue_actions_redaction_reason_null" CHECK ("job_queue_actions"."kind" <> 'REASON_REDACTED' OR "job_queue_actions"."reason" IS NULL);
END
$redaction_reason_null$;

COMMIT;
