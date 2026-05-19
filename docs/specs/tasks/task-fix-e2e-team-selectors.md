# Task: Fix E2E selector mismatches in team.spec.ts

## Контекст
E2E run 26055265819 на ветке `fix/team-detail-hooks` — 36 тестов из `apps/e2e/tests/team.spec.ts` упали с ошибками вида:

```
Error: expect(locator).toBeVisible() failed
Locator: getByTitle('Переименовать')
Error: element(s) not found
```

```
TimeoutError: page.waitForRequest: Timeout 10000ms exceeded
```

Тесты написаны с расчётом на `title="Переименовать"`, `title="Добавить участника"` и т.д., но новый Teams UI (PR #13 Teams Redesign) может использовать другие атрибуты на кнопках.

## Провалившиеся тесты (все в team.spec.ts)

1. Read-only view (line 30, 45)
2. Rename team (lines 58, 65, 82, 91)
3. Delete team (lines 105, 112, 124)
4. Add member (lines 143, 150, 164)
5. Remove member (line 183)
6. Team detail page (lines 201, 237)
7. JUNIOR RBAC (lines 344, 350)
8. Clickable team cards (lines 381, 397)
9. Edge cases (line 420)
10. API — Telegram and Notes fields (line 444)
11. Teams List — Toolbar and Row Layout (lines 517, 529, 538, 556)
12. Team Detail — Edit Dialog and Active Projects (lines 569, 598, 610)
13. Add Member — Enhanced Validation (lines 630, 655, 680)
14. React Hooks Compliance (lines 726, 746, 761, 793, 824)

## Задача

1. **Прочитай** `apps/e2e/tests/team.spec.ts` — посмотри какие селекторы используются
2. **Прочитай** реальные компоненты Teams UI:
   - `apps/web/app/routes/crm/team/index.tsx` (или аналог)
   - `apps/web/app/routes/crm/team/$teamId.tsx` (или аналог)
   - Компоненты в `apps/web/app/routes/crm/team/`
3. **Сопоставь** — какие `title`, `aria-label`, `data-testid` или текстовые метки реально есть в UI
4. **Обнови** `apps/e2e/tests/team.spec.ts` — исправь все несоответствующие селекторы
5. **Работай на ветке** `fix/team-detail-hooks` (уже существует)
6. **Закоммить и запушить** изменения на `fix/team-detail-hooks`

## НЕ делай

- Не меняй саму логику тестов (что они проверяют)
- Не меняй бизнес-логику компонентов
- Не добавляй `data-testid` атрибуты в компоненты (если только крайне необходимо — предпочитай существующие `title`, `aria-label`, текст)

## Ожидаемый результат

Все 36 упавших тестов должны проходить при локальном запуске. После пуша — PM перезапустит e2e.
