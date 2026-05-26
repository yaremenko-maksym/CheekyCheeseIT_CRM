# Invoice Signing Epic — Master Spec

**Feature:** Автоматическая генерация инвойсов + двусторонняя подпись (компания + контрагент) для двух типов транзакций: Senior payout (74% компании) + Employee salary (компания → сотрудник).

**Started:** 2026-05-26

## Бизнес-логика

### Триггеры генерации инвойса

**1. Senior payout (74% на смарт-контракт):**
- SENIOR создаёт транзакцию SENIOR_INCOME → ACCOUNTANT валидирует → SENIOR кликает «Оплатить»
- В момент successful `POST /api/transactions/:id/submit-payment`:
  - Генерируется PDF (только подпись COMPANY/ADMIN)
  - Auto-sign ADMIN (method=AUTO_COMPANY)
  - Notification SENIOR: «Инвойс ожидает вашей подписи»

**2. Employee salary (компания → JUNIOR/SENIOR/HR):**
- ADMIN/ACCOUNTANT создаёт SALARY transaction → проходит весь workflow → status=PAID
- В момент перехода status → PAID:
  - Генерируется PDF
  - Auto-sign ADMIN
  - Notification employee: «Инвойс ожидает вашей подписи»

### Жизненный цикл инвойса

```
[Generated]
   ↓ auto-sign COMPANY
[Ожидает подписи] ──┐
                    │ counterparty clicks "Подписать"
                    │ → hash verify → insert COUNTERPARTY signature
                    │ → re-gen PDF c обеими подписями
                    │ → upload new Document, soft-delete old
                    │ → update transactions.invoice_document_id FK
                    ↓
              [Подписано всеми] (immutable)
```

**После SIGNED:** invoice immutable. Если нужна правка — создаётся **amendment** (новый invoice с ref на старый через поле `amends_transaction_id` — out of scope для v1, отложено).

### Подпись (Click + audit)

При клике «Подписать»:
1. Backend выгружает текущий PDF из S3 → compute SHA-256 hash
2. Compare с `pdf_hash` первой подписи (AUTO_COMPANY) → если mismatched → 409 Conflict (защита от tampering)
3. Insert `invoice_signatures` row: `signer_role=COUNTERPARTY`, `signer_id=user.id`, `pdf_hash=current`, `ip_address=req.ip`, `user_agent=req.headers['user-agent']`, `method=MANUAL_CLICK`
4. Re-gen PDF с обеими подписями (имя ADMIN + timestamp, имя counterparty + timestamp + short hash)
5. Upload new PDF as Document (category=INVOICE) → update `transactions.invoice_document_id` → soft-delete old Document

**Юр.значимость:** click-signature НЕ заменяет КЭП (квалифицированная электронная подпись Украина), но достаточно для internal accountability + аудита.

## RBAC

| Действие | ADMIN | SENIOR | JUNIOR | HR | ACCOUNTANT |
|---|---|---|---|---|---|
| Auto-sign COMPANY (system) | ✓ | — | — | — | — |
| Подписать как COUNTERPARTY (SENIOR_PAYOUT) | — | ✓ (свои) | — | — | — |
| Подписать как COUNTERPARTY (SALARY) | — | ✓ (свои) | ✓ (свои) | ✓ (свои) | — |
| View все invoices | ✓ | — | — | — | ✓ |
| View свои invoices | ✓ | ✓ | ✓ | ✓ | ✓ |
| Public verify endpoint (без auth) | публичный read-only | | | | |

## DB Schema

### Migration 0016 — INVOICE category + FK
```sql
ALTER TYPE document_category ADD VALUE 'INVOICE';

ALTER TABLE transactions
  ADD COLUMN invoice_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX idx_transactions_invoice ON transactions(invoice_document_id) WHERE invoice_document_id IS NOT NULL;
```

### Migration 0017 — invoice_signatures
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

### Migration 0018 — notifications
```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,         -- 'INVOICE_SIGN_REQUIRED', 'INVOICE_SIGNED'
  title VARCHAR(255) NOT NULL,
  body TEXT,
  link VARCHAR(500),                  -- '/crm/finance/invoices/:id'
  read_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC);
```

