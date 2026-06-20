# Progress: fix #252 security+code review findings

current_milestone: 4/4 (COMPLETE)
last_commit: 5ec27edc
last_push: 5ec27edc

## Verification

- typecheck @crm/api: green
- eslint (6 touched files): clean
- full @crm/api suite vs crm_qa: 103 files / 1731 tests passed
- payout-company-wallet.integration vs crm_qa: 19 passed (H1 + M3 added)
- payout-manual-confirm.rbac.integration vs crm_qa: 6 passed (M2)
- etherscan.verify-deposit unit: 11 passed (H2 URL assertion added)
- MAIN repo apps/ packages/: clean (no contamination)

## Findings → status

- H1 txHash-reuse guard in manualConfirmPayout — DONE (service + 2 integration tests, crm_qa green)
- H2 Etherscan tokentx &address= — DONE (etherscan.service)
- M1 applyPayoutPaidCascade atomic (db.transaction) — DONE (cascade wrapped, invoice moved post-commit)
- M2 real-controller RBAC 403 test (manual-confirm) — DONE (new spec, 6 tests crm_qa green)
- M3 two-path mutual-exclusion docs + cross-path test — DONE (docs + 2 cross-path tests, crm_qa green)
- M4 PAYOUT_AMOUNT_TOLERANCE doc — DONE
- code-review MED SENIOR/DROP intent docs — DONE
- code-review LOW convertToUsdtMinor currency union — DONE (CurrencyEnum from @crm/shared)

## blast_radius

- manualConfirmPayout: PayoutRequestsController POST :id/manual-confirm; tests payout-company-wallet.integration.spec
- payPayoutRequest: PayoutRequestsController PATCH :id/pay; web finance/api.ts (2 callers via PayPayoutRequestDto)
- applyPayoutPaidCascade: private, callers = payPayoutRequest + manualConfirmPayout
- convertToUsdtMinor: private, caller = createPayoutRequest only
- etherscan.verifyDeposit: company-account.service + payPayoutRequest; tests etherscan.verify-deposit.spec
- PayoutRequestsController ctor: add @Inject(TransactionsService) — mirrors CompanyAccountController

## files_done

## files_pending

- apps/api/src/finance/etherscan.service.ts (H2)
- apps/api/src/finance/transactions.service.ts (H1, M1, M3, M4, intent docs, LOW union)
- apps/api/src/finance/transactions.controller.ts (M2 @Inject)
- apps/api/src/finance/payout-company-wallet.integration.spec.ts (M3 cross-path, H1 manual-reuse test)
- apps/api/src/finance/payout-manual-confirm.rbac.integration.spec.ts (M2 new file)
