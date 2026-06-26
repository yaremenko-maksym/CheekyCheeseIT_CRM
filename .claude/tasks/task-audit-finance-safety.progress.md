# Progress: task-audit-finance-safety

current_milestone: 6/6 (all findings fixed + tested)
branch: fix/audit-finance-safety
pr: #296
last_commit: c23a2c66

## Findings (all fixed, each with tests)

1. MED — createDividend overdraw + TOCTOU
   - apps/api/src/finance/company-account.service.ts — db.transaction + lockCompanyAccount
     - computeCompanyAccountBalanceFromLedger gate; BadRequestException if amount > balance.
   - tests: company-account.service.spec.ts (unit) + company-account-dividend.integration.spec.ts (real DB, concurrency).

2. MED/LOW — pending-settlement controller RBAC guards
   - apps/api/src/finance/pending-settlement.controller.ts — class @UseGuards(RolesGuard)
     - per-method @Roles (settleCompany/listCompany → ADMIN,ACCOUNTANT; listSenior → +SENIOR)
     - @Inject(PendingSettlementService) for test-env DI parity.
   - tests: finance-controller-guards.rbac.integration.spec.ts.

3. LOW — TransactionsController RBAC guards
   - apps/api/src/finance/transactions.controller.ts — class @UseGuards(RolesGuard)
     - per-method @Roles matching each service-side check; ownership-only methods
       (updateSeniorIncome) left open intentionally; service checks kept (defense-in-depth).
   - tests: finance-controller-guards.rbac.integration.spec.ts.

4. LOW — float math in computeDropDistribution
   - apps/api/src/finance/transactions.service.ts — MONEY_SCALE (1e6) + Math.round + toFixed(6).
   - tests: transactions.distribution.spec.ts (rounding-precision cases).

5. LOW — salary-cron N+1 + TOCTOU + no unique index
   - apps/api/src/database/schema.ts — partial unique index uq_transactions_salary_receiver_month
     (WHERE type='SALARY' AND salary_month IS NOT NULL); db:push verified on crm_qa.
   - apps/api/src/finance/transactions.service.ts — both cron inserts → ON CONFLICT DO NOTHING
     (removed find-then-insert N+1/TOCTOU). createSalary (manual) now translates 23505 → clean 400.
   - tests: salary-cron-idempotency.integration.spec.ts; create-accountant + pay-salary RBAC specs
     updated to use distinct salary months under the new unique invariant.

6. LOW — manualConfirmPayout txHash-reuse TOCTOU
   - apps/api/src/finance/transactions.service.ts — conditional UPDATE WHERE status='PENDING'
     inside applyPayoutPaidCascade (serializes the flip) + in-transaction txHash-reuse guard
     (guardTxHashReuse). Existing unique index uq_payout_requests_txhash_paid kept.
   - tests: manual-confirm-toctou.integration.spec.ts (concurrency + reuse rejection).

## Verification

- api unit suite (parallel, no DB): 1874 passed / 2 skipped.
- api integration suite (serial, crm_qa — CI-equivalent): 606 passed / 53 files.
- typecheck + eslint: clean.

ac_verified: 1,2,3,4,5,6
