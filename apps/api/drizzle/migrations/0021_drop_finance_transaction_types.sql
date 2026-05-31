-- 0021_drop_finance_transaction_types.sql
--
-- Drop role - phase 2 (finances). Strictly additive: existing senior-only
-- finance flows are not touched. Phase 2 introduces two new transaction
-- types and an optional explicit recipient pointer for transactions whose
-- payee is not the same as receiverId.
--
-- Additions:
--   * transaction_type enum += 'DROP_INCOME' (incoming → drop)
--   * transaction_type enum += 'PAYOUT_DROP' (auto-created drop share after
--     payPayoutRequest on a drop-project)
--   * transactions.recipient_id (uuid, nullable, FK users ON DELETE SET NULL).
--
-- Why nullable on recipient_id:
--   * Every existing transaction stays untouched (NULL). Only PAYOUT_DROP
--     populates it today; future flows can opt-in.
--
-- Why SET NULL on the FK:
--   * Soft delete is the rule everywhere (archivedAt). SET NULL keeps the
--     audit row legible if a referenced user is ever hard-deleted; the row
--     itself is never the source of truth for the drop's identity
--     (receiverId carries the same value for PAYOUT_DROP — recipient_id is
--     the semantic alias).

--> statement-breakpoint
ALTER TYPE "transaction_type" ADD VALUE IF NOT EXISTS 'DROP_INCOME';

--> statement-breakpoint
ALTER TYPE "transaction_type" ADD VALUE IF NOT EXISTS 'PAYOUT_DROP';

--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "recipient_id" uuid;

--> statement-breakpoint
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_recipient_id_users_id_fk"
  FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE SET NULL;
