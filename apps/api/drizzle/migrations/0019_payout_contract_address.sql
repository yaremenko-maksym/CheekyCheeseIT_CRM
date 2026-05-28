-- 0019_payout_contract_address.sql
--
-- Adds `contract_address` to payout_requests — the destination wallet the
-- SENIOR must send their 74% obligation to. Per-payout (one fresh address
-- generated server-side at create time), shape-compatible with Ethereum
-- (`0x` + 40 hex chars).
--
-- Stub semantics until PHASE 8 deploys the real PaymentSplitter contract:
--   * createPayoutRequest() generates a deterministic-looking random address
--     using crypto.randomBytes(20).toString('hex'). The SENIOR copies it and
--     "pays" — the etherscan stub in dev auto-confirms any tx hash.
--   * When PHASE 8 ships, the server-side generator is swapped for the
--     deployed splitter address (one shared, or per-payout escrow — TBD
--     in PHASE 8 design). Column shape stays the same.
--
-- NOT NULL because every payout MUST have a destination — there is no
-- legitimate flow where a SENIOR pays without knowing where to send.
-- Backfill for existing rows uses md5(id) padded to 40 hex chars so the
-- constraint can be applied without manual intervention; backfilled rows
-- are non-functional (the contract isn't deployed) but preserve referential
-- integrity for historical PAID rows.

--> statement-breakpoint
ALTER TABLE "payout_requests" ADD COLUMN "contract_address" varchar(255);
--> statement-breakpoint
UPDATE "payout_requests"
SET "contract_address" = '0x' || md5("id"::text) || substring(md5("id"::text || 'salt') FROM 1 FOR 8)
WHERE "contract_address" IS NULL;
--> statement-breakpoint
ALTER TABLE "payout_requests" ALTER COLUMN "contract_address" SET NOT NULL;
