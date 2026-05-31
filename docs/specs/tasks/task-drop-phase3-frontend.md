# task-drop-phase3-frontend

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase3 (та же)

## Зависит от: task-drop-phase3-backend (в ветке)

## Контекст

UI для Phase 3 — кнопка «Подтвердить оплату» на строке PAYOUT (тип PENDING_PAYMENT) с диалогом выбора админа. Backend готов (POST /api/transactions/:id/confirm-payout). Дефолтная сумма берётся из PAYOUT row (read-only).

## Acceptance Criteria

### AC1. Кнопка «Подтвердить оплату» на /crm/finance

- [ ] В таблице транзакций на `/crm/finance` (или `/crm/finance/index.tsx`):
  - Если `tx.type === 'PAYOUT'` И `tx.status === 'PENDING_PAYMENT'`:
    - В колонке «Действия» добавить кнопку **«Подтвердить оплату»** (data-testid `confirm-payout-button-{txId}`).
    - Видна только ADMIN и ACCOUNTANT.
  - Для других транзакций — кнопка не показывается.
- [ ] Регрессия: текущие действия в таблице (редактировать, удалить) — без изменений.

### AC2. Диалог «Подтвердить оплату»

- [ ] Новый компонент `apps/web/app/components/finance/ConfirmPayoutDialog.tsx`:
  - Open через клик на кнопку из AC1.
  - Заголовок: «Подтвердить оплату».
  - Содержимое:
    - Тёмный info-block: «Транзакция выплаты `${tx.amount} ${tx.currency}` от `${sender.displayName}`». Read-only.
    - Поле Select **«Кому пришла оплата»** (required, data-testid `confirm-payout-admin-select`):
      - Опции: Maksym Yaremenko, Kostya (active ADMINs из API `/users?role=ADMIN&active=true`).
      - Default: пустой («— выберите админа —»).
    - Поле «Сумма» — read-only badge `${tx.amount} ${tx.currency}` (no input).
  - Кнопки: «Отмена» / **«Подтвердить»** (data-testid `confirm-payout-submit`).
- [ ] Submit:
  - POST `/api/transactions/${txId}/confirm-payout` с body `{ recipientAdminId: selectedAdmin.id }`.
  - На success → toast «Оплата подтверждена», invalidate queries `['transactions']` + `['finance-summary']`, закрыть диалог.
  - На 400/403/409 → toast.error с backend message или fallback «Не удалось подтвердить оплату».

### AC3. Отображение PAID PAYOUT и ADMIN_INCOME

- [ ] После confirmation:
  - PAYOUT строка — status badge меняется на «Оплачено» (зелёный).
  - В таблице **появляется новая ADMIN_INCOME строка** (или PAYOUT_CONFIRMED, как backend решил) с recipient = выбранный админ, amount = PAYOUT amount.
- [ ] `apps/web/app/routes/crm/finance/constants.ts` — label + color для нового типа уже добавлены в backend task.

### AC4. Регрессия

- [ ] Все остальные финансовые экраны (Phase 2 distribution UI, balances, drop project detail finance tab) — без изменений.
- [ ] Existing transaction actions (edit/delete) на других типах — работают как раньше.

### AC5. Локально

```bash
pnpm typecheck
pnpm lint
pnpm --filter @crm/web build
pnpm test
pnpm --filter @crm/e2e test
```

Все зелёные.

### AC6. Playwright проверка (через MCP)

Скриншоты в `/tmp/drop-phase3-fe-*.png`:

- [ ] Login ADMIN → /crm/finance → видна кнопка «Подтвердить оплату» на PAYOUT (PENDING_PAYMENT) строке.
- [ ] Клик → диалог открыт, info-block с суммой/валютой, Select админа, read-only сумма.
- [ ] Submit без выбора админа → ошибка валидации.
- [ ] Submit с Maksym → toast «Оплата подтверждена», PAYOUT badge «Оплачено», новая строка ADMIN_INCOME / PAYOUT_CONFIRMED появилась.
- [ ] DROP/SENIOR/JUNIOR/HR → кнопка не показывается (UI hide + 403 на backend если direct API).

### AC7. Push

- [ ] git push origin feat/drop-role-phase3
- [ ] gh pr comment <N> с summary + скриншоты.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
