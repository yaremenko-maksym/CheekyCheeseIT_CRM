# task-invoice-data-layer

## Агент: coder

## Приоритет: high

## Зависит от: —

## Ветка: feature/invoice-data-layer (создать новую от main)

## Контекст

Эпик Invoice Signing — фундамент. См. полный спек: [`docs/specs/pm-brief-invoice-signing.md`](../pm-brief-invoice-signing.md). Эта таска — только schema/migrations/Zod, без бизнес-логики.

## Конкретные изменения

### 1. Migration 0016 — INVOICE category + FK

`apps/api/drizzle/migrations/0016_invoice_category_and_fk.sql`:

```sql
ALTER TYPE document_category ADD VALUE 'INVOICE';

ALTER TABLE transactions
  ADD COLUMN invoice_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_invoice
  ON transactions(invoice_document_id)
  WHERE invoice_document_id IS NOT NULL;
```

### 2. Migration 0017 — invoice_signatures

`apps/api/drizzle/migrations/0017_invoice_signatures.sql`:

```sql
CREATE TYPE invoice_signer_role AS ENUM ('COMPANY', 'COUNTERPARTY');
CREATE TYPE invoice_signature_method AS ENUM ('AUTO_COMPANY', 'MANUAL_CLICK');

CREATE TABLE invoice_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  signer_role invoice_signer_role NOT NULL,
  signer_id UUID NOT NULL REFERENCES users(id),
  signed_at TIMESTAMP NOT NULL DEFAULT now(),
  pdf_hash CHAR(64) NOT NULL,
  ip_address INET,
  user_agent TEXT,
  method invoice_signature_method NOT NULL,
  CONSTRAINT uniq_sig UNIQUE (transaction_id, signer_role)
);

CREATE INDEX idx_invoice_signatures_transaction ON invoice_signatures(transaction_id);
CREATE INDEX idx_invoice_signatures_signer ON invoice_signatures(signer_id);
```

### 3. Migration 0018 — notifications

`apps/api/drizzle/migrations/0018_notifications.sql`:

```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  link VARCHAR(500),
  read_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC);
```

### 4. Drizzle journal update

`apps/api/drizzle/migrations/meta/_journal.json` — добавить 3 entries:

- idx 16, tag `0016_invoice_category_and_fk`, when 1780700000000
- idx 17, tag `0017_invoice_signatures`, when 1780800000000
- idx 18, tag `0018_notifications`, when 1780900000000

### 5. `apps/api/src/database/schema.ts`

- Добавить `INVOICE` в `documentCategoryEnum` массив
- Добавить колонку `invoiceDocumentId: uuid('invoice_document_id').references(() => documents.id, { onDelete: 'set null' })` в `transactions`
- Добавить экспорт `invoiceSignerRoleEnum`, `invoiceSignatureMethodEnum`
- Добавить таблицу `invoiceSignatures` со всеми полями + uniqueIndex
- Добавить таблицу `notifications` со всеми полями + indexes
- Экспортировать типы `InvoiceSignature`, `NewInvoiceSignature`, `Notification`, `NewNotification`

### 6. `packages/shared/src/schemas/invoices.ts` — **новый файл**

```typescript
import { z } from 'zod'

export const invoiceSignerRoleSchema = z.enum(['COMPANY', 'COUNTERPARTY'])
export const invoiceSignatureMethodSchema = z.enum(['AUTO_COMPANY', 'MANUAL_CLICK'])

export const invoiceSignatureSchema = z.object({
  id: z.string().uuid(),
  transactionId: z.string().uuid(),
  signerRole: invoiceSignerRoleSchema,
  signerId: z.string().uuid(),
  signerName: z.string(), // joined из users.displayName
  signedAt: z.string().datetime(),
  pdfHashShort: z.string().length(8), // first 8 of SHA-256
  method: invoiceSignatureMethodSchema,
})

export const invoiceStatusSchema = z.enum(['PENDING', 'SIGNED'])

export const invoiceSchema = z.object({
  transactionId: z.string().uuid(),
  documentId: z.string().uuid().nullable(),
  status: invoiceStatusSchema,
  type: z.enum(['SENIOR_INCOME', 'SALARY']), // narrow subset of transaction_type
  amount: z.string(), // numeric as string
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
  counterpartyId: z.string().uuid(),
  counterpartyName: z.string(),
  projectName: z.string().nullable(),
  salaryMonth: z.string().nullable(),
  signatures: z.array(invoiceSignatureSchema),
  createdAt: z.string().datetime(),
})

export const invoiceListItemSchema = invoiceSchema.pick({
  transactionId: true,
  status: true,
  type: true,
  amount: true,
  currency: true,
  counterpartyName: true,
  createdAt: true,
})

export const invoiceVerifyResponseSchema = z.object({
  transactionId: z.string().uuid(),
  status: invoiceStatusSchema,
  amount: z.string(),
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
  type: z.enum(['SENIOR_INCOME', 'SALARY']),
  signatures: z.array(
    z.object({
      role: invoiceSignerRoleSchema,
      signerName: z.string(),
      signedAt: z.string().datetime(),
      pdfHashShort: z.string().length(8),
    }),
  ),
})

export type InvoiceSigner = z.infer<typeof invoiceSignerRoleSchema>
export type InvoiceSignature = z.infer<typeof invoiceSignatureSchema>
export type Invoice = z.infer<typeof invoiceSchema>
export type InvoiceListItem = z.infer<typeof invoiceListItemSchema>
export type InvoiceVerifyResponse = z.infer<typeof invoiceVerifyResponseSchema>
```

