# task-drop-phase4a-balances-backend

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase4-balances

## Зависит от: Phase 3 (merged в main: PR #68)

## Источник истины: пользовательская спецификация (см. Контекст)

## Контекст

**Phase 4-A** — базовая инфраструктура балансов для будущих каналов оплаты дропа (Phase 4-B). Только backend, без UI.

Модель:

- **TOВ balance** — корпоративный счёт. Источник прибыли. Из него выводятся дивиденды 50/50.
- **Admin balance** (на каждого админа: Maksym + Kostya) — личные деньги. +=crypto/cash incomes, +=dividends.
- **Senior balance** (на каждого синьора) — личные. += incomes от drop/TOВ.
- **Pending senior obligations** — отдельные сущности «X owes senior Y», статус PENDING/PAID.

**Принципы**:

1. Балансы вычисляются **on-demand** из transactions, не хранятся отдельно.
2. Каждая транзакция меняет ровно один баланс (за исключением dividends — TOВ и admin одной операцией).
3. Pending obligations — отдельные сущности с lifecycle.

## Подготовка

1. Прочитай docs/agents/coder.md, docs/agents/CLAUDE-coder.md, docs/agents/memory/coder/lessons.md.
2. Через ast-grep сними карту: где `getSummary` (Phase 2 admin balances), где `partnerBalances`, MAKSYM_ID, KOSTYA_ID. Туда добавлять ветки Phase 4.
3. Прочитай существующие transaction types в [`packages/shared/src/schemas/finance.ts`](../../packages/shared/src/schemas/finance.ts) — расширяем enum.

## Acceptance Criteria

### AC1. Новые типы транзакций (миграция 0023)

- [ ] В `packages/shared/src/schemas/finance.ts` `transactionTypeSchema` добавить:
  - `TOV_INCOME` — поступление на корпоративный счёт ТОВ.
  - `SENIOR_PENDING_PAYOUT` — обязательство выплатить синьору (pending). Не меняет баланс синьора пока не закрыто.
  - `SENIOR_PAID` — закрытие pending senior (создаёт реальный приход на senior balance + связывает с pending).
  - `ADMIN_INCOME_CASH` — приход cash на личный баланс админа.
  - `ADMIN_INCOME_CRYPTO` — приход USDT на личный crypto-кошелёк админа.
  - `SENIOR_INCOME_CRYPTO` — приход USDT на crypto-кошелёк синьора.
  - `DIVIDEND_TO_ADMIN` — распределение из TOВ на admin balance (50/50).
  - `DIVIDEND_TAX` — налог на дивиденды (6.5%).
- [ ] В `apps/api/src/database/schema.ts` соответствующий drizzle pgEnum обновить.
- [ ] Миграция `apps/api/drizzle/migrations/0023_phase4a_balance_types.sql`:
  - `ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS '...'` для каждого нового значения.
  - Без UPDATE существующих rows (новые типы только для новых транзакций).

### AC2. Новая таблица pending_obligations

- [ ] `apps/api/src/database/schema.ts` — таблица `pending_obligations`:
  ```ts
  {
    id: uuid primary,
    creditor_user_id: uuid FK users   // кто должен получить (senior)
    debtor_type: enum('DROP', 'TOV', 'ADMIN')  // кто должен (источник)
    debtor_user_id: uuid nullable FK users  // если DEBTOR=DROP/ADMIN
    source_transaction_id: uuid FK transactions  // откуда возникло (например, TOV_INCOME)
    closing_transaction_id: uuid nullable FK transactions  // SENIOR_PAID который закрыл
    amount: numeric(20,6)
    currency: text  // 'USDT', 'USD', 'UAH', 'EUR'
    status: enum('PENDING', 'PAID', 'CANCELLED')
    created_at, updated_at
  }
  ```
- [ ] Migration включает создание таблицы + индексы по `creditor_user_id`, `status`, `source_transaction_id`.

### AC3. BalanceService

