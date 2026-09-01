-- =============================================================================
-- Approvals — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- Position 3 of docs/superpowers/specs/2026-09-01-notifications-and-
-- confirmations-design.md — the foundation registry for "actions touching an
-- employee's money or responsibility do not take effect until they agree in
-- the CRM". ONE brand new table + 1 new enum — fully additive, no existing
-- table/column touched. Empty on ship (no caller wires a real subject yet —
-- that is positions 4/5 of the plan), so this migration carries zero data
-- risk: nothing currently running depends on this table, and nothing in it
-- can be wrong yet.
--
-- Shipped in the SAME PR as the table's own service/tests, not deferred to
-- "whichever position adds the first caller" — a plan to add prod DDL
-- together with a LATER PR is exactly the unenforced hand-off this repo's
-- own guards (check-prod-ddl-wiring.py, check-db-push-guard-wiring.py, …)
-- exist to replace: a comment nobody is forced to re-read. The table is
-- additive and empty, so shipping it now costs nothing and removes that
-- dependency entirely — task-approvals-foundation review (coordinator,
-- 2026-09-01).
--
-- The dev/CI database gets these changes via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push, see `.github/workflows/ci.yml`). The prod image does NOT
-- ship drizzle-kit, so prod is migrated with THIS script (same pattern as
-- `2026-07-26_csp_reports.sql`).
--
-- How to apply
-- ------------
-- From the VPS (or any host with Docker access to the prod stack):
--
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-09-01_approvals.sql
--
-- DEPENDENCY (DevOps): add this file to the SCP `source:` list AND to a step
-- in .github/workflows/deploy.yml that invokes psql against it — same two-part
-- wiring `scripts/devops/check-prod-ddl-wiring.py` verifies for every other
-- file in this directory (COPY + APPLY, not just a comment mentioning the
-- filename). Out of Coder zone-of-write (`.claude/rules/common/zone-of-write.md`
-- — `.github/workflows/**` is DevOps-owned); this PR ships the script + this
-- note only, same division of labour as `2026-07-26_csp_reports.sql` /
-- `infra/csp-report-wiring` (coordinated via a companion DevOps PR, #430 in
-- that precedent).
--
-- Idempotent: guarded `CREATE TYPE` (duplicate_object exception swallowed) +
-- `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX/CONSTRAINT IF NOT EXISTS`
-- (constraints via a guarded DO block, Postgres has no `ADD CONSTRAINT IF NOT
-- EXISTS`) — safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enum (guarded CREATE for idempotency)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE approval_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 2. approvals — one proposal = one row per approver (see the `approvals`
--    table's own header comment in schema.ts for the full design reasoning).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type         varchar(50) NOT NULL,
  subject_id           uuid NOT NULL,
  approver_user_id     uuid NOT NULL REFERENCES users(id),
  status               approval_status NOT NULL DEFAULT 'PENDING',
  rejection_reason     text,
  decided_at           timestamptz,
  proposed_by_user_id  uuid NOT NULL REFERENCES users(id),
  superseded_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Drives "history for this subject" reads (admin re-propose screen, audit).
CREATE INDEX IF NOT EXISTS idx_approvals_subject
  ON approvals (subject_type, subject_id);

-- Drives "what's waiting on me" (Экран «что от меня ждут», position 7).
CREATE INDEX IF NOT EXISTS idx_approvals_approver_pending
  ON approvals (approver_user_id)
  WHERE status = 'PENDING' AND superseded_at IS NULL;

-- Race guard: at most one LIVE row per (subject, approver) at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_approvals_live_subject_approver
  ON approvals (subject_type, subject_id, approver_user_id)
  WHERE superseded_at IS NULL;

-- "Отказ возможен и требует причины" (§3.3) — enforced at the DB, not just
-- the Zod DTO, because this table is a shared registry future callers reach
-- directly. Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so the guard is
-- a DO block swallowing the duplicate-object exception, same idiom as the
-- enum above.
DO $$
BEGIN
  ALTER TABLE approvals ADD CONSTRAINT ck_approvals_rejection_reason_required
    CHECK (status <> 'REJECTED' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- decidedAt is set exactly when a row leaves PENDING — never before, never
-- left null after.
DO $$
BEGIN
  ALTER TABLE approvals ADD CONSTRAINT ck_approvals_decided_at_matches_status
    CHECK ((status = 'PENDING') = (decided_at IS NULL));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- VERIFY (after applying):
--   SELECT to_regclass('public.approvals');                       -- not null
--   SELECT unnest(enum_range(NULL::approval_status));              -- 3 rows
--   SELECT indexname FROM pg_indexes WHERE tablename = 'approvals';
--   SELECT conname FROM pg_constraint WHERE conrelid = 'approvals'::regclass AND contype = 'c';
-- =============================================================================
--
-- Rollback (feature-level, no prod data expected — table ships empty):
--   DROP TABLE IF EXISTS approvals;
--   DROP TYPE IF EXISTS approval_status;
-- =============================================================================
