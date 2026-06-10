-- Migration 0009: Repoint legends from per-user to per-project
-- Add legend_entries journal table
-- Safe: legends table was empty (0 rows confirmed via postgres MCP)
--> statement-breakpoint
ALTER TABLE "legends" DROP CONSTRAINT IF EXISTS "legends_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "legends" DROP CONSTRAINT IF EXISTS "legends_user_id_unique";
--> statement-breakpoint
ALTER TABLE "legends" DROP COLUMN IF EXISTS "user_id";
--> statement-breakpoint
ALTER TABLE "legends" ADD COLUMN "project_id" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "legends" ADD COLUMN "presented_role" text;
--> statement-breakpoint
ALTER TABLE "legends" ADD COLUMN "presented_stack" text;
--> statement-breakpoint
ALTER TABLE "legends" ADD COLUMN "backstory" text;
--> statement-breakpoint
ALTER TABLE "legends" ADD CONSTRAINT "legends_project_id_unique" UNIQUE("project_id");
--> statement-breakpoint
ALTER TABLE "legends" ADD CONSTRAINT "legends_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "legend_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legend_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legend_entries_legend_id_legends_id_fk" FOREIGN KEY ("legend_id") REFERENCES "public"."legends"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "legend_entries_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action
);
