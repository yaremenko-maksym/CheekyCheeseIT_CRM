# task-fix-phase4b-bugs

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase4b-channels (продолжение PR #70)

## Контекст

Playwright user testing на PR #70 выявил 3 бага:

1. **Zod v4 UUID rejection** — payment-channel schemas используют `z.string().uuid()`, которая требует RFC version digit `[1-8]` в третьем октете. Seeded MAKSYM_ID/KOSTYA_ID (`00000000-0000-0000-0000-00000000000{1,2}`) имеют `0` там → 400 «Invalid UUID». **Та же ошибка** что фиксили в Phase 3 (см. `confirmPayoutSchema`).
2. **403 на чужие admin balances** — `GET /api/balances/admin/:adminId` строго ADMIN(self)/ACCOUNTANT. Но на `/crm/stats` ADMIN должен видеть **все** admin balances. Текущий RBAC слишком строгий.
3. **English тексты** «Income / Dividends Paid / Expenses / Tax» в `TOV balance card` на `/crm/stats` — должно быть на русском по правилу проекта (язык UI = русский).

## Acceptance Criteria

### AC1. Fix Zod UUID в payment-channel schemas

- [ ] Через ast-grep найди все `z.string().uuid()` в `packages/shared/src/schemas/finance.ts` для payment-channel схем (`initiateCashPaymentSchema`, `confirmCryptoPaymentSchema`, etc.).
- [ ] Заменить на `z.string().regex(UUID_LIKE_REGEX)` (тот же паттерн что в Phase 3 fix).
- [ ] Backend service уже re-validates role+archived, поэтому безопасно.

### AC2. Расширить ADMIN RBAC на чужие admin balances

- [ ] В `apps/api/src/finance/balance.controller.ts` (или service):
  - `GET /api/balances/admin/:adminId` — ADMIN может смотреть **любого** ADMIN (не только себя). ACCOUNTANT — любого. Остальные роли — 403.
  - Текущая логика: ADMIN(self) / ACCOUNTANT(any) → меняется на ADMIN(any ADMIN) / ACCOUNTANT(any).
- [ ] То же для `GET /api/balances/senior/:seniorId` — ADMIN может видеть любого SENIOR (для /crm/stats).
- [ ] **НЕ менять** RBAC для других endpoint'ов.

### AC3. Локализация TOВ balance card

- [ ] В компоненте TOВ balance card на `/crm/stats` (или соответствующем):
  - «Income» → «Доход»
  - «Dividends Paid» → «Выплачено дивидендов»
  - «Expenses» → «Расходы»
  - «Tax» → «Налог»
- [ ] Любые другие EN строки на этой странице — перевести на русский.

### AC4. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
```

Все зелёные.

### AC5. Playwright (через MCP)

- [ ] Login ADMIN → /crm/stats → нет 403 в console, видит Maksym/Kostya balances.
- [ ] POST /api/payments/initiate-cash с recipientAdminId=MAKSYM_ID → 200/201, транзакции созданы.

### AC6. Push

- [ ] `git push origin feat/drop-role-phase4b-channels`
- [ ] `gh pr comment 70` с описанием 3 фиксов.

## Что НЕ нужно

- Любые изменения вне 3 указанных багов.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
