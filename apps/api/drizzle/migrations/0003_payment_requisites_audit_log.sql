-- Migration: payment requisites + audit log + backfill wallet_address
-- Replaces wallet_address (varchar) with structured payment fields
-- Converts tech_stack from varchar(100) to text[]
-- Adds user_audit_log table

--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('USDT_ERC20', 'BANK_UAH_FOP');

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "payment_method" "payment_method";
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wallet_usdt_erc20" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wallet_usdt_label" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bank_uah_recipient" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bank_uah_iban" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bank_uah_rnokpp" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bank_uah_bank_name" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archived_at" timestamp;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "admin_note" text;

--> statement-breakpoint
-- Backfill legacy wallet_address into new USDT field
UPDATE "users"
SET "wallet_usdt_erc20" = "wallet_address",
    "payment_method" = 'USDT_ERC20'
WHERE "wallet_address" IS NOT NULL;

--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "wallet_address";

--> statement-breakpoint
-- Convert tech_stack from varchar(100) to text[]
-- Drop and re-add since varchar cannot be directly cast to text[]
ALTER TABLE "users" DROP COLUMN "tech_stack";
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tech_stack" text[];

--> statement-breakpoint
CREATE TABLE "user_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"target_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_audit_log" ADD CONSTRAINT "user_audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_audit_log" ADD CONSTRAINT "user_audit_log_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX "user_audit_log_target_id_idx" ON "user_audit_log" USING btree ("target_id");
