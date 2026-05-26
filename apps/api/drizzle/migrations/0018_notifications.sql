-- 0018_notifications.sql
--
-- Invoice Signing Epic — data layer step 3: in-app notifications.
--
-- General-purpose notification feed (server-side persistence replaces the
-- PHASE 1 in-memory NotificationsContext stub on the front-end). Triggered
-- by the InvoicesService for now (`INVOICE_SIGN_REQUIRED`,
-- `INVOICE_SIGNED`); future epics will reuse the same table for other
-- events without further migrations.
--
-- Design notes:
--   * `type` is VARCHAR(50) — not an enum — to keep the migration forward-
--      compatible. New event types only require shared Zod additions, no
--      DB migration. Each emitter validates against the Zod enum.
--   * `link` is a relative front-end path like `/crm/finance/invoices/:id`.
--      Click on a notification in the header dropdown navigates to it.
--   * `read_at` NULL = unread; timestamp = when the user marked it read.
--   * ON DELETE CASCADE on user_id — deleting a user wipes their feed
--      (no orphan notifications visible to nobody).
--
-- Indexes:
--   * Partial unread index (filtered on read_at IS NULL) — drives the
--      header colokol'chik unread-count query and the "unread only"
--      filter on the listing endpoint.
--   * (user_id, created_at DESC) composite — drives the chronological
--      listing inside the dropdown (10 most recent for the current user).

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(50) NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text,
	"link" varchar(500),
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk"
   FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_user_unread"
  ON "notifications" USING btree ("user_id")
  WHERE "read_at" IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_user_created"
  ON "notifications" USING btree ("user_id", "created_at" DESC);
