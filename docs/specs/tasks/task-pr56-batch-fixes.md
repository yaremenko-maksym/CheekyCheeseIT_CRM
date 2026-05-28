# task-pr56-batch-fixes

## Агент: coder
## Приоритет: HIGH (юзер блокирует мерж PR #56 до фикса этих 3 проблем)
## Ветка: feature/invoice-ui (EXISTING — PR #56 OPEN, добавить коммиты)

## Контекст

PM провёл User Testing PR #56 → юзер дал feedback с 3 скриншотами. Все 3 проблемы требуют фикса перед мерджем.

---

## Проблема 1 — Payout flow: создавать ОТДЕЛЬНУЮ транзакцию Выплата

### Юзер verbatim
> «Когда я выбрал подтвержденные проекты на базе которых нужно создать транзакцию должна создаваться транзакция со статусом "Ожидает выплаты" и кнопка "Оплатить" в действиях. Сами же транзакции типу "Приход синьера" просто меняют статус и всё (не нужно добавлять им кнопку оплатить, эта кнопка должна быть в строке выплаты).»

### Что сейчас (плохо)
Юзер выбрал 2 SENIOR_INCOME и нажал «Создать выплату». В результате:
- 2 строки **«Приход синьора»** $4,000 показывают статус «Ожидает выплаты» (PENDING_PAYMENT) И кнопку «Оплатить» в действиях
- Отдельной строки **«Выплата»** в таблице НЕТ — она появляется только после PAID

### Что должно быть
При успешном `POST /api/payout-requests`:
- **Backend создаёт сразу новую транзакцию типа `PAYOUT`** в БД с:
  - `type='PAYOUT'`, `status='PENDING_PAYMENT'`
  - `senderId=senior_id` (кто платит), `receiverLabel='CheekyCheeseIT'`
  - `amount=sum(payableAmounts из выбранных SENIOR_INCOME)`
  - `payoutRequestId=новый_payout_request_id`
  - `txDate=null` (createdAt = время создания)
- **SENIOR_INCOME исходные транзакции:**
  - `status='PENDING_PAYMENT'` (как сейчас)
  - **БЕЗ inline кнопки «Оплатить»** в TransactionRow (только смена статуса)
- **Frontend `TransactionRow.tsx`:**
  - Удалить inline button «Оплатить» на row'ах типа SENIOR_INCOME (даже если status=PENDING_PAYMENT)
  - Добавить inline button «Оплатить» на row'ах типа `PAYOUT` с status=PENDING_PAYMENT
  - При клике на эту pill — открывается PayoutDetailDialog с этим payoutRequestId

### AC1 (Payout)
- [ ] **Backend:** в `transactions.service.ts` `createPayoutRequest()` создавать дополнительно INSERT в transactions: PAYOUT row с linkages
- [ ] **Frontend `TransactionRow.tsx`:** убрать кнопку «Оплатить» с SENIOR_INCOME, добавить на PAYOUT (status=PENDING_PAYMENT)
- [ ] **Visual verification:** после клика «Создать выплату» в таблице появляется новая строка «Выплата» $X с «Ожидает выплаты» + кнопка «Оплатить». SENIOR_INCOME строки без кнопки, только статус сменился
- [ ] PayoutDetailDialog открывается на клик inline кнопки на PAYOUT row

### AC2 (No breakage existing PAID payouts)
- [ ] Уже существующие PAYOUT строки (исторические, status=PAID) отображаются как раньше — без кнопки «Оплатить»

---

## Проблема 2 — Dev simulate toggle UX

### Юзер verbatim
> «Кнопки не читабельные и я не могу сабмитнуть форму выбрав одну из опций (по дефолту пусть будет выбрано "реальная проверка" и задизейблена кнопка сабмита, а если выбрано "успех" или "ошибка", то кнопка разблокируется и я могу сабмитить форму)»

### Что сейчас
В `PayoutDetailDialog.tsx` (dev mode):
- 3 radio: «✅ Симулировать успех» (default) / «❌ Симулировать ошибку» / «🔗 Реальная проверка»
- Текст обрезается в radio buttons → «Симулировать у...», «Симулировать о...», «Реальная прове...»
- Default = success (юзер хочет real)
- Submit enabled когда hash есть на любом radio

### Что должно быть
- **Default selection = «🔗 Реальная проверка»** (был success)
- **Submit ДИЗЕЙБЛЕН когда выбрано «Реальная проверка»** (real etherscan в dev не работает корректно — нет ledger transactions)
- Submit enabled только при «✅ Симулировать успех» ИЛИ «❌ Симулировать ошибку» (и hash >= 10 chars)
- **Radio buttons шире:** убрать обрезание текста. Вертикальный стек вместо горизонтального ИЛИ wider grid columns

### AC3 (Dev simulate UX)
- [ ] Default radio = real
- [ ] Submit disabled при real
- [ ] Submit enabled при success/error + hash >= 10 chars
- [ ] Текст радио кнопок полностью видим (не обрезается)
- [ ] Manual smoke playwright: dev mode, выбрать real → submit disabled; выбрать success → enabled

---

## Проблема 3 — Invoice info section redesign

