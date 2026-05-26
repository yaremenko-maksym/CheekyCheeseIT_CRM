-- 0017_invoice_signatures.sql
--
-- Invoice Signing Epic — data layer step 2: signatures audit table.
--
-- Each invoice is bound to exactly one transaction (1-to-1 via
-- transactions.invoice_document_id). A transaction can have at most two
-- signatures — one per role (COMPANY auto-signed by ADMIN, COUNTERPARTY
-- manually clicked by the recipient). Enforced by a UNIQUE constraint on
-- (transaction_id, signer_role).
--
-- Fields:
--   * `pdf_hash` — SHA-256 of the PDF bytes at the moment of signing.
--      Stored as CHAR(64) (hex). Used by the public /verify endpoint to
--      detect tampering between the signed bytes and the current S3
--      object. First 8 chars (`pdfHashShort`) are also stamped onto the
--      regenerated PDF itself so the signature page shows it.
--   * `ip_address` (INET) — captured at signing time for accountability.
--      Never returned by the public verify endpoint (privacy).
--   * `user_agent` — TEXT, same privacy treatment as ip_address.
--   * `method` — `AUTO_COMPANY` for the system auto-sign of the ADMIN
--      side; `MANUAL_CLICK` for the counterparty click-through. Audit
--      trail uses this to distinguish the two flows.
--
-- ON DELETE behaviour:
--   * `transaction_id` → CASCADE so deleting a transaction wipes its
--      signatures too (a signed invoice can't survive its transaction).
--   * `signer_id` → no action (default RESTRICT) so we never lose track of
--      who signed; if a user must be deleted, ADMIN explicitly migrates
--      their signatures first.

--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."invoice_signer_role" AS ENUM('COMPANY', 'COUNTERPARTY');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."invoice_signature_method" AS ENUM('AUTO_COMPANY', 'MANUAL_CLICK');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"signer_role" "invoice_signer_role" NOT NULL,
	"signer_id" uuid NOT NULL,
	"signed_at" timestamp DEFAULT now() NOT NULL,
	"pdf_hash" char(64) NOT NULL,
	"ip_address" inet,
	"user_agent" text,
	"method" "invoice_signature_method" NOT NULL,
	CONSTRAINT "uniq_sig" UNIQUE("transaction_id", "signer_role")
);

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_signatures" ADD CONSTRAINT "invoice_signatures_transaction_id_transactions_id_fk"
   FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_signatures" ADD CONSTRAINT "invoice_signatures_signer_id_users_id_fk"
   FOREIGN KEY ("signer_id") REFERENCES "public"."users"("id")
   ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invoice_signatures_transaction"
  ON "invoice_signatures" USING btree ("transaction_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invoice_signatures_signer"
  ON "invoice_signatures" USING btree ("signer_id");
