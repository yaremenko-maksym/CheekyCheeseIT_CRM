-- Senior roles 3b (plan docs/superpowers/plans/2026-11-16-senior-roles.md, Task 3.4 / 6.1): the
-- partial index the role-AI candidate scan reads.
--
-- WHAT THIS FILE DOES
--   Creates ONE object: idx_job_opportunities_role_pending, a PARTIAL btree index on
--   job_opportunities (last_observed_at DESC, id) WHERE role_status = 'PENDING'.
--   It serves `candidates` in job-sourcing/role-ai/role-ai.store.ts, whose shape is
--   `WHERE o.role_status = 'PENDING' AND <…> ORDER BY o.last_observed_at DESC, o.id LIMIT n`:
--   the predicate matches the query's own, and the key order matches the ORDER BY, so the LIMIT is
--   answered from the index instead of sorting every PENDING row. The query's remaining conjuncts
--   (classifier version, availability, the FAILED-cache NOT EXISTS) stay heap filters — none of
--   them is selective enough on its own to be worth a key column, and adding one would stop the
--   index from serving the ORDER BY. Reviewers of PR #1382 asked for this index; it was deferred
--   to the flag-enable PR, which is this one.
--
-- The Drizzle declaration is the `idx_job_opportunities_role_pending` index in
-- schema/job-opportunities.ts; dev and CI get it through db:push.
--
-- ORDER
--   AFTER manual/2026-11-17_technical_roles.sql, which adds the `role_status` column the predicate
--   reads. Applied before it, this file fails with 42703 (undefined_column).
--
-- WHY NOT CONCURRENTLY
--   The deploy applies this file in its own transaction (`psql -v ON_ERROR_STOP=1
--   --single-transaction < <file>`, one such call per file in deploy-stack-on-vps.sh), and CREATE
--   INDEX CONCURRENTLY cannot run inside a transaction block — it would abort this file's apply
--   with 25001. The transaction is also what makes the SET LOCAL below take effect, so the file
--   must keep being applied with --single-transaction.
--   The plain build is acceptable here because the table is small and the build is short: a plain
--   build holds a ShareLock on job_opportunities (concurrent reads continue, writes wait) only for
--   that time. The file it follows, 2026-11-17_technical_roles.sql, already builds the GIN index on
--   this same table plainly, so this adds no new class of deploy pause.
--   Verification condition: if job_opportunities ever grows to where this build is a visible deploy
--   stall, move the file out of the transactional apply and rewrite it as CONCURRENTLY with the
--   INVALID-leftover sweep of 2026-11-02_job_dirty_work_pending_partial.sql.
--
-- APPLY
--   The role-AI pass's candidate query reads it, so it SHOULD run before the container swap; being
--   only an index, a deploy that applied it late is slow, never wrong.
--   psql -v ON_ERROR_STOP=1 --single-transaction < 2026-11-18_job_opportunities_role_pending_index.sql
--   Re-runnable: IF NOT EXISTS, so a second apply is a no-op.
--   Rollback: DROP INDEX IF EXISTS idx_job_opportunities_role_pending. Nothing but the planner
--   reads it, so dropping it slows the candidate scan and changes no result.

SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_job_opportunities_role_pending
  ON job_opportunities (last_observed_at DESC, id)
  WHERE role_status = 'PENDING';
