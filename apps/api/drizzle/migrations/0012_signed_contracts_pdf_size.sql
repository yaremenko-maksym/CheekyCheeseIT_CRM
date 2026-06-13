-- task-junior-ut-round2 §7: store the real PDF size of a signed contract so the
-- documents list / preview show the actual size instead of a hardcoded 0 B.
-- Nullable: filled at signing time for new contracts, lazily backfilled on first
-- PDF download for legacy rows. NULL = size not yet computed.
ALTER TABLE "signed_contracts" ADD COLUMN "pdf_size_bytes" integer;
