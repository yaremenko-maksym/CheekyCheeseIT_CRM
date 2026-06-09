# task-drop-phase2-backend

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase2

## Зависит от: Phase 1 (merged в main: PR #63, #64)

## Источник истины: [`docs/specs/drop-role-and-finance-spec.md`](../drop-role-and-finance-spec.md) секция 8.1

## Контекст

**Phase 2** — финансы drop-проекта. Цель: добавить ветку распределения для проектов с `dropId != null`. Принцип №1 (как в Phase 1): **не сломать senior-проектов**. Все изменения строго аддитивные, через extract-helper + if-branch по `project.dropId`.

Пример распределения по спеку (приход $1000, синьор 26%, дроп 5%):

```
Приход на дропа:            $1000
  − доля синьора (26%):      $260   → senior balance
  − доля дропа (5%):          $50   → drop balance
  = остаток:                 $690   → 50/50 admins: $345 / $345
```

Junior salary — **отдельно** (junior_payments), но unlock condition расширяется на drop income (см. AC5).

## Подготовка

1. Прочитай: [`docs/specs/drop-role-and-finance-spec.md`](../drop-role-and-finance-spec.md) §8.1.
2. Прочитай: docs/agents/coder.md, docs/agents/CLAUDE-coder.md, docs/agents/memory/coder/lessons.md.
3. Через ast-grep сними карту: где `seniorShare`, `partnerBalance`, `MAKSYM_ID`, `KOSTYA_ID` — туда добавить comments «PHASE 2 — drop branch».
4. Postgres MCP: убедись что `projects.drop_id` колонка есть на main (Phase 1 migration 0020).

## Acceptance Criteria

### AC1. Refactor 50/50 split в helper (REFACTOR-ONLY, regression must pass)

- [ ] В `apps/api/src/finance/transactions.service.ts` извлеки логику расчёта 50/50 партнёрам из `payPayoutRequest()` (строки ~915-936) в **новый приватный метод** `computePartnersSplit(payableAmount: Decimal): { adminId: string, amount: Decimal }[]`.
- [ ] Старый код в `payPayoutRequest()` теперь вызывает `computePartnersSplit(payable)` и итерирует — **полностью эквивалентно** прежней логике. Senior-проекты должны давать **бит-в-бит** те же транзакции.
- [ ] Все существующие тесты на финансы должны пройти без правок. UT regression — обязательно.

### AC2. Новый helper `computeDropDistribution`

- [ ] Новый приватный метод `computeDropDistribution(income, project, drop, senior)`:
  - Принимает: amount (incoming USDT/USD), project (с `dropId`), drop (user с `dropSharePercent`), senior (user с `seniorSharePercent`).
  - Возвращает:
    ```ts
    {
      seniorShare: { amount: Decimal, percent: number },
      dropShare: { amount: Decimal, percent: number },
      partnerShares: { adminId: string, amount: Decimal }[]  // 2 строки, 50/50
    }
    ```
  - Логика:
    1. `seniorPercent = senior.seniorSharePercent ?? 26`. `seniorAmount = income * seniorPercent / 100`.
    2. `dropPercent = drop.dropSharePercent ?? 5`. `dropAmount = income * dropPercent / 100`.
    3. `remainder = income − seniorAmount − dropAmount`. **Assert**: `remainder >= 0`. Иначе бросить `BadRequestException('Sum of senior+drop shares exceeds 100%')`.
    4. `partnerShares = computePartnersSplit(remainder)` — переиспользовать helper из AC1.
  - **Чистая функция**: no DB writes, без побочных эффектов. Тестируется UT без моков сервиса.

### AC3. Расширение `payPayoutRequest` ветка drop

- [ ] Найди где `payPayoutRequest()` использует `computePartnersSplit` (после AC1).
- [ ] Перед расчётом — резолв: `project = await db.query.projects(...)`, `drop = project.dropId ? await usersService.findById(project.dropId) : null`.
- [ ] **Branch**:
  - `if (drop)` → `const dist = computeDropDistribution(income, project, drop, senior)`. Создать транзакции:
    - 1 транзакция `SENIOR_PAYOUT` (новый тип? см. AC4) с amount=dist.seniorShare.amount → seniorId. **ИЛИ** просто пометить amount уже выплаченных синьору. **Решение**: использовать существующий тип `PAYOUT` для синьора (текущий путь) и добавить `dropPayoutId` metadata если нужно различать.
    - 1 транзакция нового типа `PAYOUT_DROP` с amount=dist.dropShare.amount → recipientId=drop.id.
    - 2 транзакции `PAYOUT_ADMIN` (как раньше) — по `dist.partnerShares`.
  - `else` → текущий код 1:1 (через `computePartnersSplit`).
- [ ] **НЕ менять** validation для senior-проектов — текущий путь живёт как есть.

### AC4. Новый тип транзакции `PAYOUT_DROP`

