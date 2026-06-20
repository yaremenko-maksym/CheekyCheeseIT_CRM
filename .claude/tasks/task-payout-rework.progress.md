# Progress: fix #252 security+code review findings

current_milestone: 1/4
last_commit: c5d553db
last_push: (pending)

## Findings → status

- H1 txHash-reuse guard in manualConfirmPayout — PENDING
- H2 Etherscan tokentx &address= — PENDING
- M1 applyPayoutPaidCascade atomic (db.transaction) — PENDING
- M2 real-controller RBAC 403 test (manual-confirm) — PENDING
- M3 two-path mutual-exclusion docs + cross-path test — PENDING
- M4 PAYOUT_AMOUNT_TOLERANCE doc — PENDING
- code-review MED SENIOR/DROP intent docs — PENDING
- code-review LOW convertToUsdtMinor currency union — PENDING

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
