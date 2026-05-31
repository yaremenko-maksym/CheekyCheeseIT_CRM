# task-drop-phase4c-pending-settlement

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase4c-pending-settlement

## Зависит от: Phase 4-B (merged в main: PR #70 — каналы оплаты + TOВ balance card)

## Контекст

**Phase 4-C** — UI для закрытия pending senior obligations, созданных в Phase 4-B.

Phase 4-B создаёт `SENIOR_PENDING_PAYOUT` транзакции в двух случаях:

1. **Bank channel** (drop платит на ТОВ): `debtor_type='TOV'` — ТОВ должен синьору senior-долю.
2. **Cash channel** (drop отдаёт нал админу): `debtor_type='DROP'`, `debtor_user=drop.id` — дроп должен синьору senior-долю.

Phase 4-C даёт UI чтобы:

- Бухгалтер закрывал TOV-долги переводом с ТОВ-баланса синьору.
- Дроп закрывал свои долги синьорам (платил из своих средств).
- Синьор видел список ожидающих зачислений и мог подтверждать получение (для дропа) или просто видеть статус (для ТОВ).

## Подготовка

1. Прочитай docs/agents/coder.md, docs/agents/CLAUDE-coder.md, docs/agents/memory/coder/lessons.md.
2. Прочитай Phase 4-A: `SENIOR_PENDING_PAYOUT` + `pending_obligations` table — структура в main.
3. Прочитай Phase 4-B: `confirmBankPayment` + `confirmCashPayment` — где создаются SENIOR_PENDING_PAYOUT.
4. Через ast-grep сними карту: `pending_obligations` таблица (если есть), `SENIOR_PENDING_PAYOUT` создание/чтение.

## Acceptance Criteria

### AC1. Backend — `PendingSettlementService` (или дополнить BalanceService)

`apps/api/src/finance/pending-settlement.service.ts`:

- [ ] `listSeniorObligations(actor)`:
  - RBAC: SENIOR (свои pending), ADMIN/ACCOUNTANT (все).
  - Возвращает: список SENIOR_PENDING_PAYOUT в статусе PENDING_PAYMENT — `{ id, debtorType: 'DROP'|'TOV', debtorName, seniorId, seniorName, amount, currency, projectName, createdAt }`.
  - Sort by createdAt DESC.

- [ ] `listDropObligations(actor)`:
  - RBAC: DROP (свои долги), ADMIN/ACCOUNTANT (все).
  - Возвращает: SENIOR_PENDING_PAYOUT где debtor_type='DROP' и debtor_user_id=actor.id (для DROP) или все (для ADMIN/ACCOUNTANT).

- [ ] `listTovObligations(actor)`:
  - RBAC: ADMIN / ACCOUNTANT.
  - Возвращает: SENIOR_PENDING_PAYOUT где debtor_type='TOV'.

- [ ] `settleByDrop(obligationId, actor)`:
  - RBAC: caller = debtor drop OR ACCOUNTANT/ADMIN.
  - Проверка: obligation существует, статус PENDING_PAYMENT, debtor_type='DROP'.
  - Действие:
    - Закрывает SENIOR_PENDING_PAYOUT (PENDING_PAYMENT → PAID).
    - Создаёт `SENIOR_INCOME` (или новый тип `SENIOR_INCOME_FROM_DROP`, по аналогии с _\_CASH/_\_CRYPTO — решай по месту) на синьора, amount + currency из obligation.
    - Если новый тип нужен — добавь enum через миграцию.
  - Возвращает обновлённую obligation + новую транзакцию.

- [ ] `settleByTov(obligationId, actor)`:
  - RBAC: ACCOUNTANT / ADMIN.
  - Проверка: obligation существует, статус PENDING_PAYMENT, debtor_type='TOV'.
  - Проверка баланса ТОВ: если ТОВ не хватает — 400 «Недостаточно средств на ТОВ».
  - Действие:
    - Закрывает SENIOR_PENDING_PAYOUT.
    - Создаёт `TOV_EXPENSE` (или новый `SENIOR_INCOME_FROM_TOV`) — уменьшает ТОВ-баланс.
    - Создаёт `SENIOR_INCOME` (или `SENIOR_INCOME_FROM_TOV`) — добавляет на senior баланс.
  - Возвращает обновлённую obligation + новые транзакции.

### AC2. Endpoints

`apps/api/src/finance/pending-settlement.controller.ts`:

