# Progress: task-finance-receipt-integration

current_milestone: 5/5 — DONE (all milestones complete, typecheck green)
last_commit: (final milestone 5 commit)
last_push: (after this commit)

files_done:

- apps/api/drizzle/migrations/0013_transactions_receipt_refactor.sql
- apps/api/drizzle/migrations/meta/\_journal.json
- apps/api/src/database/schema.ts
- packages/shared/src/schemas/finance.ts
- apps/api/src/finance/transactions.service.ts
- apps/api/src/database/seed.ts
- apps/web/app/routes/crm/finance/components/ReceiptInput.tsx
- apps/web/app/routes/crm/finance/components/dialogs/CreateTransactionDialog.tsx
- apps/web/app/routes/crm/finance/components/dialogs/EditSeniorIncomeDialog.tsx
- apps/web/app/routes/crm/finance/components/dialogs/AdminEditTransactionDialog.tsx
- apps/web/app/routes/crm/finance/components/dialogs/TransactionDetailDialog.tsx
- apps/web/app/routes/crm/finance/components/dialogs/ValidateDialog.tsx
- apps/e2e/tests/finance-senior-flow.spec.ts (mock data updated)

files_pending:

- apps/api/drizzle/migrations/0013_transactions_receipt_refactor.sql
- apps/api/drizzle/migrations/meta/\_journal.json
- apps/api/src/database/schema.ts
- apps/api/src/database/seed.ts
- apps/api/src/finance/transactions.service.ts
- packages/shared/src/schemas/finance.ts
- apps/web/app/routes/crm/finance/components/ReceiptInput.tsx
- apps/web/app/routes/crm/finance/components/dialogs/CreateTransactionDialog.tsx
- apps/web/app/routes/crm/finance/components/dialogs/EditSeniorIncomeDialog.tsx
- apps/web/app/routes/crm/finance/components/dialogs/AdminEditTransactionDialog.tsx
- apps/web/app/routes/crm/finance/components/dialogs/TransactionDetailDialog.tsx
- apps/web/app/routes/crm/finance/components/dialogs/ValidateDialog.tsx

milestones:

1. Migration + schema.ts + journal — atomic DB change
2. Shared Zod schema — finance.ts
3. Backend service + seed — transactions.service.ts + seed.ts
4. ReceiptInput rewrite — file uploads to documents API
5. Dialogs (5 files) — wire up to new fields
