# Progress: salary-pay-flow (rework #254)

current_milestone: 1/5
last_commit: e0388bf7
last_push: e0388bf7

## Milestones

1. Shared schema: paySalarySchema (+fundingSource/payerAdminId/currency + superRefine), createSalarySchema simplify.
2. Backend service: createSalary→PENDING (no funding/gate); createMonthlySalaries→fundingSource=null,USD; paySalary→apply funding/currency at PAID.
3. financeApi.paySalary signature + PaySalaryDialog selector + remove SALARY funding from CreateTransactionDialog.
4. Tests: rework salary-funding-source integration → paySalary; RTL funding-source update; new PaySalaryDialog RTL.
5. typecheck/lint/test green; E2E selectors; final report.

## blast_radius (existing exported symbols changed)

- paySalarySchema / PaySalaryDto — call-sites: transactions.controller.ts paySalary; financeApi.paySalary; PaySalaryDialog; tests.
- createSalarySchema / CreateSalaryDto — call-sites: transactions.controller.ts createSalary; financeApi.createSalary; CreateTransactionDialog; tests.
- TransactionsService.createSalary — caller: controller; tests (salary-funding-source.integration, salary-no-admin-receiver, create-accountant.rbac).
- TransactionsService.paySalary — caller: controller; tests.
- TransactionsService.createMonthlySalaries — caller: cron; tests.

## reuse

- refineCompanyAccountUsdt (shared superRefine) — reuse for paySalarySchema.
- lockCompanyAccount + computeCompanyAccountBalance — reuse in paySalary COMPANY_ACCOUNT branch (already used).
- AmountCurrencyInput disableCurrency — reuse for PaySalaryDialog USDT-lock.
- adminUsers via /users role===ADMIN — reuse pattern from CreateTransactionDialog.

files_done: []
files_pending: [finance.ts, transactions.service.ts, api.ts, PaySalaryDialog.tsx, CreateTransactionDialog.tsx, salary-funding-source.integration.spec.ts, CreateTransactionDialog.funding-source.test.tsx, PaySalaryDialog.test.tsx]
