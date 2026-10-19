-- =============================================================================
-- r5 Task 1.3b — append-only triggers for the queue audit log and the immutable
-- generation entries, plus the R-B end-of-retention path
-- =============================================================================
--
-- AUTHORITY
--   docs/architecture/2026-10-17-db-least-privilege-roles.md §3 (Accepted, PR #1018)
--     — the three layers, and R-B with its six conditions;
--   apps/api/src/database/schema/job-queue.ts, "TASK 1.3 OBLIGATION" items (a) and (b)
--     — the implementation brief written by the task that created these tables;
--   docs/legal/2026-10-17-job-queue-actions-erasure.md §6.2 / §8 item 4
--     — retention is TWO YEARS, UNIFORM across every event kind, and at expiry the
--       rows are DELETED (owner, 2026-10-17), not re-pointed at a sentinel.
--
-- Drizzle cannot declare a trigger, so `db:push` cannot create any of this: it is
-- forward DDL applied by hand from the comment above. Everything here is additive
-- and idempotent — see "IDEMPOTENCY" below.
--
-- WHAT THIS FILE DELIVERS
--   1. job_queue_actions        — append-only: UPDATE / DELETE / TRUNCATE refused,
--                                 except the two narrow R-B shapes in section 4.
--   2. job_queue_generation_entries
--                               — immutable: UPDATE / TRUNCATE refused; DELETE refused
--                                 unless it arrives through a parent cascade; INSERT
--                                 refused unless the generation is still BUILDING.
--   3. job_queue_generations    — scope_kind / team_id / expires_at frozen; status
--                                 one-way; DELETE refused unless INVALIDATED.
--   4. The R-B retention path   — two SECURITY DEFINER functions owned by
--                                 `crm_retention_owner`, the only sanctioned way a
--                                 log row is ever deleted or its `reason` redacted.
--
-- APPLY ORDER — THIS FILE DEPENDS ON ROLES IT DOES NOT CREATE
--   `crm_retention_owner` and `crm_app` are created by r5 Task 1.3c
--   (2026-10-18_db_roles.sql). This file must be applied AFTER that one. Section 0
--   below refuses to apply at all if either role is missing, so a wrong order fails
--   on the first statement with nothing half-created, rather than leaving the
--   triggers in place and the retention path absent.
--
-- IDEMPOTENCY (the deploy re-applies every manual file on EVERY deploy, under
-- `psql -v ON_ERROR_STOP=1` with statement-level autocommit — so each statement
-- must be independently re-runnable, and a failure must not leave a half state)
--   - every function is `CREATE OR REPLACE`;
--   - every trigger is dropped and recreated (`DROP TRIGGER IF EXISTS` then
--     `CREATE TRIGGER`), because PostgreSQL 16 has no
--     `CREATE OR REPLACE TRIGGER ... IF NOT EXISTS` and a recreate is the only way
--     to converge a trigger whose definition changed. See THE RECREATE WINDOW below:
--     it is real, and this is where its cost is written down rather than waved at;
--   - `ALTER TABLE ... ENABLE ALWAYS TRIGGER` is idempotent by nature;
--   - the grants are `REVOKE ALL ... FROM PUBLIC` + `GRANT EXECUTE ... TO crm_app`,
--     both convergent.
--
-- THE RECREATE WINDOW — real, bounded, and NOT closed by this file
--   This file has no `BEGIN`/`COMMIT`. Under `psql -v ON_ERROR_STOP=1` every statement
--   therefore autocommits, so between the `DROP TRIGGER` and the `CREATE TRIGGER` of
--   the same guard there is a committed instant in which the guard DOES NOT EXIST and
--   no lock is held either — `DROP TRIGGER` takes ACCESS EXCLUSIVE on the table, but
--   releases it when that statement commits. The window is real. It recurs on EVERY
--   deploy, because the deploy re-applies every manual file.
--
--   WHAT IT EXPOSES, precisely. During the window the table is protected only by its
--   GRANTS, which is the layer that was always the primary one here:
--     - `crm_app` — nothing. `job_queue_actions` is class B: its UPDATE/DELETE/TRUNCATE
--       are REVOKED, so the API cannot exploit the window even with no trigger present.
--       The trigger is the SECOND lock on an already-revoked privilege (ADR §3).
--     - `crm_retention_owner` — the shape guard, and only it. The role holds SELECT and
--       DELETE, so inside the window it could delete a row that is NOT yet two years
--       old, which outside the window the trigger refuses. It is NOLOGIN with
--       CONNECTION LIMIT 0, so this requires an already-compromised superuser session.
--     - the migration role running the deploy — nothing new: ownership alone lets it
--       `DISABLE TRIGGER`, with or without this window. ADR §3 states that this file's
--       protection against the migration role is procedural, and the DETECTION is the
--       companion catalog check on the next deploy.
--   So the window widens no privilege that the grants do not already withhold; what it
--   removes is the defence-in-depth second lock, for the roles that have the first one.
--
--   WHY IT IS STILL OPEN. Wrapping the file in one transaction would close it — DDL is
--   transactional in PostgreSQL, and `2026-10-18_db_grants.sql` and the privileges check
--   are both wrapped this way, so it would also match the sibling convention. It is not
--   done here unilaterally because it trades the window for its mirror image: one
--   transaction holds ACCESS EXCLUSIVE on all three tables for the whole file, which
--   blocks every reader and writer of the job queue for that duration instead of
--   leaving one guard briefly absent. Which of those two costs is the right one to pay
--   is a judgement about the deploy, not about this DDL, and it is recorded here for
--   the owner rather than settled by whoever edited the file last.
--
-- WHY `ENABLE ALWAYS` ON EVERY TRIGGER HERE
--   A trigger in the default state is SKIPPED when `session_replication_role =
--   replica`. These are security guards, not business logic, so each one is set to
--   `ALWAYS` and fires in every replication mode. (It still does not bind a role
--   that can `DISABLE TRIGGER` — ownership alone suffices for that; ADR §3's table
--   states exactly who is and is not bound. The companion catalog check,
--   2026-10-18_job_queue_append_only_check.sql, is what catches a trigger LEFT
--   disabled or dropped, on the next deploy.)
--
-- WHY NOT `pg_trigger_depth()` FOR THE CASCADE TEST (the trap this file avoids)
--   MEASURED on this exact schema (rolled-back probe trigger, recorded in the
--   job-queue.ts header): the entries trigger sees depth 1 on a DIRECT delete and 2
--   under a cascade. So `pg_trigger_depth() > 0` admits precisely the delete it must
--   refuse. The test used instead is the one the same probe confirmed: the DELETE is
--   admitted only when the PARENT ROW IS ALREADY GONE — the generation row under the
--   purge cascade, the opportunity row under the opportunity cascade. On a direct
--   delete both parents exist.
--
-- THE RETENTION PATH SHIPS INERT — BY DESIGN, NOT AS A GAP
--   Nothing calls `crm_retention_purge_job_queue_actions()`: there is no schedule, no
--   cron, no API caller. Wiring the job is a later task (r5 Task 1.4). Until then the
--   function exists, is pinned by the catalog check, and purges nothing because
--   nobody invokes it. `EXECUTE` is granted to `crm_app` by name, as ADR condition 4
--   requires, so the eventual caller needs no privilege change.
--
-- WHAT THE MEMO ASKS THE RETENTION JOB TO DECIDE BEFORE IT RUNS (recorded, not built)
--   Deletion destroys aggregate counts by construction. If any report needs
--   "dismissals per month" beyond two years, those figures must be computed into a
--   separate counters table BEFORE the rows are deleted (counts per period carrying
--   no user and no team reference are genuinely anonymous and may be kept
--   indefinitely). This file deliberately does not build that table — recovering the
--   numbers after a purge is impossible, so the decision belongs to the task that
--   turns the purge on.
--
-- KNOWN DIVERGENCE FROM THE ADR, STATED RATHER THAN SMOOTHED OVER (1 of 2)
--   ADR §3 reads "expired" from a retention-policy table (class E), because at the
--   time the periods were not set. The owner then set them: two years, uniform across
--   every event kind. With one uniform period that table would hold exactly one
--   meaningful value while adding a MUTABLE input to a security predicate — a row
--   `crm_user` could edit to make any row expired. The interval is therefore a
--   literal, written in the two places that need it (the trigger and the purge
--   function), and the catalog check pins BOTH bodies by checksum, so a change to
--   either is caught at the next deploy. If retention ever becomes per-kind again,
--   the policy table returns and this comment is the record of why it was not built
--   now. The two sites must agree; each names the other in its comment.
--
-- KNOWN DIVERGENCE FROM THE ADR AND THE LEGAL MEMO (2 of 2) — THE REDACTION EVENT
--   Both authorities ask each redaction to APPEND a `REASON_REDACTED` event row to
--   `job_queue_actions` ("provably complete rather than unchangeable"). That row
--   cannot be written today, and not for want of trying: `job_queue_action_kind` has
--   no `REASON_REDACTED` value, and `ck_job_queue_actions_versions` /
--   `ck_job_queue_actions_target` would refuse such a row (the third version branch
--   demands a moving version pair, which a redaction has not got). Both the enum and
--   those CHECKs live in `apps/api/src/database/schema/**`, which r5 Task 1.3b is
--   explicitly scoped OUT of, and adding the value only here would drift against the
--   Drizzle schema that `db:push` reconciles — on the next push drizzle-kit would try
--   to reconcile a type it does not know, in every developer's database.
--   So, until the schema task lands the value and the two CHECK branches:
--     - the redaction function records who / when / which request with `RAISE LOG`,
--       into the PostgreSQL server log, which is outside the application's reach;
--     - the integration spec PINS the absence of the enum value, so the day it is
--       added the pin fails and points here (the device PR #1017 used for this same
--       class of honest gap);
--     - the PR body lists this as the follow-up that must land BEFORE the redaction
--       path is used in production.
--   Nothing is quietly weaker than the authorities describe: the function exists, the
--   trigger admits only its shape, and the evidence lands in the server log rather
--   than nowhere.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. PRECONDITION — the roles this file depends on, by name. FIRST statement, so
--    a wrong apply order costs nothing.
-- -----------------------------------------------------------------------------
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
      'r5 Task 1.3b cannot apply: required role(s) absent: %', array_to_string(missing, ', ')
      USING
        ERRCODE = 'undefined_object',
        HINT = 'Apply apps/api/drizzle/manual/2026-10-18_db_roles.sql (r5 Task 1.3c) FIRST. '
               'This file creates no roles: crm_retention_owner owns the two retention '
               'functions and crm_app is the only grantee of EXECUTE on them. Nothing '
               'has been created by this run.';
  END IF;
END
$precondition$;


-- -----------------------------------------------------------------------------
-- 1. job_queue_actions — append-only, with the two R-B shapes as the only exception
-- -----------------------------------------------------------------------------
-- The exception is bounded by DATA SHAPE as well as by identity (ADR §3): even a
-- misuse of the retention identity cannot delete a row that is not yet due, nor
-- rewrite any column other than `reason`. Each conjunct below is a separate guard,
-- and the spec deletes each one by hand and names the test that goes red.
--
-- The "no other column moved" test is `to_jsonb(NEW) - 'reason' = to_jsonb(OLD) -
-- 'reason'` rather than a conjunction of per-column comparisons, deliberately: a
-- column added to this table later is covered the day it is added, whereas a
-- 14-term conjunction silently stops covering the table it guards.
CREATE OR REPLACE FUNCTION public.job_queue_actions_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- R-B shape 1: the end-of-retention purge. Two years, uniform (legal memo §6.2).
    -- The same interval is written in crm_retention_purge_job_queue_actions(); the
    -- two must agree, and the catalog check pins both bodies.
    IF current_user = 'crm_retention_owner'
       AND OLD.created_at <= now() - interval '2 years'
    THEN
      RETURN OLD;
    END IF;

    RAISE EXCEPTION
      'job_queue_actions is append-only: DELETE refused (row %)', OLD.id
      USING
        ERRCODE = 'restrict_violation',
        DETAIL  = 'The only sanctioned deletion is the end-of-retention purge: '
                  'current_user = crm_retention_owner AND created_at older than two years.',
        HINT    = 'Call crm_retention_purge_job_queue_actions() instead of deleting rows.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- R-B shape 2: redaction of `reason` to the fixed token, nothing else moved.
    --
    -- `OLD.reason <> token` carries TWO jobs, and the second is easy to break by
    -- "tidying" it. It refuses a second redaction of an already-redacted row (an
    -- UPDATE that writes a new row version while changing nothing), AND it refuses a
    -- row whose reason is NULL — because `NULL <> token` is UNKNOWN, and a
    -- conjunction containing UNKNOWN is not TRUE, so the exception is not admitted.
    -- An earlier draft carried an explicit `OLD.reason IS NOT NULL` conjunct beside
    -- it; deleting that conjunct by hand changed NO test, which is the definition of
    -- an operand this suite cannot pin, so it was removed rather than kept as
    -- unverifiable defence. Rewriting `<>` into `IS DISTINCT FROM` would silently
    -- admit NULL-reason rows; the test "refuses a redaction of a row whose reason is
    -- already NULL" is what makes that edit fail loudly (verified by deleting it).
    IF current_user = 'crm_retention_owner'
       AND NEW.reason = '[REASON REDACTED]'
       AND OLD.reason <> '[REASON REDACTED]'
       AND to_jsonb(NEW) - 'reason' = to_jsonb(OLD) - 'reason'
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'job_queue_actions is append-only: UPDATE refused (row %)', OLD.id
      USING
        ERRCODE = 'restrict_violation',
        DETAIL  = 'The only sanctioned update is the redaction of `reason` to the fixed '
                  'token, by crm_retention_owner, with every other column unchanged.',
        HINT    = 'The redaction path is NOT YET CALLABLE: '
                  'crm_retention_redact_action_reason(action_id, request_id) exists but '
                  'raises 42501, because crm_retention_owner is granted SELECT and DELETE '
                  'and the function also needs UPDATE (reason) — a column-level privilege '
                  'the least-privilege model forbids (db-privileges check, part 3). Until '
                  'that is decided, a reason cannot be redacted by any route. Do not add '
                  'the grant to make this message go away.';
  END IF;

  -- Unreachable: the trigger is created for UPDATE OR DELETE only. Raising rather
  -- than returning keeps a future re-pointing of this function at another event from
  -- silently passing the row through.
  RAISE EXCEPTION 'job_queue_actions_append_only() fired on an unexpected operation: %', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE OR REPLACE FUNCTION public.job_queue_actions_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  -- A row-level DELETE trigger does NOT fire on TRUNCATE; without this statement
  -- trigger, TRUNCATE empties the audit log silently.
  RAISE EXCEPTION 'job_queue_actions is append-only: TRUNCATE refused'
    USING ERRCODE = 'restrict_violation';
END
$fn$;

DROP TRIGGER IF EXISTS trg_job_queue_actions_append_only ON public.job_queue_actions;
CREATE TRIGGER trg_job_queue_actions_append_only
  BEFORE UPDATE OR DELETE ON public.job_queue_actions
  FOR EACH ROW EXECUTE FUNCTION public.job_queue_actions_append_only();
ALTER TABLE public.job_queue_actions
  ENABLE ALWAYS TRIGGER trg_job_queue_actions_append_only;

DROP TRIGGER IF EXISTS trg_job_queue_actions_no_truncate ON public.job_queue_actions;
CREATE TRIGGER trg_job_queue_actions_no_truncate
  BEFORE TRUNCATE ON public.job_queue_actions
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_queue_actions_no_truncate();
ALTER TABLE public.job_queue_actions
  ENABLE ALWAYS TRIGGER trg_job_queue_actions_no_truncate;


-- -----------------------------------------------------------------------------
-- 2. job_queue_generation_entries — immutable, cascade-aware
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.job_queue_generation_entries_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The purge deletes the GENERATION and lets the FK cascade remove its entries;
    -- deleting an opportunity removes it from every generation (r5 Task 6.2 allows
    -- removals). Both cascades reach this trigger with the parent row ALREADY GONE,
    -- which a direct delete never does. See the header on why not pg_trigger_depth().
    IF NOT EXISTS (SELECT 1 FROM job_queue_generations g WHERE g.id = OLD.generation_id)
       OR NOT EXISTS (SELECT 1 FROM job_opportunities o WHERE o.id = OLD.opportunity_id)
    THEN
      RETURN OLD;
    END IF;

    RAISE EXCEPTION
      'job_queue_generation_entries is immutable: direct DELETE refused (generation %, opportunity %)',
      OLD.generation_id, OLD.opportunity_id
      USING
        ERRCODE = 'restrict_violation',
        DETAIL  = 'An entry is removed only by deleting its generation (invalidate first) '
                  'or its opportunity, so the removal arrives through the FK cascade.';
  END IF;

  RAISE EXCEPTION
    'job_queue_generation_entries is immutable: % refused (generation %, opportunity %)',
    TG_OP, OLD.generation_id, OLD.opportunity_id
    USING
      ERRCODE = 'restrict_violation',
      DETAIL  = 'An entry is a snapshot: a refresh publishes a new generation instead.';
END
$fn$;

CREATE OR REPLACE FUNCTION public.job_queue_generation_entries_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'job_queue_generation_entries is immutable: TRUNCATE refused'
    USING ERRCODE = 'restrict_violation';
END
$fn$;

-- SR-M-3 — a LATE insert is a cross-team disclosure path: an entry added to an
-- already PUBLISHED generation appears in a list a team is being served right now.
--
-- `FOR SHARE` IS THE GUARD, NOT DECORATION (TOCTOU, found in review 2026-10-18 and
-- MEASURED on the scratch catalog before the fix). A plain unlocked read of the
-- parent status is defeated by concurrency rather than by a missing check:
--   1. T1 inserts an entry; the trigger reads BUILDING.
--   2. T2 publishes the generation and commits.
--   3. T1 commits — and the entry is now inside a PUBLISHED generation.
-- Both interleavings were reproduced (the insert did not even wait: the FK's own
-- `FOR KEY SHARE` lock does NOT conflict with the `FOR NO KEY UPDATE` that a plain
-- UPDATE of a non-key column takes, so the publish sailed past). `FOR SHARE` DOES
-- conflict with `FOR NO KEY UPDATE`, so one of the two waits: either the publish
-- waits for this insert and the entry lands legitimately, or this insert waits for
-- the publish and then — under READ COMMITTED, which re-evaluates a locked row after
-- the blocker commits — re-reads PUBLISHED and raises. Proven both ways by
-- `job-queue-append-only.integration.spec.ts` ("two-connection race").
-- `FOR SHARE` rather than `FOR UPDATE`: two builders filling the SAME generation
-- concurrently must not serialise against each other, and share locks do not.
CREATE OR REPLACE FUNCTION public.job_queue_generation_entries_building_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  parent_status text;
BEGIN
  SELECT g.status::text INTO parent_status
  FROM job_queue_generations g
  WHERE g.id = NEW.generation_id
  FOR SHARE;

  -- No parent row: leave it to the FK, which reports 23503 for exactly this.
  IF parent_status IS NULL THEN
    RETURN NEW;
  END IF;

  IF parent_status <> 'BUILDING' THEN
    RAISE EXCEPTION
      'job_queue_generation_entries: INSERT refused — generation % is %, not BUILDING',
      NEW.generation_id, parent_status
      USING
        ERRCODE = 'restrict_violation',
        DETAIL  = 'Entries are inserted only while the generation is BUILDING; a published '
                  'generation is a frozen snapshot.';
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_job_queue_generation_entries_immutable ON public.job_queue_generation_entries;
CREATE TRIGGER trg_job_queue_generation_entries_immutable
  BEFORE UPDATE OR DELETE ON public.job_queue_generation_entries
  FOR EACH ROW EXECUTE FUNCTION public.job_queue_generation_entries_immutable();
ALTER TABLE public.job_queue_generation_entries
  ENABLE ALWAYS TRIGGER trg_job_queue_generation_entries_immutable;

DROP TRIGGER IF EXISTS trg_job_queue_generation_entries_no_truncate ON public.job_queue_generation_entries;
CREATE TRIGGER trg_job_queue_generation_entries_no_truncate
  BEFORE TRUNCATE ON public.job_queue_generation_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_queue_generation_entries_no_truncate();
ALTER TABLE public.job_queue_generation_entries
  ENABLE ALWAYS TRIGGER trg_job_queue_generation_entries_no_truncate;

DROP TRIGGER IF EXISTS trg_job_queue_generation_entries_building_only ON public.job_queue_generation_entries;
CREATE TRIGGER trg_job_queue_generation_entries_building_only
  BEFORE INSERT ON public.job_queue_generation_entries
  FOR EACH ROW EXECUTE FUNCTION public.job_queue_generation_entries_building_only();
ALTER TABLE public.job_queue_generation_entries
  ENABLE ALWAYS TRIGGER trg_job_queue_generation_entries_building_only;


-- -----------------------------------------------------------------------------
-- 3. job_queue_generations — frozen scope, one-way status, invalidate before purge
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.job_queue_generations_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  -- Repointing a generation serves one team's opportunities to another (SR-M-3);
  -- moving `expires_at` revives an expired generation (SR-L-5).
  IF NEW.scope_kind IS DISTINCT FROM OLD.scope_kind THEN
    RAISE EXCEPTION 'job_queue_generations.scope_kind is frozen (generation %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    RAISE EXCEPTION 'job_queue_generations.team_id is frozen (generation %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'job_queue_generations.expires_at is frozen (generation %)', OLD.id
      USING
        ERRCODE = 'restrict_violation',
        DETAIL  = 'Moving the expiry would revive an expired generation; publish a new one.';
  END IF;

  -- One-way: BUILDING -> PUBLISHED -> INVALIDATED, BUILDING -> INVALIDATED. A status
  -- that does not move is allowed, so an UPDATE of another column needs no exception.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (OLD.status = 'BUILDING'  AND NEW.status = 'PUBLISHED')
       OR (OLD.status = 'BUILDING'  AND NEW.status = 'INVALIDATED')
       OR (OLD.status = 'PUBLISHED' AND NEW.status = 'INVALIDATED')
     )
  THEN
    RAISE EXCEPTION
      'job_queue_generations: status transition % -> % refused (generation %)',
      OLD.status, NEW.status, OLD.id
      USING
        ERRCODE = 'restrict_violation',
        DETAIL  = 'The lifecycle is one-way: BUILDING -> PUBLISHED -> INVALIDATED, '
                  'or BUILDING -> INVALIDATED.';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.job_queue_generations_purge_invalidated_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF OLD.status <> 'INVALIDATED' THEN
    RAISE EXCEPTION
      'job_queue_generations: DELETE refused — generation % is %, not INVALIDATED',
      OLD.id, OLD.status
      USING
        ERRCODE = 'restrict_violation',
        DETAIL  = 'Invalidate before purge. CONSEQUENCE, STATED: deleting a TEAM cascades '
                  'into its generations, so a team delete is refused until that team''s '
                  'generations are invalidated (the application archives teams, it never '
                  'deletes them).';
  END IF;

  RETURN OLD;
END
$fn$;

DROP TRIGGER IF EXISTS trg_job_queue_generations_frozen ON public.job_queue_generations;
CREATE TRIGGER trg_job_queue_generations_frozen
  BEFORE UPDATE ON public.job_queue_generations
  FOR EACH ROW EXECUTE FUNCTION public.job_queue_generations_frozen();
ALTER TABLE public.job_queue_generations
  ENABLE ALWAYS TRIGGER trg_job_queue_generations_frozen;

DROP TRIGGER IF EXISTS trg_job_queue_generations_purge_invalidated_only ON public.job_queue_generations;
CREATE TRIGGER trg_job_queue_generations_purge_invalidated_only
  BEFORE DELETE ON public.job_queue_generations
  FOR EACH ROW EXECUTE FUNCTION public.job_queue_generations_purge_invalidated_only();
ALTER TABLE public.job_queue_generations
  ENABLE ALWAYS TRIGGER trg_job_queue_generations_purge_invalidated_only;


-- -----------------------------------------------------------------------------
-- 4. The R-B retention path — two SECURITY DEFINER functions
-- -----------------------------------------------------------------------------
-- The six conditions of ADR §3, and where each one lives:
--   (1) owner `crm_retention_owner`, a dedicated NOLOGIN non-superuser — the
--       ALTER FUNCTION ... OWNER TO below, pinned by the catalog check;
--   (2) `SET search_path = pg_catalog, public, pg_temp`, pg_temp LAST and EXPLICIT —
--       below, pinned by the catalog check's `proconfig` assertion;
--   (3) static SQL only: the purge takes no argument at all, and the redaction uses
--       its arguments only as bound values. No EXECUTE, no format() into a statement;
--   (4) EXECUTE revoked from PUBLIC, granted to `crm_app` BY NAME;
--   (5) the shape of every admitted change is validated INSIDE THE TRIGGER (section 1),
--       independently of these bodies, so a bug here cannot widen the exception;
--   (6) the catalog check pins existence, signature, prosecdef, proowner, proconfig,
--       proacl and `md5(pg_get_functiondef(oid))`.
--
-- WHY THE TABLE REFERENCES BELOW ARE NOT SCHEMA-QUALIFIED — a deliberate choice, not
-- an omission. Qualifying them (`public.job_queue_actions`) would make the `pg_temp`
-- ordering untestable: the attack would be blocked by the qualification, removing the
-- `SET search_path` would change nothing observable, and no test could ever show the
-- condition is load-bearing. With an unqualified reference the spec's shadowing test
-- fails the moment the setting is dropped, and the catalog check pins `proconfig` so
-- the setting cannot vanish quietly. The security review demonstrated the attack this
-- defends against: a definer function without the explicit `pg_temp` read a SHADOWED
-- row from the caller's temporary table.
CREATE OR REPLACE FUNCTION public.crm_retention_purge_job_queue_actions()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  purged bigint;
BEGIN
  -- Two years, uniform across every event kind (owner, 2026-10-17; legal memo §6.2).
  -- The SAME interval is written in job_queue_actions_append_only(), which refuses
  -- any delete this function could attempt outside it. Change one, change both.
  DELETE FROM job_queue_actions WHERE created_at <= now() - interval '2 years';
  GET DIAGNOSTICS purged = ROW_COUNT;

  IF purged > 0 THEN
    RAISE LOG 'crm_retention: purged % expired job_queue_actions row(s)', purged;
  END IF;

  RETURN purged;
END
$fn$;

-- The redaction backstop (legal memo §8 item 3): free text can always carry a name
-- somebody typed. The text is replaced with a fixed token rather than NULL, so the
-- non-blank CHECK and the row's meaning both survive. See the header's divergence
-- note 2 for why the evidence goes to the server log today instead of into a
-- `REASON_REDACTED` row.
--
-- THIS FUNCTION IS INERT IN PRODUCTION AS DEPLOYED. It is created, owned, pinned and
-- granted — and it CANNOT RUN: measured `42501`. It needs `SELECT` plus `UPDATE (reason)`
-- on `job_queue_actions`, and `crm_retention_owner` is granted `SELECT, DELETE`. The
-- missing privilege cannot simply be added, which is why this is written down instead of
-- fixed: its true minimum is the column-level `UPDATE (reason)`, and part 3 of the
-- db-privileges check rejects ANY column-level privilege other than `SELECT` for these
-- roles, outright; while a table-level `UPDATE` is wider than the function needs — it
-- would let the role rewrite any column of the audit log, and although the trigger above
-- constrains the SHAPE of an admitted update, a grant in a least-privilege manifest is
-- supposed to be justified by a failing run, not by a trigger covering for it.
--
-- So the redaction path is DECLARED but NOT YET CALLABLE, deliberately, pending an owner
-- decision on which of those two the model should accept. Consequences, stated plainly:
-- a `reason` cannot be redacted by any route today, and the legal memo §8 item 3
-- obligation is therefore NOT discharged by this deploy. The integration suite pins the
-- inert state ("is INERT under the PRODUCTION grant set"), and its three behavioural
-- redaction tests run with a grant the suite adds and revokes itself — they establish
-- this body's logic, never that production can call it.
CREATE OR REPLACE FUNCTION public.crm_retention_redact_action_reason(
  p_action_id uuid,
  p_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  redacted boolean;
BEGIN
  IF p_action_id IS NULL THEN
    RAISE EXCEPTION 'crm_retention_redact_action_reason: action id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Bounded and non-blank, per ADR condition 3 — the only validation the arguments
  -- need, because neither one ever reaches a statement as text.
  IF p_request_id IS NULL OR p_request_id !~ '[^[:space:]]' OR length(p_request_id) > 200 THEN
    RAISE EXCEPTION
      'crm_retention_redact_action_reason: request id must be non-blank and at most 200 characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE job_queue_actions
     SET reason = '[REASON REDACTED]'
   WHERE id = p_action_id
     AND reason IS NOT NULL
     AND reason <> '[REASON REDACTED]';

  redacted := FOUND;

  IF redacted THEN
    -- The interim evidence channel (header, divergence 2): the server log is outside
    -- the application's reach, and this is the ONLY record of a redaction until the
    -- `REASON_REDACTED` event kind exists.
    RAISE LOG 'crm_retention: redacted reason of job_queue_actions % (request %, session_user %)',
      p_action_id, p_request_id, session_user;
  END IF;

  RETURN redacted;
END
$fn$;

ALTER FUNCTION public.crm_retention_purge_job_queue_actions() OWNER TO crm_retention_owner;
ALTER FUNCTION public.crm_retention_redact_action_reason(uuid, text) OWNER TO crm_retention_owner;

REVOKE ALL ON FUNCTION public.crm_retention_purge_job_queue_actions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_retention_redact_action_reason(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.crm_retention_purge_job_queue_actions() TO crm_app;
GRANT EXECUTE ON FUNCTION public.crm_retention_redact_action_reason(uuid, text) TO crm_app;
