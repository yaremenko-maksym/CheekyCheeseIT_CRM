# task-invoice-api

## Агент: coder
## Приоритет: high
## Зависит от: task-invoice-data-layer, task-invoice-pdf-gen (оба merged)
## Ветка: feature/invoice-api (создать новую от main, после merge data-layer + pdf-gen)

## Контекст

NestJS API для invoice signing + notifications. Полный спек — [`docs/specs/pm-brief-invoice-signing.md`](../pm-brief-invoice-signing.md) секция «Endpoints».

## Конкретные изменения

### 1. NestJS Module structure

```
apps/api/src/invoices/
├── invoices.module.ts
├── invoices.service.ts          ← бизнес-логика
├── invoices.controller.ts       ← REST endpoints
├── invoices.service.spec.ts
└── invoices.controller.spec.ts

apps/api/src/notifications/
├── notifications.module.ts
├── notifications.service.ts
├── notifications.controller.ts
├── notifications.service.spec.ts
```

### 2. InvoicesService

**Public methods:**

```typescript
class InvoicesService {
  // Auto-trigger (called from transactions.service.ts)
  async autoCreateForSeniorPayout(transactionId: string): Promise<void>;
  async autoCreateForSalary(transactionId: string): Promise<void>;
  
  // CRUD
  async listInvoices(viewer: SessionUser, filters: InvoiceFilters): Promise<InvoiceListItem[]>;
  async getInvoice(viewer: SessionUser, transactionId: string): Promise<Invoice>;
  async signInvoice(viewer: SessionUser, transactionId: string, req: Request): Promise<Invoice>;
  
  // Public verify (no auth context)
  async verifyInvoice(transactionId: string): Promise<InvoiceVerifyResponse>;
}
```

### 3. Auto-create logic (shared между обоими triggers)

```typescript
private async autoCreate(tx: Transaction): Promise<void> {
  if (tx.invoiceDocumentId) return;                  // idempotent — already created
  
  const counterparty = await this.usersService.getById(this.getCounterpartyId(tx));
  const company = { name: 'CheekyCheese IT', address: '...' };
  
  // 1. Generate PDF (без COUNTERPARTY signature)
  const { pdfBuffer, sha256Hash } = await this.pdfService.generateSignableInvoicePdf({
    transaction: tx,
    company,
    counterparty,
    signatures: [],          // ещё нет
    verifyUrl: `${process.env.FRONTEND_URL}/invoice/v/${tx.id}`,
  });
  
  // 2. Upload as INVOICE document (через DocumentsService.uploadInternal — bypass user upload validation)
  const doc = await this.documentsService.uploadInternal({
    category: 'INVOICE',
    ownerId: counterparty.id,
    file: pdfBuffer,
    mimeType: 'application/pdf',
    name: `invoice-${tx.id.slice(0,8)}.pdf`,
    uploadedById: SYSTEM_USER_ID || this.getAdminId(),  // или специальный SYSTEM user
  });
  
  // 3. Link document to transaction
  await this.db.update(transactions)
    .set({ invoiceDocumentId: doc.id })
    .where(eq(transactions.id, tx.id));
  
  // 4. Auto-sign COMPANY (ADMIN user)
  const adminId = await this.usersService.getAdminId();
  await this.db.insert(invoiceSignatures).values({
    transactionId: tx.id,
    signerRole: 'COMPANY',
    signerId: adminId,
    pdfHash: sha256Hash,
    method: 'AUTO_COMPANY',
    // ip/user-agent NULL для auto-sign
  });
  
  // 5. Notification counterparty
  await this.notificationsService.create({
    userId: counterparty.id,
    type: 'INVOICE_SIGN_REQUIRED',
    title: 'Инвойс ожидает вашей подписи',
    body: `${this.getInvoiceTypeLabel(tx)} — сумма ${tx.amount} ${tx.currency}`,
    link: `/crm/finance/invoices/${tx.id}`,
  });
}
```

