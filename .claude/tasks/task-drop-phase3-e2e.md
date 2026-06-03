# task-drop-phase3-e2e

## Агент: autotest

## Приоритет: high

## Ветка: feat/drop-role-phase3 (та же)

## Зависит от: backend + frontend Phase 3 (в ветке)

## Контекст

E2E для Phase 3 manual payout confirmation. Real-API подход.

## Подготовка

1. Прочитай: docs/agents/autotest.md, docs/agents/memory/autotest/lessons.md.
2. `git checkout feat/drop-role-phase3` — backend + frontend в ветке.
3. Postgres MCP: подтверди новый тип транзакции (если backend выбрал PAYOUT_CONFIRMED).

## Acceptance Criteria

### AC1. Helpers в fixtures.ts

- [ ] Расширить `apps/e2e/tests/fixtures.ts`:
  - `confirmPayoutViaAPI(page, txId, recipientAdminId)` — POST /api/transactions/:id/confirm-payout, возвращает { paidPayout, adminIncomeTx }.
  - `findPendingPayoutsForProjectViaAPI(page, projectId)` — фильтр PAYOUT + PENDING_PAYMENT.

### AC2. Happy path — drop project

`apps/e2e/tests/drop-confirm-payout.spec.ts`:

- [ ] Setup через real API: drop user + senior + drop-project. DROP creates DROP_INCOME → ACCOUNTANT validates → Phase 2 создаёт payout_request + PAYOUT (PENDING) + PAYOUT_DROP + 2× PAYOUT_ADMIN.
- [ ] Login ADMIN → /crm/finance → найти PAYOUT row → клик «Подтвердить оплату».
- [ ] Asserts:
  - Диалог открыт. Info-block содержит amount + currency + sender displayName.
  - Select «Кому пришла оплата» с опциями Maksym + Kostya.
- [ ] Выбрать Maksym → submit.
- [ ] Asserts через postgres MCP:
  - PAYOUT: status = `PAID`, validatedBy != null, validatedAt != null.
  - Новая транзакция: type = `ADMIN_INCOME` (или `PAYOUT_CONFIRMED`), recipientId = Maksym, amount = PAYOUT.amount, projectId = PAYOUT.projectId.
- [ ] UI: PAYOUT badge «Оплачено» (PAID), новая ADMIN_INCOME строка с recipient = Maksym.

### AC3. Senior project flow

`apps/e2e/tests/senior-confirm-payout.spec.ts`:

- [ ] Setup: senior creates SENIOR_INCOME → validate → PAYOUT (PENDING).
- [ ] ACCOUNTANT clicks confirm-payout → выбирает Kostya → submit.
- [ ] Asserts: PAYOUT PAID, новая ADMIN_INCOME для Kostya.

### AC4. RBAC

`apps/e2e/tests/drop-confirm-payout-rbac.spec.ts`:

- [ ] Login DROP → /crm/finance → его собственная PAYOUT row → НЕТ кнопки «Подтвердить оплату».
- [ ] Login DROP → direct API call POST /api/transactions/:id/confirm-payout → 403.
- [ ] Аналогично SENIOR / JUNIOR / HR → 403.
- [ ] ADMIN + ACCOUNTANT → 200.

### AC5. Edge cases

`apps/e2e/tests/drop-confirm-payout-edges.spec.ts`:

- [ ] Confirm уже PAID транзакцию → 400.
- [ ] Confirm транзакцию типа SENIOR_INCOME → 400.
- [ ] Confirm с invalid recipientAdminId (нерабочий UUID или не ADMIN) → 400.

### AC6. Регрессия — Phase 2 auto-50/50 остаётся

`apps/e2e/tests/phase2-auto-distribution-regression.spec.ts` (extend существующий drop-distribution.spec.ts):

- [ ] DROP_INCOME validate → Phase 2 создаёт 4 транзакции (PAYOUT + PAYOUT_DROP + 2× PAYOUT_ADMIN). **Не сломалось** после Phase 3.
- [ ] После confirm-payout: 4 Phase 2 транзакции остаются, добавляется 5-я (ADMIN_INCOME confirmed).

### AC7. Локально

```bash
pnpm --filter @crm/e2e test
```

Все зелёные.

### AC8. Push

- [ ] git push origin feat/drop-role-phase3
- [ ] gh pr comment <N> — список новых spec'ов.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
