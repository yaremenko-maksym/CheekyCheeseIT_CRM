# AutoTest — Agent Notes

## E2E тесты

```
apps/e2e/
  tests/
    auth.spec.ts
    teams.spec.ts
    projects.spec.ts
    interviews.spec.ts
    finance.spec.ts
  playwright.config.ts
```

## Паттерн теста

```typescript
import { test, expect } from '@playwright/test'

test.describe('Module Name', () => {
  test.beforeEach(async ({ page }) => {
    // seed users доступны через API, Google OAuth в CI недоступен
    // тесты пишутся против запущенного приложения
    await page.goto('http://localhost:3000/crm/...')
  })

  test('user can do X', async ({ page }) => {
    await expect(page.getByText('...', { exact: false })).toBeVisible()
  })
})
```

## Seed данные для тестов

Тестовые пользователи из seed: admin, senior1, senior2, junior1, hr, accountant (все @cheekyit.com).
Seed применяется перед тестами в CI: `pnpm --filter @crm/api db:seed`

## E2E Anti-patterns (ЗАПРЕЩЕНО)

### route.continue() в тестах с моками

```typescript
// НЕПРАВИЛЬНО — проксирует на реальный API, которого нет в тесте
await page.route('/api/teams/*', route => route.continue())

// ПРАВИЛЬНО — возвращает данные из фикстур
await page.route('/api/teams/*', route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(fixtures.team)
}))
```

Все API-роуты в тестах замоканы через `fixtures.ts`. При переопределении роута
для конкретного теста **всегда** использовать `route.fulfill()`, никогда `route.continue()`.

### getByText() без скоупа на контентную область

```typescript
// НЕПРАВИЛЬНО — может матчить sidebar, header, модалки
await expect(page.getByText('Статистика')).toBeVisible()

// ПРАВИЛЬНО — скоупить на main
const main = page.locator('main')
await expect(main.getByText('Статистика')).toBeVisible()
```

`page.getByText()` без скоупа — антипаттерн. **Всегда** скоупить на `page.locator('main')`
или более конкретный контейнер.

### Слишком широкие CSS-селекторы

```typescript
// НЕПРАВИЛЬНО — может найти 2+ элементов (sidebar + content)
await page.locator('a[href="/crm/team"]').click()

// ПРАВИЛЬНО — data-testid на навигационных элементах
await page.locator('[data-testid="back-button"]').click()
```

Кнопки "Назад", закрытия диалогов и отмены форм всегда имеют `data-testid`.
Если `data-testid` отсутствует — это баг в компоненте, создай REQUEST_CHANGES review.

## Существующие тесты — не ломать

- `interviews.spec.ts` — Kanban stages: `HR Screen, English, Tech, Final, Client, Offer Received`
  - Используй `{ exact: false }` при проверке stage labels
- Тесты должны быть идемпотентными (можно запускать несколько раз)

## Когда писать тесты (РЕЖИМ 1: PR Post-Approval)

Анализируй diff PR через `mcp__github__get_pull_request_files`.
Пиши тесты для:
- Новых user flows (создание/редактирование/удаление сущностей)
- RBAC (убедись что роли не видят лишнего)
- Edge cases из acceptance criteria

НЕ пиши тесты для:
- Только типы/схемы без UI/API
- Только рефакторинг без изменения поведения
- Конфигурационные файлы

## Когда писать тесты (РЕЖИМ 2: docs/business/** Push)

Читай изменённые бизнес-документы → найди новые user flows → напиши или обнови тесты.
Ветка: `test/update-<hint>-<YYYYMMDD>`, затем PR.

## Git workflow для AutoTest

```bash
git checkout -b test/update-<feature>-$(date +%Y%m%d)
# пиши тесты
git add apps/e2e/tests/<file>.spec.ts
git commit -m "test(<module>): add E2E coverage for <feature>"
git push origin <branch>
# открыть PR через mcp__github__create_pull_request
```
