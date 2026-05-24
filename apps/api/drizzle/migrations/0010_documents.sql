-- Migration: PHASE 6 — Documents table (file metadata).
--
-- Creates the `documents` table that backs all uploads (resumes, scans,
-- contracts, receipts, avatars, logos). File bytes live in S3/MinIO; this
-- table tracks metadata + the immutable `s3_key`. Soft delete is two-stage:
-- owner/ADMIN soft-delete sets deleted_at + deleted_by; ADMIN-only hard
-- delete then removes the S3 object and the DB row.
--
-- FK references from users.avatar_document_id / projects.logo_document_id /
-- transactions.receipt_document_id are added in subsequent migrations
-- (0011_transactions_receipt_refactor, 0012_users_avatar_doc_fk,
-- 0013_projects_logo_doc_fk). This migration is self-contained.
--
-- CONTRACT-requires-projectId is enforced in the Zod schema (not as a CHECK
-- constraint) so validation errors are human-readable and the migration is
-- safe to apply on partially-seeded DBs.

--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."document_category" AS ENUM('RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'AVATAR', 'LOGO');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"category" "document_category" NOT NULL,
	"name" varchar(255) NOT NULL,
	"s3_key" varchar(512) NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime_type" varchar(64) NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"deleted_at" timestamp,
	"deleted_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "documents_s3_key_unique" UNIQUE("s3_key")
);

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_documents_owner" ON "documents" USING btree ("owner_id") WHERE "documents"."deleted_at" IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_documents_project" ON "documents" USING btree ("project_id") WHERE "documents"."deleted_at" IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_documents_category" ON "documents" USING btree ("category");
