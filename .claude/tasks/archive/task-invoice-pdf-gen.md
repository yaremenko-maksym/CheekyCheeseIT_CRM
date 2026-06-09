# task-invoice-pdf-gen

## Агент: coder

## Приоритет: high

## Зависит от: task-invoice-data-layer (merged)

## Ветка: feature/invoice-pdf-gen (создать новую от main, после merge data-layer)

## Контекст

PDF generation для invoice signing. Полный спек — [`docs/specs/pm-brief-invoice-signing.md`](../pm-brief-invoice-signing.md) секция «PDF Template».

Сейчас в `apps/api/src/finance/pdf-invoice.service.ts` уже есть какой-то PDF generator для existing invoices. Нужно проверить — возможно расширить, возможно написать новый отдельный service. Решение принимать после прочтения existing service (ast-grep по `PdfInvoiceService`).

## Конкретные изменения

### 1. PDF Service (extend or new)

Если existing `pdf-invoice.service.ts` — это generic invoice generator, **расширить** его методом:

```typescript
async generateSignableInvoicePdf(params: {
  transaction: TransactionWithRelations,
  company: { name: string, address: string },
  counterparty: { displayName: string, paymentMethod: PaymentMethod },
  signatures: InvoiceSignatureWithSigner[],
  verifyUrl: string,    // for QR code
}): Promise<{ pdfBuffer: Buffer; sha256Hash: string }>;
```

Если existing service — это узкоспециализированный для другого типа документа, создать **новый** `apps/api/src/invoices/invoice-pdf.service.ts`.

### 2. PDF Template (русский язык)

Layout (A4 portrait, использовать pdf-lib):

```
┌─────────────────────────────────────────────┐
│  [Logo]   CheekyCheese IT                   │
│           АКТ ВЫПОЛНЕННЫХ РАБОТ              │   ← для SENIOR_INCOME
│           ВЫПЛАТА ЗАРПЛАТЫ                   │   ← для SALARY
│                                              │
│  №: 1234abcd (8 chars transactionId)        │
│  Дата: 26.05.2026                           │
│ ─────────────────────────────────────────── │
│  ИСПОЛНИТЕЛЬ:                                │
│  CheekyCheese IT                             │
│  Адрес: г. Киев, ул. ...                    │
│ ─────────────────────────────────────────── │
│  ЗАКАЗЧИК:                                   │
│  Иван Иванов                                 │
│  USDT ERC-20: 0x...                          │
│  OR ФОП UAH IBAN: UA...                      │
│ ─────────────────────────────────────────── │
│  ОПИСАНИЕ УСЛУГИ:                            │
│  Доля по проекту "Acme Corp"                │
│  Период: май 2026                            │
│ ─────────────────────────────────────────── │
│  СУММА К ОПЛАТЕ:                             │
│  1 234.56 USDT                               │
│  (≈ 50 432.10 UAH по курсу НБУ 26.05.2026)  │
│ ─────────────────────────────────────────── │
│  ПОДПИСИ:                                    │
│                                              │
│  1. От ИСПОЛНИТЕЛЯ:                          │
│     Maksym Y. (ADMIN)                        │
│     26.05.2026 14:00:00 UTC                  │
│     Метод: Автоматическая электронная        │
│                                              │
│  2. От ЗАКАЗЧИКА:                            │
│     Иван Иванов                              │
│     26.05.2026 15:30:00 UTC                  │
│     Hash: a1b2c3d4                            │
│     Метод: Электронная click-подпись         │
│                                              │
│  ИЛИ если ещё нет:                           │
│  2. От ЗАКАЗЧИКА:                            │
│     ⏳ Ожидает подписи                        │
│ ─────────────────────────────────────────── │
│  [QR код]                                    │
│  Проверить документ:                         │
│  https://crm.../invoice/v/1234abcd          │
└─────────────────────────────────────────────┘
```

Использовать:

- `pdf-lib` для базовой генерации (уже в зависимостях)
- `qrcode` npm package для QR (`pnpm add qrcode @types/qrcode` в `apps/api`)
- Cyrillic font: загрузить `Roboto-Regular.ttf` (lic. Apache 2.0) или DejaVuSans в `apps/api/src/assets/fonts/` — обязательно с поддержкой кириллицы. pdf-lib не поддерживает Cyrillic стандартными fonts.

### 3. Hash compute helper

```typescript
// apps/api/src/invoices/invoice-pdf.utils.ts
import { createHash } from 'crypto'

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export function shortHash(fullHash: string): string {
  return fullHash.slice(0, 8)
}
```

### 4. Currency conversion (UAH equivalent)

Reuse existing `apps/api/src/finance/nbu-currency.service.ts`:

```typescript
const nbuRate = await this.nbuService.getRate('USDT', txDate)
const uahEquivalent = amount * nbuRate
// Format: "(≈ 50 432.10 UAH по курсу НБУ 26.05.2026)"
```

Если currency = UAH, секцию пропустить.

### 5. Counterparty payment method

Из `users.preferredPaymentMethod` (PHASE 7 feature). Если поле существует:

- USDT_ERC20: показать wallet address
- BANK_UAH: показать IBAN
- Если nullable: показать «Не указано — обратитесь к ADMIN»

### 6. Tests (unit)

`apps/api/src/invoices/invoice-pdf.service.spec.ts` — **новый**:

- `generateSignableInvoicePdf` с 0 signatures → PDF содержит «Ожидает подписи»
- С 1 signature (COMPANY auto) → показывает только companу
- С 2 signatures → показывает оба + short hash
- Hash deterministic: тот же input → тот же hash
- PDF content включает QR код (можно проверить через PNG extract или просто наличие image)
- Cyrillic text не ломается (assert PDF size reasonable, не error throw)

## Acceptance criteria

- [ ] `qrcode` + `@types/qrcode` добавлены в `apps/api/package.json`
- [ ] Cyrillic font (Roboto или аналог) добавлен в `apps/api/src/assets/fonts/`
- [ ] PDF service генерирует валидный PDF (`pdf-parse` локально не throws при reading)
- [ ] Hash compute helper работает (sha256 hex, length 64)
- [ ] QR код в PDF читается (декодируется в правильный URL)
- [ ] **Unit tests pass:** все кейсы из секции «Tests»
- [ ] **Typecheck + Lint pass**
- [ ] **Manual test:** локально вызвать `generateSignableInvoicePdf` с mock data → сохранить как `/tmp/test-invoice.pdf` → открыть и убедиться что Cyrillic отображается, QR сканится, layout не сломан
- [ ] CI green

## Запрещено трогать

- `transactions.service.ts` / любую бизнес-логику триггеров — это task-invoice-api
- `documents.service.ts` — uploading PDF будет в api task
- Migrations — должны быть уже applied из data-layer task
- UI — отдельная task

## Verification

1. `pnpm --filter @crm/api test invoice-pdf` — все unit pass
2. Manual: написать quick CLI скрипт `apps/api/scripts/test-invoice-pdf.ts`:

```typescript
import { InvoicePdfService } from '../src/invoices/invoice-pdf.service';
// mock data...
const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf({...});
require('fs').writeFileSync('/tmp/test-invoice.pdf', pdfBuffer);
console.log('hash:', sha256Hash);
```

Запустить через `ts-node` и открыть PDF в Preview. Если Cyrillic читается + QR работает → success. 3. Commit: `feat(invoice): PDF generation service с Cyrillic font + QR verification` + `ac_verified: 1-9` 4. Push → PR с label `ai-review-ready`
