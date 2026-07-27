# task-onchain-payment-integrity — progress

current_milestone: 1/6
branch: fix/onchain-payment-integrity
last_commit: —
last_push: —

## Milestones

1. schema: consumed_tx_hashes table + manual DDL (backfill)
2. etherscan.service: fromAddress/fromMatches (topics[1] + tx.from fallback)
3. transactions.service: payPayoutRequest sender gate + registry insert inside cascade tx
4. company-account.service: submitDeposit + getDepositStatus sender gate + registry
5. tests (unit + integration, incl. cross-path + race on real DB)
6. full run + PR

## blast_radius

- `EtherscanService.verifyDeposit` — callers: `transactions.service.ts:2789` (payPayoutRequest),
  `company-account.service.ts:242` (submitDeposit), `:323` (getDepositStatus).
  17 spec files build `DepositVerification` fakes → widened interface touches all of them.
- `applyPayoutPaidCascade` — callers: payPayoutRequest, manualConfirmPayout.
- `computeCompanyAccountBalanceFromLedger` — unchanged, but asserted in the cross-path test.

## files_done

—

## files_pending

apps/api/src/database/schema.ts
apps/api/drizzle/manual/2026-07-27_consumed_tx_hashes.sql
apps/api/src/finance/etherscan.service.ts
apps/api/src/finance/transactions.service.ts
apps/api/src/finance/company-account.service.ts
specs
