# Fix Business Logic Inconsistencies (BA Audit)

## Контекст

BA-анализ выявил расхождения между документацией, схемой БД и тестами. Все изменения согласованы с бизнес-владельцем. Задача устраняет накопленный технический долг перед стартом PHASE 6.

---

## Модуль 1: Finance — статус `PENDING_PAYMENT`

### Проблема
В схеме отсутствует статус `PENDING_PAYMENT` в `transaction_status` enum, хотя документация и пользовательский флоу его требуют.

### Решение (согласовано)
Добавить `PENDING_PAYMENT` в enum. Флоу SENIOR_INCOME транзакции:
```
PENDING → VALIDATED → PENDING_PAYMENT → PAID
                   ↘ REJECTED
```
`payout_requests` остаётся. Когда SENIOR создаёт `payout_request` для группы VALIDATED транзакций — эти транзакции переходят в `PENDING_PAYMENT`. После того как SENIOR вносит `txHash` и `payout_request.status` становится `PAID` — транзакции переходят в `PAID`.

### Что нужно изменить
- [ ] `apps/api/src/database/schema.ts` — добавить `'PENDING_PAYMENT'` в `transactionStatusEnum`
- [ ] Drizzle миграция — сгенерировать и применить (`drizzle-kit generate` + `drizzle-kit migrate`)
- [ ] `apps/api/src/finance/transactions.service.ts` — при создании `payout_request` переводить связанные SENIOR_INCOME транзакции в `PENDING_PAYMENT`; при `submitPayoutTxHash` переводить в `PAID`
- [ ] `packages/shared/src/schemas/finance.ts` — добавить `'PENDING_PAYMENT'` в `transactionStatusSchema` / `transactionStatusEnum`
- [ ] `apps/web/app/routes/crm/finance/` — обновить статус-бейджи и логику показа кнопок (кнопка "Выплатить" у SENIOR появляется при наличии VALIDATED, исчезает если все уже PENDING_PAYMENT)

### Acceptance Criteria
- [ ] Транзакция переходит в `PENDING_PAYMENT` при создании `payout_request`
- [ ] Транзакция переходит в `PAID` после подтверждения `txHash`
- [ ] Статус `PENDING_PAYMENT` корректно отображается в UI (бейдж, цвет)
- [ ] Кнопка "Выплатить" у SENIOR не показывается если все VALIDATED транзакции уже в `PENDING_PAYMENT`

---

## Модуль 2: Interviews — стейдж `CLIENT_INTERVIEW`

### Проблема
Стейдж `CLIENT_INTERVIEW` существует в DB enum, но отсутствует в UI (нет колонки), документации и тестах.

### Решение (согласовано)
`CLIENT_INTERVIEW` — реальный бизнес-стейдж между `FINAL_INTERVIEW` и `OFFER_RECEIVED`.

Полный флоу:
```
HR_SCREEN → ENGLISH_CHECK → TECH_INTERVIEW → FINAL_INTERVIEW → CLIENT_INTERVIEW → OFFER_RECEIVED
                                                                                         ↓
                                                                             HIRED | REJECTED | ARCHIVED
```

### Что нужно изменить
- [ ] `apps/web/app/routes/crm/interviews/` — добавить колонку `CLIENT_INTERVIEW` между `FINAL_INTERVIEW` и `OFFER_RECEIVED` в Kanban-доске
- [ ] `apps/web/app/routes/crm/interviews/` — добавить кнопку перехода в `CLIENT_INTERVIEW` в диалоге карточки
- [ ] `packages/shared/src/schemas/interviews.ts` — убедиться что `CLIENT_INTERVIEW` есть в `interviewStageSchema` (в DB enum уже есть)
- [ ] `docs/business/modules/interviews.md` — обновить схему стейджей
- [ ] `CLAUDE.md` — обновить список стейджей в разделе Interviews

---

## Модуль 3: Interviews — метод эндпоинта move

### Проблема
Документация говорит `POST /api/interviews/:id/move`, E2E тесты ожидают `PATCH`.

### Решение (согласовано)
Правильный метод: `PATCH`. Исправить документацию.

### Что нужно изменить
- [ ] `docs/business/modules/interviews.md` — заменить `POST /api/interviews/:id/move` на `PATCH /api/interviews/:id/move`
- [ ] Проверить реальный контроллер `apps/api/src/interviews/interviews.controller.ts` — убедиться что там `@Patch(':id/move')`, а не `@Post`

