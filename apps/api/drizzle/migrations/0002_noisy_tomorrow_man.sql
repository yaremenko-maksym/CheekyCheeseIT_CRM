CREATE TYPE "public"."employee_contract_status" AS ENUM('DRAFT', 'READY_TO_SIGN', 'SIGNED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "employee_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_template_id" uuid NOT NULL,
	"body_markdown" text NOT NULL,
	"status" "employee_contract_status" DEFAULT 'DRAFT' NOT NULL,
	"signed_contract_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_source_template_id_contract_templates_id_fk" FOREIGN KEY ("source_template_id") REFERENCES "public"."contract_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_signed_contract_id_signed_contracts_id_fk" FOREIGN KEY ("signed_contract_id") REFERENCES "public"."signed_contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_contracts_user_status_idx" ON "employee_contracts" USING btree ("user_id","status");--> statement-breakpoint
-- MED-1 safety: use IF NOT EXISTS so this migration is idempotent on production.
-- Before applying on prod, verify no duplicate receipt_document_id values exist:
--   SELECT receipt_document_id, COUNT(*) FROM transactions
--   WHERE receipt_document_id IS NOT NULL
--   GROUP BY 1 HAVING COUNT(*) > 1;
-- If duplicates are found, a manual cleanup step is required before this migration.
-- As of 2026-06-06, local DB shows zero duplicates (confirmed via postgres MCP query).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_transactions_receipt_document_id" ON "transactions" USING btree ("receipt_document_id") WHERE "transactions"."receipt_document_id" IS NOT NULL;