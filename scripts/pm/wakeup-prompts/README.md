# PM Wake-up Prompts — Cross-session Continuation Templates

Эти templates скармливаются `mcp__scheduled-tasks__create_scheduled_task` через `pm-schedule.sh`. Каждый template — self-contained prompt, который стартует **fresh PM-сессию** на запланированном времени fire'а.

## Зачем self-contained

`mcp__scheduled-tasks` запускает Claude-сессию БЕЗ контекста от source-сессии (та, что создала task). Поэтому prompt должен:

1. **Bootstrap PM роли** — "Ты — PM-агент CRM Cheeky Cheese IT, прочитай pm.md и CLAUDE-pm.md"
2. **State retrieval** — найти контекст в `docs/specs/pm-state.json` через `scheduled_task_id` (matching against `active[].next_action.scheduled_task_id`)
3. **Action** — что именно делать (poll workflow, check PR, etc.)
4. **Outcome handling** — куда идти при success / failure / still-running
5. **Stop condition** — однократный check vs повторный self-schedule

## Substitution vars

`pm-schedule.sh` подставляет `{{KEY}}` → value:

- **Built-in (всегда есть):**
  - `{{TASK_ID}}` — kebab-case ID запланированной задачи (для матчинга с pm-state.json)
  - `{{FIRE_AT}}` — ISO timestamp когда сработает
  - `{{SCHEDULED_AT}}` — когда запланировано (для max_age_min проверки)
- **Передаются через `--prompt-var KEY=val`:**
  - Зависят от template (см. секцию "Required vars" в каждом файле)

## Доступные templates

| Template | Use case | Required vars |
|----------|----------|---------------|
| `poll-e2e-run.md` | Ожидание GHA E2E workflow | `REPO`, `RUN_ID`, `PR` |
| `poll-pr-checks.md` | Ожидание CI checks на PR | `REPO`, `PR` |
| `poll-pr-merged.md` | Verify auto-merge сработал после `merge-approved` label | `REPO`, `PR` |

## Добавить новый template

1. Создать `<name>.md` в этой директории
2. Структура: role bootstrap + context retrieval + action + outcome + stop
3. Документировать `Required vars` в шапке файла
4. Добавить строку в таблицу выше

## Smoke test

```bash
bash scripts/pm/pm-schedule.sh \
  --delay-min 60 \
  --task-id-hint smoke-test \
  --description "Smoke test (will not fire if disabled)" \
  --prompt-template poll-pr-checks \
  --prompt-var REPO=yaremenko-maksym/CheekyCheeseIT_CRM \
  --prompt-var PR=42 \
  --dry-run
```

`--dry-run` печатает materialized prompt в `/tmp/pm-schedule-<id>.prompt.md` без записи в pm-state.json.
