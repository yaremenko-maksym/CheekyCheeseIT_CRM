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
--
-- Order: AFTER `2026-10-18_db_roles.sql` (the owner and grantee roles) and AFTER
-- `2026-10-21_job_queue_reason_redacted.sql` (the enum value and the CHECK branches the
-- evidence row needs); BEFORE `2026-10-18_db_grants.sql`. The precondition below refuses
-- to apply, with nothing changed, if a role is missing.
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

COMMIT;