---

## Модуль 4: Teams — seed и RBAC

### Проблема
В `seed.ts` все HR-пользователи добавляются во все команды. Это нарушает RBAC: каждый HR должен видеть только команды, в которых он является членом.

### Решение (согласовано)
`teams` таблица остаётся без `hrId`. "Своя команда" HR = та, где он есть в `team_members`. Seed исправляется: каждый HR добавляется только в конкретные команды.

### Что нужно изменить
- [ ] `apps/api/src/database/seed.ts` — в `SEED_TEAMS` добавить поле `hrEmails` (по аналогии с `seniorEmail`) и при создании команды добавлять только указанных HR, а не всех
- [ ] `docs/business/modules/team.md` — убрать `hrId` из SQL-схемы, обновить описание структуры
- [ ] `CLAUDE.md` — раздел "Teams (PHASE 2)" — убрать упоминание `hrId`

Пример исправленного seed:
```typescript
const SEED_TEAMS = [
  {
    name: 'Команда Oleksiy',
    seniorEmail: 'oleksiy.kovalenko@cheekycheese.dev',
    hrEmail: 'kateryna.shevchenko@cheekycheese.dev',
  },
  {
    name: 'Команда Dmytro',
    seniorEmail: 'dmytro.marchenko@cheekycheese.dev',
    hrEmail: 'anna.lysenko@cheekycheese.dev',
  },
]
```

---

## Модуль 5: Finance — HR видит свои зарплаты

### Проблема
Документация (CLAUDE.md, finance.md) говорит "HR видит список проектов (без сумм)". Реальный UI и тесты показывают "История ваших выплат" (SALARY транзакции где HR = receiver).

### Решение (согласовано)
Правильно: HR видит свои зарплатные выплаты. Документацию исправить.

### Что нужно изменить
- [ ] `docs/business/modules/finance.md` — исправить строку HR в таблице RBAC: `HR | Свои зарплатные выплаты`
- [ ] `CLAUDE.md` — исправить: "HR: видит список проектов (без сумм)" → "HR: видит свои выплаты зарплаты"

---

## Модуль 6: `seniorSharePercent` — дефолты форм и fixtures

### Проблема
`seniorSharePercent` = % который синьор оставляет себе (26%). Формы на фронтенде используют дефолт `74` — это инверсия смысла. Fixtures.ts использует неверное имя поля и неверное значение.

### Что нужно изменить
- [ ] `apps/web/app/routes/crm/team.tsx:250` — исправить `seniorSharePercent: 74` → `seniorSharePercent: 26`
- [ ] `apps/web/app/routes/crm/users/index.tsx:312` — исправить `seniorSharePercent: 74` → `seniorSharePercent: 26`
- [ ] `apps/web/app/routes/crm/users/index.tsx:702` — исправить `?? 74` → `?? 26`
- [ ] `apps/e2e/tests/fixtures.ts` — в `USERS.senior` переименовать `defaultSharePercent: 74` → `seniorSharePercent: 26`; в `PROJECTS` убрать `sharePercent: 74` (этого поля нет в API ответе проекта)

---

## Файлы для изменения (сводка)

```
apps/api/src/database/schema.ts          ← PENDING_PAYMENT в enum
apps/api/src/database/seed.ts            ← исправить HR seed
apps/api/src/finance/transactions.service.ts  ← PENDING_PAYMENT логика
apps/api/src/interviews/interviews.controller.ts  ← проверить PATCH
apps/web/app/routes/crm/interviews/      ← CLIENT_INTERVIEW колонка
apps/web/app/routes/crm/finance/         ← PENDING_PAYMENT бейджи
apps/web/app/routes/crm/team.tsx         ← дефолт seniorSharePercent
apps/web/app/routes/crm/users/index.tsx  ← дефолт seniorSharePercent
apps/e2e/tests/fixtures.ts               ← поля senior и project
packages/shared/src/schemas/finance.ts   ← PENDING_PAYMENT в enum
packages/shared/src/schemas/interviews.ts ← проверить CLIENT_INTERVIEW
docs/business/modules/finance.md         ← HR RBAC, статус-флоу
docs/business/modules/interviews.md      ← стейджи, метод PATCH
docs/business/modules/team.md            ← убрать hrId
CLAUDE.md                                ← синхронизировать всё
```

---

## Связанные документы
- `docs/business/modules/finance.md`
- `docs/business/modules/interviews.md`
- `docs/business/modules/team.md`
- `docs/business/user-flows.md`