### 7. `packages/shared/src/schemas/notifications.ts` — **новый файл**

```typescript
import { z } from 'zod'

export const notificationTypeSchema = z.enum(['INVOICE_SIGN_REQUIRED', 'INVOICE_SIGNED'])

export const notificationSchema = z.object({
  id: z.string().uuid(),
  type: notificationTypeSchema,
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
})

export const notificationsListResponseSchema = z.object({
  items: z.array(notificationSchema),
  unreadCount: z.number().int().nonnegative(),
})

export type NotificationType = z.infer<typeof notificationTypeSchema>
export type Notification = z.infer<typeof notificationSchema>
export type NotificationsListResponse = z.infer<typeof notificationsListResponseSchema>
```

### 8. `packages/shared/src/index.ts` — добавить exports

```typescript
export * from './schemas/invoices'
export * from './schemas/notifications'
```

### 9. Update `documentCategorySchema` в `packages/shared/src/schemas/documents.ts`

Добавить `'INVOICE'` в z.enum.

### 10. Seed updates (`apps/api/src/database/seed.ts`)

- НЕ создавать seed invoices (только реальные операции триггерят)
- Можно добавить 1-2 пустых notifications для UI testing — например для каждого пользователя:

```typescript
await db.insert(notifications).values({
  userId: alice.id,
  type: 'INVOICE_SIGN_REQUIRED',
  title: 'Тестовое уведомление',
  body: 'Это пример уведомления для проверки колокольчика',
  link: null,
})
```

(опционально, можно пропустить если seed уже сложный)

## Тесты (unit)

### `apps/api/src/database/schema.spec.ts` (расширить existing)

Если есть — добавить кейсы для invoice_signatures unique constraint:

- Двойная вставка с одним (transaction_id, signer_role) → fail
- INVOICE документы фильтруются как INTERNAL_CATEGORIES (важно для PHASE 6 RBAC consistency)

### `packages/shared/src/schemas/invoices.spec.ts` — **новый**

- `invoiceSchema.parse(validData)` — success
- `invoiceSchema.parse({ status: 'INVALID' })` — throws
- `invoiceVerifyResponseSchema` — отсутствуют private fields (нет ip/userAgent)

### `packages/shared/src/schemas/notifications.spec.ts` — **новый**

- Notification valid
- `notificationsListResponseSchema` — unreadCount >= 0

## Acceptance criteria

- [ ] 3 migration files созданы (0016, 0017, 0018)
- [ ] \_journal.json обновлён с 3 entries
- [ ] `schema.ts` имеет all 3 changes (documents enum, transactions FK, invoice_signatures + notifications tables)
- [ ] `packages/shared/src/schemas/invoices.ts` + `notifications.ts` созданы с полной Zod
- [ ] Документы category enum в shared включает INVOICE
- [ ] **Local apply migration:** `pnpm --filter @crm/api db:migrate` — все 3 миграции applied без errors
- [ ] **DB inspection (postgres MCP):** `SELECT enum_range(NULL::document_category)` возвращает 7 значений включая INVOICE; `SELECT * FROM invoice_signatures LIMIT 0` работает; `SELECT * FROM notifications LIMIT 0` работает
- [ ] **Unit tests pass:** `pnpm --filter @crm/shared test` + `pnpm --filter @crm/api test`
- [ ] **Typecheck pass:** `pnpm typecheck`
- [ ] CI green после push

## Запрещено трогать

- Бизнес-логика (services, controllers) — это только schema layer
- PDF generation — отдельный task (task-invoice-pdf-gen)
- UI — отдельный task (task-invoice-ui)
- Existing migrations 0000-0015 — не модифицировать
- DocumentsService — добавление category в enum уже достаточно, не трогать бизнес-код модуля

## Verification перед push

1. `pnpm --filter @crm/api db:migrate` — успех
2. postgres MCP: `SELECT column_name FROM information_schema.columns WHERE table_name = 'invoice_signatures'` → 9 columns
3. `pnpm test` + `pnpm typecheck` локально pass
4. `git diff HEAD --name-only` — только migrations + schema.ts + shared schemas + seed (optional)
5. Commit: `feat(invoice): data layer (migrations 0016-0018 + Zod schemas)` + `ac_verified: 1-10`
6. Push `feature/invoice-data-layer` → open PR с label `ai-review-ready`
