# task-drop-phase4-refactor-remove-tov

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase4-remove-tov

## Зависит от: PR #71 (Phase 4-C merged)

## Контекст

Владелец передумал по бизнес-модели: ТОВ убираем полностью. Партнёрские расчёты идут только в крипте (drop → company) или налом (но налом инициирует ТОЛЬКО ADMIN/ACCOUNTANT, не drop сам).

Это рефакторинг 4-A/4-B/4-C — убираем bank channel, TOV balance, TOV-related транзакции и pending-obligations, перестраиваем cash UI.

## Новая модель

### Drop → Company

- **Crypto channel** (как было): drop отправляет USDT на 3 кошелька. Подтверждает txHash. Создаются 3 транзакции (SENIOR_INCOME_CRYPTO + 2× ADMIN_INCOME_CRYPTO).
- **Cash channel**: drop НЕ инициирует и НЕ имеет UI для cash. ADMIN/ACCOUNTANT видит VALIDATED DROP_INCOME без payout cascade в таблице транзакций на `/crm/finance`, в столбце «Действия» доп. кнопка («Cash передан»). Click → диалог с Select из 2 админов (Maksym/Kostya) → создаются ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT (debtor=DROP).
- **Bank channel**: УБРАТЬ полностью.

### Phase 2/3 manual payout (synior salary etc)

- В существующем `ConfirmPayoutDialog` — радио-выбор «Метод оплаты»: **crypto** (по умолчанию) или **cash**.
- Если crypto — поле txHash как сейчас.
- Если cash — без txHash, просто confirm.
- payment_method сохраняется в PAYOUT_CONFIRMED транзакции.

### TOV — полностью убрать

- Никакого баланса ТОВ.
- Никаких TOV_INCOME / TOV_EXPENSE транзакций.
- Никаких SENIOR_PENDING_PAYOUT с debtor_type='TOV'.

## Acceptance Criteria

### AC1. Backend — удалить bank channel

- [ ] Удалить из `payment-channel.service.ts`: `initiateBankPayment`, `confirmBankPayment`.
- [ ] Удалить из `payment-channel.controller.ts`: `POST /api/payments/initiate-bank`, `POST /api/payments/confirm-bank`.
- [ ] Удалить shared schemas: `initiateBankPaymentSchema`, `confirmBankPaymentSchema`, `initiateBankPaymentResponseSchema`.
- [ ] Удалить из frontend `api.ts`: `initiateBankPayment`, `confirmBankPayment`.

### AC2. Backend — переделать cash channel

- [ ] Удалить из `payment-channel.service.ts`: `initiateCashPayment`, `listPendingCash` (этот pending-cash flow заменяется на новый — admin-initiated).
- [ ] Удалить из controller: `POST /api/payments/initiate-cash`, `GET /api/payments/pending-cash`.
- [ ] Удалить shared schemas: `initiateCashPaymentSchema`, `pendingCashItemSchema`, `pendingCashListResponseSchema`, статус `PENDING_CASH_CONFIRM` из `transactionStatusSchema`. Если есть DB-миграция, добавляющая этот статус — добавь обратную миграцию убирающую его (по up-only добавь note или просто оставь enum value, но не используй).
- [ ] Изменить `confirmCashPayment`:
  - Body: `{ incomeId, recipientAdminId }` (как сейчас).
  - RBAC: **только ACCOUNTANT / ADMIN** (DROP не может).
  - Проверка: income — VALIDATED DROP_INCOME без существующего payout cascade.
  - Создаёт ADMIN_INCOME_CASH на recipientAdminId + SENIOR_PENDING_PAYOUT (debtor=DROP) — как сейчас.
  - Закрывает PAYOUT → PAID. Если PAYOUT placeholder не существует — создать.
- [ ] Endpoint остаётся `POST /api/payments/confirm-cash`.

### AC3. Backend — удалить ТОВ balance + obligations

- [ ] Удалить `BalanceService.getTOVBalance` + endpoint `GET /api/balances/tov`.
- [ ] Удалить `pending-settlement.service.ts.listTovObligations` + `settleByTov`.
- [ ] Удалить endpoints `GET /api/pending-settlements/tov`, `POST /api/pending-settlements/:id/settle-tov`.
- [ ] В `confirmBankPayment` (только что удалён) была логика создания TOV_INCOME — её больше нет.
- [ ] Не создавать новые `SENIOR_PENDING_PAYOUT` с `debtor_type='TOV'`. Если такие есть в DB — оставить (для history), но новые не создавать.
- [ ] Удалить из shared schemas: tov-related types, tovBalance fields из `financeSummarySchema` если есть.

### AC4. Backend — payment_method в payout cash

- [ ] В `confirmPayout` (Phase 3 manual confirmation) добавить параметр `method: 'CRYPTO' | 'CASH'`.
- [ ] Если CRYPTO — требовать `txHash`. Если CASH — НЕ требовать txHash.
- [ ] Сохранять `payment_method` в созданной PAYOUT_CONFIRMED транзакции (новый field в schema если нет).
- [ ] Update shared `confirmPayoutSchema` соответственно.

### AC5. Frontend — убрать TOВ balance card на /crm/stats

- [ ] Удалить компонент TOВ balance card (или TOВ section).
- [ ] Удалить hook `useTOVBalance` если есть.
- [ ] Список балансов участников (Admin/Senior) — оставить.

### AC6. Frontend — переделать /crm/payments/initiate/:incomeId