- [ ] В `packages/shared/src/schemas/finance.ts` расширить `transactionTypeSchema` enum: добавить `PAYOUT_DROP`.
- [ ] В `apps/api/src/database/schema.ts` соответствующий drizzle pgEnum обновить (новая миграция).
- [ ] Миграция `0021_transaction_type_payout_drop.sql` (или следующий номер) — `ALTER TYPE transaction_type ADD VALUE 'PAYOUT_DROP'`.
- [ ] В `getSummary()` (метод балансов) добавить ветку: `dropBalance` для каждого DROP user = сумма PAYOUT_DROP received − sent (если есть). Существующие admin/senior балансы — без изменений.
- [ ] Endpoint: `GET /api/finance/drop-balance/:dropId` или расширить существующий `GET /api/finance/summary?userId=...`. На твоё усмотрение — но для DROP user должен возвращаться его баланс PAYOUT_DROP агрегирован.

### AC5. Junior salary unlock — расширение

- [ ] В `apps/api/src/finance/transactions.service.ts` найди `unlockJuniorSalaryForProject` (или эквивалент). Сейчас триггерится валидацией SENIOR income.
- [ ] Расширить условие: junior salary unlock'ается ТАКЖЕ если на проекте есть VALIDATED **drop income** за тот же месяц. Т.е. триггер unlock = «есть VALIDATED любого income (senior OR drop) на этом проекте за месяц».
- [ ] **НЕ менять** существующий senior unlock — только добавить ИЛИ-ветку для drop case.
- [ ] UT: drop income → junior unlock.

### AC6. Создание drop-income (входящая транзакция дропа)

- [ ] Сейчас `createSeniorIncome(input)` принимает projectId, amount, currency, receipt, и создаёт транзакцию seniorId=caller.
- [ ] Новый метод `createDropIncome(input, actor)`:
  - RBAC: caller.role === 'DROP'.
  - Проверить: `project.dropId === caller.id` иначе 403 «Это не drop-проект под вами».
  - Создать транзакцию `SENIOR_INCOME` (текущий тип, переиспользуем) но с `seniorId = caller.id` (DROP user в этом контексте). **ИЛИ** новый тип `DROP_INCOME` — решение: новый тип `DROP_INCOME` для ясности.
- [ ] Новый endpoint: `POST /api/transactions/drop-income` — body как createSeniorIncome. Для DROP user only.
- [ ] Регрессия: `createSeniorIncome` для синьора — без изменений.

### AC7. Расширение `validateTransaction` для drop income

- [ ] При валидации транзакции типа `DROP_INCOME` (см. AC6):
  - Триггерить `computeDropDistribution` flow аналогично senior income → создание PAYOUT placeholder.
  - Логика та же что для senior, но через новую ветку.
- [ ] Существующий senior validation — без изменений.

### AC8. Schemas (shared)

- [ ] `packages/shared/src/schemas/finance.ts`:
  - `transactionTypeSchema` += `'PAYOUT_DROP'`, `'DROP_INCOME'`.
  - Новая `createDropIncomeSchema` (зеркало `createSeniorIncomeSchema` если есть).
  - `transactionSchema` поле `recipientId` или `dropId` — для PAYOUT_DROP нужно знать кому. **Решение**: добавить optional `recipientId: z.string().uuid().nullable()` для всех типов; используется PAYOUT_DROP для drop user; для PAYOUT_ADMIN тоже подходит (вместо `seniorId` для admin context). Не ломать существующий schema — добавить как optional.
- [ ] Все добавки экспортированы из `packages/shared/src/index.ts`.

### AC9. UT — обязательно

- [ ] `apps/api/src/finance/transactions.distribution.spec.ts` (новый):
  - `computeDropDistribution(1000, project, drop{share:5}, senior{share:26})` → senior=260, drop=50, partners=[345, 345].
  - Edge: `senior%=50, drop%=50` → remainder=0, partners=[0,0]. OK.
  - Edge: `senior%=60, drop%=50` → throws BadRequest.
  - Edge: `senior%=0, drop%=0` → senior=0, drop=0, partners=[500,500].
- [ ] `apps/api/src/finance/transactions.service.ts` UT regression:
  - `computePartnersSplit(1000)` → `[{maksym, 500}, {kostya, 500}]`. (After AC1 extract.)
  - `payPayoutRequest(seniorProject)` — same trans output as before refactor.
  - `payPayoutRequest(dropProject)` — produces PAYOUT (senior), PAYOUT_DROP (drop), 2× PAYOUT_ADMIN.

### AC10. Локальная проверка

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/e2e test  # регрессия — senior finance не сломан
docker compose down -v && docker compose up -d && pnpm --filter @crm/api db:migrate && pnpm --filter @crm/api db:seed  # миграция 0021 на чистой БД
```

Все зелёные.

### AC11. PR

- [ ] Ветка: `feat/drop-role-phase2`.
- [ ] Push, open PR. Title: `feat(drop): фаза 2 — финансы drop-проекта (backend distribution)`.
- [ ] PR body: ссылка на спек §8.1 + AC чеклист + результат tests + smoke миграции.
- [ ] Senior touch-point inventory в комменте PR — какие места `senior` касался, какие — нет.

## Что НЕ нужно в этом таске

- UI / `apps/web/**` — следующий task.
- Manual payout confirmation (Phase 3).
- Smart-contract integration (Phase 8).
- НЕ менять `createSeniorIncome` сигнатуру или поведение — только добавить параллельный `createDropIncome`.
- НЕ переиспользовать `seniorId` поле для DROP recipient — использовать новое `recipientId` или явный тип.

## Прогресс

Поддерживай `docs/specs/tasks/task-drop-phase2-backend.progress.md` с milestone-маркерами.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
