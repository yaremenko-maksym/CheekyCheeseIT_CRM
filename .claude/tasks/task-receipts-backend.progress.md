# task-receipts-backend — progress

current_milestone: 1/6
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
