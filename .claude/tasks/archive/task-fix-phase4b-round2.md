# task-fix-phase4b-round2

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase4b-channels (продолжение PR #70)

## Контекст

Второй раунд playwright testing PR #70 выявил архитектурную ошибку в Cash channel + минор в форматировании.

**Cash channel был спроектирован неправильно.** Сейчас дроп якобы сам выбирает админа-получателя. Это неверный флоу:

- Дроп физически идёт к админу (Maksym или Kostya) и передаёт нал. Кто из админов — определяется out-of-band (звонок, встреча).
- В CRM дроп просто фиксирует факт «нал передан».
- ADMIN/ACCOUNTANT в своём UI видит pending cash drop'а и **назначает** какой из админов реально получил → тогда создаются транзакции.

## Acceptance Criteria

### Bug A (критичный) — Cash channel: убрать выбор админа у DROP, добавить confirm-flow для ACCOUNTANT/ADMIN

#### A.1. Backend

- [ ] Изменить `POST /api/payments/initiate-cash`:
  - Body теперь: `{ incomeId }` (БЕЗ `recipientAdminId`).
  - RBAC: DROP (own income) / ACCOUNTANT / ADMIN.
  - НЕ создаёт `ADMIN_INCOME_CASH` и `SENIOR_PENDING_PAYOUT` сразу.
  - Помечает payout (или родительский DROP_INCOME → payout cascade) статусом `PENDING_CASH_CONFIRM` (новый статус payout, добавить в enum миграцией).
  - Сохраняет на payout (или новой таблице `cash_settlements`) channel='CASH' и `confirmedAt=null`, `recipientAdminId=null`.
- [ ] Новый endpoint `POST /api/payments/confirm-cash`:
  - Body: `{ incomeId, recipientAdminId }`.
  - RBAC: **только ACCOUNTANT / ADMIN** (DROP не имеет права).
  - Проверка: recipientAdminId — active ADMIN, не archived.
  - Проверка: payout (income) находится в статусе `PENDING_CASH_CONFIRM`.
  - Создаёт `ADMIN_INCOME_CASH` (amount = partner share) на выбранного админа.
  - Создаёт `SENIOR_PENDING_PAYOUT` (debtor_type='DROP', debtor_user=dropId, creditor=seniorId).
  - Закрывает PAYOUT → `PAID`.
- [ ] Новый endpoint `GET /api/payments/pending-cash`:
  - RBAC: ACCOUNTANT / ADMIN.
  - Возвращает список payout'ов в статусе `PENDING_CASH_CONFIRM`: `{ incomeId, dropName, projectName, amount, currency, initiatedAt }`.
- [ ] Удалить из `confirmCashPayment` / `initiateCashPayment` старую логику с recipientAdminId.
- [ ] Schema (Zod): `initiateCashPaymentSchema` — убрать `recipientAdminId`. Новый `confirmCashPaymentSchema = { incomeId, recipientAdminId }`. RecipientId — `z.string().regex(UUID_LIKE_REGEX)`, не `.uuid()`.
- [ ] Миграция: добавить `PENDING_CASH_CONFIRM` в `payout_status` enum. Скорее всего нужна и новая таблица/колонки для отметки channel='CASH'. Решай по месту, но миграция должна быть только up-migration (без drop таблиц).

#### A.2. Frontend `/crm/payments/initiate/:incomeId`

- [ ] **Cash channel card** (для DROP):
  - Убрать Select с админами.
  - Текст: «Передайте нал любому из админов (Maksym или Kostya). После этого нажмите кнопку — бухгалтер подтвердит зачисление.»
  - Кнопка: «Я передал нал админу».
  - На submit → POST `/api/payments/initiate-cash` `{ incomeId }`. Toast «Ожидает подтверждения бухгалтера», redirect.
- [ ] Убрать GET /api/users?role=ADMIN отсюда полностью.

#### A.3. Frontend — новый UI для ACCOUNTANT/ADMIN

- [ ] На `/crm/finance` (или отдельный route `/crm/finance/pending-cash`) — секция/таб «Ожидают подтверждения cash»:
  - Список pending cash: проект, имя дропа, сумма, дата инициации.
  - Кнопка «Подтвердить получение» → диалог с Select из 2 админов (Maksym/Kostya) → POST `/api/payments/confirm-cash` `{ incomeId, recipientAdminId }`.
  - После подтверждения — список обновляется, транзакции созданы.
  - Скрыт для DROP/SENIOR/JUNIOR/HR.
- [ ] Можно использовать существующий `pending payouts` экран если он уже есть. Решай по месту.

### Bug B (минор) — Форматирование суммы в FinanceTab

- [ ] На `/crm/profile?tab=finance` для DROP в секции «Приходы, ожидающие оплаты компании» сумма сейчас показана как `3500.000000 USDT`.
- [ ] Использовать существующий `formatAmount(amount, currency)` helper из `apps/web/app/lib/format-amount.ts` (или аналог). Должно выводить `$3,500.00 USDT`.
- [ ] **Не менять** существующее форматирование в других местах.

### AC3. UT

- [ ] payment-channel.spec.ts — обновить тесты cash flow:
  - initiate-cash: создаёт payout в PENDING_CASH_CONFIRM, БЕЗ income транзакций.
  - confirm-cash: создаёт ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT, payout → PAID.
  - RBAC: DROP не может confirm-cash (403).
  - Edge: confirm-cash на payout не в PENDING_CASH_CONFIRM → 400.

### AC4. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/e2e test
docker compose down -v && docker compose up -d && pnpm db:migrate && pnpm db:seed
```

Все зелёные.

### AC5. Playwright (через MCP)

- [ ] Login DROP → /crm/payments/initiate/<id> → Cash card **без Select**, только кнопка «Я передал нал».
- [ ] Submit → toast «Ожидает подтверждения», income остаётся в pending state.
- [ ] Login ADMIN → UI с pending cash list → видит запись DROP'а.
- [ ] Confirm с recipientAdmin=Maksym → транзакции созданы, payout PAID.
- [ ] DROP → /crm/profile?tab=finance → сумма `$3,500.00 USDT` (не `3500.000000`).

### AC6. Push

- [ ] `git push origin feat/drop-role-phase4b-channels`
- [ ] `gh pr comment 70` с описанием 2 фиксов + что добавлен новый endpoint `POST /api/payments/confirm-cash` + ACCOUNTANT UI.

## Что НЕ нужно

- Менять crypto/bank каналы.
- Менять RBAC на других endpoint'ах.
- Любые UI изменения вне Cash flow и FinanceTab.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
