-- 0020_drop_role_and_schema.sql
--
-- Drop role - phase 1. Strictly additive: existing senior/team/project
-- behavior is unchanged. This migration adds:
--   * role enum value `'DROP'` (5 → 6 values).
--   * users.drop_share_percent (int, nullable, default 5) — DROP's cut.
--   * team_type enum (`'SENIOR' | 'DROP'`).
--   * teams.type (NOT NULL, default 'SENIOR') + backfill of existing rows.
--   * projects.drop_id (uuid, nullable, FK users ON DELETE RESTRICT).
--
-- Why nullable on users.drop_share_percent and projects.drop_id:
--   * The column applies only to DROP users / drop-projects. Existing
--     non-DROP rows must remain valid without a default value carrying a
--     business meaning.
--
-- Why RESTRICT on projects.drop_id:
--   * Soft delete is the rule everywhere (archivedAt). RESTRICT guards
--     against any future hard delete of a DROP user accidentally orphaning
--     a drop-project's financial routing — surfacing as an explicit FK
--     error instead of silent NULL.

--> statement-breakpoint
ALTER TYPE "role" ADD VALUE IF NOT EXISTS 'DROP';

--> statement-breakpoint
CREATE TYPE "team_type" AS ENUM ('SENIOR', 'DROP');

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "drop_share_percent" integer DEFAULT 5;

--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "type" "team_type" DEFAULT 'SENIOR' NOT NULL;

--> statement-breakpoint
-- Defensive backfill: ALTER … DEFAULT already populates existing rows,
-- but we run UPDATE explicitly to keep the migration safe to re-run on
-- environments where the column was previously added without a default.
UPDATE "teams" SET "type" = 'SENIOR' WHERE "type" IS NULL;

--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "drop_id" uuid;

--> statement-breakpoint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_drop_id_users_id_fk"
  FOREIGN KEY ("drop_id") REFERENCES "users"("id") ON DELETE RESTRICT;
