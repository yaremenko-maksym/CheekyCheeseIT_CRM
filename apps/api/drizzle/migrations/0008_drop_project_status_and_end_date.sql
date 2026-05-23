-- Migration: Drop `status` enum/column and `end_date` column from projects.
--
-- Round 5 design pivot: project lifecycle reduces to ACTIVE (default) vs.
-- ARCHIVED (archivedAt timestamp). There is no longer a CLOSED business
-- contract state; `archivedAt` doubles as "when the project ended". The
-- previous CLOSED rows are kept as ACTIVE — admins can manually archive
-- them through the UI.
--
-- Order is important: drop the column first (so the enum has no consumers),
-- then drop the enum, then drop end_date. All wrapped in idempotent guards
-- so re-running the migration in a partially-applied DB is safe.

--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "status";

--> statement-breakpoint
DROP TYPE IF EXISTS "project_status";

--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "end_date";
