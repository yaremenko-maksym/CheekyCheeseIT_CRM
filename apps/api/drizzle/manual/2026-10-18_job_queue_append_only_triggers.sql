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
--                                 except the two narrow R-B shapes in section 4; a
--                                 `REASON_REDACTED` evidence row admitted on INSERT only
--                                 from the redaction path (r5 Task 1.4b-iii, SR-M-1 of
--                                 PR #1075); and `created_at` forced to `now()` on
--                                 INSERT, so the column every retention decision reads
--                                 is written by the database and not by its writer. See
--                                 "WHY `created_at` IS FORCED" below.
--   2. job_queue_generation_entries
--                               — immutable: UPDATE / TRUNCATE refused; DELETE refused
--                                 unless it arrives through a parent cascade; INSERT
--                                 refused unless the generation is still BUILDING.
--   3. job_queue_generations    — scope_kind / team_id / expires_at frozen; status
--                                 one-way; DELETE refused unless INVALIDATED.
--   4. The R-B retention path   — two SECURITY DEFINER functions owned by
--                                 `crm_retention_owner`, the only sanctioned way a
--                                 log row is ever deleted or its `reason` redacted.
--                                 Both halves are callable under the production grant
--                                 set since r5 Task 1.4b-iii; until then the REDACTION
--                                 half raised `42501`. See "THE REDACTION HALF —
--                                 CALLABLE SINCE r5 TASK 1.4b-iii" below for what was
--                                 measured and what is still open.
--
-- APPLY ORDER — THIS FILE DEPENDS ON ROLES IT DOES NOT CREATE
--   `crm_retention_owner` and `crm_app` are created by r5 Task 1.3c
--   (2026-10-18_db_roles.sql). This file must be applied AFTER that one. Section 0
--   below refuses to apply at all if either role is missing, so a wrong order fails
--   on the first statement with nothing half-created, rather than leaving the
--   triggers in place and the retention path absent.
--
-- IDEMPOTENCY (the deploy re-applies every manual file on EVERY deploy, under
-- `psql -v ON_ERROR_STOP=1`, each file piped whole into ONE psql session — so every
-- statement must be independently re-runnable, and a failure must not leave a half state)
--   - every function is `CREATE OR REPLACE`;
--   - every trigger is `CREATE OR REPLACE TRIGGER`, which converges a changed definition
--     IN PLACE with no `DROP` (PostgreSQL 14+; measured on 16.15, `tgtype` 27 -> 19 -> 27
--     with the trigger never absent). It needs no `IF NOT EXISTS` — `OR REPLACE` handles
--     both the create and the converge case. This is also what closes the RECREATE
--     window; see the two-windows section below for which change closes which;
--   - `ALTER TABLE ... ENABLE ALWAYS TRIGGER` is idempotent by nature, and is REQUIRED
--     after every `CREATE OR REPLACE TRIGGER`: measured, `OR REPLACE` resets `tgenabled`
--     from 'A' to 'O'. The companion catalog check asserts 'A', so a deploy that died
--     between the two is caught rather than assumed away;
--   - the grants are `REVOKE ALL ... FROM PUBLIC` + `GRANT EXECUTE ... TO crm_app`,
--     both convergent;
--   - the ONE exception to "every function is `CREATE OR REPLACE`": r5 Task 1.4b-iii
--     changed the redaction function's ARGUMENT LIST, which `OR REPLACE` cannot do — it
--     would create a second overload beside the old one and leave the old one callable.
--     So the old signature is `DROP FUNCTION IF EXISTS`-ed first, inside the same
--     transaction as the `CREATE` / `OWNER TO` / `REVOKE` / `GRANT` of the new one.
--     A no-op on every apply after the first.
--
-- TWO WINDOWS, TWO DIFFERENT FIXES — AND EACH GETS THE CREDIT IT EARNED
--   Both windows are closed. An earlier version of this comment credited the transaction
--   with closing both, and that is wrong: the two changes in this file close one each,
--   and both reviewers measured which (fix round 3, CR-M-10).
--
--     1. the RECREATE window — CLOSED BY `CREATE OR REPLACE TRIGGER`, not by the wrap.
--        Under statement-level autocommit, `DROP TRIGGER` then `CREATE TRIGGER` left a
--        committed instant with the guard ABSENT and no lock held (`DROP TRIGGER` releases
--        its lock when that statement commits), and it recurred on every deploy.
--        `CREATE OR REPLACE TRIGGER` converges a changed definition IN PLACE with no
--        `DROP` at all, so the trigger is never absent — measured in an UNWRAPPED control
--        run, where the trigger count on the guarded tables stayed at 7 throughout (the
--        count on the day of that measurement, 2026-10-19; it is 8 since the `created_at`
--        guard below — the figure is kept as the historical reading it is, not updated,
--        because updating it would misreport what was observed).
--        That is why the `OR REPLACE` is load-bearing and not decoration, and it keeps
--        this window closed even if the file is ever applied statementwise by something
--        that is not the deploy.
--
--     2. the ENABLE ORIGIN window — CLOSED BY THE TRANSACTION, and only by it.
--        `CREATE TRIGGER` *and* `CREATE OR REPLACE TRIGGER` both leave the trigger
--        `ENABLE ORIGIN` until the separate `ENABLE ALWAYS` commits (measured: `OR
--        REPLACE` resets `tgenabled` 'A' -> 'O'), so for that instant a session with
--        `session_replication_role = replica` skipped the guard entirely. No form of
--        `CREATE ... TRIGGER` can close this one; only not committing in between does.
--
--   WHAT THE WRAP ITSELF GUARANTEES, stated precisely because it is the claim the suite
--   proves: `BEGIN;` / `COMMIT;` wrap everything below, matching
--   `2026-10-18_db_grants.sql` and the privileges check. DDL is transactional in
--   PostgreSQL, so NO intermediate state inside this file is ever visible to another
--   session — a concurrent session sees the previous state until `COMMIT`, then the new
--   one, and nothing in between. The integration suite observes exactly that from a
--   second connection (`OWNER-M-1 — the file is one transaction`), and security's
--   unwrapped control showed seven intermediate states where the wrapped run shows none.
--
--   WHAT THE WRAP COSTS — AND THE LOCK MODE IS NOT THE ONE EVERYONE ASSUMED.
--   Both review axes (and an earlier version of this comment) described the wrap as
--   holding ACCESS EXCLUSIVE on the three tables, i.e. blocking every reader and writer.
--   MEASURED on 16.15, that is wrong: `CREATE OR REPLACE TRIGGER` and
--   `ALTER TABLE ... ENABLE ALWAYS TRIGGER` both take **ShareRowExclusiveLock**, and
--   nothing in this file takes anything stronger. `pg_locks` was read inside the
--   transaction after each statement to confirm it.
--     What ShareRowExclusive actually does: it does NOT conflict with ACCESS SHARE, so
--   plain SELECTs against the queue tables run throughout, unblocked. It DOES conflict
--   with ROW EXCLUSIVE, so INSERT / UPDATE / DELETE on those three tables wait until
--   `COMMIT` — and with other DDL on them. So the cost is paid by WRITERS, not readers,
--   and it is paid for the few milliseconds this file takes.
--     Why that is acceptable here, concretely: the six queue tables are EMPTY on
--   production (r5 is not yet live) and no shipped code path writes them, and the file
--   runs before the container swap, so the API serving traffic at that moment is the old
--   one, which does not touch these tables at all. `SET LOCAL lock_timeout` below bounds
--   the other direction — if some writer unexpectedly does hold ROW EXCLUSIVE, the deploy
--   aborts rather than queueing. Both halves are pinned by tests (`OWNER-M-1` in the
--   integration suite), including the lock mode claim above.
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
-- WHY `created_at` IS FORCED, AND WHY IT OVERRIDES RATHER THAN REFUSES (r5 Task 1.4b-i,
-- closing SR-M-1 of PR #1062; backlog 263)
--   THE HOLE. `job_queue_actions.created_at` is `defaultNow()` with a NOT NULL and no
--   CHECK, and a default is only a default: any writer may supply its own value. Since
--   PR #1062 the end-of-retention purge runs DAILY, so a row inserted with a `created_at`
--   two years in the past is evidence that DELETES ITSELF WITHIN TWENTY-FOUR HOURS, by
--   the sanctioned path, leaving the log looking healthy.
--     The append-only trigger in section 1 cannot compensate, and this is the part worth
--   reading twice: its DELETE branch admits a row whose `OLD.created_at <= now() -
--   interval '2 years'` — it READS THE SAME UNTRUSTED COLUMN. So section 1's assurance
--   that a misuse of the retention identity "cannot delete a row that is not yet due"
--   holds exactly as far as `created_at` is trustworthy, and not one step further. The
--   guard below is what makes that sentence true; the two are one mechanism.
--
--   WHAT IT STOPS, AND WHAT IT DOES NOT — the same claim its neighbours make, stated
--   again rather than left to be inferred. It stops AN APPLICATION BUG: a writer that
--   supplies a timestamp, whether from a client clock, a replayed payload, or a belief
--   that it owns the column. It does NOT stop a superuser or the table owner: ownership
--   alone suffices to `DISABLE TRIGGER` or `DROP TRIGGER`, here as everywhere else in
--   this file. Against that actor the protection is procedural and the DETECTION is the
--   companion catalog check, which pins this trigger exactly as it pins the other seven
--   and fails the NEXT DEPLOY if it is missing, disabled, repointed or rewritten.
--
--   THE FORCE IS UNCONDITIONAL; THE COMPARISON IS DIAGNOSTICS. The assignment
--   `NEW.created_at := now()` runs on every row, outside the `IF`. The comparison exists
--   only to decide whether to complain, so a mistake in it can cost a missing warning and
--   cannot open a hole — the inverse arrangement (assign inside the branch) would make
--   the predicate load-bearing for the guarantee, which is the shape of defect this file
--   keeps finding in its own history.
--
--   OVERRIDE, NOT REFUSAL — the choice, and the argument, because the choice is not
--   self-evident and both answers are defensible.
--     First, a fact that removes the usual reason to prefer refusal: DETECTION COSTS
--   NOTHING AND IS EXACT. `now()` is the transaction timestamp and is stable for the whole
--   transaction, so a row relying on the default arrives at this trigger with
--   `NEW.created_at` EQUAL to `now()`, to the microsecond — `IS DISTINCT FROM now()` is
--   therefore a precise test of "the writer supplied something of its own", with no
--   tolerance window to tune and no clock-skew edge to admit a small backdate. Both
--   designs can see the buggy writer equally well; the only question is what to do about
--   it. (A writer that explicitly passes `now()` or `DEFAULT` is indistinguishable from
--   the default, and rightly so: it supplied the correct value.)
--     The decision rests on FAILURE ASYMMETRY. A refusal turns a timestamp bug into a
--   MISSING AUDIT ROW — and, when the audit INSERT shares a transaction with the action it
--   records, into the business action itself being refused. For a log whose entire purpose
--   is evidence, "no row" is worse than "the correct row, plus a complaint": a guard
--   protecting an audit trail must not be able to convert a writer's bug into a gap in that
--   trail. Overriding yields a row that is correct in the column that matters, every time,
--   including against a writer nobody has reviewed yet.
--     Loudness is then recoverable WITHOUT paying that price: `RAISE WARNING` reaches the
--   server log AND the connected client (node-postgres surfaces it as a `notice` event), so
--   the first writer's author meets it on the first run, in dev and in CI, which is where
--   the "catches a buggy writer early" argument wanted to put it. This file already uses
--   the server log as its evidence channel for redactions, so the device is not new here.
--     WHAT OVERRIDING COSTS, stated and not softened: a writer that MEANT a different
--   instant — "the action happened at T, we are recording it now" — gets a row asserting
--   the recording time, with only a warning to say its intent was discarded. That is
--   accepted, because there is no legitimate supplied value for THIS column other than
--   exactly `now()`: a writer that needs the event time needs a separate column, and the
--   warning's HINT says so. Refusal would make that point more forcefully, at the cost in
--   the paragraph above.
--     WHEN TO REVISIT, so the choice stays falsifiable: if this warning is ever observed
--   in a real log, a real writer supplies a real value, and the override-versus-refusal
--   trade can be re-decided against that case instead of against this reasoning.
--
--   WHAT THIS DELIBERATELY TAKES AWAY, named because something depended on it. Supplying
--   `created_at` at INSERT time was the ONLY way to produce an aged row — backdating later
--   is impossible by design, the section 1 trigger refusing every UPDATE but the redaction
--   — and the two integration suites that must build an EXPIRED row (the append-only suite
--   and the retention cron's) used exactly that. Removing the capability from writers
--   removes it from them too, by construction and not by oversight: they must now age a row
--   as the TABLE OWNER with this trigger disabled, which is the same procedural trust they
--   already use to replay tampering against the catalog check. That companion change lives
--   in the test zone and is named in the PR body.
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
-- THE REDACTION HALF — CALLABLE SINCE r5 TASK 1.4b-iii (it shipped UNCALLABLE in 1.3b)
--   History, kept because the reasoning still binds: 1.3b shipped
--   `crm_retention_redact_action_reason` created, owned, pinned and granted, and unable to
--   run — `42501`, because its owner held `SELECT, DELETE` and it needs `UPDATE (reason)`.
--   No grant was added then, on purpose: the function could not yet append the
--   `REASON_REDACTED` evidence row both authorities require (no enum value, two CHECKs
--   refusing it), and a redaction nobody can prove happened is worse than one that
--   refused. r5 Task 1.4b-ii (PR #1075) made the row recordable; 1.4b-iii makes the
--   function write it, and grants what that takes and nothing more.
--
--   WHAT CHANGED, AND WHAT EACH PIECE IS JUSTIFIED BY
--     - the signature gains `p_actor_id uuid` (owner decision, 2026-10-22): the evidence
--       row's `actor_id` is the person who triggered the erasure. `actor_id` stays NOT
--       NULL with its RESTRICT FK, and no service principal exists in `users`;
--     - the redaction UPDATE and the evidence INSERT run in ONE call: a failure of the
--       INSERT (an unknown actor -> 23503, a key collision -> 23505, a CHECK -> 23514)
--       aborts the call, and the redaction with it;
--     - `crm_retention_owner` gains column-level `UPDATE (reason)` and table-level
--       `INSERT` on `job_queue_actions`, each the answer to a FAILING RUN that is recorded
--       with its statement and SQLSTATE in `privilege-classes.ts`
--       (`RETENTION_OWNER_TABLE_PRIVILEGES`, `RETENTION_OWNER_REDACTION_COLUMN_GRANT`) —
--       the file the grants and their check are generated from. The column-level grant is
--       the ONE non-SELECT column privilege part 3 of the privileges check admits, bound to
--       exactly this role, table and column (owner decision, 2026-10-22);
--     - section 1 gates the INSERT side (SR-M-1 of PR #1075): a `REASON_REDACTED` row is
--       admitted only when `current_user = 'crm_retention_owner'`, which is to say only
--       from inside the definer function, and that role may insert nothing else. Until
--       this task the CHECKs admitted the row shape from ANY writer, which was tolerable
--       only while nothing wrote it.
--
--   WHAT IS MEASURED, AND HOW FAR THE CLAIM GOES. The integration suite runs the redaction
--   under the grant statements of the GENERATED GRANTS FILE — the bytes production applies
--   — and not under a grant the suite invents for itself ("is CALLABLE under the
--   PRODUCTION grant set"). That is a claim about this function and its grants. It is NOT
--   a claim that any erasure request has been honoured: nothing in the application calls
--   this function yet (checked 2026-10-22: no caller in `apps/api/src` outside specs).
--   Whether the legal memo §8 item 3 obligation is discharged IN PRACTICE depends on that
--   caller and the process around it, which is a later task's to ship and the owner's to
--   judge. This file states only that the database side can now do what the obligation
--   needs, and that this was measured rather than assumed.
--
-- A DEFERRED GAP: `job_queue_generations` HAS NO INSERT GUARD
--   The three guards on this table and its entries all constrain what happens AFTER a
--   generation exists. Nothing constrains the INSERT, so a role with INSERT can create
--   a generation that is already PUBLISHED and already expired — a state the state
--   machine would never reach by moving through it. MEASURED, and deliberately left
--   open here.
--     Why it is a follow-up and not this file: there is no cross-team disclosure in it.
--   An entry can only be added while the generation is BUILDING, so a generation born
--   PUBLISHED is permanently EMPTY — the exposure is an integrity nuance (a nonsense
--   row), not a read of another team's queue. Closing it means an eighth trigger with
--   its own admitted-shape semantics, its own manifest entry and its own tests, decided
--   on its own merits rather than appended to a PR already in a fix round.
--     It is recorded in three places so it is a known state and not a discovery: here,
--   in the PR body, and as a GAP PIN test in the integration suite that goes red the
--   day the guard lands. It is NOT the same gap as divergence 2 below.
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
-- KNOWN DIVERGENCE FROM THE ADR AND THE LEGAL MEMO (2 of 2) — THE REDACTION EVENT — CLOSED
--   Both authorities ask each redaction to APPEND a `REASON_REDACTED` event row to
--   `job_queue_actions` ("provably complete rather than unchangeable"). Through r5 Task
--   1.4b-ii that row could not be written, and the server log (`RAISE LOG`) was the only
--   evidence channel. Since 1.4b-iii the function appends the row in the same call as the
--   redaction: `kind = 'REASON_REDACTED'`, `subject_action_id` = the redacted row,
--   `actor_id` = the caller-supplied actor, `reason` NULL (the evidence row carries no free
--   text that could itself need redacting — SR-M-5 of PR #1075, enforced by
--   `ck_job_queue_actions_redaction_reason_null`), and the request id carried in
--   `idempotency_key` as `<request id>:<subject action id>`, so one request may redact
--   several rows without colliding on the per-actor unique key. The `RAISE LOG` line stays,
--   as a second channel outside the application's reach.
--   STILL OPEN, and deliberately not decided here (owner decisions pending; PR #1075
--   findings SR-M-3 and SR-M-6): which SCOPE the evidence row should carry — it copies the
--   subject row's `scope_kind` / `team_id` only because `scope_kind` is NOT NULL and a value
--   must be written, and copying keeps its visibility exactly that of the row it is about —
--   and how a lawfully purged subject is told apart from one that never existed.
-- =============================================================================


BEGIN;

-- `lock_timeout`, not `statement_timeout`: the failure this bounds is WAITING FOR A LOCK,
-- and the right outcome is to abort the deploy while the OLD API is still serving, not to
-- queue behind a long reader and hold ACCESS EXCLUSIVE on the queue tables meanwhile.
-- Five seconds, chosen against the facts rather than by habit: the six queue tables are
-- EMPTY on production and no shipped code path reads them yet, so the expected wait is
-- zero and any wait at all means something unexpected holds a conflicting lock — which is
-- exactly when a deploy should stop and be looked at. Long enough to ride out a momentary
-- autovacuum or a catalog read; far too short to stall a deploy. `SET LOCAL`, so it dies
-- with this transaction and leaks into nothing the deploy runs next.
SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 0. PRECONDITION — the roles this file depends on, by name. FIRST statement after
--    `BEGIN`, so a wrong apply order costs nothing: it raises, the transaction
--    aborts, and not one object in this file is created.
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
--
-- THE INSERT SIDE (r5 Task 1.4b-iii, closing SR-M-1 of PR #1075). One function decides
-- every write shape of the log, so the trigger fires on INSERT as well. Two rules, the
-- mirror image of each other:
--   - a `REASON_REDACTED` evidence row is admitted only from `crm_retention_owner`. That
--     role is NOLOGIN, so the only code that runs as it is the body of a SECURITY
--     DEFINER function it owns — in practice, the redaction function. Without this the
--     CHECK branch #1075 added admits the row shape from ANY writer, and `crm_app` could
--     fabricate evidence of a redaction that never happened;
--   - `crm_retention_owner` inserts NOTHING ELSE. Its `INSERT` grant exists only for the
--     evidence row, so the trigger narrows that grant to it by shape, the same way the
--     DELETE and UPDATE branches narrow the role's other privileges.
-- Every other INSERT passes untouched, which is the append-only log's normal write.
CREATE OR REPLACE FUNCTION public.job_queue_actions_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Compared as text, so the comparison cannot raise `invalid input value for enum`
    -- on a database whose enum predates the value; there it is simply never true.
    IF NEW.kind::text = 'REASON_REDACTED' THEN
      IF current_user = 'crm_retention_owner' THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION
        'job_queue_actions: a REASON_REDACTED evidence row is written only by the redaction path (row %)',
        NEW.id
        USING
          ERRCODE = 'restrict_violation',
          DETAIL  = 'Evidence of a redaction is appended by '
                    'crm_retention_redact_action_reason(), in the same call as the '
                    'redaction it records; current_user here is ' || current_user || '.',
          HINT    = 'Call crm_retention_redact_action_reason(action_id, request_id, '
                    'actor_id) instead of inserting the evidence row yourself.';
    END IF;

    IF current_user = 'crm_retention_owner' THEN
      RAISE EXCEPTION
        'job_queue_actions: crm_retention_owner may insert only REASON_REDACTED evidence rows (row %, kind %)',
        NEW.id, NEW.kind
        USING
          ERRCODE = 'restrict_violation',
          DETAIL  = 'The retention owner holds INSERT for the redaction evidence row and '
                    'for nothing else.';
    END IF;

    RETURN NEW;
  END IF;

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
        HINT    = 'Call crm_retention_redact_action_reason(action_id, request_id, '
                  'actor_id): it redacts the reason and appends the REASON_REDACTED '
                  'evidence row in one call. Do not rewrite the row directly.';
  END IF;

  -- Unreachable: the trigger is created for INSERT OR UPDATE OR DELETE only. Raising
  -- rather than returning keeps a future re-pointing of this function at another event
  -- from silently passing the row through.
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

CREATE OR REPLACE TRIGGER trg_job_queue_actions_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.job_queue_actions
  FOR EACH ROW EXECUTE FUNCTION public.job_queue_actions_append_only();
ALTER TABLE public.job_queue_actions
  ENABLE ALWAYS TRIGGER trg_job_queue_actions_append_only;

CREATE OR REPLACE TRIGGER trg_job_queue_actions_no_truncate
  BEFORE TRUNCATE ON public.job_queue_actions
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_queue_actions_no_truncate();
ALTER TABLE public.job_queue_actions
  ENABLE ALWAYS TRIGGER trg_job_queue_actions_no_truncate;

-- `created_at` is written by the DATABASE, never by the writer (r5 Task 1.4b-i, closing
-- SR-M-1 of PR #1062). The full argument — why the hole mattered the day the purge
-- started running, why this overrides instead of refusing, and what the choice costs —
-- is in the header under "WHY `created_at` IS FORCED". The two sentences that must
-- travel WITH the code:
--   this stops an APPLICATION BUG, not a superuser (ownership alone disables any trigger
--   here; the catalog check is the detection), and
--   the DELETE branch of job_queue_actions_append_only() reads this very column, so its
--   two-year bound is trustworthy only because of this function.
CREATE OR REPLACE FUNCTION public.job_queue_actions_created_at_now()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  -- Diagnostics, not the guarantee. `now()` is the TRANSACTION timestamp and is stable
  -- for the whole transaction, so a row that relied on the column default arrives here
  -- with `NEW.created_at` equal to it to the microsecond. That makes this an EXACT test
  -- of "the writer supplied a value of its own" — no tolerance window, no clock-skew
  -- edge through which a small backdate could pass as the default — and it is why
  -- overriding gives up none of refusal's ability to see the bug. A writer that passes
  -- `DEFAULT`, or `now()` explicitly, is silent here because it supplied the right value.
  IF NEW.created_at IS DISTINCT FROM now() THEN
    RAISE WARNING
      'job_queue_actions.created_at is set by the database: supplied %, stored % (row %)',
      NEW.created_at, now(), NEW.id
      USING
        DETAIL = 'This column is the input to the two-year retention bound and to the '
                 'purge, so a supplied value is a backdated audit row. It was overridden '
                 'rather than refused, so no evidence is lost to this bug.',
        HINT   = 'Stop sending created_at. If the WRITER needs the instant the action '
                 'happened, as distinct from the instant it was recorded, that is a '
                 'separate column and a schema change — not this one.';
  END IF;

  -- The guarantee, unconditional and outside the IF above: a mistake in that comparison
  -- can cost a warning, never the column.
  NEW.created_at := now();

  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER trg_job_queue_actions_created_at_now
  BEFORE INSERT ON public.job_queue_actions
  FOR EACH ROW EXECUTE FUNCTION public.job_queue_actions_created_at_now();
ALTER TABLE public.job_queue_actions
  ENABLE ALWAYS TRIGGER trg_job_queue_actions_created_at_now;


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

CREATE OR REPLACE TRIGGER trg_job_queue_generation_entries_immutable
  BEFORE UPDATE OR DELETE ON public.job_queue_generation_entries
  FOR EACH ROW EXECUTE FUNCTION public.job_queue_generation_entries_immutable();
ALTER TABLE public.job_queue_generation_entries
  ENABLE ALWAYS TRIGGER trg_job_queue_generation_entries_immutable;

CREATE OR REPLACE TRIGGER trg_job_queue_generation_entries_no_truncate
  BEFORE TRUNCATE ON public.job_queue_generation_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_queue_generation_entries_no_truncate();
ALTER TABLE public.job_queue_generation_entries
  ENABLE ALWAYS TRIGGER trg_job_queue_generation_entries_no_truncate;

CREATE OR REPLACE TRIGGER trg_job_queue_generation_entries_building_only
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

CREATE OR REPLACE TRIGGER trg_job_queue_generations_frozen
  BEFORE UPDATE ON public.job_queue_generations
  FOR EACH ROW EXECUTE FUNCTION public.job_queue_generations_frozen();
ALTER TABLE public.job_queue_generations
  ENABLE ALWAYS TRIGGER trg_job_queue_generations_frozen;

CREATE OR REPLACE TRIGGER trg_job_queue_generations_purge_invalidated_only
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
-- non-blank CHECK and the row's meaning both survive, and the call APPENDS the
-- `REASON_REDACTED` evidence row the memo and the ADR require (r5 Task 1.4b-iii).
--
-- CALLABLE UNDER THE PRODUCTION GRANT SET, measured: the integration suite runs it under
-- the grant statements of the generated grants file (`is CALLABLE under the PRODUCTION
-- grant set`). Until 1.4b-iii it raised `42501`; the header's "THE REDACTION HALF"
-- section keeps that history and states what the measurement does NOT show — nothing in
-- the application calls this function yet.
--
-- THE SIGNATURE CHANGED in 1.4b-iii: `p_actor_id uuid` was added. `CREATE OR REPLACE`
-- cannot change an argument list — it would add an overload and leave the old
-- two-argument function in place, owned, granted to `crm_app`, and (with the grants this
-- task adds) able to redact WITHOUT writing evidence. So the old signature is dropped
-- first, inside this file's transaction, and the six ADR §3 conditions are re-applied to
-- the new one below before `COMMIT`: no other session ever sees the function with its
-- default PUBLIC EXECUTE, nor the old one beside the new.
--   The SAME body is created by `2026-10-22_job_queue_redaction_callable.sql`, the dated
-- upgrade file the deploy applies BEFORE the grants file. The catalog check pins one md5
-- for both, so the two copies cannot drift without failing the deploy.
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

ALTER FUNCTION public.crm_retention_purge_job_queue_actions() OWNER TO crm_retention_owner;
ALTER FUNCTION public.crm_retention_redact_action_reason(uuid, text, uuid) OWNER TO crm_retention_owner;

REVOKE ALL ON FUNCTION public.crm_retention_purge_job_queue_actions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_retention_redact_action_reason(uuid, text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.crm_retention_purge_job_queue_actions() TO crm_app;
GRANT EXECUTE ON FUNCTION public.crm_retention_redact_action_reason(uuid, text, uuid) TO crm_app;

COMMIT;
