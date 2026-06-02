# task-aggregate-invoice-per-payout

## Агент: coder

## Приоритет: high

## Ветка: feat/aggregate-invoice-per-payout

## Зависит от: PR #79 (invoice polish — merged)

## Контекст

Текущая модель: 1 SENIOR_INCOME → 1 invoice. Если senior получает оплату за 6 проектов в одном PAYOUT cascade → создаются **6 отдельных инвойсов** (для каждого SENIOR_INCOME).

**Новая модель** (user clarification): **1 инвойс на 1 PAYOUT**, агрегирует все связанные SENIOR_INCOME.

Также:

- Описание услуг меняется: было «Доля по проекту X / Период Y» → должно быть **«Услуги исполнителя согласно контракту № <N>»**.
- Контракты — отдельная phase, сейчас placeholder в DB (например `CHK-<userId>-2026` или per-user hardcoded).
- Каждый сотрудник имеет 1 контракт (per-user), не per-project.

## Acceptance Criteria

### AC1. Backend — trigger point

- [ ] В `apps/api/src/finance/transactions.service.ts` (line ~1196):
  - Текущая логика: цикл по PAID SENIOR_INCOME / DROP_INCOME — `safeAutoCreateInvoice('SENIOR_INCOME', incomeTx.id)`.
  - Заменить на: **1 вызов** для PAYOUT row — `safeAutoCreateInvoice('PAYOUT', payoutTxId)`. Найди PAYOUT в каскаде (один на payoutRequestId, type=PAYOUT).
- [ ] В `InvoicesService` — переделать `autoCreateForSeniorPayout(transactionId)` либо создать новый `autoCreateForPayout(payoutId)`:
  - Принимает payoutTxId.
  - Находит все связанные SENIOR_INCOME / DROP_INCOME через `payoutRequestId`.
  - Создаёт **1 invoice** с aggregated данными (см. AC2).
  - Counterparty = receiver PAYOUT (= drop owner / senior).
  - Идемпотентность: если invoice уже создан для этого PAYOUT — no-op.

### AC2. Backend — aggregated invoice data

В новом invoice:

- **Amount**: sum всех связанных income amounts (или равно PAYOUT.amount если он total). Если currency mixed — это edge case, пока assume single currency.
- **Currency**: общая.
- **Description**: «Услуги исполнителя согласно контракту № <contractNumber>». Без списка проектов в описании.
- **Project list**: храним в metadata / отдельном поле — для render может выводиться как secondary info (приложение «Проекты: A, B, C, D, E, F» или подобное), но **основное описание** — generic «согласно контракту».
- **Counterparty contract number**: TBD model — пока используй placeholder formula `CHK-${userId.slice(0,8)}-${year}` или поле в schema users `contract_number text` (если решишь добавить).

### AC3. Backend — schema

Решай по месту:

- **Вариант A**: добавить `users.contract_number text` (nullable, для существующих null = используем placeholder).
- **Вариант B**: формула в коде (`CHK-${userId.slice(0,8)}-${year}`) без DB column. Когда контракты появятся как отдельная phase — будет переделано.

Минимальный путь — **Variant B** (no migration сейчас).

### AC4. Backend — handling старых invoices

- Существующие invoice'ы в S3 + DB записи в `invoice_signatures` — **не трогать**. Backward compat для уже подписанных.
- Новые PAYOUT'ы (которые transitиt в PAID после deploy) получают aggregated invoice.

### AC5. Frontend — никаких изменений UI

- Invoice list UI продолжает работать как раньше (просто меньше инвойсов).
- Notification «Invoice ready for sign» теперь будет 1 раз на PAYOUT (не 6).

### AC6. PDF rendering

- [ ] В `invoice-pdf.service.ts` секция «ОПИСАНИЕ УСЛУГ» рендерит:
  ```
  ОПИСАНИЕ УСЛУГ
  Услуги исполнителя согласно контракту № CHK-12345678-2026
  ```
- [ ] **Опционально**: secondary line с проектами (если 6 проектов — компактный список):
  ```
  Проекты: Acme Corp · LearnSpace · TechCorp AI · Senior Regression · Drop Phase 2 · ...
  ```
  Если список длинный (>3 проектов) — обрезать с `…` или wrap на 2 строки.
- [ ] Период — оставить (например «Период: май 2026») чтобы понять за что платят.

### AC7. UT обязательно

- [ ] `invoices.spec.ts`:
  - `autoCreateForPayout` — создаёт 1 invoice для PAYOUT, агрегирует amount.
  - Идемпотентность: повторный вызов = no-op.
  - 6 проектов (mock 6 SENIOR_INCOME для одного payoutRequestId) → 1 invoice, amount = sum.
  - Existing invoice (= уже attached к PAYOUT) → no-op.
- [ ] `invoice-pdf.service.spec.ts`:
  - Description renders «Услуги исполнителя согласно контракту № X».
  - Список проектов рендерится если ≤ 3, обрезается если >3.

### AC8. Visual verification (обязательно)

- [ ] Сгенерируй пример PDF для **6 проектов** (один senior, один PAYOUT, 6 SENIOR_INCOME с разными projectIds).
- [ ] Открой через playwright MCP + screenshot.
- [ ] Также сгенерируй example для **1 проекта** (simple case) — убедись что не сломал single-project layout.
- [ ] Embed оба screenshot в PR.

### AC9. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
docker compose down -v && docker compose up -d && pnpm db:migrate && pnpm db:seed
```

Все зелёные. БЕЗ `--no-verify`.

### AC10. PR

- [ ] Ветка `feat/aggregate-invoice-per-payout`.
- [ ] Title: `feat(invoices): 1 инвойс на PAYOUT (aggregated multi-project) + новое описание услуг`.
- [ ] Body: модель изменения, before/after screenshots (1 project + 6 projects), backward compat note.

### AC11. Финальный отчёт

```bash
git log origin/feat/aggregate-invoice-per-payout -1 --oneline
gh pr view <PR_NUM> --json number,headRefName,state
```

- оба screenshot (1-project и 6-project).

## Что НЕ нужно

- Менять flow подписания / notifications.
- Реализовывать contracts module (это next phase).
- Менять SALARY invoice (per-transaction остаётся как есть).
- Удалять старые invoice'ы.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
