# task-pr56-final-ut-batch

## Агент: coder
## Приоритет: HIGH (юзер блокирует merge PR #56)
## Ветка: feature/invoice-ui (EXISTING — PR #56 OPEN)

## Контекст

UT после R5 (HEAD bf5dc2e) выявил 5 проблем — добавить fixes коммитами в этот же PR.

---

## Проблема 1 — Submit в PayoutDetailDialog не работает в simulate mode

### Что сейчас
В DEV mode юзер выбирает «✅ Симулировать успех», кнопка «Подтвердить оплату» visually yellow (enabled looking), но кликом не срабатывает.

### Root cause
Submit button `disabled={txHash.trim().length < 10 || payMutation.isPending}`. Когда `simulateMode='success'` ИЛИ `'error'` — backend не использует hash (early return на simulateResult). Но фронт всё равно требует hash >= 10 chars → button disabled. Visually styles не делают button явно disabled (look enabled), но onClick ignored.

### AC1 (Submit gate)
- [ ] В `PayoutDetailDialog.tsx` submit disabled logic:
  ```ts
  const isSimulate = simulateMode === 'success' || simulateMode === 'error'
  const submitDisabled = 
    payMutation.isPending ||
    (simulateMode === 'real' && (isProd || isProd || txHash.trim().length < 10)) ||
    (!isSimulate && txHash.trim().length < 10)
  ```
  Логика: hash требуется только при `real` mode (PROD) ИЛИ когда simulateMode не выбран в DEV. При `success`/`error` — hash optional.
- [ ] Если submitDisabled → визуально явно disabled (`opacity-50 cursor-not-allowed`)
- [ ] При simulate mode — `payPayoutRequest` принимает hash optional (если empty — отправлять без hash field в body)

---

## Проблема 2 — SENIOR_INCOME должен быть VALIDATED после validate (не PENDING_PAYMENT)

### Юзер verbatim
> «Давай статус будет "Подтверждено" типу как финальный статус для прихода синьера, а дальше уже идет флоу Выплаты»

### Что сейчас (bf5dc2e)
ACCOUNTANT validates → SENIOR_INCOME status → PENDING_PAYMENT (одно с PAYOUT). Badge показывает «Ожидает выплаты» на SENIOR_INCOME. Это путает — выплата ждёт на PAYOUT, а SENIOR_INCOME уже логически завершён (validated).

### Что должно быть
- SENIOR_INCOME после validate → status = **`VALIDATED`** (финальный для income)
- Badge на SENIOR_INCOME = **«Подтверждено»** (зелёный)
- PAYOUT row остаётся PENDING_PAYMENT → badge «Ожидает выплаты»

### AC2 (SENIOR_INCOME статус)
- [ ] Backend `validateTransaction()`:
  - SENIOR_INCOME UPDATE → status `'VALIDATED'` (не PENDING_PAYMENT)
  - Остальное (payout_request INSERT + PAYOUT INSERT) остаётся как есть
  - **Атомарно через db.transaction()** (всё ещё)
- [ ] Frontend badge mapping: SENIOR_INCOME + status VALIDATED → «Подтверждено»
- [ ] Existing logic для PAYOUT row (status PENDING_PAYMENT + «Оплатить» button) не трогать
- [ ] При оплате PAYOUT (payPayoutRequest) — SENIOR_INCOME статус становится `PAID` (auto-update в payPayoutRequest service)

---

## Проблема 3 — Receipt image без height limit (растягивается)

### Что сейчас (Фото 3)
В TransactionDetailDialog (детали транзакции) справа показан чек (image). При длинном фото — растягивается на всю высоту dialog, перекрывая модал.

### AC3 (Receipt image height)
- [ ] В `TransactionDetailDialog.tsx` (или wherever receipt preview rendered):
  - Container для receipt image: `max-h-[400px]` (или 60vh) с `overflow-hidden`
  - Image: `object-contain max-h-full w-full`
  - Если image overflow → внутренний scroll (или граничный crop в pretty way)
- [ ] Прямоугольная рамка вокруг с padding, чтобы выглядело как «карточка чека»

---

## Проблема 4 — PayoutDetailDialog: tx count + label rename

