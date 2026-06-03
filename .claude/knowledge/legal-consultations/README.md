# Legal Consultations Log

Persistent log strategic-mode консультаций Legal-агента. Используется как:

1. Future reference при похожих вопросах (поиск по теме)
2. Audit trail (история legal decisions)
3. Source для lessons.md записей

## Naming

```
YYYY-MM-DD-<slug>.md
```

Примеры:

- `2026-05-31-fop3-vs-fop2-for-juniors.md`
- `2026-06-15-passport-storage-s3.md`
- `2026-07-02-usdt-payouts-aml.md`

## Структура файла

Создаётся PM в Mode D — `## Вопрос` + `## Контекст`. Legal-агент добавляет `## Ответ юриста` (структура из `docs/agents/legal.md`).

После закрытия консультации файл остаётся как permanent reference. Не удалять / не редактировать ретроспективно — для consistency audit trail.

## Чем отличается от task-legal-\*.md

|           | `docs/specs/tasks/task-legal-*.md`         | `docs/specs/legal-consultations/*.md`           |
| --------- | ------------------------------------------ | ----------------------------------------------- |
| Mode      | A (consult) — task-связанная               | D (strategic) — vне task-flow                   |
| Lifecycle | После закрытия → archive (как другие task) | Permanent log                                   |
| Trigger   | PM создаёт для конкретной feature/PR       | PM создаёт по запросу User вне feature-pipeline |
| Контекст  | Привязан к task / PR / feature             | Strategic standalone вопрос                     |
| Чтение    | PM при работе над задачей                  | User / PM при future similar вопросах           |

## Опционально: index

Если log разрастётся (> 20 файлов) — создать `INDEX.md` с категоризацией по topic для быстрого поиска. Пока — `ls -la` достаточно.
