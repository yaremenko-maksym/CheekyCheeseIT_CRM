-- MED-1 safety: use IF NOT EXISTS so this migration is idempotent on production.
-- Before applying on prod, verify no duplicate receipt_document_id values exist:
--   SELECT receipt_document_id, COUNT(*) FROM transactions
--   WHERE receipt_document_id IS NOT NULL
--   GROUP BY 1 HAVING COUNT(*) > 1;
-- If duplicates are found, a manual cleanup step is required before this migration.
-- As of 2026-06-06, local DB shows zero duplicates (confirmed via postgres MCP query).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_transactions_receipt_document_id" ON "transactions" USING btree ("receipt_document_id") WHERE "transactions"."receipt_document_id" IS NOT NULL;
