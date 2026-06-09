# task-fix-phase4c-e2e-mocks

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase4c-pending-settlement (продолжение PR #71)

## Контекст

После Phase 4-C три новые карточки на `/crm/finance` (Senior/Drop/Tov) и FinanceTab стреляют `GET /api/pending-settlements/{senior,drop,tov}` при mount. В E2E fixtures (`apps/e2e/tests/fixtures.ts`) функция `mockAuthAs` интерсептит API через `page.route()` — без моков эти запросы идут на реальный backend без JWT cookie → 401 → axios interceptor (`apps/web/app/lib/axios.ts`) → `window.location.href = '/login'` → все sidebar-nav тесты с /crm/finance падают.

Тот же фейл-паттерн что фиксили в round 2 для `/api/payments/pending-cash`.

## Acceptance Criteria

### AC1. Добавить 3 mocks в fixtures.ts

В `apps/e2e/tests/fixtures.ts` в функции `mockAuthAs` рядом с уже существующим `/api/payments/pending-cash` моком (внутри notifications/payments секции) добавить:

```ts
// Drop role - phase 4-C. PendingSettlement{Senior,Drop,Tov}Card mount on
// /crm/finance + DROP FinanceTab and immediately fire GET
// /api/pending-settlements/{senior,drop,tov}. Without these mocks → 401 →
// axios interceptor → redirect to /login → every test that touches
// /crm/finance or /crm/profile?tab=finance fails. Same fix pattern as
// /api/payments/pending-cash mock above.
await page.route(new RegExp(`${API}/pending-settlements/senior(\\?.*)?$`), (r) => jsonOk(r, []))
await page.route(new RegExp(`${API}/pending-settlements/drop(\\?.*)?$`), (r) => jsonOk(r, []))
await page.route(new RegExp(`${API}/pending-settlements/tov(\\?.*)?$`), (r) => jsonOk(r, []))
```

### AC2. Локально

```bash
pnpm --filter @crm/e2e test tests/navigation.spec.ts
pnpm --filter @crm/e2e test tests/projects.spec.ts tests/projects-senior-share-override.spec.ts
pnpm --filter @crm/e2e test
```

Все зелёные.

### AC3. Push

- [ ] `git push origin feat/drop-role-phase4c-pending-settlement`
- [ ] `gh pr comment 71` с описанием fix.

## Что НЕ нужно

- Менять PendingSettlement\* карточки.
- Менять axios interceptor.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