---

## Задание AutoTest-агенту

### `apps/e2e/tests/finance.spec.ts`

**Проблема:** Тесты не покрывают статус `PENDING_PAYMENT` — его не существовало в схеме.

**Что добавить:**

```
Finance — статус PENDING_PAYMENT
- SENIOR: транзакция переходит в PENDING_PAYMENT после создания payout_request
  (проверить что кнопка "Выплатить" исчезает для этой транзакции)
- ADMIN: статус-бейдж "Ожидает выплаты" виден на PENDING_PAYMENT транзакции
- SENIOR: не видит кнопку "Выплатить" если все VALIDATED транзакции уже в PENDING_PAYMENT
- ADMIN/ACCOUNTANT: видят PENDING_PAYMENT транзакции в общем списке
```

**Фикстура для добавления в fixtures.ts:**
```typescript
const TX_PENDING_PAYMENT_SENIOR: object = {
  ...TX_VALIDATED_SENIOR,
  id: 'tx-pending-payment-senior',
  status: 'PENDING_PAYMENT',
  payoutRequestId: 'pr-pending-id',
}
```

---

### `apps/e2e/tests/interviews.spec.ts`

**Проблема 1:** `STAGE_LABELS` не содержит `CLIENT_INTERVIEW`. Тест на рендер колонок не проверяет эту колонку.

**Проблема 2:** Тест `'move to next stage sends PATCH /move request'` корректен (PATCH), но стоит добавить явный тест перехода через `CLIENT_INTERVIEW`.

**Что исправить/добавить:**

```
// 1. Добавить CLIENT_INTERVIEW в STAGE_LABELS
CLIENT_INTERVIEW: 'Client Interview'

// 2. Обновить тест рендера всех колонок — добавить 'Client Interview'
test('renders all active stage columns', ...)  // добавить Client Interview в список

// 3. Новый тест:
test('move from FINAL_INTERVIEW to CLIENT_INTERVIEW', async ({ asSenior }) => {
  // карточка в FINAL_INTERVIEW → кнопка "Client Interview" видна
  // клик → PATCH /move с { stage: 'CLIENT_INTERVIEW' }
})

// 4. Новый тест:
test('move from CLIENT_INTERVIEW to OFFER_RECEIVED', async ({ asSenior }) => {
  // карточка в CLIENT_INTERVIEW → кнопка "Offer Received" видна
  // клик → PATCH /move с { stage: 'OFFER_RECEIVED' }
})
```

**Фикстуры для добавления:**
```typescript
// Добавить в INTERVIEWS
{
  id: 'interview-4-id',
  ...INTERVIEWS[0],
  companyName: 'Client Interview Corp',
  stage: 'FINAL_INTERVIEW',
}
{
  id: 'interview-5-id',
  ...INTERVIEWS[0],
  companyName: 'Offer Pending Corp',
  stage: 'CLIENT_INTERVIEW',
}
```

---

### `apps/e2e/tests/fixtures.ts`

**Проблема:** Поля `USERS.senior.defaultSharePercent: 74` и `PROJECTS[0].sharePercent: 74` не соответствуют реальному API.

**Что исправить:**
```typescript
// БЫЛО:
senior: {
  defaultSharePercent: 74,
  ...
}

// СТАЛО:
senior: {
  seniorSharePercent: 26,
  ...
}

// БЫЛО:
PROJECTS = [{
  sharePercent: 74,
  ...
}]

// СТАЛО: удалить поле sharePercent из PROJECTS
// (его нет в API-ответе проекта; override хранится в projectFinanceSettings)
```

Проверить что после изменения имени поля тесты в `users.spec.ts` и `projects.spec.ts` не падают.

---

### `apps/e2e/tests/team.spec.ts`

**Проблема:** Тест `'ADMIN can remove a non-protected member'` использует `EXTRA_ACCOUNTANT` (два бухгалтера) чтобы обойти защиту "нельзя удалить последнего ACCOUNTANT". Это логика теста — не баг, но стоит добавить явный негативный тест.

**Что добавить:**
```
test('нельзя удалить единственного ACCOUNTANT', async ({ asAdmin }) => {
  // мокировать API команды с одним ACCOUNTANT
  // кнопка "Исключить" для него должна быть disabled или отсутствовать
})

test('нельзя удалить единственного HR', async ({ asAdmin }) => {
  // аналогично
})
```