- [ ] `GET /api/pending-settlements/senior` — список pending для текущего юзера (SENIOR / ADMIN / ACCOUNTANT).
- [ ] `GET /api/pending-settlements/drop` — список долгов дропа (DROP / ADMIN / ACCOUNTANT).
- [ ] `GET /api/pending-settlements/tov` — список долгов ТОВ (ADMIN / ACCOUNTANT).
- [ ] `POST /api/pending-settlements/:id/settle-drop` — body `{}`. RBAC: DROP (own debt) / ACCOUNTANT / ADMIN.
- [ ] `POST /api/pending-settlements/:id/settle-tov` — body `{}`. RBAC: ACCOUNTANT / ADMIN.

### AC3. Frontend — SENIOR view

`apps/web/app/routes/crm/finance/index.tsx`:

- [ ] Для роли SENIOR добавить секцию **«Ожидают зачисления»** (выше или ниже существующих списков):
  - Использовать карточку аналогично `PendingCashCard` (см. round 2 паттерн).
  - Карточка содержит:
    - Заголовок: «Ожидают зачисления»
    - Подсказка: «Senior-доля от дропа или ТОВ. Закроется автоматически когда дроп заплатит / бухгалтер обработает выплату».
    - Список: проект, тип долга (Дроп: <имя> или ТОВ), сумма с `formatAmountUsd`, дата.
  - **Не показывает кнопку «получил»** — пассивный view (закрытие триггерится действиями DROP / ACCOUNTANT).

### AC4. Frontend — DROP view

`apps/web/app/components/user-profile/tabs/FinanceTab.tsx`:

- [ ] Для DROP добавить секцию **«Долги перед синьорами»** (после «Приходы, ожидающие оплаты компании»):
  - Список SENIOR_PENDING_PAYOUT где debtor_type='DROP' и debtor=drop.
  - Поля: имя синьора, проект, сумма (`formatAmountUsd`), дата.
  - Кнопка **«Я заплатил синьору»** → POST `/api/pending-settlements/:id/settle-drop`. Toast «Долг закрыт».

### AC5. Frontend — ACCOUNTANT/ADMIN view

`apps/web/app/routes/crm/finance/index.tsx`:

- [ ] Для ADMIN/ACCOUNTANT добавить секцию **«Долги ТОВ перед синьорами»** (рядом с другими pending панелями):
  - Карточка-аналог `PendingCashCard`.
  - Поля: имя синьора, проект, сумма, дата.
  - Кнопка **«Выплатить из ТОВ»** → POST `/api/pending-settlements/:id/settle-tov`. Toast «Выплата проведена».
  - Если ТОВ-баланс недостаточен — кнопка disabled + tooltip «Недостаточно средств на ТОВ».

### AC6. Regression — Phase 4-B каналы не сломаны

- [ ] confirmBankPayment всё ещё создаёт SENIOR_PENDING_PAYOUT (debtor=TOV).
- [ ] confirmCashPayment всё ещё создаёт SENIOR_PENDING_PAYOUT (debtor=DROP).
- [ ] Mutex логика payout settle всё ещё работает.

### AC7. UT обязательно

`apps/api/src/finance/pending-settlement.spec.ts`:

- [ ] settleByDrop: закрывает obligation + создаёт SENIOR_INCOME.
- [ ] settleByTov: создаёт TOV_EXPENSE + SENIOR_INCOME, ТОВ balance уменьшается.
- [ ] settleByTov insufficient balance → 400.
- [ ] RBAC: DROP не может settle чужой долг, SENIOR не может settle (только видит).
- [ ] Edge: already-settled obligation → 400.

### AC8. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
docker compose down -v && docker compose up -d && pnpm db:migrate && pnpm db:seed
```

Все зелёные.

### AC9. Playwright (через MCP)

- [ ] Login DROP → /crm/profile?tab=finance → видит «Долги перед синьорами» с кнопкой «Я заплатил». Click → долг исчезает, toast.
- [ ] Login SENIOR → /crm/finance → видит «Ожидают зачисления».
- [ ] Login ADMIN → /crm/finance → видит «Долги ТОВ перед синьорами». Click «Выплатить из ТОВ» → транзакции созданы, ТОВ balance уменьшается.
- [ ] RBAC: DROP получает 403 на /pending-settlements/tov.

### AC10. PR

- [ ] Ветка `feat/drop-role-phase4c-pending-settlement`.
- [ ] Title: `feat(drop): фаза 4c — pending senior settlement UI (drop/tov долги синьорам)`.
- [ ] Body с описанием 3 секций UI + новых endpoints + что было создано.

## Что НЕ нужно

- Менять confirm-bank / confirm-cash логику (Phase 4-B уже создаёт SENIOR_PENDING_PAYOUT).
- Менять Cash/Bank/Crypto UI на initiate page.
- Dividends withdrawal — Phase 4-D.
- Smart contract integration — Phase 5.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
