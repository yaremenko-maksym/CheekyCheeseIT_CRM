-- =============================================================================
-- job_queue_actions — REASON_REDACTED evidence rows (r5 Task 1.4b-ii), prod forward DDL
-- =============================================================================
--
-- Why this file exists AT ALL, which is the whole point
-- ----------------------------------------------------
-- r5 Task 1.4b-ii widened `job_queue_actions` so that a redaction of some other action
-- row's `reason` can APPEND its own evidence row (legal memo 2026-10-17 section 7 /
-- section 8 item 3; least-privilege ADR section 3, R-B). The Drizzle schema says so,
-- and `2026-10-17_job_opportunities_store.sql` — the FRESH-CREATE file — now says so
-- too, in its `CREATE TYPE` and `CREATE TABLE` literals.
--
-- That is enough for a NEW database and reaches production not at all. Part 1 is
-- applied on every deploy, but every statement in it is guarded BY NAME:
-- `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, and the
-- `duplicate_object` guard around each `ADD CONSTRAINT` swallows the error for a
-- constraint whose name already exists — however different its expression. Production
-- has had this store since the deploy that followed #1022 (part 1 has been a hard apply
-- step in `deploy.yml` since 2026-10-17, and deploys have run since), so there the
-- type, the table and both CHECKs already exist in their OLD shape and part 1's edits
-- are invisible to it. This file is what carries them across — the "new, dated
-- migration" that part 1's own header names as the remedy for exactly this situation.
--
-- THE TRAP THIS FILE IS SHAPED AROUND
-- -----------------------------------
-- `drizzle-kit push` does NOT detect a changed CHECK when the constraint NAME is
-- unchanged. Both CHECKs below keep their names and change their predicates, so
-- neither push nor any redefinition-in-place would move them: each needs an explicit
-- `DROP CONSTRAINT` followed by `ADD CONSTRAINT`. A file that merely re-stated them
-- would no-op in silence and leave the database disagreeing with the schema it is meant
-- to match — the failure mode
-- `job-opportunities-store-forward-ddl.integration.spec.ts` exists to make loud.
--
-- What it changes (three objects, nothing else)
-- ---------------------------------------------
--   1. `job_queue_action_kind` gains `REASON_REDACTED` — APPENDED LAST. Order is
--      load-bearing: the equivalence spec pins `enumsortorder = 14` from both sides.
--   2. `job_queue_actions.subject_action_id` — new `uuid`, NULLABLE, NO DEFAULT, and
--      deliberately NO FOREIGN KEY. The absence is the design, not an omission: the
--      subject row is OLDER than its evidence row and so falls due for the two-year
--      purge up to two years earlier. `RESTRICT` (23503 at once) and `NO ACTION` (at
--      end of statement) would each abort the whole purge, and a retention job that
--      cannot run is a storage-limitation breach; `SET NULL` is an UPDATE, which the
--      append-only trigger refuses; `CASCADE` would erase audit through a cascade — the
--      one thing every other FK on this table is RESTRICT to prevent. A dangling id
--      after the subject is purged is the INTENDED end state. A test pins this table's
--      foreign-key count at 7, so "fixing" this by adding an eighth fails loudly.
--      DO NOT ADD ONE HERE.
--   3. `ck_job_queue_actions_target` and `ck_job_queue_actions_versions` — one new
--      branch each, plus a `kind <> 'REASON_REDACTED'` conjunct on each catch-all. That
--      conjunct is the clause most likely to be deleted as redundant, AND IT IS NOT:
--      without it the new kind satisfies the catch-all and becomes effectively
--      unconstrained — a redaction could carry an opportunity instead of a subject
--      action, or a fabricated moving version pair. Each is pinned by a test.
--
-- No INDEX is added on `subject_action_id`: by this table's own stated rule an index
-- exists for an FK probe or for a shipped reader, and here there is neither.
--
-- Not here, deliberately: `crm_retention_redact_action_reason` still performs NO
-- INSERT. Writing the evidence row is r5 Task 1.4b-iii, which needs an actor the
-- function's signature cannot name — an owner decision, NOT a reason to make `actor_id`
-- nullable. A GAP PIN goes red the day that lands.
--
-- Idempotency contract (as part 1: every `manual/*.sql` is applied on EVERY deploy)
-- --------------------------------------------------------------------------------
--   * `ALTER TYPE ... ADD VALUE IF NOT EXISTS` — a no-op on the second apply.
--   * `ADD COLUMN IF NOT EXISTS` — likewise. The column is nullable with no default, so
--     PG adds it without rewriting the table.
--   * the two CHECKs are DROPPED and re-ADDED on every apply. `ADD CONSTRAINT` has no
--     `IF NOT EXISTS` form, and a drop-then-add is idempotent by construction: it
--     CONVERGES on the definition written here instead of keeping whatever is already
--     there, which is precisely what part 1's name-keyed guard cannot do.
--   * each drop+add pair is wrapped in an explicit transaction, so there is NO window in
--     which the table sits with its constraint missing. Re-adding VALIDATES against
--     existing rows under ACCESS EXCLUSIVE — both predicates are narrower only for
--     `REASON_REDACTED`, a kind no existing row can carry, so every existing row
--     satisfies them and no `NOT VALID` / `VALIDATE` dance is needed. `convalidated`
--     stays true, which is what `db:push` produces and what the equivalence spec pins.
--
-- MUST NOT be applied with `psql -1` / `--single-transaction`
-- ----------------------------------------------------------
-- A new enum value cannot be USED in the transaction that added it, and the CHECK
-- predicates below name `'REASON_REDACTED'` as a literal. Applied as one transaction
-- this file fails loudly at the first `ADD CONSTRAINT`; it corrupts nothing.
-- `deploy.yml` applies it as `psql -v ON_ERROR_STOP=1 < file` — statement-level
-- autocommit — so the `ALTER TYPE` has committed before any CHECK is added. Same
-- constraint, same reason, as 2026-10-05_vacancy_sourcing_schema.sql.
--
-- Order: apply AFTER 2026-10-17_job_opportunities_store.sql, which creates the objects
-- this file alters. On a fresh database part 1 already produces the final shape, and
-- every statement here is then a no-op except the two drop-and-adds, which re-add what
-- is already there with a byte-identical `pg_get_constraintdef`.
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-10-21_job_queue_reason_redacted.sql
--
-- On production this is not run by hand: it is wired into .github/workflows/deploy.yml
-- as a hard-required apply step, after both parts of the store.
-- =============================================================================

SET lock_timeout = '10s';
SET statement_timeout = '5min';


-- ---------------------------------------------------------------------------
-- 1. The enum value — appended last, never inserted among the queue kinds
-- ---------------------------------------------------------------------------

ALTER TYPE "job_queue_action_kind" ADD VALUE IF NOT EXISTS 'REASON_REDACTED';


-- ---------------------------------------------------------------------------
-- 2. The subject column — nullable uuid, no default, NO foreign key (see header)
-- ---------------------------------------------------------------------------

ALTER TABLE "job_queue_actions" ADD COLUMN IF NOT EXISTS "subject_action_id" uuid;


-- ---------------------------------------------------------------------------
-- 3. ck_job_queue_actions_target — a third branch; BOTH pre-existing branches gain
--    `subject_action_id IS NULL`, so the new column belongs to the redaction kind
--    alone; the catch-all gains `kind <> 'REASON_REDACTED'`
--
-- `subject_action_id <> id` (SR-M-2 of the security review on PR #1075): a redaction
-- may not name ITSELF as its subject. An evidence row that is its own subject is not
-- evidence of anything, and the first draft of this branch admitted it. Both operands
-- are non-NULL where the clause is evaluated — `id` is the primary key and the branch
-- has already required the subject — so there is no UNKNOWN-passes-a-CHECK trap of the
-- kind constraint 4 below documents.
--
-- WHY DROP-AND-ADD RATHER THAN `NOT VALID` + `VALIDATE`, decided rather than defaulted.
-- `NOT VALID` followed by `VALIDATE CONSTRAINT` is the right pattern on a BIG table: it
-- avoids the full scan under ACCESS EXCLUSIVE and validates later under a weaker lock.
-- It is not taken here, for two reasons:
--   * `job_queue_actions` is EMPTY on production — nothing writes it yet — so the scan
--     this would avoid costs nothing, and the plain ADD is instant;
--   * the equivalence spec compares `convalidated`, and the security review measured all
--     eight CHECKs on the migrated database as validated. A `NOT VALID` whose `VALIDATE`
--     is forgotten leaves a constraint that EXISTS AND ENFORCES NOTHING for every
--     pre-existing row — a guard present and not guarding, which is the one outcome
--     worth more than the lock it saves. Taking the pattern would mean taking both
--     statements, and the cheaper shape here is to take neither.
-- The window of the DROP-and-ADD was measured closed by the review: a concurrent writer
-- attempting the very insert the constraint would refuse blocks on ACCESS EXCLUSIVE and
-- cannot slip through, and this file's `lock_timeout` bounds the wait.
--
-- THE PREDICATE IS STRICTER THAN THE POPULATION MAY BE. `ADD CONSTRAINT` scans existing
-- rows, so a row already holding `subject_action_id = id` would make this statement fail
-- — correctly, and loudly. There are none today because the table is empty and no code
-- path writes it; that is stated here rather than relied on silently, because it stops
-- being true the moment r5 Task 1.4b-iii wires the INSERT.
-- ---------------------------------------------------------------------------

BEGIN;
ALTER TABLE "job_queue_actions" DROP CONSTRAINT IF EXISTS "ck_job_queue_actions_target";
ALTER TABLE "job_queue_actions" ADD CONSTRAINT "ck_job_queue_actions_target" CHECK (("job_queue_actions"."kind" IN ('TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED') AND "job_queue_actions"."opportunity_id" IS NULL AND "job_queue_actions"."subscription_id" IS NOT NULL AND "job_queue_actions"."source_record_id" IS NULL AND "job_queue_actions"."subject_action_id" IS NULL)
          OR ("job_queue_actions"."kind" = 'REASON_REDACTED' AND "job_queue_actions"."subject_action_id" IS NOT NULL AND "job_queue_actions"."subject_action_id" <> "job_queue_actions"."id" AND "job_queue_actions"."opportunity_id" IS NULL AND "job_queue_actions"."subscription_id" IS NULL AND "job_queue_actions"."source_record_id" IS NULL)
          OR ("job_queue_actions"."kind" NOT IN ('TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED') AND "job_queue_actions"."kind" <> 'REASON_REDACTED' AND "job_queue_actions"."opportunity_id" IS NOT NULL AND "job_queue_actions"."subscription_id" IS NULL AND "job_queue_actions"."subject_action_id" IS NULL));
COMMIT;


-- ---------------------------------------------------------------------------
-- 4. ck_job_queue_actions_versions — a both-versions-NULL branch for the evidence
--    row, and the catch-all narrowed so it can never fabricate a moving pair
-- ---------------------------------------------------------------------------

BEGIN;
ALTER TABLE "job_queue_actions" DROP CONSTRAINT IF EXISTS "ck_job_queue_actions_versions";
ALTER TABLE "job_queue_actions" ADD CONSTRAINT "ck_job_queue_actions_versions" CHECK (("job_queue_actions"."kind" IN ('OPENED', 'DEAD_LINK', 'SPAM') AND "job_queue_actions"."before_version" IS NULL AND "job_queue_actions"."after_version" IS NULL)
          OR ("job_queue_actions"."kind" = 'SUPPRESSED' AND "job_queue_actions"."before_version" IS NULL AND "job_queue_actions"."after_version" IS NULL)
          OR ("job_queue_actions"."kind" = 'REASON_REDACTED' AND "job_queue_actions"."before_version" IS NULL AND "job_queue_actions"."after_version" IS NULL)
          OR ("job_queue_actions"."kind" NOT IN ('OPENED', 'DEAD_LINK', 'SPAM') AND "job_queue_actions"."kind" <> 'REASON_REDACTED' AND "job_queue_actions"."before_version" IS NOT NULL AND "job_queue_actions"."after_version" IS NOT NULL AND "job_queue_actions"."before_version" >= 0 AND "job_queue_actions"."after_version" > "job_queue_actions"."before_version"));
COMMIT;