**Helpers:**
- `getCounterpartyId(tx)` — для SENIOR_INCOME это `tx.senderId` (senior сам); для SALARY это `tx.receiverId` (employee). Verify эту логику в schema/business rules.
- `getAdminId()` — first ADMIN by `created_at ASC`. Cache в memory на startup (refresh on user changes — может быть LRU 1 entry).
- `SYSTEM_USER_ID` — опционально, если нужен «системный» author для documents. Иначе just use admin.

### 4. Sign logic

```typescript
async signInvoice(viewer: SessionUser, transactionId: string, req: Request): Promise<Invoice> {
  const tx = await this.txService.findById(transactionId);
  if (!tx) throw new NotFoundException();
  
  // RBAC check
  if (this.getCounterpartyId(tx) !== viewer.id) {
    throw new ForbiddenException('Вы не контрагент этой транзакции');
  }
  
  // Check no existing COUNTERPARTY signature (immutable rule)
  const existing = await this.db.select().from(invoiceSignatures)
    .where(and(eq(invoiceSignatures.transactionId, tx.id), eq(invoiceSignatures.signerRole, 'COUNTERPARTY')))
    .limit(1);
  if (existing.length) throw new ConflictException('Инвойс уже подписан');
  
  // Get current PDF + compute hash
  if (!tx.invoiceDocumentId) throw new ConflictException('Инвойс не сгенерирован');
  const doc = await this.documentsService.getById(tx.invoiceDocumentId);
  const pdfBuffer = await this.s3Service.getObject(doc.s3Key);
  const currentHash = sha256Hex(pdfBuffer);
  
  // Verify hash matches first signature (защита от tampering)
  const companySig = await this.db.select().from(invoiceSignatures)
    .where(and(eq(invoiceSignatures.transactionId, tx.id), eq(invoiceSignatures.signerRole, 'COMPANY')))
    .limit(1);
  if (companySig[0].pdfHash !== currentHash) {
    throw new ConflictException('PDF был изменён после первой подписи');
  }
  
  // Insert COUNTERPARTY signature
  const signedAt = new Date();
  await this.db.insert(invoiceSignatures).values({
    transactionId: tx.id,
    signerRole: 'COUNTERPARTY',
    signerId: viewer.id,
    pdfHash: currentHash,
    ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
    userAgent: req.headers['user-agent'] || null,
    method: 'MANUAL_CLICK',
    signedAt,
  });
  
  // Re-generate PDF c обеими подписями
  const allSigs = await this.getSignaturesWithSignerNames(tx.id);
  const counterparty = await this.usersService.getById(viewer.id);
  const { pdfBuffer: newPdf, sha256Hash: newHash } = await this.pdfService.generateSignableInvoicePdf({
    transaction: tx,
    company: { name: 'CheekyCheese IT', address: '...' },
    counterparty,
    signatures: allSigs,
    verifyUrl: `${process.env.FRONTEND_URL}/invoice/v/${tx.id}`,
  });
  
  // Upload new Document, soft-delete old
  const newDoc = await this.documentsService.uploadInternal({...});
  await this.documentsService.softDelete(doc.id, SYSTEM_USER_ID);
  await this.db.update(transactions)
    .set({ invoiceDocumentId: newDoc.id })
    .where(eq(transactions.id, tx.id));
  
  // Notify ADMIN that счёт подписан
  const adminId = await this.usersService.getAdminId();
  await this.notificationsService.create({
    userId: adminId,
    type: 'INVOICE_SIGNED',
    title: `${counterparty.displayName} подписал инвойс`,
    body: `${this.getInvoiceTypeLabel(tx)} — сумма ${tx.amount} ${tx.currency}`,
    link: `/crm/finance/invoices/${tx.id}`,
  });
  
  return this.getInvoice(viewer, tx.id);
}
```

### 5. List/Get RBAC

