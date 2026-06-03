# task-fix-phase4b-e2e-mock

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase4b-channels (продолжение PR #70)

## Контекст

После round 2 commit'а PendingCashCard на `/crm/finance` стреляет `GET /api/payments/pending-cash` при mount для ADMIN/ACCOUNTANT. В E2E fixtures (`apps/e2e/tests/fixtures.ts`) используется `mockAuthAs` который мокает API через `page.route()` — но без мока этого endpoint'а запрос идёт на реальный backend, JWT cookie не выставлен (mockAuthAs не делает real login) → 401 → axios interceptor (`apps/web/app/lib/axios.ts`) → `window.location.href = '/login'` → все sidebar-nav тесты с /crm/finance падают.

## Acceptance Criteria

### AC1. Добавить mock в fixtures.ts

- [ ] В `apps/e2e/tests/fixtures.ts` в функции `mockAuthAs` рядом с notifications mocks добавить:
  ```ts
  await page.route(new RegExp(`${API}/payments/pending-cash(\\?.*)?$`), (r) => jsonOk(r, []))
  ```
- [ ] Точка вставки: сразу после notifications mocks (после `await page.route(new RegExp(`${API}/notifications(\\?.*)?$`), ...)`).
- [ ] Комментарий: краткое объяснение почему добавлен (PendingCashCard mount → 401 → redirect). Можно скопировать из «Контекст» этой задачи.

### AC2. (Опционально) Тот же fix для других новых endpoint'ов

- [ ] Проверь не добавил ли Round 2 другие новые endpoint'ы которые могут стрелять с /crm/finance / /crm/profile / etc на mount без мока. `/api/payments/initiate-cash` и `/api/payments/confirm-cash` — POST, вызываются по клику не на mount, мок не нужен. `/api/payments/admin-recipients` был удалён в финальной версии task'а, не должен фигурировать.

### AC3. Локально

```bash
pnpm --filter @crm/e2e test tests/navigation.spec.ts
pnpm --filter @crm/e2e test tests/projects-senior-share-override.spec.ts
pnpm --filter @crm/e2e test
```

Все зелёные.

### AC4. Push

- [ ] `git push origin feat/drop-role-phase4b-channels`
- [ ] `gh pr comment 70` с описанием 1-line fix.

## Что НЕ нужно

- Менять PendingCashCard логику.
- Менять axios interceptor.
- Любые другие изменения.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
