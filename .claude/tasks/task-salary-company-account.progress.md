# Progress: task-salary-company-account (BACKEND)

current_milestone: 5/7
done: 1 (schemas) 2 (shared helper) 3 (reconcile both balance fns) 4 (remove LOCKED + cron COMPANY_ACCOUNT)
note: company-account.service.spec balance block MUST be rewritten (helper now 6 SUM queries, not 4) — M7.
branch: feature/salary-company-account

## Milestones

1. Shared schemas: add fundingSource to createExpense/createAdminIncome + USDT superRefine; flip createSalary default doc.
2. Shared balance helper `company-account-balance.ts` (SSOT) — deposits + payouts(COMPANY) + adminIncome(COMPANY) − dividends − salary(COMPANY) − expense(COMPANY).
3. Reconcile: company-account.service.computeBalance + transactions.service.computeCompanyAccountBalance both call the shared helper.
4. Remove LOCKED: createMonthlySalaries always PENDING + COMPANY_ACCOUNT/USDT; delete unlockJuniorSalaryForProject + 2 call-sites.
5. createSalary manual default→COMPANY_ACCOUNT; paySalary txDate+gate.
6. createExpense + createAdminIncome COMPANY_ACCOUNT branches; exclude company-funded ADMIN_INCOME from getSummary adminBalances.
7. Tests: update salary-funding-source + salary-no-admin-receiver + company-account.service.spec; new integration for all 6 terms + expense/admin-income/paySalary + cron PENDING. typecheck/lint/test.

## blast_radius (exported / shared symbols touched)

- computeCompanyAccountBalance (transactions.service:1612) — caller: createSalary. Will delegate to shared helper.
- company-account.service.computeBalance (private) — getAccount. Will delegate to shared helper.
- createSalary default flip ADMIN_PERSONAL→COMPANY_ACCOUNT — breaks salary-funding-source legacy test + salary-no-admin-receiver 201 tests (no deposit seeded). MUST update both.
- getSummary adminBalances — exclude ADMIN_INCOME fundingSource=COMPANY_ACCOUNT. Covered by transactions.get-summary.spec.
- createExpenseSchema / createAdminIncomeSchema — add optional fundingSource. Backward-compat (legacy callers omit).
- unlockJuniorSalaryForProject delete — validateTransaction 2 call-sites (lines 1339,1397). LOCKED enum stays in DB/shared (existing prod rows, defensive).

## files_done

## files_pending

- packages/shared/src/schemas/finance.ts
- apps/api/src/finance/company-account-balance.ts (new)
- apps/api/src/finance/company-account.service.ts
- apps/api/src/finance/transactions.service.ts
- specs (update + new)
