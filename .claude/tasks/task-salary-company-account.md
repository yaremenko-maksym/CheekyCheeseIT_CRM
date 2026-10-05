# Task: Admin salary/expense/income via the company account + remove LOCKED (BACKEND)

## Model: opus

(Money ledger: balance math, gates, RBAC, reconciliation of two balance functions → opus per model-routing.)

## Zone: Coder — `apps/api/**`, `packages/shared/**`, `.claude/tasks/<my-task>.progress.md`. (The frontend selector is a SEPARATE task, do NOT touch `apps/web`.)

## Context / owner's direction (2026-06-20)

The company account (Phase 8) = a **USDT-only** pool. We extend the ledger: salaries/expenses from the company account decrease the balance, an admin income to the company account tops it up. Study via **codegraph** BEFORE editing (verbatim source): `createSalary` (1635), `createMonthlySalaries` (3088), `paySalary` (3053), `createExpense`, `createAdminIncome`, `computeCompanyAccountBalance` (1612), `unlockJuniorSalaryForProject` (3544, callers 1439/1497), `company-account.service.computeBalance` (71), `balance.service` (admin personal balance).

## OWNER'S DECISIONS (fixed — do not re-ask)

1. **Admin income (ADMIN_INCOME) with the "Company account" → TOPS UP the account balance (+)**. The money goes into the company pool, NOT onto the admin's personal balance.
2. **Everything with the "Company account" — USDT only** (no conversion; amount = USDT).
3. Keep the cron; **remove the LOCKED dependency on senior/drop income** (juniors get PENDING immediately).
4. **Salaries are created with fundingSource = COMPANY_ACCOUNT by default** (both the cron and the manual dialog).
5. **On salary payment `txDate` → the payment date** (now).
6. The "Company account" option is also available when creating an **expense (EXPENSE)** and an **admin income (ADMIN_INCOME)** (for them it is an OPTION, not the default).

## Single ledger formula (used for BOTH display and gate — RECONCILIATION)

```
Balance = + Σ(COMPANY_DEPOSIT PAID)
          + Σ(PAYOUT PAID, fundingSource='COMPANY_ACCOUNT')
          + Σ(ADMIN_INCOME PAID, fundingSource='COMPANY_ACCOUNT')   ← NEW (+)
          − Σ(DIVIDEND_TO_ADMIN PAID)
          − Σ(SALARY PAID, fundingSource='COMPANY_ACCOUNT')
          − Σ(EXPENSE PAID, fundingSource='COMPANY_ACCOUNT')        ← NEW (−)
```

**CRITICAL (bug fix):** right now two functions diverge — `company-account.service.computeBalance` (71) includes `+PAYOUT(COMPANY_ACCOUNT)`, while `transactions.service.computeCompanyAccountBalance` (1612, used as the salary gate) does NOT. This means the gate undercounts the balance. **Reduce to ONE shared function** (extract a common helper OR let transactions.service call company-account.service), so the gate and display are BYTE-for-byte identical. Add both new terms to the single function.

## Implementation

### 1. Remove LOCKED (cron + unlock)

- `createMonthlySalaries` (3088): for **JUNIOR** remove the `hasValidatedIncome ? PENDING : LOCKED` branch — always **PENDING**. Remove the `hasValidatedIncome` query and the related logic.
- Delete the method `unlockJuniorSalaryForProject` (3544) + both calls in `validateTransaction` (1439, 1497). Check that the deletion leaves no orphaned imports/variables.
- The `LOCKED` status for SALARY is no longer created. (Existing LOCKED rows in prod — we do not migrate; but check that UI/findAll is not broken by them — they will become "dangling". If simple: leave as is, document.)

### 2. Salary by default = COMPANY_ACCOUNT