```typescript
async listInvoices(viewer: SessionUser, filters: InvoiceFilters): Promise<InvoiceListItem[]> {
  let where = and(
    eq(transactions.type, sql`ANY(ARRAY['SENIOR_INCOME', 'SALARY']::transaction_type[])`),
    isNotNull(transactions.invoiceDocumentId),
  );
  
  if (viewer.role === 'ADMIN' || viewer.role === 'ACCOUNTANT') {
    // see all
  } else {
    // see only own (where viewer is counterparty)
    where = and(where, or(
      and(eq(transactions.type, 'SENIOR_INCOME'), eq(transactions.senderId, viewer.id)),
      and(eq(transactions.type, 'SALARY'), eq(transactions.receiverId, viewer.id)),
    ));
  }
  
  // Filter by status (computed): PENDING/SIGNED
  if (filters.status === 'PENDING') {
    where = and(where, sql`NOT EXISTS (SELECT 1 FROM invoice_signatures WHERE transaction_id = transactions.id AND signer_role = 'COUNTERPARTY')`);
  } else if (filters.status === 'SIGNED') {
    where = and(where, sql`EXISTS (SELECT 1 FROM invoice_signatures WHERE transaction_id = transactions.id AND signer_role = 'COUNTERPARTY')`);
  }
  
  // ... + type/period filters
  
  return rows.map(mapToListItem);
}
```

### 6. Public verify endpoint (no auth guard)

```typescript
@Public()  // skip JWT guard
@Get('verify/:transactionId')
async verifyInvoice(@Param('transactionId') id: string): Promise<InvoiceVerifyResponse> {
  return this.invoicesService.verifyInvoice(id);
}

// в service:
async verifyInvoice(transactionId: string): Promise<InvoiceVerifyResponse> {
  const tx = await this.db.select(...).from(transactions)
    .where(eq(transactions.id, transactionId))
    .limit(1);
  if (!tx.length) throw new NotFoundException();
  if (!tx[0].invoiceDocumentId) throw new NotFoundException('Инвойс не сгенерирован');
  
  const sigs = await this.getSignaturesWithSignerNames(tx[0].id);
  
  return {
    transactionId: tx[0].id,
    status: sigs.some(s => s.signerRole === 'COUNTERPARTY') ? 'SIGNED' : 'PENDING',
    amount: tx[0].amount,
    currency: tx[0].currency,
    type: tx[0].type as 'SENIOR_INCOME' | 'SALARY',
    signatures: sigs.map(s => ({
      role: s.signerRole,
      signerName: s.signerName,
      signedAt: s.signedAt.toISOString(),
      pdfHashShort: s.pdfHash.slice(0, 8),
      // НЕТ ip/user_agent — private
    })),
  };
}
```

### 7. Trigger integration в transactions.service.ts

Найти места где меняется status и добавить вызовы:

**a) После submit-payment (existing endpoint POST /api/transactions/:id/submit-payment):**
```typescript
async submitPayment(...) {
  // existing logic
  await this.invoicesService.autoCreateForSeniorPayout(tx.id);
}
```

**b) При переходе SALARY transaction в status=PAID:**
Найти где `transactions.status` → 'PAID' для type='SALARY' и добавить:
```typescript
if (tx.type === 'SALARY' && previousStatus !== 'PAID' && newStatus === 'PAID') {
  await this.invoicesService.autoCreateForSalary(tx.id);
}
```

### 8. NotificationsService + Controller

```typescript
class NotificationsService {
  async create(input: { userId, type, title, body?, link? }): Promise<Notification>;
  async listForUser(userId, opts: { unreadOnly?, limit? }): Promise<NotificationsListResponse>;
  async markRead(userId, notificationId): Promise<void>;
  async markAllRead(userId): Promise<void>;
}

@Controller('notifications')
class NotificationsController {
  @Get() list(...);
  @Patch(':id/read') markRead(...);
  @Patch('read-all') markAllRead(...);
}
```

