# task-receipts-backend — progress

current_milestone: 7/7 (review round 1 fixes done; full unit+integration suite green)
branch: feature/transaction-receipts (local: be, push via HEAD:)
worktree: .claude/worktrees/agent-a2a607af5fbfc4b7b (ALL edits inside here)

## Milestones

1. Shared schema + unit tests (finance.ts: BLOCKCHAIN_EXPLORER_HOSTS, isExplorerUrl, receiptMandatoryError, mandatoryReceiptRefine, attachReceiptSchema; 9 schemas refined; finance.receipts.spec.ts)
2. Drizzle schema + prod DDL (schema.ts transactionAuditLog; drizzle/manual/2026-07-14_transaction_audit_log.sql)
3. Service — new receipt paths (declareUsdtProjectIncome, createAdminTransfer, paySalary, createDividend, settleByCompany + SettleFunding)
4. Attach/replace endpoint (replaceReceiptAtomic helper extracted; attachOrReplaceReceipt; PATCH :id/receipt controller)
5. Integration tests (RBAC matrix, USDT explorer, audit-log, replace-delete, regression)
6. Full verification + PR

## blast_radius (exported symbols changed — call-sites)

- createSeniorIncomeSchema, createDropIncomeSchema, createAdminIncomeSchema, createExpenseSchema — already had receiptFields; add superRefine (mandatory). Type stays optional -> fe typecheck unaffected.
- createUsdtIncomeSchema, createAdminTransferSchema, createDividendSchema, paySalarySchema, settleSeniorPayoutSchema — add receiptFields (optional in type) + superRefine. Call-sites: fe finance/api.ts, transactions.controller.ts, company-account.controller.ts, pending-settlement.controller.ts.
- SettleFunding type — add optional receipt fields; call-sites settleByCompany/settleByCompanySourceTransaction.
- updateSeniorIncome refactor -> replaceReceiptAtomic helper; updateDropIncome, attachOrReplaceReceipt reuse.

## Key decisions

- Migration = schema.ts (db:push source) + manual prod DDL (repo has NO migrations journal; db:generate absent, only db:push).
- Mandatory enforced via superRefine (NOT required-type) -> monorepo typecheck green until frontend catches up.

## Review round 1 (code+security APPROVE, fix-round mandated)

1. MED-1: legacy `POST /pending-settlements/:id/settle-company` (obligation-id) removed —
   ignored its body entirely (privileged mandatory-receipt bypass); zero apps/web callers
   (grep confirmed only by-source-transaction is wired). apps/e2e (pending-settlement.spec.ts,
   rbac-matrix-smoke.spec.ts) directly HTTP-probes the removed route — FLAGGED for AutoTest's
   next commit on this branch (out of my zone per task file).
2. MED-2: added receiptMandatoryError service-side defense-in-depth re-check to
   createSeniorIncome/createDropIncome/createAdminIncome/createExpense (parity with the other
   5 flows).
3. LOW: ParseUUIDPipe on PATCH :id/receipt.
4. LOW: unit tests for userinfo look-alike vectors in isExplorerUrl (code was already correct).
5. Full-suite verification (mandated by receiving-code-review discipline) surfaced 12 MORE
   pre-existing integration spec files broken by my OWN original mandatory-receipt change
   (never run in the original round) — all fixed with receipt fields added to call sites:
   company-account-debit-race/dividend/ledger/.rbac, dividend-idempotency, pay-salary-invoice,
   pay-salary.rbac, salary-funding-source, senior-settle-owner, usdt-income-idempotency,
   usdt-income-obligations, transactions.create-accountant.rbac.
- Final: shared unit 321/321, api unit 1615/1615, api FULL integration 74 files / 770/770 green.
