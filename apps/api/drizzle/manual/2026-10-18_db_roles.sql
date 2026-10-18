-- 2026-10-18_db_roles.sql — the application roles (file 1 of ADR §4)
--
-- Specification: docs/architecture/2026-10-17-db-least-privilege-roles.md §1, §4
-- (Accepted 2026-10-17, PR #1018). Companion files, in apply order:
--   1. this file                          — roles, passwords, database/schema rules, default privileges
--   2. every other drizzle/manual/*.sql   — the schema itself
--   3. 2026-10-18_db_grants.sql           — the per-class grants (generated)
--   4. 2026-10-18_db_privileges_check.sql — the catalog check (generated); fails the deploy on drift
--
-- WHICH BRANCH OF ADR §4 STEP 0 PRODUCTION IS IN, AND ON WHICH VERSION
-- Measured on production by the orchestrator, 2026-10-18: `crm_user` has `rolsuper = t`
-- and is the ONLY role in the cluster, so production is step 0's **branch 1** — the simple
-- one. Every statement below is therefore applied by a superuser that also owns `crm_db`:
-- `log_min_error_statement` is settable, the `postgres` / `template1` revocations succeed,
-- the attribute-repair block can repair anything, and part 8 of the catalog check expects
-- ZERO membership rows (a superuser creating a role is not made a member of it). Being the
-- only role also means the three created here cannot collide with anything.
--
-- Production runs PostgreSQL **16.14**; the behaviours this file relies on were reproduced
-- on 16.15. Nothing used here is newer than 16.0 — `pg_auth_members.inherit_option` /
-- `set_option` and `createrole_self_grant` arrived in 16.0, and the rest
-- (`aclexplode`, `acldefault`, the `has_*_privilege` family, `ALTER DEFAULT PRIVILEGES FOR
-- ROLE CURRENT_USER`, `array_append`) predates 15. The one PostgreSQL 16 behaviour change
-- this file works around — that changing SUPERUSER / CREATEDB / REPLICATION / BYPASSRLS
-- requires holding the attribute — also landed in 16.0 and only affects branch 2, which
-- production is not in. So the 16.15-vs-16.14 gap carries no version risk here.
--
-- THIS FILE MUST BE APPLIED FIRST. Roles must exist before any file mentions them; the
-- grants file raises a named exception if it runs before this one.
--
-- Applied by deploy.yml as `psql -v ON_ERROR_STOP=1 < file`, re-applied on EVERY deploy,
-- with statement-level autocommit. Every statement below is therefore idempotent and
-- independently applicable: `CREATE ROLE` has no `IF NOT EXISTS`, so it is guarded by a
-- `DO` block, and every attribute is re-asserted rather than assumed, which makes the
-- re-apply the repair path for drift (ADR §4, "Rollback").
--
-- ============================================================================
-- PASSWORDS: HOW THEY GET IN HERE, AND THE THREE TRAPS THAT SHAPE IT
-- ============================================================================
-- A password must never reach a command line, a process list or the server log. ADR §4
-- names three traps; all three are closed by the same mechanism:
--
--   1. THE SERVER LOG. `log_min_error_statement` defaults to `error`, so a FAILING
--      statement is logged with its full text — an `ALTER ROLE … PASSWORD 'plain'` that
--      fails on a typo writes the password to the log. Closed twice over: this file never
--      carries a plain password (only a SCRAM-SHA-256 verifier, which Postgres stores as
--      given), and the verifier never appears in statement text either — it is read from
--      a parameter, so the logged text of a failing statement is the `DO` block, not the
--      secret. The `log_min_error_statement = panic` belt around the section is the third
--      layer, applied only there so that the rest of the file still logs its errors.
--
--   2. THE PROCESS LIST. Any value in argv is readable by any local user through `ps`.
--      So the verifier is NOT passed as `psql -v name=value` and NOT embedded in this
--      file: it arrives as a connection parameter, which travels over the wire.
--
--   3. `DO` BLOCKS. psql substitutes `:'var'` in ordinary statements but NOT inside a
--      `DO $$ … $$` body, so the ADR has the passwords set by plain statements after the
--      `DO` block, reading psql variables via `\getenv`.
--
-- DEVIATION FROM THE ADR, DELIBERATE, REPORTED TO THE OWNER: this file takes the verifier
-- from the GUC `crm_roles.*_verifier` rather than from a psql `\getenv` variable. The
-- reason is testability, and it is mechanical rather than aesthetic:
-- `database/manual-sql-statements.ts` — the splitter every forward-DDL spec uses, and the
-- only thing that applies a manual file the way psql does — REFUSES a file containing a
-- psql meta-command, because such a file cannot be verified by sending its statements to
-- the server. With `\getenv` this file would be the one manual file no spec can apply, and
-- the password path (ADR's own "not verified by running" row) would stay unproved. With
-- the GUC, `db-privileges.integration.spec.ts` applies these exact bytes and then logs in
-- with the password, which is the proof the ADR asks for. The three traps are closed at
-- least as well: a GUC value reaches the backend as a connection parameter, never argv,
-- and it is readable only by the session that set it.
--
-- HOW THE DEPLOY SETS IT (for the DevOps wiring — value by NAME, never by value):
--
--   PGOPTIONS="-c crm_roles.app_verifier=$APP_VERIFIER" \
--     docker compose exec -T -e PGOPTIONS postgres \
--       psql -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 \
--       < /opt/crm/apps/api/drizzle/manual/2026-10-18_db_roles.sql
--
-- `docker compose exec -e PGOPTIONS` (name only) takes the value from the calling
-- environment; `-e NAME=value` would put it on the host's process list, which is the trap.
-- Compute the verifier from the secret WITHOUT putting it in argv:
--
--   APP_VERIFIER="$(printf %s "$CRM_APP_DB_PASSWORD" | \
--     node apps/api/src/database/privileges/scram-verifier.cli.mjs)"
--
-- A verifier whose GUC is unset leaves that role's password UNTOUCHED. That is what lets
-- one file serve every rollout step: step 2 sets none, step 5 sets the app verifier,
-- step 8 adds the collector's. Rotation of either then becomes "change the secret, deploy".
--
-- WHY `crm_user`'s OWN PASSWORD IS NOT SET HERE (owner's decision, 2026-10-18, overriding
-- ADR §4 step 7)
-- -------------------------------------------------------------------------------------
-- An earlier revision of this file carried a third row rotating the migration role's own
-- password, inert until a CI secret existed. It is removed, and the removal is the safer
-- direction rather than the lazier one: THE DEPLOY CONNECTS TO THE DATABASE AS `crm_user`.
-- A rotation that fires the moment a secret appears therefore turns any divergence between
-- that secret and the stored password into a broken deploy — every subsequent one — and the
-- recovery needs machine access to the host, not another deploy. Worse, nothing exercises
-- the path until the day it locks the deploy out: the two application roles are proved by
-- logging in with them (`db-privileges.integration.spec.ts`), while the migration role's
-- rotation could only be proved by rotating the credential the test harness is using.
--
-- Rotating `crm_user` stays an explicit, deliberate owner step, done by hand with the
-- machine in reach. `generate-privilege-sql.spec.ts` asserts this file sets no password
-- but the two application roles', so the path cannot come back without that decision being
-- revisited.

-- ----------------------------------------------------------------------------
-- 0. Session settings
-- ----------------------------------------------------------------------------

-- PostgreSQL 16 automatically makes a non-superuser CREATEROLE creator a MEMBER of every
-- role it creates. `createrole_self_grant = ''` makes that grant carry neither INHERIT nor
-- SET — only ADMIN, which cannot be avoided because it is what lets the creator manage the
-- role. Reproduced on 16.15 (2026-10-18): with this empty, the row is
-- (admin_option=t, inherit_option=f, set_option=f); a superuser creator gets no row at all.
-- The ASSERTION is the guarantee, not this setting: holding ADMIN, the creator can re-grant
-- itself WITH SET at any time, so part 8 of the catalog check re-checks it on every deploy.
SET createrole_self_grant = '';

-- ----------------------------------------------------------------------------
-- 1. The roles themselves
-- ----------------------------------------------------------------------------
-- `crm_app`       — the API. Owns nothing, member of no role, not a superuser.
-- `crm_collector` — the collection worker (r5 Task 1.3). Created now so the catalog check
--                   covers it from the first deploy; it holds no password until ADR §4
--                   step 8, and a role with no password cannot authenticate at all.
-- `crm_retention_owner` — NOLOGIN owner of the two R-B retention functions (ADR §3).
--                   Task 1.3b adds the functions; the role exists first because they are
--                   owned by it.
--
-- Why each attribute, i.e. which attack it closes (ADR §1):
--   owns nothing   — ownership, not superuser, is what allows DISABLE TRIGGER, DROP
--                    TRIGGER, ALTER TABLE and re-granting.
--   NOSUPERUSER    — `session_replication_role` is superuser-settable, and it skips every
--                    trigger not in the ALWAYS state.
--   NOCREATEROLE   — otherwise the role could mint a more privileged one.
--   NOBYPASSRLS / NOREPLICATION / NOCREATEDB — nothing here needs them.
DO $roles$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT *
      FROM (VALUES
        ('crm_app', true),
        ('crm_collector', true),
        ('crm_retention_owner', false)
      ) AS v(rolname, can_login)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.rolname) THEN
      EXECUTE format('CREATE ROLE %I %s NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
                     r.rolname, CASE WHEN r.can_login THEN 'LOGIN' ELSE 'NOLOGIN' END);
      RAISE NOTICE 'created role %', r.rolname;
    END IF;
  END LOOP;
END
$roles$;

-- Re-assert the attributes on every deploy: this is the drift-repair path. A role granted
-- SUPERUSER or CREATEROLE by hand loses it here, before the catalog check fails the deploy
-- over it.
--
-- WHY THIS IS A DIFF AND NOT A FLAT `ALTER ROLE … WITH <every attribute>`
-- Measured on 16.15 (2026-10-18) by applying this file as a non-superuser CREATEROLE role,
-- i.e. step 0's branch 2, which the ADR calls "the plan as written": a flat re-assert FAILS
-- with `permission denied to alter role`, and the DETAIL names the rule —
--   "Only roles with the SUPERUSER attribute may change the SUPERUSER attribute"
-- and the same for CREATEDB, REPLICATION and BYPASSRLS. PostgreSQL 16 requires the altering
-- role to HOLD an attribute even to set it to NO. (LOGIN, INHERIT, NOCREATEROLE and
-- CONNECTION LIMIT were accepted.) So naming all six unconditionally would stop a branch-2
-- deploy at this statement — before anything was checked, and for a state that is already
-- correct, since `CREATE ROLE` above set it.
--
-- Issuing only the clauses that actually DIFFER from the catalog means: no statement at all
-- in the normal case, repair in branch 1 (the owner is a superuser and may change
-- anything), and in branch 2 repair of whatever the role is allowed to change plus a loud
-- WARNING for the rest. What the WARNING does not do, stated plainly: in branch 2 this file
-- CANNOT take SUPERUSER, CREATEDB, REPLICATION or BYPASSRLS away from an application role —
-- only the cluster's superuser can. The catalog check (part 7) fails the deploy on exactly
-- that state, so the condition is detected and reported; it is not silently repaired.
--
-- CONNECTION LIMIT, with the arithmetic rather than a round number: `DatabaseService` opens
-- one `pg` Pool with no `max`, i.e. pg's default of 10. A deploy recreates the API container
-- and the recreate can briefly overlap, so 10 x 2 = 20, plus 10 of headroom for an operator
-- session and a pool that has not finished draining. A limit that is too low is an outage,
-- so the headroom is deliberate.
--
-- NOLOGIN is what keeps `crm_retention_owner` off the network; CONNECTION LIMIT 0 is a
-- second layer that costs nothing and is assertable. Neither affects a SECURITY DEFINER
-- function running as its owner, which is the only way that role is ever used.
--
-- Keep in step with ROLES and CONNECTION_LIMITS in
-- src/database/privileges/privilege-classes.ts — the catalog check compares against them.
DO $attributes$
DECLARE
  r record;
  clauses text[];
BEGIN
  FOR r IN
    SELECT w.rolname, w.can_login, w.conn_limit, a.rolsuper, a.rolcreatedb, a.rolcreaterole,
           a.rolreplication, a.rolbypassrls, a.rolinherit, a.rolcanlogin, a.rolconnlimit
      FROM (VALUES
        ('crm_app', true, 30),
        ('crm_collector', true, 10),
        ('crm_retention_owner', false, 0)
      ) AS w(rolname, can_login, conn_limit)
      JOIN pg_roles a ON a.rolname = w.rolname
  LOOP
    -- `array_append` and not `||`: with an UNTYPED literal on the right, `text[] || 'x'`
    -- resolves to the array-with-array operator and fails with `malformed array literal`,
    -- while `text[] || format(…)` resolves to array-with-element because format() returns a
    -- typed text. So the `||` form works for some of these lines and not others — measured
    -- on 16.15 when the repair path first ran for real.
    clauses := ARRAY[]::text[];
    IF r.rolcanlogin <> r.can_login THEN
      clauses := array_append(clauses, CASE WHEN r.can_login THEN 'LOGIN' ELSE 'NOLOGIN' END);
    END IF;
    IF r.rolsuper THEN clauses := array_append(clauses, 'NOSUPERUSER'); END IF;
    IF r.rolcreatedb THEN clauses := array_append(clauses, 'NOCREATEDB'); END IF;
    IF r.rolcreaterole THEN clauses := array_append(clauses, 'NOCREATEROLE'); END IF;
    IF r.rolreplication THEN clauses := array_append(clauses, 'NOREPLICATION'); END IF;
    IF r.rolbypassrls THEN clauses := array_append(clauses, 'NOBYPASSRLS'); END IF;
    IF NOT r.rolinherit THEN clauses := array_append(clauses, 'INHERIT'); END IF;
    IF r.rolconnlimit <> r.conn_limit THEN
      clauses := array_append(clauses, format('CONNECTION LIMIT %s', r.conn_limit));
    END IF;

    IF cardinality(clauses) = 0 THEN
      CONTINUE;
    END IF;

    BEGIN
      EXECUTE format('ALTER ROLE %I WITH %s', r.rolname, array_to_string(clauses, ' '));
      RAISE NOTICE 'repaired attributes of %: %', r.rolname, array_to_string(clauses, ' ');
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE WARNING 'cannot repair attributes of % (% ) as % — a superuser must do it; the catalog check will fail the deploy until then',
          r.rolname, array_to_string(clauses, ' '), current_user;
    END;
  END LOOP;
END
$attributes$;

-- ----------------------------------------------------------------------------
-- 2. Passwords — see the header for the mechanism and the three traps
-- ----------------------------------------------------------------------------

-- The belt of trap 1, around this section only. Needs superuser; in step 0's branch 2
-- (`crm_user` is not a superuser) it is skipped, and the verifier-only rule carries the
-- guarantee on its own — which is why this is a NOTICE and not a failure.
DO $quiet$
BEGIN
  PERFORM set_config('log_min_error_statement', 'panic', false);
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'log_min_error_statement not settable by % — relying on the verifier-only rule', current_user;
END
$quiet$;

DO $passwords$
DECLARE
  r record;
  verifier text;
BEGIN
  FOR r IN
    SELECT *
      FROM (VALUES
        ('crm_app', 'crm_roles.app_verifier'),
        ('crm_collector', 'crm_roles.collector_verifier')
        -- The two application roles, and deliberately NOT the migration role: see the
        -- header, "WHY crm_user's OWN PASSWORD IS NOT SET HERE".
      ) AS v(rolname, parameter)
  LOOP
    verifier := NULLIF(current_setting(r.parameter, true), '');
    IF verifier IS NULL THEN
      RAISE NOTICE '% not set — password of % left unchanged', r.parameter, r.rolname;
      CONTINUE;
    END IF;
    -- A malformed value would otherwise be stored verbatim as the password, and the role
    -- could never log in again — with the cause invisible, since nothing may print it.
    IF verifier !~ '^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$' THEN
      RAISE EXCEPTION '% is not a SCRAM-SHA-256 verifier (got % characters) — compute it with scram-verifier.cli.mjs, do not pass a plain password',
        r.parameter, length(verifier)
        USING ERRCODE = '22023';
    END IF;
    EXECUTE format('ALTER ROLE %I PASSWORD %L', r.rolname, verifier);
    RAISE NOTICE 'password of % set from %', r.rolname, r.parameter;
  END LOOP;
END
$passwords$;

-- Drop the verifiers from the session, so nothing later in the deploy can read them back.
SELECT set_config('crm_roles.app_verifier', '', false) IS NOT NULL AS app_verifier_cleared,
       set_config('crm_roles.collector_verifier', '', false) IS NOT NULL AS collector_verifier_cleared;

DO $loud$
BEGIN
  PERFORM set_config('log_min_error_statement', 'error', false);
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
END
$loud$;

-- ----------------------------------------------------------------------------
-- 3. Database and schema
-- ----------------------------------------------------------------------------
-- `REVOKE ALL ON DATABASE` removes the implicit `CONNECT` and `TEMPORARY` that PUBLIC has
-- by default, then `CONNECT` is granted back by name. No `TEMPORARY` for either role: if
-- the API ever needs a temporary table, the grant is added by a PR that says why.
--
-- The database is named by `current_database()` rather than literally, so the same file is
-- correct on production (`crm_db`), on CI (`crm_ci`) and on every scratch database — the
-- ADR's rollout depends on this file being applied identically everywhere.
DO $database$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO crm_app, crm_collector', current_database());
END
$database$;

-- The OTHER databases of the cluster. Without this, `crm_app` can still connect to
-- `postgres` and create temporary tables there (ADR §2, "Database and schema").
-- `pg_hba.conf` (§4 step 7, [OWNER]) confines both roles to `crm_db` at the network layer
-- as well; this is the privilege layer of the same confinement.
--
-- Non-fatal on a permission error: in branch 2 `crm_user` may not own `template1`, and the
-- catalog check then fails loudly with the exact database and privilege. Failing HERE would
-- stop a branch-2 deploy at file 1, before anything is checked.
--
-- Attempted only where PUBLIC still HOLDS one of the two privileges. Without that
-- condition the statement is a no-op that is nevertheless refused for lack of privilege,
-- so branch 2 would warn on every deploy about a state a superuser had already fixed —
-- and a warning that fires when nothing is wrong is a warning nobody reads.
DO $others$
DECLARE
  d text;
BEGIN
  FOR d IN
    SELECT db.datname
      FROM pg_database db
     WHERE db.datname IN ('postgres', 'template1')
       AND db.datallowconn
       AND EXISTS (
         SELECT 1
           FROM aclexplode(COALESCE(db.datacl, acldefault('d', db.datdba))) a
          WHERE a.grantee = 0 AND a.privilege_type IN ('CONNECT', 'TEMPORARY')
       )
  LOOP
    BEGIN
      EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', d);
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE WARNING 'could not revoke PUBLIC CONNECT/TEMPORARY on database % as % — the catalog check will fail on this', d, current_user;
    END;
  END LOOP;
END
$others$;

-- `REVOKE CREATE ON SCHEMA public FROM PUBLIC` is already the default on a cluster
-- initialised by PostgreSQL 15 or later. Issued explicitly so the file is correct on any
-- cluster, including one restored from an older dump.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- `crm_retention_owner` gets USAGE but no CONNECT: privilege checks inside a SECURITY
-- DEFINER function run as the function's owner, so it needs to resolve names in `public`
-- even though it never connects.
GRANT USAGE ON SCHEMA public TO crm_app, crm_collector, crm_retention_owner;

-- ----------------------------------------------------------------------------
-- 4. Functions
-- ----------------------------------------------------------------------------
-- PostgreSQL grants `EXECUTE` on every new function to PUBLIC. A function the API must
-- call is granted to `crm_app` by name, in the PR that adds it (ADR §2, "Functions").
-- Firing a trigger does not check `EXECUTE` on the trigger function, so the append-only
-- triggers of §3 keep working. Built-ins live in `pg_catalog` and are untouched.
--
-- The WARNING first: a cluster that does carry an extension in `public` (pgcrypto, say)
-- would have its functions silently taken away from PUBLIC here, which could break a
-- column default. Verified 2026-10-18 on a database built by `db:push` from this
-- repository: zero functions and zero extensions in `public`, so the revoke is a no-op
-- today. The warning is what makes it loud if production differs.
DO $funcs$
DECLARE
  affected text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO affected
    FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
   WHERE p.pronamespace = 'public'::regnamespace
     AND a.grantee = 0
     AND a.privilege_type = 'EXECUTE';
  IF affected IS NOT NULL THEN
    RAISE WARNING 'revoking PUBLIC EXECUTE on functions in public: % — check that no column default or view depends on PUBLIC being able to call them', affected;
  END IF;
END
$funcs$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- 5. Default privileges — sequences and the function revoke, and nothing on tables
-- ----------------------------------------------------------------------------
-- THE TRAP (ADR §2, and the reason `CURRENT_USER` appears here rather than a literal):
-- `ALTER DEFAULT PRIVILEGES` applies only to objects created BY THE ROLE NAMED. A table
-- created by any other role gets no grants at all — silently. Naming `CURRENT_USER` ties
-- the default privileges to whichever role is applying this file, which is by construction
-- the role that applies every other DDL file in the same deploy, and on a developer machine
-- the role behind `db:push`. Verified on 16.15: `FOR ROLE CURRENT_USER` is accepted and
-- records `defaclrole = crm_user`.
--
-- Part 5 of the catalog check closes the loop by DERIVING the migration role from who owns
-- the tables and failing if the default privileges are attached to anyone else. So if DDL
-- ever starts running as a second role, the deploy fails instead of new tables quietly
-- losing their grants.
--
-- WHAT IS DELIBERATELY *NOT* HERE: A DEFAULT PRIVILEGE ON TABLES
-- An earlier revision of this file carried
--
--   ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
--
-- so that "a new class A table is reachable the moment it is created" would be true. It is
-- removed, for two reasons, and the second is why this counted as a hole rather than a
-- rough edge:
--
--   1. It bought nothing. A new table cannot ship without a manifest entry anyway:
--      `privilege-classes.spec.ts` derives its relation list from the Drizzle schema and
--      fails the unit suite on any unclassified `pgTable`, so the grants file names every
--      new table by the time it reaches a deploy. The default privilege bought only the
--      WINDOW between a CREATE TABLE and the grants file in the same deploy.
--   2. `ON TABLES` includes VIEWS — PostgreSQL uses "table" loosely there — and the
--      privileges on the base tables of an auto-updatable view are checked against the
--      VIEW OWNER, which is the migration role. So any view created over a class B, A-log,
--      E or V relation was WRITABLE by `crm_app`, which is a path straight around the
--      revoke those classes exist to make. Measured as `crm_app`: a direct
--      `UPDATE public.job_queue_actions` was refused while an `UPDATE` through a view over
--      it changed a row.
--
-- The window it closed is a real one — a table created mid-deploy is unreachable until the
-- grants file runs — and the answer to it is ORDERING, not a blanket privilege: `deploy.yml`
-- applies the grants file after every relation-creating file. Fail closed is also loud:
-- `permission denied`, SQLSTATE 42501, is visible in a log, whereas a silently over-granted
-- new table is not.
--
-- What remains below is what has no such blast radius:
--   * SEQUENCES, so a table whose grants do arrive does not then fail on its own identity
--     column. A sequence is not a view and has no owner-checked write path;
--   * the FUNCTIONS revoke, which only ever takes privileges away.
-- There is nothing for `crm_collector` here, deliberately: it reaches a new table only
-- when a grant names it.
-- And one statement that exists only because REMOVING a statement does not undo it. A
-- database where the earlier revision of this file ran still carries that `pg_default_acl`
-- row, and part 5 of the catalog check would then fail on every deploy with no forward fix
-- — the ADR's "the fix is a PR, not a hand-made GRANT" has to be true of this too. The
-- revoke is a no-op where the grant never existed, which is the case on production.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  REVOKE ALL ON TABLES FROM crm_app, crm_collector, crm_retention_owner;

ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crm_app;

-- And the same forward-repair argument one step further, for the one drift the GRANT above
-- does NOT undo: a `pg_default_acl` row carrying GRANT OPTION. Re-granting a privilege the
-- role already holds grantably leaves the flag standing (measured on 16.15, 2026-10-18),
-- so part 5's `OR a.grantable` branch would fail every deploy of such a database with no
-- fix a PR could ship. `REVOKE GRANT OPTION FOR` takes the flag and leaves the privilege,
-- and is a no-op where the flag was never set — which is the case on production.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  REVOKE GRANT OPTION FOR USAGE, SELECT ON SEQUENCES FROM crm_app;

-- Not scoped to a schema on purpose: a function created anywhere must not be
-- PUBLIC-executable by default.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