## PDF Template

Содержимое (русский язык, A4 portrait):

1. **Header:** Лого компании (`projects.logoDocId` reuse OR компани logo от `/admin/settings` — out of scope v1) + название «CheekyCheese IT»
2. **Title:** «АКТ ВЫПОЛНЕННЫХ РАБОТ» (для SENIOR_PAYOUT) или «ВЫПЛАТА ЗАРПЛАТЫ» (для SALARY)
3. **Side A — Компания:**
   - Название: CheekyCheese IT
   - Адрес/Реквизиты: из constants (TBD) или из `.env`
4. **Side B — Контрагент (counterparty):**
   - ФИО (из `users.displayName` + опционально legal name из `legends` если есть для SENIOR)
   - Реквизиты: USDT ERC-20 wallet ИЛИ UAH банковский счёт (зависит от `users.preferredPaymentMethod` — добавлено в Phase 7 ранее)
5. **Body:**
   - Описание: для SENIOR_PAYOUT → «Доля по проекту {projectName}, период {salaryMonth}»; для SALARY → «Заработная плата сотрудника за {salaryMonth}»
   - Сумма + currency (например `1234.56 USDT`)
   - Эквивалент в UAH (через NBU rate если currency != UAH)
6. **Signatures block:**
   - **Подпись 1 — Компания:** ADMIN displayName, timestamp, method «Автоматическая (электронная)»
   - **Подпись 2 — Контрагент:** displayName + timestamp + short hash (8 chars) + IP last octet (privacy) ИЛИ «Ожидает подписи» если ещё не подписан
7. **Footer:** QR-код → ссылка `https://{FRONTEND_URL}/invoice/v/{transactionId}` для независимой верификации hash

### Verification endpoint (public, no auth)
`GET /api/invoices/:transactionId/verify` →
```json
{
  "transactionId": "uuid",
  "status": "SIGNED" | "PENDING",
  "amount": "1234.56",
  "currency": "USDT",
  "type": "SENIOR_INCOME" | "SALARY",
  "signatures": [
    { "role": "COMPANY", "signerName": "Maksym Y.", "signedAt": "2026-05-26T14:00:00Z", "pdfHashShort": "a1b2c3d4" },
    { "role": "COUNTERPARTY", "signerName": "John D.", "signedAt": "2026-05-26T15:30:00Z", "pdfHashShort": "a1b2c3d4" }
  ]
}
```

UI verification page `/invoice/v/:id` — публичная (без login), показывает «✓ Документ верифицирован» + детали.

## Notifications система

### Backend events
- `INVOICE_SIGN_REQUIRED` — counterparty получает после auto-sign COMPANY
- `INVOICE_SIGNED` — ADMIN получает после counterparty sign (для tracking)

### UI Header колокольчик
PHASE 1 NotificationsContext был front-end stub (in-memory). Расширяем:
- Backend `GET /api/notifications?unreadOnly=true&limit=10` (TanStack Query, polling 30s ИЛИ WebSocket — v1 использует polling)
- Backend `PATCH /api/notifications/:id/read`
- Backend `PATCH /api/notifications/read-all`
- Frontend: Badge with unread count, dropdown с 10 последними, клик на item → mark read + navigate to link

## Endpoints (новые)

```
GET    /api/invoices                              — список (по фильтрам status/type/period)
GET    /api/invoices/:transactionId               — detail (transaction + document URL + signatures)
POST   /api/invoices/:transactionId/sign          — counterparty signing
GET    /api/invoices/:transactionId/verify        — PUBLIC (no auth) — hash + signatures для QR

GET    /api/notifications?unreadOnly=true         — список
PATCH  /api/notifications/:id/read                — mark single
PATCH  /api/notifications/read-all                — mark all
```

Internal helper (вызывается из `transactions.service.ts`):
```
InvoicesService.autoCreateInvoiceForPayout(transactionId)   — trigger 1
InvoicesService.autoCreateInvoiceForSalary(transactionId)   — trigger 2 (when status=PAID)
```

