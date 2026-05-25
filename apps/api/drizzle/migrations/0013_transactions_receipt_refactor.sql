-- Migration: PHASE 6 — refactor `transactions.receipt_url` into a typed pair.
--
-- Replaces the legacy `receipt_url` text column with two mutually exclusive
-- fields that match the PHASE 6 receipt-handling rules:
--
--   * `receipt_document_id` — FK to `documents` (category = RECEIPT). Used
--     when the user uploaded a chequed image / PDF through the documents
--     API. ON DELETE SET NULL: hard-deleting the receipt document leaves
--     the transaction intact, the row simply shows "no receipt".
--
--   * `receipt_external_url` — free-form URL for external proofs (e.g.
--     Etherscan TX hash, Wise transfer screenshot link). Text, no FK.
--
-- A row-level CHECK enforces that AT MOST ONE of the two is populated:
--   (receipt_document_id IS NULL OR receipt_external_url IS NULL)
-- Both NULL is allowed (transaction without receipt — same semantics as
-- before).
--
-- Fresh-DB strategy: NO UPDATE backfill. The old `receipt_url` column is
-- dropped outright. Existing seed data is migrated separately in
-- `seed.ts` (URLs go to `receipt_external_url`; production has no users
-- yet, so there is nothing to preserve). Re-running the seed after this
-- migration regenerates the historical data with the new column.

--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "receipt_url";

--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "receipt_document_id" uuid;

--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "receipt_external_url" text;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_receipt_document_id_documents_id_fk"
   FOREIGN KEY ("receipt_document_id") REFERENCES "public"."documents"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_receipt_xor"
  CHECK ("receipt_document_id" IS NULL OR "receipt_external_url" IS NULL);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transactions_receipt_document"
  ON "transactions" USING btree ("receipt_document_id")
  WHERE "receipt_document_id" IS NOT NULL;