### 9. DocumentsService.uploadInternal расширение

Сейчас `DocumentsService` имеет `upload(file, category, ownerId, projectId?)` — что вызывается из user-facing endpoints. Нужен **system-facing** метод который:
- Bypass file size / MIME checks (доверенный internal call)
- Принимает Buffer вместо Multer file
- Принимает explicit `uploadedById`

Если такого метода нет — добавить:
```typescript
async uploadInternal(params: {
  category: DocumentCategory,
  ownerId: string,
  file: Buffer,
  mimeType: string,
  name: string,
  uploadedById: string,
  projectId?: string,
}): Promise<Document>;
```

## Endpoints summary

```
GET    /api/invoices                              — список (filters: type, status, period)
GET    /api/invoices/:transactionId               — detail
POST   /api/invoices/:transactionId/sign          — counterparty signing
GET    /api/invoices/:transactionId/verify        — PUBLIC (no auth)

GET    /api/notifications                         — список текущего user (filters: unreadOnly, limit)
PATCH  /api/notifications/:id/read                — mark single read
PATCH  /api/notifications/read-all                — mark all read
```

## Tests (unit + integration)

`apps/api/src/invoices/invoices.service.spec.ts`:
- `autoCreate` — idempotent (second call no-op)
- `autoCreate` — PDF gen called, document linked, signature inserted, notification created
- `sign` — happy path
- `sign` — RBAC: non-counterparty → ForbiddenException
- `sign` — already signed → ConflictException
- `sign` — hash mismatch (PDF tampered between gen + sign) → ConflictException
- `listInvoices` — RBAC: SENIOR sees only own; ADMIN sees all
- `verifyInvoice` — public, no auth, returns only public fields (no ip/UA)

`apps/api/src/notifications/notifications.service.spec.ts`:
- create + list + markRead happy paths
- listForUser does not leak other users' notifications

## Acceptance criteria

- [ ] Module `invoices/` + `notifications/` созданы со всей структурой
- [ ] 6 invoice endpoints + 3 notification endpoints реализованы
- [ ] `transactions.service.ts` triggers added (submit-payment + PAID transition)
- [ ] `DocumentsService.uploadInternal` метод добавлен (или существующий расширен)
- [ ] Все unit tests pass (`pnpm --filter @crm/api test`)
- [ ] Typecheck pass
- [ ] **Manual integration test:** локально создать SALARY transaction → подвинуть в PAID → проверить через postgres MCP что `invoice_signatures` имеет 1 entry (COMPANY auto) и `transactions.invoice_document_id` не NULL. Зайти как counterparty → POST sign → проверить что появилась 2-я signature + новый Document, старый soft-deleted.
- [ ] **Verify endpoint без auth:** `curl http://localhost:3001/api/invoices/<txId>/verify` без cookie → 200 OK с правильным JSON
- [ ] CI green после push

## Запрещено трогать

- `pdf-invoice.service.ts` / `invoice-pdf.service.ts` — отдельный task (data layer + pdf-gen уже merged)
- UI — отдельный task
- Migrations — должны быть уже applied
- Существующие transactions endpoints (`POST /api/transactions`, `validate`, etc.) — только добавлять trigger вызовы, не менять остальную логику

## Verification

1. `pnpm --filter @crm/api test` — все unit pass
2. `pnpm typecheck` pass
3. Manual integration test (см. AC)
4. `git diff HEAD --name-only` — только `apps/api/src/invoices/`, `apps/api/src/notifications/`, `apps/api/src/finance/transactions.service.ts` (trigger calls), `apps/api/src/documents/documents.service.ts` (uploadInternal), `apps/api/src/app.module.ts` (register new modules)
5. Commit: `feat(invoice): InvoicesModule + NotificationsModule + transaction triggers` + `ac_verified: 1-9`
6. Push → PR с label `ai-review-ready`
