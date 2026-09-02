-- =============================================================================
-- projects.status + visible_projects VIEW — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- Position 4 of docs/superpowers/specs/2026-09-01-notifications-and-
-- confirmations-design.md §4.2/§6 — a project starts life as a DRAFT and
-- only becomes ACTIVE once every invited approver (the project's senior +
-- drop, if any — see `approvals`, subjectType 'PROJECT', PR #624) confirms
-- it. Today a project is fully active the instant an ADMIN/HR creates it; the
-- employee whose share it affects finds out after the fact.
--
-- Two changes, shipped together because the second depends on the first:
--   1. `projects.status` — a THIRD, explicit lifecycle enum column. NOT a
--      replacement for `archived_at` — the two are deliberately separate
--      axes (see schema.ts's own comment on this column for the full
--      reasoning: collapsing "not yet confirmed" into "finished" is exactly
--      the bug this column exists to prevent).
--   2. `visible_projects` — a VIEW exposing only `status = 'ACTIVE' AND
--      archived_at IS NULL` rows. Same "eliminate, don't detect" shape as
--      `non_deleted_transactions` (2026-08-03_non_deleted_transactions_view.sql)
--      — see that migration's own header for the review history this
--      pattern comes from.
--
-- Existing projects
-- -----------------
-- EVERY project that already exists today was, by definition, never subject
-- to this gate — none of them should turn into an invisible, unconfirmable
-- draft the moment this column ships. The column's DEFAULT ('ACTIVE') does
-- this backfill AS PART OF the single `ADD COLUMN` statement below — Postgres
-- applies a constant DEFAULT to every existing row atomically, in the same
-- DDL statement, with no separate per-row UPDATE that could leave some rows
-- migrated and others not. There is no partial-success state for this step:
-- it is one statement, it either fully commits or the whole script aborts
-- (`ON_ERROR_STOP=1`) before touching anything after it.
--
-- The VERIFY block below still checks the row counts explicitly (not because
-- this shape can silently skip a row — it structurally cannot — but because
-- an unverified "it worked" is exactly the lesson of PR #623: a migration
-- that does not check its own work looks identical, in its own output, to
-- one that quietly did the wrong thing).
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-09-02_project_status.sql
--
-- Wired into .github/workflows/deploy.yml (rollback-preflight file list, SCP
-- copy step, psql apply step) in this SAME PR — mirrors 2026-09-01_approvals.sql
-- exactly, for the same reason (CR-H-2, code-review PR #624): without the
-- column, the code in this PR does not work; shipping the DDL and its
-- deploy-pipeline wiring in two PRs would leave a window where prod 500s the
-- moment the image ships. `scripts/devops/check-prod-ddl-wiring.py` verifies
-- both the COPY and the APPLY step exist (not just a comment naming the file).
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` (Postgres has this natively, unlike
-- `ADD CONSTRAINT`) + `CREATE OR REPLACE VIEW` — safe to re-run any number of
-- times, on every deploy, forever.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enum (guarded CREATE for idempotency — Postgres has no
--    `CREATE TYPE IF NOT EXISTS`, same idiom as 2026-09-01_approvals.sql).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE project_status AS ENUM ('DRAFT', 'ACTIVE', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 2. projects.status — additive column, NOT NULL with a DEFAULT so every
--    existing row backfills to 'ACTIVE' atomically as part of THIS statement.
-- -----------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status project_status NOT NULL DEFAULT 'ACTIVE';

-- -----------------------------------------------------------------------------
-- 3. visible_projects — read surface for every module that is not the
--    projects/** home module or a named admin/approver narrow path.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW visible_projects AS
SELECT * FROM projects WHERE status = 'ACTIVE' AND archived_at IS NULL;

-- =============================================================================
-- VERIFY (after applying) — fail loudly, not "applied successfully" on a
-- silently wrong result (lesson from PR #623, two review rounds):
--
--   -- 1. Column + enum exist:
--   SELECT column_name, data_type FROM information_schema.columns
--     WHERE table_name = 'projects' AND column_name = 'status';
--   SELECT unnest(enum_range(NULL::project_status));              -- 3 rows
--
--   -- 2. Every pre-existing project migrated to ACTIVE — no row was silently
--   --    skipped or left with an unexpected status. If this prints anything
--   --    other than a single ACTIVE row, STOP and investigate before
--   --    treating the migration as successful:
--   SELECT status, count(*) FROM projects GROUP BY status;
--
--   -- 3. The view exists and its row count matches the ACTIVE+non-archived
--   --    count computed independently (two different queries must agree):
--   SELECT viewname FROM pg_views WHERE viewname = 'visible_projects';
--   SELECT count(*) FROM visible_projects;
--   SELECT count(*) FROM projects WHERE status = 'ACTIVE' AND archived_at IS NULL;
--
--   -- 4. VERIFY-only, NOT for the deploy log (no personal data in CI output):
--   --    run this BY HAND if step 2 above shows anything unexpected, to see
--   --    WHICH projects need attention. Never pipe this into a script whose
--   --    output reaches a public log.
--   SELECT id, name, status FROM projects WHERE status <> 'ACTIVE';
-- =============================================================================
--
-- Rollback (feature-level; only if this feature is being reverted entirely —
-- dropping the column loses no data other than this feature's own field,
-- since every pre-existing row was 'ACTIVE' before this column existed):
--   DROP VIEW IF EXISTS visible_projects;
--   ALTER TABLE projects DROP COLUMN IF EXISTS status;
--   DROP TYPE IF EXISTS project_status;
-- =============================================================================
