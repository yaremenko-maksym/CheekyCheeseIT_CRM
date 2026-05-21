-- Migration: Archive infrastructure for teams + projects + team_members + audit log mirror
-- Adds soft archive columns + audit log tables mirroring user_audit_log shape.

--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "archived_at" timestamp;
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "left_at" timestamp;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp;

--> statement-breakpoint
CREATE TABLE "team_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"target_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "team_audit_log" ADD CONSTRAINT "team_audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "team_audit_log" ADD CONSTRAINT "team_audit_log_target_id_teams_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_audit_log_target_id_idx" ON "team_audit_log" USING btree ("target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_audit_log_created_at_idx" ON "team_audit_log" USING btree ("created_at");

--> statement-breakpoint
CREATE TABLE "project_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"target_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_audit_log" ADD CONSTRAINT "project_audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_audit_log" ADD CONSTRAINT "project_audit_log_target_id_projects_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_audit_log_target_id_idx" ON "project_audit_log" USING btree ("target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_audit_log_created_at_idx" ON "project_audit_log" USING btree ("created_at");
