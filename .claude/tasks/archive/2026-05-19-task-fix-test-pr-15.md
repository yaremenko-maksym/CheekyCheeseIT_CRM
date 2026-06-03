# task-fix-test-pr-15

## Агент: autotest

## Приоритет: high

## Ветка: fix/team-detail-hooks

## НЕ создавать новую ветку — пушить в существующую: `fix/team-detail-hooks`

## Контекст

PR #15 — фикс React Rules of Hooks в `apps/web/app/routes/crm/team/$teamId.tsx`.
AutoTest написал тесты в `apps/e2e/tests/team.spec.ts`, но они падают с ошибками.
Нужно исправить тесты — код компонента правильный, тесты неверные.

## Ошибки которые нужно исправить

### 1. RBAC тесты — "element(s) not found"

```
tests/team.spec.ts:30 › HR sees management buttons but not delete
→ Error: expect(locator).not.toBeVisible() failed
→ locator resolved to <button>... (11 × locator resolved to...)

tests/team.spec.ts:45 › ADMIN sees all buttons including delete
→ Error: element(s) not found
```

Тесты ищут кнопки с неверными локаторами. Нужно:

1. Прочитать реальную вёрстку `apps/web/app/routes/crm/team/$teamId.tsx`
2. Найти точные data-testid / текст кнопок / aria-label — то что реально есть в DOM
3. Исправить локаторы в тестах

### 2. Rename dialog тесты — "interrupted"

```
tests/team.spec.ts:58 › opens rename dialog with current name pre-filled
tests/team.spec.ts:65 › save button submits PATCH request with new name
tests/team.spec.ts:82 › validation: empty name shows error on blur
tests/team.spec.ts:91 › cancel closes dialog without PATCH
→ Error: locator.click: Test ended.
```

Клик не находит элемент до timeout. Нужно:

1. Проверить как открывается rename dialog в реальном компоненте
2. Исправить навигацию к странице и клик по нужному элементу

## Алгоритм

1. `git fetch origin fix/team-detail-hooks && git checkout fix/team-detail-hooks`
2. Прочитать `apps/web/app/routes/crm/team/$teamId.tsx` — понять структуру UI, кнопки, dialogs
3. Прочитать текущий `apps/e2e/tests/team.spec.ts` — найти неверные предположения
4. Исправить локаторы и сценарии, чтобы тесты соответствовали реальному UI
5. Проверить что исправленные тесты логически правильно тестируют хуки-фикс (хуки не нарушают рендер)
6. `git add apps/e2e/tests/team.spec.ts && git commit -m "fix(tests): correct selectors in team.spec.ts"`
7. `git push origin fix/team-detail-hooks`

## Acceptance criteria

- [ ] Все тесты в `team.spec.ts` проходят без interruption / element not found ошибок
- [ ] RBAC тесты проверяют реальные кнопки с правильными локаторами
- [ ] Rename dialog тест открывает диалог через существующий UI-элемент
- [ ] `pnpm --filter @crm/e2e test -- --grep "Team page"` — все зелёные

## Запрещено трогать

- `apps/web/app/routes/crm/team/$teamId.tsx` — только тесты, не код
- Любые другие файлы кроме `apps/e2e/tests/team.spec.ts`
