# task-fix-e2e-team-selectors

## Агент: autotest

## Приоритет: CRITICAL (E2E broken on main — issue #19 open)

## Ветка: fix/e2e-team-selectors

## Контекст

E2E тесты `apps/e2e/tests/team.spec.ts` упали на main после слияния PR #18
(feat(teams): UI improvements — flat list, contacts, Telegram links, Russian).

Причины:

1. Все текстовые якоря переведены с украинского на русский
2. Ролевая группировка убрана → плоский список участников
3. Контакты (email, telegram, phone) теперь видны в карточках участников
4. Новая структура карточки команды в списке

**Задача — исправить tests/team.spec.ts так чтобы все тесты проходили.**

## Реальные ошибки из CI run 26093479206

```
strict mode violation: locator('text=Участники команды').locator('..').locator('..').getByText('Бухгалтер', { exact: true }) resolved to 2 elements
TimeoutError: locator.click: Timeout 10000ms exceeded
Error: expect(locator).toBeVisible() failed — element(s) not found
Error: expect(locator).not.toBeVisible() failed
```

## Маппинг изменённых селекторов

| Старый (украинский)                                  | Новый (русский)                    |
| ---------------------------------------------------- | ---------------------------------- |
| `getByTitle('Перейменувати')`                        | `getByTitle('Переименовать')`      |
| `getByText('Учасники команди')`                      | `getByText('Участники команды')`   |
| `getByRole('heading', { name: /Активні проекти/i })` | `/Активные проекты/i`              |
| `getByRole('button', { name: 'Додати' })`            | `'Добавить'`                       |
| `getByRole('button', { name: 'Редагувати' })`        | `'Редактировать'`                  |
| `getByTitle('Виключити')`                            | `getByTitle('Исключить')`          |
| `getByRole('button', { name: 'Скасувати' })`         | `'Отмена'`                         |
| `getByRole('button', { name: 'Відміна' })`           | `'Отмена'`                         |
| `getByRole('button', { name: 'Зберегти' })`          | `'Сохранить'`                      |
| `getByPlaceholder('Пошук за назвою…')`               | `'Поиск по названию…'`             |
| `getByText('Нічого не знайдено')`                    | `'Ничего не найдено'`              |
| `getByText('Створена')`                              | `'Создана'`                        |
| `getByText('Додати учасника')`                       | `'Добавить участника'`             |
| `getByPlaceholder('Назва команди')`                  | `'Название команды'`               |
| `getByText('Посилання на Telegram-чат команди')`     | `'Ссылка на Telegram-чат команды'` |
| `getByRole('button', { name: /Зберегти/ })`          | `/Сохранить/`                      |

## Структурные изменения

### Плоский список участников

- Удалить/переписать тест `'shows members grouped by role'` — группировки больше нет
- Вместо `getByText('Синьор').first()` / `getByText('Бухгалтер').first()` проверять по именам участников
- **ОШИБКА в CI:** `locator('text=Участники команды').locator('..').locator('..').getByText('Бухгалтер', { exact: true }) resolved to 2 elements` — этот паттерн поиска сломан. Заменить на прямой поиск по имени пользователя или `data-testid`

### Убран фильтр по ролям

- Удалить/пропустить тест `getByRole('combobox').filter({ hasText: 'Всі ролі' })` — фильтра больше нет

### Telegram ссылка в списке команд

- Если тест проверяет кнопки в строке команды — адаптировать под новую структуру (ссылка на TG теперь есть)

## Инструкция

1. Прочитай `apps/e2e/tests/team.spec.ts` целиком
2. Прочитай реальные компоненты:
   - `apps/web/app/routes/crm/team/index.tsx`
   - `apps/web/app/routes/crm/team/$teamId.tsx`
3. Применяй маппинг выше + проверяй каждый локатор по DOM
4. Для `strict mode violation` (2 элемента) — использовать `.first()` или более специфичный локатор
5. Создай ветку `fix/e2e-team-selectors` от main, закоммить изменения, запуши

## Остаточные ошибки из e2e run 26107699840 (НУЖНО ИСПРАВИТЬ)

### Ошибка 1: `team.spec.ts:580` — украинский label "Нотатки"

```
getByLabel('Нотатки') — element(s) not found
```

**Исправление:** компонент `apps/web/app/routes/crm/team/$teamId.tsx` использует `<Label htmlFor="edit-notes">Заметки</Label>` (русский).
Заменить в тесте: `getByLabel('Нотатки')` → `getByLabel('Заметки')`

### Ошибка 2: `team.spec.ts:228` — role badges всё ещё видны

```
expect(page.getByText('Синьор').first()).not.toBeVisible()
Expected: not visible
Received: visible — <div class="...border-blue-500/30 bg-blue-500/15 text-blue-400...">Синьор</div>
```

**Причина:** UI убрал групповые заголовки по ролям, но role badges на карточках участников **по-прежнему показывают роль** (как badge).
**Исправление:** удалить строки 228–230 — эти три `not.toBeVisible()` проверки для `'Синьор'`, `'HR'`, `'Бухгалтер'`.
Тест должен только проверять что члены видны по именам (строки 223–225), без проверки отсутствия текста ролей.

**Ветка: `fix/e2e-team-selectors` — КОММИТЬ на существующую ветку, НЕ создавать новую.**

## Acceptance criteria

- [ ] Все тесты в `apps/e2e/tests/team.spec.ts` проходят локально
- [ ] Нет ни одного украинского текста в локаторах
- [ ] Нет тестов на ролевые заголовки (они удалены из UI)
- [ ] Ветка запушена → PM перезапустит E2E

## Запрещено трогать

- `apps/web/**` — только тесты
- `apps/api/**`
- `packages/shared/**`
