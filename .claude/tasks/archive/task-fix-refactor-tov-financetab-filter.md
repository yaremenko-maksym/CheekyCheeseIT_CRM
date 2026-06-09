# task-fix-refactor-tov-financetab-filter

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase4-remove-tov (продолжение PR #72)

## Контекст

User testing PR #72 выявил баг в `FinanceTab.tsx`:

**Сейчас**: на `/crm/profile?tab=finance` для DROP секция «ПРИХОДЫ, ОЖИДАЮЩИЕ ОПЛАТЫ КОМПАНИИ» показывает все VALIDATED DROP_INCOME независимо от того, settled ли cascade. Если ADMIN/ACCOUNTANT уже зафиксировал cash через кнопку «Cash передан» (создан ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT + PAYOUT → PAID), приход всё равно отображается с кнопкой «Платить компании».

Если drop кликнет — попадёт на `/crm/payments/initiate/<id>` с crypto card и кнопкой «Подтвердить отправку». Backend вернёт 400 (income already settled), но UX confusing.

## Acceptance Criteria

### AC1. Фикс фильтра

- [ ] В `apps/web/app/components/user-profile/tabs/FinanceTab.tsx` найти секцию «ПРИХОДЫ, ОЖИДАЮЩИЕ ОПЛАТЫ КОМПАНИИ» (или аналогичный заголовок).
- [ ] Текущий фильтр (вероятно) — `tx.type === 'DROP_INCOME' && tx.status === 'VALIDATED'`.
- [ ] Изменить: дополнительно исключить incomes у которых **уже есть settled cascade**:
  - Имеется PAYOUT транзакция с `payout_request_id = tx.payout_request_id` И статус PAYOUT = PAID.
  - ИЛИ: backend возвращает в `transactionDto` поле `hasSettledCascade: boolean` (computed) — использовать его.
  - Или другой способ — решай по месту. Backend можно дополнить вычислимым полем если frontend этого не знает.

### AC2. Backend (если нужен computed field)

- [ ] Если выбран путь через DTO поле — в `TransactionsService.list*` (или где собирается список) для каждого DROP_INCOME проставить `hasSettledCascade` (true если есть PAYOUT в PAID с тем же payout_request_id).
- [ ] Добавить поле в `transactionSchema` в shared (optional boolean).

### AC3. Альтернатива (проще)

- [ ] Если на frontend уже грузится полный список транзакций — фильтровать на клиенте: проверить наличие PAYOUT в PAID с тем же `payoutRequestId` в массиве `transactions`. Если есть — не показывать в pending секции.

### AC4. UT/E2E

- [ ] Если есть тест на FinanceTab — обновить чтобы покрывал случай settled cascade.

### AC5. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
```

Все зелёные.

### AC6. Playwright verify

- [ ] Login DROP с уже-settled cash flow (есть PAYOUT PAID для одного из incomes) → /crm/profile?tab=finance → секция «ПРИХОДЫ, ОЖИДАЮЩИЕ ОПЛАТЫ КОМПАНИИ» НЕ показывает этот income.
- [ ] Если есть incomes без cascade — они показываются с кнопкой «Платить компании».

### AC7. Push

- [ ] `git push origin feat/drop-role-phase4-remove-tov`
- [ ] `gh pr comment 72` с описанием фикса.

## Что НЕ нужно

- Менять PendingSettlement\* карточки.
- Менять Cash/Crypto flow логику.
- Менять `/crm/payments/initiate/:id` page.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
