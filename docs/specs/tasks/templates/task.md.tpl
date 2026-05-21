# task-<slug>

## Агент: coder | autotest | devops
## Приоритет: critical | high | medium | low
## Зависит от: (опционально, id другой задачи)
## Ветка: feature/<slug>
## (Для фиксов в существующей ветке — указать её имя)

## Контекст

<Зачем эта задача, какую проблему решает. 2-4 строки максимум.>

## Конкретные изменения

Список файлов с краткими описаниями что делать. Если правка точечная — указать функцию/блок:

1. `packages/shared/src/schemas/<module>.ts` — добавить/изменить <что>
2. `apps/api/src/<module>/<file>.ts` — реализовать <что>
3. `apps/web/app/routes/crm/<module>/` — UI <что>

## API endpoints (если новые)

- `GET /api/...` — описание. RBAC: ADMIN/SENIOR видят все, JUNIOR — только свои.
- `POST /api/...` — описание + body schema.

## DB schema (если новые таблицы / миграции)

```sql
-- Указать enum'ы, таблицы, FK, индексы
```

## RBAC

| Роль | Доступ |
|------|--------|
| ADMIN | full |
| SENIOR | filtered |
| JUNIOR | none |
| HR | filtered |
| ACCOUNTANT | full read |

## Acceptance criteria

Каждый пункт ДОЛЖЕН быть проверяем через `git diff HEAD` или grep:

- [ ] <конкретное изменение №1 — указать паттерн/класс/функцию для grep>
- [ ] <изменение №2>
- [ ] <изменение №3>

## Interaction tests (ОБЯЗАТЕЛЬНО для UI с keyboard/focus/debouncing)

Если задача трогает Autocomplete, Combobox, Modal, Form с validation, Drag-and-drop, Tooltip — указать конкретные сценарии:

- [ ] <Например: Autocomplete — Tab коммитит highlighted option>
- [ ] <Например: Autocomplete — ArrowDown/ArrowUp навигация по списку>
- [ ] <Например: Autocomplete — Escape закрывает dropdown без потери query>
- [ ] <Например: Modal — Escape закрывает; focus restore на trigger button>

См. `docs/agents/coder.md` секция 6.1 для полного чек-листа по типам компонентов.

**Если interaction-логика отсутствует** (чистый CRUD без keyboard/focus) — отметить: «Interaction tests N/A — компонент без интерактивных элементов».

## Запрещено трогать

- `<файлы не входящие в задачу>`
- `<другие модули которые могут пересечься>`

## Verification (Coder перед `git push`)

После всех правок:

1. `git diff HEAD --name-only` — только файлы из «Конкретные изменения»
2. Для каждого AC: `grep -n "<expected pattern>" <file>` подтверждает наличие
3. Если UI — `mcp__playwright__browser_navigate` на роут + `browser_take_screenshot`
4. Commit message ОБЯЗАН содержать:
   ```
   ac_verified: 1,2,3
   vision: ✓ /crm/<route>  # только для UI задач
   ```
