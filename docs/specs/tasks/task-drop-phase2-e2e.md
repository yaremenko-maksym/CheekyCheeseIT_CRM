# task-drop-phase2-e2e

## Агент: autotest

## Приоритет: high

## Ветка: feat/drop-role-phase2 (та же)

## Зависит от: backend + frontend Phase 2 (в ветке)

## Контекст

E2E coverage для Phase 2 distribution. **Real-API** approach (без моков), как в Phase 1 extension. Цель: подтвердить математику 1000→260/50/345/345 в БД и UI, плюс регрессия senior.

## Подготовка

1. Прочитай: docs/agents/autotest.md, docs/agents/memory/autotest/lessons.md.
2. `git checkout feat/drop-role-phase2` — backend + frontend уже там.
3. Postgres MCP: подтверди новые enum values (`PAYOUT_DROP`, `DROP_INCOME`) применены.

## Acceptance Criteria

### AC1. Setup helpers в fixtures.ts

- [ ] Расширить `apps/e2e/tests/fixtures.ts`:
  - `createDropProjectViaAPI(page, { dropId, seniorId, ... })` — POST /api/projects с dropId.
  - `createDropIncomeViaAPI(page, { projectId, amount, currency })` — POST /api/transactions/drop-income.
  - `validateTransactionViaAPI(page, txId)` — PATCH /api/transactions/:id/validate (триггерит distribution).

### AC2. Distribution math — real API

`apps/e2e/tests/drop-distribution.spec.ts`:

- [ ] Setup: создать drop user (через API из Phase 1 helper), создать senior, создать project с dropId.
- [ ] Login DROP → создать DROP_INCOME ($1000 USDT).
- [ ] Login ACCOUNTANT → validate transaction.
- [ ] Через postgres MCP assert: создано 4 транзакции — PAYOUT ($260 для senior), PAYOUT_DROP ($50 для drop), 2× PAYOUT_ADMIN ($345 каждому из Maksym/Kostya).
- [ ] Сумма всех = $1000.

### AC3. Distribution math — edge cases

`apps/e2e/tests/drop-distribution-edge.spec.ts`:

- [ ] Senior 26% + Drop 5% — стандарт.
- [ ] Senior 50% + Drop 50% — remainder=0, partners=0. Тест что 4 транзакции созданы, 2 из них с amount=0.
- [ ] Senior 60% + Drop 50% — backend 400 «Sum of senior+drop shares exceeds 100%». UI показывает error.
- [ ] Senior 0% + Drop 0% — partners 500/500.

### AC4. Junior salary unlock на drop income

`apps/e2e/tests/drop-junior-unlock.spec.ts`:

- [ ] Setup: drop-project с активным junior.
- [ ] Junior monthly salary создаётся в LOCKED статусе.
- [ ] DROP creates income → ACCOUNTANT validates → junior salary status переходит в PENDING (или PAID если auto-pay).
- [ ] Verify через postgres MCP.

### AC5. UI flow — создание drop-проекта

`apps/e2e/tests/drop-project-create.spec.ts`:

- [ ] Login ADMIN → /crm/projects → «Новый проект» → форма.
- [ ] В Select «Дроп» выбрать существующего drop user.
- [ ] Заполнить остальные поля → submit.
- [ ] Asserts:
  - Project создан с `dropId != null` (postgres MCP).
  - На detail page badge «Drop-проект».
  - Distribution breakdown показывает 26%/5%/50/50.

### AC6. UI — DROP income flow

`apps/e2e/tests/drop-income-ui.spec.ts`:

- [ ] Login DROP → /crm/profile → Финансы tab → кнопка «Добавить приход».
- [ ] Заполнить форму, submit.
- [ ] Toast «Приход зарегистрирован, ожидает валидации».
- [ ] В списке транзакций DROP user — новая запись со статусом PENDING.

### AC7. Регрессия — senior-проекты

`apps/e2e/tests/senior-project-distribution-regression.spec.ts`:

- [ ] Создание senior-проекта (БЕЗ dropId через форму).
- [ ] Senior creates income $1000 → accountant validates.
- [ ] Asserts: 3 транзакции — PAYOUT senior ($260), 2× PAYOUT_ADMIN ($370 каждому). **NO** PAYOUT_DROP. Сумма $1000.
- [ ] Distribution UI на detail page — без drop элементов.
- [ ] **Это эталонный regression тест Phase 2.**

### AC8. Локально

```bash
pnpm typecheck
pnpm lint
pnpm --filter @crm/e2e test
```

ВСЕ зелёные.

### AC9. Push

- [ ] git push origin feat/drop-role-phase2
- [ ] gh pr comment <N> с summary новых spec'ов.

## Helpers ref

Существующие из Phase 1 (`fixtures.ts`):

- `createDropViaAPI`, `addSeniorToDropTeamViaAPI`, `archiveDropTeamViaAPI`, `asDrop`, `asSenior`, `asAdmin`, `asAccountant`.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
