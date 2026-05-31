-- 0023_phase4a_balance_types.sql
--
-- Drop role - phase 4-A (balance infrastructure). Strictly additive: existing
-- senior / drop / payout flows are not touched. The legacy
-- `TransactionsService.getSummary` keeps reading the same enum values it
-- always read; the new `BalanceService` (computed on-demand from the unified
-- ledger) reads the new values in parallel.
--
-- Additions:
--
--   * transaction_type enum += 8 new values:
--       - TOV_INCOME               — money lands on the corporate (ТОВ) account.
--       - SENIOR_PENDING_PAYOUT    — TOВ owes a senior (creates an obligation
--                                    row; does NOT credit the senior's balance
--                                    until closed by a SENIOR_PAID row).
--       - SENIOR_PAID              — closes a pending obligation; credits the
--                                    senior's real balance.
--       - ADMIN_INCOME_CASH        — admin received cash for a project.
--       - ADMIN_INCOME_CRYPTO      — admin received USDT on personal crypto wallet.
--       - SENIOR_INCOME_CRYPTO     — senior received USDT on personal crypto wallet.
--       - DIVIDEND_TO_ADMIN        — distribution from TOВ → admin balance.
--       - DIVIDEND_TAX             — 6.5% tax on dividends; debits TOВ only.
--
--   * pending_obligation_debtor_type enum: 'DROP' | 'TOV' | 'ADMIN'
--   * pending_obligation_status enum: 'PENDING' | 'PAID' | 'CANCELLED'
--
--   * pending_obligations table — "X owes senior Y `amount` `currency`":
--       (creditor_user_id, debtor_type, debtor_user_id, source_transaction_id,
--        closing_transaction_id, amount, currency, status, created_at,
--        updated_at).
--
--     debtor_user_id is NULL when debtor_type='TOV' (the corporate account
--     has no user row); populated when debtor_type IN ('DROP','ADMIN').
--     source_transaction_id is ON DELETE RESTRICT — we never want to lose the
--     ledger anchor for an open obligation. closing_transaction_id is
--     nullable (set on PAID) and ON DELETE SET NULL (defensive — the audit
--     trail outlives any hard delete).
--
--     Indexes are scoped to the hot read paths (creditor + status filter,
--     "obligations for a senior", and reverse-lookup from a source
--     transaction).
--
-- No UPDATE statements: legacy rows never carried any of the new types and
-- the table starts empty. Backfill is a no-op.

--> statement-breakpoint
ALTER TYPE "transaction_type" ADD VALUE IF NOT EXISTS 'TOV_INCOME';

--> statement-breakpoint
ALTER TYPE "transaction_type" ADD VALUE IF NOT EXISTS 'SENIOR_PENDING_PAYOUT';

--> statement-breakpoint
ALTER TYPE "transaction_type" ADD VALUE IF NOT EXISTS 'SENIOR_PAID';

--> statement-breakpoint
ALTER TYPE "transaction_type" ADD VALUE IF NOT EXISTS 'ADMIN_INCOME_CASH';

--> statement-breakpoint
ALTER TYPE "transaction_type" ADD VALUE IF NOT EXISTS 'ADMIN_INCOME_CRYPTO';

--> statement-breakpoint
ALTER TYPE "transaction_type" ADD VALUE IF NOT EXISTS 'SENIOR_INCOME_CRYPTO';

--> statement-breakpoint
ALTER TYPE "transaction_type" ADD VALUE IF NOT EXISTS 'DIVIDEND_TO_ADMIN';

--> statement-breakpoint
ALTER TYPE "transaction_type" ADD VALUE IF NOT EXISTS 'DIVIDEND_TAX';

--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "pending_obligation_debtor_type" AS ENUM ('DROP', 'TOV', 'ADMIN');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "pending_obligation_status" AS ENUM ('PENDING', 'PAID', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_obligations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "creditor_user_id" uuid NOT NULL,
  "debtor_type" "pending_obligation_debtor_type" NOT NULL,
  "debtor_user_id" uuid,
  "source_transaction_id" uuid NOT NULL,
  "closing_transaction_id" uuid,
  "amount" numeric(20, 6) NOT NULL,
  "currency" "currency" DEFAULT 'USDT' NOT NULL,
  "status" "pending_obligation_status" DEFAULT 'PENDING' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pending_obligations"
    ADD CONSTRAINT "pending_obligations_creditor_user_id_users_id_fk"
    FOREIGN KEY ("creditor_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pending_obligations"
    ADD CONSTRAINT "pending_obligations_debtor_user_id_users_id_fk"
    FOREIGN KEY ("debtor_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pending_obligations"
    ADD CONSTRAINT "pending_obligations_source_transaction_id_transactions_id_fk"
    FOREIGN KEY ("source_transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pending_obligations"
    ADD CONSTRAINT "pending_obligations_closing_transaction_id_transactions_id_fk"
    FOREIGN KEY ("closing_transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pending_obligations_creditor"
  ON "pending_obligations" ("creditor_user_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pending_obligations_status"
  ON "pending_obligations" ("status");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pending_obligations_source"
  ON "pending_obligations" ("source_transaction_id");