### Что сейчас (Фото 4)
- Header «Транзакции в выплате (2)» — но видна только 1 строка ($1,000 AI Platform v2)
- Label «Адрес смарт-контракта (USDT ERC-20)» — юзер просит короче

### Root cause для счёта
После refactor (bf5dc2e) — backend `findPayoutRequest()` возвращает transactions linked через `payoutRequestId`. Это сейчас INCLUDE:
1. SENIOR_INCOME (исходный)
2. PAYOUT (новая)

Count = 2 (правильно DB-wise). Frontend фильтрует `t.type === 'SENIOR_INCOME'` для отображения → 1 row. Но header count показывает total length = 2.

### AC4 (Tx count + label)
- [ ] В PayoutDetailDialog показывать только SENIOR_INCOME в списке, count соответствует: `senior_income_count = payout.transactions.filter(t => t.type === 'SENIOR_INCOME').length`
- [ ] Header → «Транзакции в выплате (1)» (для одной)
- [ ] Label `Адрес смарт-контракта (USDT ERC-20)` → **`Адрес кошелька`** (короче, для main view)
- [ ] Хелпер текст можно оставить: «Отправьте сумму к оплате на указанный адрес...» — или сократить

---

## Проблема 5 — Document preview redesign

### Что сейчас (Фото 5)
Модал превью документа (Чек пример.jpg):
- Поле «Имя файла» внизу с `.jpg` (избыточно — расширение уже в title)
- Чек обрезается — большое фото не помещается в quadrant
- Layout: метаданные внизу под image (single column) — выглядит сжато

### Что должно быть
- Layout как в TransactionDetailDialog: **слева** метаданные, **справа** preview image
- Image — занимает большую часть пространства, `object-contain` чтобы видеть весь чек
- НЕ показывать поле «Имя файла» (избыточно с title)

### AC5 (Document preview)
- [ ] Layout 2-column: left = metadata (загрузил, дата, размер, формат), right = preview
- [ ] Image preview: container с aspect-ratio (или min-h-[400px]), `object-contain` для image
- [ ] Удалить поле «Имя файла» из metadata
- [ ] Modal width: `max-w-4xl` (или 80vw) — больше места

---

## Файлы (ожидаемые)

- `apps/api/src/finance/transactions.service.ts` — validateTransaction status change (AC2), payPayoutRequest должен set SENIOR_INCOME → PAID при finalize (AC2)
- `apps/web/app/routes/crm/finance/components/dialogs/PayoutDetailDialog.tsx` — submit gate (AC1), tx count + label (AC4)
- `apps/web/app/routes/crm/finance/components/dialogs/TransactionDetailDialog.tsx` (или wherever receipt preview) — height limit (AC3)
- `apps/web/app/components/documents/document-preview-dialog.tsx` (или similar) — 2-column layout + remove filename (AC5)
- Status badge mapping (если централизованный) — добавить VALIDATED → «Подтверждено» (AC2)

## Definition of Done

- ac_verified: 1,2,3,4,5
- Manual smoke playwright (быстро):
  1. ACCOUNTANT validates SENIOR_INCOME → его статус = «Подтверждено» (зелёный) + новая Выплата row «Ожидает выплаты»
  2. SENIOR open Выплата → PayoutDetailDialog: count «Транзакции в выплате (1)», label «Адрес кошелька»
  3. Click radio «Симулировать успех» → button «Подтвердить оплату» enabled (no hash)
  4. Submit → success cascade
  5. SENIOR_INCOME статус → «Оплачено»
  6. Open document preview (receipt в transaction detail) → image полностью видна (object-contain), height limited
  7. Open document standalone preview → 2-column layout, нет «Имя файла»
- Unit tests: `pnpm test`
- Typecheck: `pnpm typecheck`
- ESLint: `pnpm lint`

## Заметки для Coder

- Branch: `feature/invoice-ui` (HEAD bf5dc2e)
- ВКЛЮЧИТЬ task file в commit
- Pre-push `--no-verify` OK
- НЕ ставить labels

3 commits для traceability:
1. `fix(finance): submit enabled в simulate mode + статус Подтверждено для VALIDATED`
2. `fix(ui): receipt image height limit + payout tx count + label`
3. `refactor(documents): 2-column preview без filename`

Или 1 общий: `fix(invoices): final UT batch — submit gate + status + UI polish`
