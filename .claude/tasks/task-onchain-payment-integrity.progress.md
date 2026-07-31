# task-onchain-payment-integrity — progress

current_milestone: 6/6 (done)
branch: fix/onchain-payment-integrity

## Scope (after the owner's mid-task correction)

1. **Exact amount** — `PAYOUT_AMOUNT_TOLERANCE` (±1%) REMOVED. `payPayoutRequest`
   now demands byte-exact equality with `payableAmount`, compared as integer
   minor units (10^-6 USDT) on both sides — no float in the comparison.
2. **Recipient check** — unchanged (`toMatches`).
3. **Sender** — extracted (`topics[1]`, tx `from` fallback) and RECORDED on
   `payout_requests.tx_from_address` / `transactions.tx_from_address`, surfaced
   to ADMIN/ACCOUNTANT only, written to `transaction_audit_log`. NOT a gate
   (owner: exchange withdrawals show the exchange's hot wallet).
4. **Cross-path registry** — `consumed_tx_hashes` claimed INSIDE the crediting
   DB transaction by both the payout and the deposit path.

## AC ↔ evidence

1. amount 0.5% off (inside the OLD band) → rejected — `payout-company-wallet.integration.spec.ts`
2. amount one minor unit short → rejected — same file
3. exact amount → PAID — same file
4. third-party sender → PAID + recorded + audit-logged — same file, `company-account.deposit.integration.spec.ts`
5. recorded sender is ADMIN/ACCOUNTANT-only — same file (detail + list DTO)
6. one hash, both paths (either order) → second rejected, balance credited once — `onchain-tx-cross-path.integration.spec.ts`
7. race (real Postgres): 2 parallel payouts / payout ⟷ deposit → exactly one winner — same file + deposit spec

## files_done

apps/api/src/database/schema.ts (consumed_tx_hashes + tx_from_address ×2)
apps/api/src/database/pg-errors.ts (shared isUniqueViolation)
apps/api/src/finance/onchain-tx.ts (+ .spec.ts)
apps/api/src/finance/etherscan.service.ts
apps/api/src/finance/transactions.service.ts
apps/api/src/finance/company-account.service.ts
apps/api/src/finance/pending-settlement.service.ts (DTO field)
packages/shared/src/schemas/finance.ts (+ .spec.ts)
apps/api/drizzle/manual/2026-07-27_consumed_tx_hashes.sql
apps/web/app/... (DTO fixtures only)
specs: onchain-tx-cross-path.integration, payout-company-wallet.integration,
company-account.deposit.integration, company-account.rbac.integration,
payout-no-admin-split.integration, drop-payout-company-account.integration,
company-account.service.spec, etherscan.verify-deposit.spec, etherscan.resilience.spec
helpers: **test-helpers**/consumed-tx-hashes.ts, **test-helpers**/etherscan-fake.ts

## Verification

- unit (api): 1948 passed / 106 files
- unit (web): 933 passed / 98 files · shared: 416 passed
- integration vs crm_qa: 882 passed / 80 files — run TWICE consecutively, both green
- red-before proof: pre-fix services restored from origin/main → cross-path spec
  6/6 red (incl. a numeric double credit: balance 13438 vs expected 12698, +740),
  exact-amount tests red, sender-recording tests red

## DevOps dependency

`apps/api/drizzle/manual/2026-07-27_consumed_tx_hashes.sql` must be wired into
`.github/workflows/deploy.yml` (SCP `source:` list + Step 2b) BEFORE the new
image serves traffic — otherwise prod 500s on every payout/deposit.