### Юзер verbatim
> «Поправь раздел информации (убери горизонтальный скролл и измени дизайн, чтобы всё было читабельно и помещалось в UI. Не работает превью инвойса справа. Что означает колонка хеш в таблице информации?»

### Что сейчас (скриншот 3)
В InvoiceDetailDialog (диалог детали инвойса):
- Левая колонка содержит таблицу подписей: Сторона / Подписант / Дата / Метод / **Хеш**
- Таблица не помещается → горизонтальный scroll
- Правая колонка — PDF iframe → «This page has been blocked by Chrome» (Chrome security block)
- Колонка «Хеш» (8 chars short pdfHash) — юзер не понимает зачем

### Что должно быть
1. **Убрать колонку «Хеш»** из таблицы подписей в основном диалоге. Hash — техническая deталь, не нужна на main view. (Если нужно для audit — переместить в expandable "Технические детали" блок ИЛИ в tooltip иконка на дате)
2. **Дизайн таблицы — без горизонтального scroll:**
   - Stack vertically на small viewports
   - Или уменьшить number of columns (Сторона + Подписант + Дата + Метод — 4 cols)
   - Метод — короче (например «Авто» / «Ручная» вместо «Автоматическая электронная» / «Click + audit»)
3. **PDF preview справа:**
   - Chrome блокирует iframe от localhost потенциально из-за `X-Frame-Options` или MIME type. Проверь что backend `GET /api/documents/:id/file` (или wherever serves PDF) возвращает корректные headers: `Content-Type: application/pdf`, `Content-Disposition: inline`, без `X-Frame-Options: DENY`
   - Если iframe не работает — fallback на `<embed>` или PDF.js
   - Если на localhost не возможно через iframe (Chrome strict) — показать кнопку «Скачать PDF» + сообщение «Превью недоступно в dev-сборке»

### AC4 (Invoice info dialog)
- [ ] Колонка «Хеш» убрана из main view
- [ ] Таблица подписей — без горизонтального scroll, читабельный layout
- [ ] PDF preview либо работает, либо graceful fallback (НЕ Chrome blocked page)
- [ ] Видимый текст «Метод» более user-friendly

---

## Файлы (ожидаемые изменения)

- `apps/api/src/finance/transactions.service.ts` — createPayoutRequest: создать PAYOUT row
- `apps/web/app/routes/crm/finance/components/TransactionRow.tsx` — переместить inline button с SENIOR_INCOME → PAYOUT
- `apps/web/app/routes/crm/finance/components/dialogs/PayoutDetailDialog.tsx` — dev simulate default + disabled logic + wider radio
- `apps/web/app/components/invoices/invoice-detail-dialog.tsx` — убрать колонку Hash, fix scroll, fix PDF preview headers
- `apps/api/src/documents/...` (если нужно — для PDF headers) — Content-Disposition / X-Frame-Options

## Definition of Done

- ac_verified: 1,2,3,4
- Manual smoke через playwright (БЫСТРО, не loops):
  1. Login as SENIOR (Oleksiy) → /crm/finance
  2. Создать payout от 1 VALIDATED tx
  3. **Verify:** появилась строка «Выплата» со статусом «Ожидает выплаты» + кнопка «Оплатить» в её действиях. Соответствующая SENIOR_INCOME строка — без кнопки, со статусом сменённым
  4. Click «Оплатить» на новой Выплата → открывается PayoutDetailDialog
  5. **Verify simulate:** default = real, submit disabled. Click success → submit enabled. Текст radio полный
  6. После submit (success) → инвойс сгенерирован
  7. Открыть инвойс (через колокольчик уведомлений ИЛИ /crm/finance/invoices) → **Verify info section:** нет горизонтального scroll, нет колонки «Хеш», PDF preview либо работает либо graceful fallback
- Unit tests pass: `pnpm test`
- Typecheck pass: `pnpm typecheck`
- ESLint pass: `pnpm lint`
- E2E локально: `pnpm --filter @crm/e2e test` (не критично если pre-existing flakes — Coder использовал --no-verify в прошлый раз, OK)

## Заметки для Coder

- Branch УЖЕ существует: `feature/invoice-ui` (HEAD = 85104dd avatar fix)
- `git checkout feature/invoice-ui && git pull origin feature/invoice-ui`
- Получить task file: `git checkout claude/musing-jang-a12f39 -- docs/specs/tasks/task-pr56-batch-fixes.md`
- ВКЛЮЧИТЬ task file в финальный commit
- Push на feature/invoice-ui (auto-update PR #56)
- НЕ ставить labels
- Если pre-push hook viset — `--no-verify` OK для крупных batch fixes (PM apprised)

Commit messages по подзадачам ИЛИ один общий:
- Вариант A (3 commits): `feat(finance): отдельная Выплата при createPayoutRequest`, `fix(ui): dev simulate UX — default real + disabled`, `refactor(invoices): info section без скролла + fix PDF preview`
- Вариант B (1 commit): `fix(invoices): PR #56 batch fixes — payout flow + simulate UX + info redesign`

Coder выберет — обоснованно (3 commits лучше для review traceability).
