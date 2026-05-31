# task-drop-phase3-backend

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase3

## Зависит от: Phase 2 (merged)

## Источник истины: [`docs/specs/drop-role-and-finance-spec.md`](../drop-role-and-finance-spec.md) §8.4

## Контекст

**Phase 3** — Manual payout confirmation. Бухгалтер/ADMIN после фактической off-platform выплаты подтверждает «к какому админу пришли деньги». Это `safety net` поверх Phase 2 auto-50/50 — Phase 2 distribution **остаётся как есть**, manual flow добавляется как дополнительная функция.

**Поведение** (по уточнению владельца):

- На странице финансов (`/crm/finance`) каждая транзакция типа `PAYOUT` (status `PENDING_PAYMENT`) имеет кнопку **«Подтвердить оплату»** (видима ADMIN/ACCOUNTANT).
- Клик → диалог: «Кому из админов пришла оплата?» с Select (Maksym/Kostya).
- Сумма берётся из самой PAYOUT транзакции (read-only).
- На submit:
  - Создаётся **новая транзакция типа `ADMIN_INCOME`** (или новый тип `PAYOUT_CONFIRMED` если ADMIN_INCOME занят) с `recipientId = selectedAdmin.id`, `amount = PAYOUT.amount`, `projectId = PAYOUT.projectId`.
  - Исходная `PAYOUT` транзакция — статус → `PAID`, `validatedBy = caller.id`, `validatedAt = now()`.

Phase 2 auto-50/50 PAYOUT_ADMIN $345/$345 — **остаются** как book-keeping (партнёрское распределение). Phase 3 manual flow живёт параллельно.

## Подготовка

1. Прочитай: [`docs/specs/drop-role-and-finance-spec.md`](../drop-role-and-finance-spec.md) §8.4.
2. Прочитай: docs/agents/coder.md, docs/agents/CLAUDE-coder.md, docs/agents/memory/coder/lessons.md.
3. Через ast-grep сними карту: где `PAYOUT` status, где `validateTransaction`, где admin balance считается.

## Acceptance Criteria

### AC1. Endpoint `POST /api/transactions/:id/confirm-payout`

- [ ] Новый endpoint в `apps/api/src/finance/transactions.controller.ts`:
  - Path: `POST /api/transactions/:id/confirm-payout`
  - Body: `{ recipientAdminId: string }` — id выбранного админа (MAKSYM_ID или KOSTYA_ID).
  - RBAC: ADMIN или ACCOUNTANT.
  - Валидация:
    - Tx существует, тип = `PAYOUT`, статус = `PENDING_PAYMENT`. Иначе 400.
    - `recipientAdminId` существует, role = `ADMIN`, не archived. Иначе 400.
- [ ] Service method `confirmPayout(payoutTxId, recipientAdminId, actor)`:
  - Транзакционно:
    1. Update PAYOUT: `status = 'PAID'`, `validatedBy = actor.id`, `validatedAt = now()`.
    2. Insert новая транзакция: `type = 'ADMIN_INCOME'` (см. AC2), `recipientId = recipientAdminId`, `amount = payout.amount`, `currency = payout.currency`, `projectId = payout.projectId`, `status = 'PAID'`, `senderId = payout.senderId` (= drop или senior).
  - Возвращает: обновлённый PAYOUT + новую ADMIN_INCOME.

### AC2. Тип транзакции для подтверждённой оплаты

Решение по типу — оставляю на твоё усмотрение, но обсуди в PR description:

- **Вариант A**: переиспользовать существующий `ADMIN_INCOME` тип. Минус — он уже используется для других случаев (e.g., partner income). Плюс — без новых enum values.
- **Вариант B**: новый тип `PAYOUT_CONFIRMED` или `PAYOUT_RECEIVED`. Минус — миграция на enum + UI цвета/лейблы. Плюс — explicit semantics.

**Рекомендую B (новый тип)** — yarно различать в UI, в getSummary, в фильтрах. Миграция 0022.

- [ ] Если выбран B: новый тип в `apps/api/src/database/schema.ts` (drizzle pgEnum) + `packages/shared/src/schemas/finance.ts` (`transactionTypeSchema`).
- [ ] Миграция `0022_transaction_type_payout_confirmed.sql` (или другой номер) — `ALTER TYPE transaction_type ADD VALUE 'PAYOUT_CONFIRMED'`.
- [ ] `apps/web/app/routes/crm/finance/constants.ts` — добавить label + color для нового типа (lint/typecheck enforce exhaustive Record).

### AC3. `getSummary` admin balance

- [ ] `getSummary` для ADMIN включает новый `PAYOUT_CONFIRMED` (или `ADMIN_INCOME` если A) в balance вычислении. Регрессия — существующие admin balances считаются корректно.

### AC4. RBAC

- [ ] `POST /api/transactions/:id/confirm-payout`: ADMIN + ACCOUNTANT only. Остальные → 403.
- [ ] Для DROP/SENIOR/JUNIOR/HR — endpoint недоступен.

### AC5. Idempotency

- [ ] Двойной вызов `confirmPayout` для уже-PAID транзакции → 400 «Already confirmed». Не создавать дубликат ADMIN_INCOME.

### AC6. UT обязательно

- [ ] `apps/api/src/finance/transactions.confirm-payout.spec.ts`:
  - Happy path: PENDING_PAYMENT → confirmation → PAID + ADMIN_INCOME создан. Проверь amount/currency/projectId совпадают.
  - RBAC: SENIOR/DROP → 403.
  - Wrong status: PAYOUT уже PAID → 400.
  - Wrong type: SENIOR_INCOME → 400.
  - Wrong admin: recipientAdminId не существует / не ADMIN → 400.

### AC7. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/e2e test  # Phase 1/2 регрессия зелёная
docker compose down -v && docker compose up -d && pnpm --filter @crm/api db:migrate && pnpm --filter @crm/api db:seed
```

Все зелёные.

### AC8. PR

- [ ] Ветка `feat/drop-role-phase3`.
- [ ] Push, open PR. Title: `feat(drop): фаза 3 — ручное подтверждение выплаты (backend)`.
- [ ] PR body: ссылка на спек §8.4 + AC + решение по типу (A vs B) с обоснованием + UT результаты.

## Что НЕ нужно

- UI (`apps/web/**`) — следующий task.
- НЕ менять Phase 2 auto-50/50 distribution.
- Спек §8.4 упоминает «Pending выплата процентов синьору» для drop case — это **future scope**, не в этом PR. Только manual confirm для PAYOUT row.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
