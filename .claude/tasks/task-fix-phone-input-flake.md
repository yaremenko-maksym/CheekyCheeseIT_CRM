# task-fix-phone-input-flake

## Агент: coder

## Приоритет: medium

## Ветка: fix/phone-input-test-flake

## Зависит от: ничего

## Контекст

`apps/web/app/components/ui/__tests__/phone-input.test.tsx` имеет flaky тест:

> `PhoneInput component > sets country calling code in input after switching country via dropdown` — `Test timed out in 15000ms` на line 225

Падает в CI **постоянно** (примерно каждый 2-й run). Чинится через `gh run rerun --failed`. Это маскирует реальные регрессии — если на этой строке появится real bug, мы не заметим.

В сессии 2026-06-02 этот flake привёл к:

- 3+ retries CI на PR #74
- Coder агентам пришлось обходить pre-push hook через `--no-verify` (запрещено, см. CLAUDE-coder.md)

## Acceptance Criteria

### AC1. Диагностика

- [ ] Локально запустить тест 10 раз: `pnpm --filter @crm/web test -- phone-input --run` × 10.
- [ ] Зафиксировать % падений и где именно (какая `expect` / `waitFor` падает first).
- [ ] Если 10/10 проходят локально — попробовать с CPU throttling (`taskset -c 0 pnpm ...` или Docker с `--cpus=1`) чтобы воспроизвести медленный CI.

### AC2. Фикс

Один из подходов (выбрать после диагностики):

**A. Увеличить timeout для асинхронных операций**:

- В `waitFor()` или `findBy*` передать `{ timeout: 5000 }` для dropdown rendering.
- Если problem в lazy-loaded country list — preload.

**B. Mock async dropdown rendering**:

- Если тест ждёт реальный fetch / async load — замокать `globalThis.fetch` или динамический import.

**C. Vitest retry**:

- В `vitest.config.ts` (web) добавить `retry: 2` глобально ИЛИ `it.retry(2)` локально на этот test.
- Это наименее интрузивно но **скрывает** проблему, использовать только если A и B неэффективны.

**D. Refactor теста**:

- Если корень — race condition между двумя async операциями, перестроить (использовать `act()`, явные `waitFor` цепочки).

### AC3. Verify

- [ ] Локально запустить тест 20 раз: 20/20 проходят.
- [ ] CI на PR — typecheck/unit job стабильно зелёный без rerun.

### AC4. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
```

Все зелёные.

### AC5. PR

- [ ] Ветка `fix/phone-input-test-flake`.
- [ ] Title: `fix(test): phone-input flake — диагностика + стабильный фикс`.
- [ ] Body: что было причиной, какой подход выбран, % падений до/после.

### AC6. Финальный отчёт

Coder ДОЛЖЕН включить вывод **на момент финального response**:

```bash
git log origin/fix/phone-input-test-flake -1 --oneline
gh pr view <PR_NUM> --json number,headRefName,state
```

Без actual output этих команд — отчёт недействителен (см. CLAUDE-coder.md § «Финальный отчёт без proof of push»).

## Что НЕ нужно

- Удалять тест полностью без фикса (это снизит coverage).
- Использовать `--no-verify` при push (см. CLAUDE-coder.md, zero tolerance).
- Списать на «pre-existing» — это и есть pre-existing, его и чиним.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
