-- Role-AI spend (spec docs/superpowers/specs/2026-11-19-role-ai-spend-design.md §1, plan
-- docs/superpowers/plans/2026-11-19-role-ai-relevance-gate.md Task 3): the terminal role status
-- OUT_OF_SCOPE.
--
-- WHAT THIS FILE DOES
--   Widens ONE constraint: ck_job_opportunities_role_status on job_opportunities gains the value
--   'OUT_OF_SCOPE'. The recompute worker's role-scope gate (job-sourcing/funnel/role-scope-gate.ts)
--   writes it for a vacancy the rule left unclassified and no senior of the current roster could
--   take; such a row is hidden like PENDING and never sent to the role-AI pass. OUT_OF_SCOPE carries
--   no roles, which ck_job_opportunities_roles_iff_status already requires of every status other
--   than RULE / AI: that constraint is not touched.
--
-- The Drizzle declaration is the `ck_job_opportunities_role_status` check in
-- schema/job-opportunities.ts; dev and CI get it through db:push.
--
-- ORDER
--   AFTER manual/2026-11-17_technical_roles.sql (adds the role_status column and the 5-value
--   CHECK) and manual/2026-11-18_job_opportunities_role_pending_index.sql. BEFORE the app that
--   writes 'OUT_OF_SCOPE' starts: applied after it, every gated recompute fails with 23514.
--
-- IDEMPOTENT
--   DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT in one transaction (the deploy applies each file with
--   `psql -v ON_ERROR_STOP=1 --single-transaction`), so a second apply rebuilds the same CHECK.
--   Re-adding validates every row under an ACCESS EXCLUSIVE lock; the table is small and the
--   check is a scan of one text column.
--
-- ROLLBACK
--   Move the rows back, then restore the 5-value CHECK:
--     UPDATE job_opportunities SET role_status = 'PENDING' WHERE role_status = 'OUT_OF_SCOPE';
--     ALTER TABLE job_opportunities DROP CONSTRAINT IF EXISTS ck_job_opportunities_role_status;
--     ALTER TABLE job_opportunities ADD CONSTRAINT ck_job_opportunities_role_status
--       CHECK (role_status IS NULL OR role_status IN ('RULE', 'AI', 'PENDING', 'UNCLEAR', 'NON_IT'));

SET LOCAL lock_timeout = '10s';
ALTER TABLE job_opportunities DROP CONSTRAINT IF EXISTS ck_job_opportunities_role_status;
ALTER TABLE job_opportunities ADD CONSTRAINT ck_job_opportunities_role_status
  CHECK (role_status IS NULL OR role_status IN ('RULE', 'AI', 'PENDING', 'UNCLEAR', 'NON_IT', 'OUT_OF_SCOPE'));