- [ ] Новый сервис `apps/api/src/finance/balance.service.ts`:
  - `getTOVBalance(currency = 'USD'): Promise<{ balance, breakdown }>`:
    - balance = sum(TOV_INCOME) − sum(DIVIDEND_TO_ADMIN) − sum(EXPENSE where channel=FIAT_TOV) − sum(DIVIDEND_TAX).
    - breakdown = { income, dividends_paid, expenses, tax }
  - `getAdminBalance(adminId, currency = 'USD'): Promise<{ balance, breakdown }>`:
    - balance = sum(ADMIN_INCOME_CASH/CRYPTO where recipient=adminId) + sum(DIVIDEND_TO_ADMIN where recipient=adminId) − sum(EXPENSE where sender=adminId).
  - `getSeniorBalance(seniorId, currency): { balance, breakdown }`:
    - balance = sum(SENIOR*INCOME*\*/SENIOR_PAID where recipient=seniorId) − sum(EXPENSE where sender=seniorId).
  - `getPendingObligations(filter?: { creditor?, status? }): PendingObligation[]`:
    - Прямой fetch из `pending_obligations` table.
  - Все методы поддерживают мульти-валютный учёт (предполагается USD как базовый, остальные конвертируются через NBU rate из существующего сервиса).

### AC4. Endpoints

- [ ] `apps/api/src/finance/balance.controller.ts`:
  - `GET /api/balances/tov` → BalanceService.getTOVBalance(). RBAC: ADMIN/ACCOUNTANT.
  - `GET /api/balances/admin/:adminId` → BalanceService.getAdminBalance(). RBAC: ADMIN (только свой) / ACCOUNTANT (любой).
  - `GET /api/balances/senior/:seniorId` → BalanceService.getSeniorBalance(). RBAC: SENIOR (только свой) / ADMIN / ACCOUNTANT (любой).
  - `GET /api/pending-obligations?status=PENDING` → BalanceService.getPendingObligations(). RBAC: SENIOR (where creditor=self) / ADMIN / ACCOUNTANT.

### AC5. Shared schemas

- [ ] `packages/shared/src/schemas/finance.ts`:
  - `balanceSchema = z.object({ balance: z.number(), currency: z.string(), breakdown: z.record(z.number()) })`.
  - `pendingObligationSchema = z.object({ id, creditorUserId, debtorType, debtorUserId, sourceTransactionId, closingTransactionId, amount, currency, status, createdAt })`.
  - Экспортированы.

### AC6. Регрессия — Phase 2/3 не сломаны

- [ ] Существующий `getSummary` (admin balances из PAYOUT_ADMIN + PAYOUT_CONFIRMED) — **без изменений**. Это легаси, остаётся работать.
- [ ] Новые методы `BalanceService` — **параллельно**, не заменяют `getSummary` пока.
- [ ] Все существующие тесты Phase 1/2/3 проходят без правок.

### AC7. UT обязательно

- [ ] `apps/api/src/finance/balance.spec.ts`:
  - TOВ balance: пустой → 0. После 1× TOV_INCOME $1000 → 1000. После DIVIDEND_TO_ADMIN $500 → 500. После EXPENSE $100 → 400.
  - Admin balance: пустой → 0. После ADMIN_INCOME_CASH $500 → 500. После DIVIDEND_TO_ADMIN $250 → 750.
  - Senior balance: SENIOR_PENDING_PAYOUT **не меняет** balance. SENIOR_PAID меняет.
  - Pending obligations: создание → 1 row PENDING. Закрытие SENIOR_PAID с `closing_transaction_id` → status PENDING стать PAID.
  - Edge: multi-валютный (USDT + UAH + USD), конверсия через NBU rate.
- [ ] `apps/api/src/finance/pending-obligations.spec.ts`:
  - Creation, query filters, RBAC (senior видит только свои).

### AC8. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/e2e test  # регрессия
docker compose down -v && docker compose up -d && pnpm --filter @crm/api db:migrate && pnpm --filter @crm/api db:seed  # миграция 0023 чистая
```

Все зелёные.

### AC9. PR

- [ ] Ветка `feat/drop-role-phase4-balances`.
- [ ] Push, open PR. Title: `feat(drop): фаза 4a — schema + балансы (backend infrastructure)`.
- [ ] PR body: ссылка на эту task + список новых типов + AC чеклист + UT результаты.

## Что НЕ нужно

- UI / `apps/web/**` — будет в Phase 4-B вместе с payment channels.
- Сами payment channels — Phase 4-B.
- Pending settlement UI — Phase 4-C.
- Dividends withdrawal UI — Phase 4-D.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
