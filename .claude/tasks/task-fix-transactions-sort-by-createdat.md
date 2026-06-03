# task-fix-transactions-sort-by-createdat (follow-up)

## Агент: coder

## Приоритет: HIGH (PR #59 UT failed — sort fix не покрывает legacy data)

## Ветка: fix/transactions-sort-timestamps (EXISTING — добавить коммит в PR #59)

## Контекст

PR #59 (commit c22c03b) добавил `resolveTxDate()` backend + frontend tie-breaker по createdAt. **User Testing показал что фикс работает только для НОВЫХ транзакций.** Legacy data всё ещё неправильно сортируется:

```
1. Выплата $8,222 — 28.05.26 (txDate=null, createdAt=07:37)
2. Выплата $3,330 — 28.05.26 (txDate=null, createdAt=07:01)
3. Выплата $5,328 — 28.05.26 (txDate=null, createdAt=06:55)
4. Приход $4,000 — 28.05.26 (txDate=midnight 00:00, createdAt=08:17)  ← должен быть #1
```

Tie-breaker помогает только при `aTime === bTime`. Здесь `aTime != bTime`: midnight (00:00) для income vs createdAt (07:37) для payouts. Сравнение даёт payout первым.

**Юзер выбрал решение: Frontend всегда sort по `createdAt` (не txDate). `txDate` остаётся только для отображения в колонке «Дата».**

## AC

- [ ] **AC1: Frontend sort.ts использует createdAt как primary key**
  - В `apps/web/app/routes/crm/finance/sort.ts` функция `compareTxByDate`:
    - **Было** (c22c03b): primary key = `txDate ?? createdAt`, tie-breaker = `createdAt`
    - **Стать**: primary key = `createdAt` всегда. Удалить tie-breaker (он становится бессмысленным — createdAt уникальный)
  - Минимальная diff: убрать `txDate ?? ` из getter — оставить только `new Date(a.createdAt).getTime()`

- [ ] **AC2: Tests обновлены**
  - В `apps/web/app/routes/crm/finance/__tests__/sort.test.ts`:
    - Удалить tests которые проверяют tie-breaker по createdAt при equal txDate (они становятся trivial — primary key и есть createdAt)
    - Добавить тест: legacy scenario — payout txDate=null createdAt=07:37 vs income txDate=midnight createdAt=08:17 → income первый (DESC sort by createdAt)
    - Сохранить asc/desc test, amount sort test

- [ ] **AC3: UI колонка «Дата» отображает `txDate` как раньше**
  - НЕ менять рендеринг TransactionRow / любых компонентов. Только sort logic.
  - Verify в playwright: колонка «Дата» показывает 28.05.26 для $4,000 income (не время)

- [ ] **AC4: Backend resolveTxDate ОСТАВИТЬ**
  - НЕ откатывать `resolveTxDate()` в transactions.service.ts. Он не вредит — просто обогащает txDate реальным временем для today picks.
  - Это additive: future txDate будут более precise если нужен audit.

## Файлы (ожидаемые изменения)

- `apps/web/app/routes/crm/finance/sort.ts` — упростить compareTxByDate (~5 строк изменений)
- `apps/web/app/routes/crm/finance/__tests__/sort.test.ts` — обновить tests

## Definition of Done

- ac_verified: 1,2,3
- Manual smoke (через playwright):
  - Login as SENIOR (Oleksiy) → /crm/finance
  - Первая строка — приход $4,000 28.05.26 (PENDING)
  - Колонка «Дата» показывает 28.05.26 (не время)
- Unit tests pass: `pnpm test`
- Typecheck pass: `pnpm typecheck`
- ESLint pass: `pnpm lint`
- E2E локально перед push: `pnpm --filter @crm/e2e test`

## Заметки для Coder

- Branch УЖЕ существует: `fix/transactions-sort-timestamps`. Делать `git checkout fix/transactions-sort-timestamps` (НЕ создавать новую)
- Получить task file: `git checkout claude/musing-jang-a12f39 -- docs/specs/tasks/task-fix-transactions-sort-by-createdat.md`
- ВКЛЮЧИТЬ task file в финальный commit
- Push на тот же branch — это автоматически update'ит PR #59
- НЕ создавать новый PR
- НЕ ставить labels
