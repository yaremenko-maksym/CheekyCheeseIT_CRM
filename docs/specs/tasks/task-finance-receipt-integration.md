# task-finance-receipt-integration

## Цель
Заменить `transactions.receipt_url` (text URL) на пару `receipt_document_id` (FK -> documents) + `receipt_external_url` (text) для обратной совместимости. URL — для ссылок (например, Etherscan TX); `documentId` — для загруженных в S3 чеков (RECEIPT). XOR check: можно использовать одно ИЛИ другое, но не оба сразу (и NULL допустим).

## Ветка
`feature/finance-receipt-integration`

## Конкретные изменения

### Migration
- `apps/api/drizzle/migrations/0013_transactions_receipt_refactor.sql` — DROP `receipt_url`, ADD `receipt_document_id uuid REFERENCES documents(id) ON DELETE SET NULL`, ADD `receipt_external_url text`, ADD CHECK `receipt_document_id IS NULL OR receipt_external_url IS NULL`. Fresh DB strategy: no UPDATE backfill, seed данные обновляются отдельно.
- `apps/api/drizzle/migrations/meta/_journal.json` — добавить entry для 0013.

### Schema
- `apps/api/src/database/schema.ts` — `transactions`: убрать `receiptUrl`, добавить `receiptDocumentId` + `receiptExternalUrl`. В `transactionsRelations` добавить `receiptDocument: one(documents, ...)`.

### Shared Zod
- `packages/shared/src/schemas/finance.ts` — заменить `receiptUrl: z.string()` на пару `receiptDocumentId?: uuid` + `receiptExternalUrl?: url` во всех Create/Update схемах и `transactionSchema`. Добавить `.refine()` XOR check.

### Backend
- `apps/api/src/finance/transactions.service.ts` — обновить все insert/update пути, `mapTx` возвращает оба поля.

### Frontend
- `apps/web/app/routes/crm/finance/components/ReceiptInput.tsx` — переписать на documents API. `file` mode — `useUploadDocument({ category: 'RECEIPT' })`, возвращает `{ documentId, url, mimeType }`. `url` mode — внешняя ссылка.
- `apps/web/app/routes/crm/finance/components/dialogs/CreateTransactionDialog.tsx` — заменить `receiptUrl` на пару `receiptDocumentId` + `receiptExternalUrl`.
- `apps/web/app/routes/crm/finance/components/dialogs/EditSeniorIncomeDialog.tsx` — то же.
- `apps/web/app/routes/crm/finance/components/dialogs/AdminEditTransactionDialog.tsx` — то же.
- `apps/web/app/routes/crm/finance/components/dialogs/TransactionDetailDialog.tsx` — отрисовать чек по `receiptDocumentId` (через документ-thumb/download) или `receiptExternalUrl`.
- `apps/web/app/routes/crm/finance/components/dialogs/ValidateDialog.tsx` — отрисовать чек по обоим полям.

### Seed
- `apps/api/src/database/seed.ts` — `receiptUrl` → `receiptExternalUrl` (это URLs, не загруженные файлы).

## Acceptance Criteria
1. Миграция `0013_transactions_receipt_refactor.sql` создаёт `receipt_document_id` FK + `receipt_external_url` + XOR CHECK; убирает `receipt_url`.
2. Shared schema `transactionSchema` возвращает `receiptDocumentId` и `receiptExternalUrl` (оба nullable), backend mapper заполняет оба.
3. `ReceiptInput` использует `useUploadDocument({ category: 'RECEIPT' })` для file-mode; `url` mode остаётся прежним.
4. Все 5 finance dialog'ов отрисовывают чек корректно: либо документ (thumbnail/download), либо внешняя ссылка.
5. Seed обновлён на `receiptExternalUrl` (etherscan URLs).
6. `pnpm typecheck` зелёный.

## Target main
`main`