## UI

### Новая страница `/crm/finance/invoices`
- Tabs: «Ожидает подписи» (badge с count) / «Подписано всеми» / «Все»
- Filter dropdown: тип (Senior payout / Salary / Все)
- Сортировка: по дате создания desc
- Карточка: тип badge + сумма + currency + контрагент (ФИО) + дата + статус
- Click → InvoiceDetailDialog

### InvoiceDetailDialog (modal)
- PDF preview (iframe или PDF.js)
- Таблица подписей: role, signer name, signed at, method (Авто/Ручная)
- Если viewer ≠ counterparty OR уже подписал: кнопка «Подписать» скрыта
- Кнопка «Подписать» (active только если viewer == counterparty AND нет COUNTERPARTY signature):
  - Открывает confirm dialog: «Я согласен с содержимым инвойса» (checkbox) + «Подписать»
  - Submit → spinner → success toast → close dialog → invalidate queries

### Header колокольчик enhancement
- Badge с количеством unread (server-side count)
- Dropdown с 10 последних
- Item: title + body preview + relative time («2 минуты назад»)
- Клик на item → mark read + navigate to link (`/crm/finance/invoices/:id`)
- «Прочитать всё» button внизу dropdown

### Public verification page `/invoice/v/:id`
- Полностью без auth
- Большая зелёная «✓ Документ верифицирован»
- Таблица подписей: signer name + signed at
- PDF hash short (8 chars) для cross-check
- Транзакция: тип, сумма, currency, дата
- НЕТ raw IP / user-agent / прочих private data

## Декомпозиция задач (5 tasks)

| # | Task | Зависит от | Агент | Branch |
|---|---|---|---|---|
| 1 | `task-invoice-data-layer` | — | Coder | `feature/invoice-data-layer` |
| 2 | `task-invoice-pdf-gen` | 1 | Coder | `feature/invoice-pdf-gen` |
| 3 | `task-invoice-api` | 1, 2 | Coder | `feature/invoice-api` |
| 4 | `task-invoice-ui` | 3 | Coder | `feature/invoice-ui` |
| 5 | `task-invoice-e2e` | 4 | AutoTest | `tests/invoice-e2e` |

**Dispatch стратегия:** 4 rounds.
- **Round 1:** dispatch task 1 (data-layer)
- **Round 2:** после merge #1 — dispatch task 2 (pdf-gen) + task 3 (api) параллельно (task 3 ждёт task 2 PDF service stub, но schema-уровень уже готов)
- **Round 3:** после merge #2 + #3 — dispatch task 4 (ui)
- **Round 4:** после merge #4 — dispatch task 5 (e2e)

**Estimate:** ~7-8 часов product code total. С review/testing — ~5-7 дней до полного merge.

## Out of scope для v1 (фиксируем для будущих итераций)

- ❌ КЭП через Дія/Diia.app — отдельный эпик
- ❌ Cancellation/amendments — только через manual ADMIN intervention в БД
- ❌ Partner payouts (MAKSYM/KOSTYA 50/50) — пока без invoice
- ❌ Expense invoices — пока без подписи
- ❌ WebSocket для notifications — v1 polling 30s
- ❌ Email + Telegram notifications — только in-app колокольчик
- ❌ Multi-ADMIN auto-sign selection — hardcoded на single ADMIN (если 2+ — берётся first by created_at)

## Acceptance (PHASE-level)

- [ ] Все 5 tasks merged
- [ ] Локально: создать SALARY transaction → status PAID → invoice auto-created → counterparty подписал → status SIGNED → PDF re-generated
- [ ] Локально: SENIOR submits payout → invoice auto-created → SENIOR подписал → SIGNED
- [ ] Колокольчик в Header показывает unread count + dropdown с deep links работает
- [ ] Public verify page `/invoice/v/:id` доступна без login, показывает корректные signatures
- [ ] QR код в PDF ведёт на public verify page
- [ ] E2E coverage: auto-create, sign, RBAC, hash mismatch error, verify endpoint
- [ ] No regressions: PHASE 6 documents tests still pass
