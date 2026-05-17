# Fix E2E test: remove OFFER_RECEIVED from active stages assertion

## Контекст

PR #7 (`test/update-full-scan-20260517`) — E2E тести написані AutoTest агентом.
AutoTest Review знайшов логічну помилку: тест перевіряє `'Offer Received'` в списку активних Kanban колонок,
але `OFFER_RECEIVED` **не входить** до `ACTIVE_STAGES` у `apps/web/app/routes/crm/interviews/constants.ts`.

Тест впаде при запуску бо ця колонка не рендериться.

## Задача

Виправити **один рядок** в існуючій гілці PR #7.

**НЕ створювати нову гілку.** Запушити в існуючу: `test/update-full-scan-20260517`.
PR #7 автоматично підхопить новий коміт.

## Що змінити

**Файл:** `apps/e2e/tests/interviews.spec.ts` (приблизно рядок 50)

```typescript
// БУЛО (включає OFFER_RECEIVED якого немає в ACTIVE_STAGES):
for (const label of ['HR Screen', 'English', 'Tech', 'Final', 'Client', 'Offer Received']) {

// СТАЛО (тільки активні колонки):
for (const label of ['HR Screen', 'English', 'Tech', 'Final', 'Client']) {
```

## Алгоритм виконання

1. `git fetch origin test/update-full-scan-20260517`
2. `git checkout test/update-full-scan-20260517`
3. Знайти і виправити рядок в `apps/e2e/tests/interviews.spec.ts`
4. `pnpm typecheck && pnpm lint` (без помилок)
5. `git add apps/e2e/tests/interviews.spec.ts`
6. `git commit -m "fix(e2e): remove OFFER_RECEIVED from active stages assertion"`
7. `git push origin test/update-full-scan-20260517`
8. **Не створювати новий PR** — коміт йде в існуючий PR #7

## Acceptance Criteria

- [ ] `apps/e2e/tests/interviews.spec.ts` не містить `'Offer Received'` в масиві очікуваних активних колонок
- [ ] Коміт запушений в `test/update-full-scan-20260517`
- [ ] `pnpm typecheck` і `pnpm lint` проходять без помилок
