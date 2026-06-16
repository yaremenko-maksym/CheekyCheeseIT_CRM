# task-senior-dashboard-enhance — progress

current_milestone: 6/6
last_commit: frontend + backend + tests all green
last_push: pending final push

## Milestones

1. Shared schemas — add `currency` to `mySalaryStatus` (interviews.ts hrSummarySchema + finance.ts seniorSummarySchema). [in-progress]
2. Backend — getOwnSalaryStatus (transactions.service.ts + interviews.service.ts) returns currency; @Roles defense-in-depth on FinanceSummaryController; integration test on REAL senior-summary route (non-SENIOR=403).
3. Frontend SeniorDashboard — remove finance CTA, currency-aware salary formatter.
4. Frontend SeniorDashboard — "Добавить приход" (reuse CreateTransactionDialog), in-progress list (reuse getTransactions, filter SENIOR_INCOME PENDING/VALIDATED), "Создать выплату" (reuse PayoutDialog).
5. Frontend HRDashboard — currency-aware salary formatter (regression-safe).
6. Tests — integration (scoping/status filter/role gate/real-route 403/salary currency) + component render.

## blast_radius

- `seniorSummarySchema` (packages/shared/src/schemas/finance.ts:916) — callers: use-senior-summary.ts (parse), SeniorDashboard.tsx; test: senior-summary.integration.spec.ts. Adding `currency` to mySalaryStatus is backward-safe (new field, all producers updated).
- `hrSummarySchema` (packages/shared/src/schemas/interviews.ts:95) — callers: interviews.controller.ts, use-hr-summary.ts, HRDashboard.tsx; test: hr-summary.integration.spec.ts. Same shape change.
- `getSeniorSummary` (transactions.service.ts:2482) — produces mySalaryStatus via getOwnSalaryStatus → add currency.
- `getOwnSalaryStatus` (transactions.service.ts:2589 + interviews.service.ts:394) — two private mirrors; both return {amount,status} → add currency from salaryRow.currency.
- `FinanceSummaryController` (transactions.controller.ts:196) — add @UseGuards(RolesGuard) + @Roles('SENIOR','ADMIN') on senior-summary (defense-in-depth #234 MED).

## reuse

- CreateTransactionDialog (SENIOR → SENIOR_INCOME-only, RECEIPT mandatory) — mount as-is on dashboard. No invariant weakened.
- PayoutDialog (validatedTxs: TransactionDto[], preselectedTxIds) — mount as-is, feed validated SENIOR_INCOME.
- financeApi.getTransactions() (key ['transactions']) — backend findAll already self-scopes SENIOR to own txs. Filter SENIOR_INCOME PENDING/VALIDATED client-side (same pattern as finance/index.tsx).
- formatAmount(value, currency) from @/lib/format-amount — currency-aware formatter (50 000,00 UAH). Reuse for salary bug fix, no conversion.

## test_db

scratch crm_qa (NOT crm_db — guard #233). db:push --force + db:seed on crm_qa.
