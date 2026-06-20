# Progress: task-payout-company-wallet (backend Phase 8 v2)

current_milestone: 5/6 (M2/M3/M5 done; M4 next; M6 tests last)
last_commit: M1 26bf508 + M2/M3/M5 pending
last_push: pending

## Milestones

- M1: shared schemas (payPayoutRequestSchema, manualConfirmPayoutSchema, payoutRequestSchema currency/recipient)
- M2: createPayoutRequest — recipient = company wallet + USDT-conversion (drop mixed-currency guard)
- M3: payPayoutRequest — real Etherscan verifyDeposit + company-account credit (fundingSource marker)
- M4: manual-confirm endpoint (ADMIN/ACCOUNTANT) + RBAC
- M5: company-account computeBalance += Σ(PAYOUT PAID where fundingSource=COMPANY_ACCOUNT)
- M6: tests (unit + integration crm_qa, mock Etherscan) + eslint + typecheck

## files_done

(none yet)

## files_pending

- packages/shared/src/schemas/finance.ts
- apps/api/src/finance/transactions.service.ts
- apps/api/src/finance/transactions.controller.ts
- apps/api/src/finance/company-account.service.ts
- apps/api/src/finance/payout-company-wallet.integration.spec.ts (new)
- apps/api/src/finance/payout-company-wallet.unit.spec.ts (new)

## blast_radius (existing exported symbols changed)

- TransactionsService.createPayoutRequest — caller: PayoutRequestsController.create (controller). Tests: NEW integration spec.
- TransactionsService.payPayoutRequest — caller: PayoutRequestsController.pay. Signature change (add credit). Tests: NEW.
- CompanyAccountService.computeBalance (private) — affects getAccount balance. Tests: company-account.deposit.integration.spec.ts (existing, must stay green) + NEW.
- payPayoutRequestSchema / createPayoutRequestSchema — caller: apps/web/finance/api.ts (NOT touched per task), controller. simulateResult kept dev-only.
- new manualConfirmPayoutSchema — new endpoint only.

## Зачисление (anti-double-count decision)

computeBalance += Σ(PAYOUT.status=PAID AND fundingSource='COMPANY_ACCOUNT').amount.
PAYOUT row is exactly ONE per payout_request (created in createPayoutRequest, flipped PAID in
payPayoutRequest/manual-confirm). No extra credit-row. Idempotency: re-confirm blocked by status
guard (already PAID). Manual ADMIN_USDT/CASH → fundingSource NULL → NOT counted.