- [ ] Удалить Bank UAH на ТОВ card.
- [ ] Удалить Cash card (для DROP).
- [ ] DROP видит **только crypto card** (Подтвердить отправку с txHash).
- [ ] ADMIN/ACCOUNTANT видят на этой странице **только crypto card** тоже — для cash они идут через transactions table action.
- [ ] Если страница теперь содержит только 1 канал — пересмотреть layout (убрать «Выберите канал», просто крупная crypto секция).

### AC7. Frontend — Cash action в transactions table

- [ ] В `apps/web/app/routes/crm/finance/components/TransactionRow.tsx` для строк `tx.type === 'DROP_INCOME' && tx.status === 'VALIDATED' && (нет payout cascade)`:
  - Если actor — ADMIN/ACCOUNTANT — показывать доп. кнопку в action column: «Cash передан» (или icon).
  - Click → диалог `LogCashPaymentDialog` (новый компонент).
  - Диалог: Select из Maksym/Kostya, кнопка «Подтвердить».
  - Submit → POST `/api/payments/confirm-cash` с `{ incomeId: tx.id, recipientAdminId }`.
  - Toast «Cash зафиксирован», invalidate queries.
- [ ] Backend поможет: возвращать в `transactionSchema` поле `hasPayoutCascade: boolean` (computed) или другой способ узнать что cascade ещё нет. Решай по месту.

### AC8. Frontend — убрать PendingCashCard

- [ ] Удалить компонент `apps/web/app/routes/crm/finance/components/PendingCashCard.tsx`.
- [ ] Удалить его рендеринг из `apps/web/app/routes/crm/finance/index.tsx`.
- [ ] Удалить `financeApi.listPendingCash` из `api.ts`.

### AC9. Frontend — PendingSettlement{Tov} убрать, Senior/Drop оставить

- [ ] Удалить `PendingSettlementTovCard.tsx`.
- [ ] Удалить его рендеринг из `finance/index.tsx`.
- [ ] Удалить из `api.ts` функции для tov pending settlements.
- [ ] `PendingSettlementSeniorCard` — оставить (синьоры всё ещё видят долги от дропов).
- [ ] `PendingSettlementDropCard` — оставить (дропы всё ещё могут платить долг синьору).
- [ ] Также убедиться что `PendingSettlementSeniorCard` не показывает TOV-должников (фильтр по debtorType='DROP' только).

### AC10. Frontend — ConfirmPayoutDialog: radio method

- [ ] В `apps/web/app/components/finance/ConfirmPayoutDialog.tsx` добавить radio group:
  - 💎 Крипта (default) — показывать input txHash + ссылку на etherscan.
  - 💵 Наличка — НЕ показывать txHash, прятать поле.
- [ ] Submit:
  - Если crypto — POST с `{ method: 'CRYPTO', txHash }`.
  - Если cash — POST с `{ method: 'CASH' }` без txHash.

### AC11. UT обязательно

- [ ] `payment-channel.spec.ts`:
  - bank methods — удалены.
  - confirmCash: ADMIN/ACCOUNTANT может, DROP — 403.
  - confirmCash на не-VALIDATED DROP_INCOME → 400.
  - confirmCash дважды → 400 (idempotency / cascade-exists check).
- [ ] `pending-settlement.spec.ts`:
  - settleByTov — удалить тесты.
  - listTov — удалить.
  - senior/drop — остаются.
- [ ] `payouts.spec.ts` (или где confirmPayout):
  - method='CRYPTO' — требует txHash.
  - method='CASH' — без txHash.
  - payment_method сохраняется в PAYOUT_CONFIRMED.

### AC12. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
docker compose down -v && docker compose up -d && pnpm db:migrate && pnpm db:seed
```

Все зелёные.

### AC13. E2E mocks

- [ ] В `apps/e2e/tests/fixtures.ts` удалить моки для удалённых endpoints (`/api/payments/pending-cash`, `/api/balances/tov`, `/api/pending-settlements/tov`, bank endpoints).

### AC14. Playwright (через MCP)

- [ ] Login DROP → /crm/payments/initiate/<id> → видит **ТОЛЬКО crypto card**, без Bank/Cash.
- [ ] Login ADMIN → /crm/finance → видит на DROP_INCOME row кнопку «Cash передан». Click → диалог с Select Maksym/Kostya → submit → транзакции созданы (ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT).
- [ ] Login ADMIN → /crm/finance → НЕ видит «Долги ТОВ перед синьорами» (карточка удалена).
- [ ] Login ADMIN → /crm/stats → НЕ видит TOВ balance card.
- [ ] Login SENIOR → confirmPayout → диалог имеет radio crypto/cash. Cash → нет поля txHash.

### AC15. PR

- [ ] Ветка `feat/drop-role-phase4-remove-tov`.
- [ ] Title: `refactor(drop): убрать ТОВ — каналы только crypto/cash + admin-инициирует cash + payout method radio`.
- [ ] Body — подробно: что удалено (bank channel, TOV balance, PendingCashCard, PendingSettlementTovCard, TOВ-related endpoints), что переделано (cash flow drop→company теперь admin-initiated через action в таблице, payout dialog получил method radio).

## Что НЕ нужно

- Удалять DB-данные (transactions с типом TOV_INCOME / TOV_EXPENSE могут остаться в истории).
- Менять crypto channel логику.
- Smart contract integration — Phase 5.
- Phase 4-D (dividends withdrawal) — отдельно.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