- `createMonthlySalaries`: creates salaries (HR/ACCOUNTANT + JUNIOR) with **fundingSource='COMPANY_ACCOUNT'**, currency **USDT**, senderId=null, senderLabel='Счёт компании', status **PENDING** (NOT PAID — the money is debited on payment). Amount = as now (`monthlySalary` / `juniorSalaryOverride`), but interpreted as USDT. Idempotency (skip if one already exists for the month) — preserve.
- `createSalary` (manual, 1635): the default `fundingSource` when ABSENT → **COMPANY_ACCOUNT** (it used to be ADMIN_PERSONAL legacy — we flip it; update the affected tests, including #222 ACCOUNTANT self-pay — the default is now company). Manual still creates PAID with the creation-time balance gate (already present for COMPANY_ACCOUNT).
- `createSalarySchema`: you may keep `fundingSource` optional and default it in the service (cleaner for backward-compat calls), OR `.default('COMPANY_ACCOUNT')` in the schema — choose one, document it.

### 3. paySalary (3053): txDate + gate

- On the PENDING→PAID flip: set **`txDate: new Date()`** (the payment date).
- If `tx.fundingSource === 'COMPANY_ACCOUNT'`: before the flip check that the single balance ≥ `tx.amount`; otherwise `BadRequestException('Недостаточно средств на счёте компании')`. (The money is debited precisely at PAID — the balance formula counts only PAID SALARY.)
- ADMIN-only (as now).

### 4. EXPENSE with the company account

- `createExpenseSchema` (packages/shared): add `fundingSource: salaryFundingSourceSchema.optional()` (reuse the existing enum) + superRefine "COMPANY_ACCOUNT → currency only USDT" (as in salary).
- `createExpense` service: if `fundingSource==='COMPANY_ACCOUNT'` → currency='USDT', balance gate (≥ amount, otherwise BadRequest), senderId=null, senderLabel='Счёт компании', record `fundingSource`. Otherwise — current behavior (legacy, without fundingSource). EXPENSE is created PAID. The default is NOT company (an option).

### 5. ADMIN_INCOME with the company account (TOPS UP +)

- `createAdminIncomeSchema`: add `fundingSource` optional + USDT superRefine.
- `createAdminIncome` service: if `fundingSource==='COMPANY_ACCOUNT'` → currency='USDT', record `fundingSource='COMPANY_ACCOUNT'` on the ADMIN_INCOME row. The money goes to the company account (the balance formula sums ADMIN_INCOME PAID COMPANY_ACCOUNT as **+**). Project — as now (income from a project), but the destination = the company account. The default is NOT company (an option).
- **CRITICAL — do not double:** update `balance.service` (the admin's personal balance) so that ADMIN_INCOME with `fundingSource='COMPANY_ACCOUNT'` does **NOT** credit the admin's personal balance (the money went into the company pool, not to the admin personally). Study balance.service via codegraph, exclude company-funded admin income from the personal calculation. If balance.service affects getSummary/other places — check the blast-radius.

### 6. Reconcile balance (see the formula above) — a single function, both new terms.

## Acceptance Criteria (each with a test, integration against the REAL scratch DB `crm_qa`, NOT `crm_db`)

1. Cron/`createMonthlySalaries`: JUNIOR always PENDING (no LOCKED); HR/ACCOUNTANT/JUNIOR are created with fundingSource=COMPANY_ACCOUNT, USDT, PENDING. `unlockJuniorSalaryForProject` removed, income validation no longer unlocks salary. (unit + integration).
2. `createSalary` manual: default (absent fundingSource) = COMPANY_ACCOUNT. typecheck green.
3. `paySalary`: txDate becomes the payment date; a company-funded salary is blocked when the balance is insufficient (BadRequest), passes when sufficient + debits the balance. (integration).
4. EXPENSE COMPANY_ACCOUNT: USDT, gate, debits the balance; legacy EXPENSE (without fundingSource) does not touch the balance. (integration).
5. ADMIN_INCOME COMPANY_ACCOUNT: USDT, **tops up** the company account balance; does NOT credit the admin's personal balance (balance.service). legacy ADMIN_INCOME — as before. (integration — check both the account balance and the admin's personal balance).
6. **Reconciliation:** display balance (`GET /company-account`) == gate balance (used in createSalary/paySalary/createExpense) — one function, includes PAYOUT + both new terms. (unit/integration — set up data with all 6 terms, compare both points).
7. eslint clean; full `pnpm --filter @crm/api test` green on crm_qa; api typecheck.

## Test discipline

Integration against `crm_qa` (guard #233), asserts of balance deltas + 403 where RBAC. Real controller where the RBAC surface changes (FM-5; finance is already in the allowlist). Do NOT hardcode amounts — compute from seed. `DATABASE_URL= git push`.

## Worktree (FM-2)

`/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/worktrees/salary-company-account`, branch `feature/salary-company-account` off main `cfffec61`. ALL Edit/Write inside it. Do NOT write to main-repo paths. After the first edit `git -C <wt> status`. `pnpm -C <wt> install --frozen-lockfile` if there is no node_modules.

## Git

Chunked `wip:`. Final without `wip:`: `feat(api): salary/expense/admin-income via company account + remove LOCKED salary + pay-date on salary pay` + `ac_verified: 1,2,3,4,5,6,7`. `DATABASE_URL= git push`. PR to main. Do NOT merge. The frontend selector (the source in CreateTransactionDialog for salary/expense/admin-income) is a SEPARATE task after the backend review.
