-- 0016_invoice_category_and_fk.sql
--
-- Invoice Signing Epic — data layer step 1:
--   1. Extend `document_category` enum with `INVOICE` value (7 total).
--      Generated PDF invoices are stored as Documents (category = INVOICE)
--      to reuse the existing S3 + presigned download pipeline; the file
--      bytes never leave the documents pipeline.
--   2. Add `transactions.invoice_document_id` FK → documents(id) so each
--      SENIOR_INCOME / SALARY transaction can point at its currently-active
--      invoice PDF. ON DELETE SET NULL keeps the transaction row intact if
--      the invoice document is hard-deleted (e.g. by ADMIN cleanup).
--   3. Partial index on the FK (NOT NULL only) — used by /api/invoices to
--      list transactions with an attached invoice without scanning the
--      whole transactions table.
--
-- The FK in `apps/api/src/database/schema.ts` is declared inline next to
-- the column (we already import `documents` in the same module so there's
-- no circular reference like the avatar/logo case).
--
-- INVOICE Documents are treated as INTERNAL_CATEGORIES on the front-end
-- (managed only from `/crm/finance/invoices` UI, hidden from the global
-- `/crm/documents` list) — that wiring lives in PHASE 6 RBAC code, not in
-- this migration.

--> statement-breakpoint
ALTER TYPE "document_category" ADD VALUE IF NOT EXISTS 'INVOICE';

--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "invoice_document_id" uuid;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_invoice_document_id_documents_id_fk"
   FOREIGN KEY ("invoice_document_id") REFERENCES "public"."documents"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transactions_invoice"
  ON "transactions" USING btree ("invoice_document_id")
  WHERE "invoice_document_id" IS NOT NULL;
