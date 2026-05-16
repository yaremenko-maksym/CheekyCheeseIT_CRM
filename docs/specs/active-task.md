# Active Task

> Этот файл содержит ТЕКУЩУЮ задачу для Coder-агента.
> Когда задача выполнена и PR смёрджен, BA перемещает этот файл в `docs/specs/archive/YYYY-MM-DD-<slug>.md`.

## Статус: НЕТ АКТИВНОЙ ЗАДАЧИ

Когда будет готова задача, BA заполняет по шаблону ниже.

---

## Шаблон задачи

```markdown
# [PHASE X] Название задачи

## Контекст
Почему делаем эту задачу. Связь с бизнес-логикой из docs/business/.

## User Story
Как [роль], я хочу [действие], чтобы [ценность].

## Acceptance Criteria
- [ ] Критерий 1
- [ ] Критерий 2

## Технические требования
- Новые таблицы / изменения схемы
- Новые API endpoints
- UI компоненты

## Файлы для изменения
- `apps/api/src/...`
- `apps/web/app/...`
- `packages/shared/src/schemas/...`

## Тесты
- Unit: что должны покрывать Vitest тесты
- E2E: какие flows проверить в Playwright

## Связанные документы
- Бизнес-логика: docs/business/modules/xxx.md
- User flows: docs/business/user-flows.md#xxx
```
