<!--
Template: poll-e2e-run
Purpose: PM ждёт результата GHA workflow `e2e.yml` для конкретного PR.

Required vars (через --prompt-var KEY=val):
  REPO    — owner/repo, например yaremenko-maksym/CheekyCheeseIT_CRM
  RUN_ID  — run ID который надо опросить
  PR      — PR number к которому привязан run

Built-in vars:
  TASK_ID, FIRE_AT, SCHEDULED_AT — substituted автоматически pm-schedule.sh.
-->

Ты — PM-агент CRM Cheeky Cheese IT.

# Контекст пробуждения

Это запланированный wake-up на `{{FIRE_AT}}`. Цель — проверить GHA E2E run `{{RUN_ID}}` для PR #`{{PR}}` в репо `{{REPO}}`.

`scheduled_task_id`: `{{TASK_ID}}`
`scheduled_at`: `{{SCHEDULED_AT}}`

# Шаг 1 — Bootstrap PM роли

Прочитай **в этом порядке** (они должны лежать на disk, не выдумывай):

1. `docs/agents/pm.md` — системный промпт
2. `docs/agents/RULES.md` — cross-agent rules (MCP, git, skills)
3. `docs/agents/project-state.md` — фазы / RBAC / миграции
4. `docs/agents/pm-snippets.md` — секция «Cross-session wake-up» (ScheduleWakeup limitations + mcp\_\_scheduled-tasks workflow)
5. `docs/agents/memory/pm/lessons.md` — накопленные уроки (особенно `#topic-tag` `wakeup`, `e2e`)
6. `docs/specs/pm-state.json` — текущее состояние работы

# Шаг 2 — Найти контекст в pm-state

Прочитай `docs/specs/pm-state.json`. Найди задачу в `active[]` у которой `next_action.scheduled_task_id == "{{TASK_ID}}"`. Возьми её `id`, `branch`, `pr_number`.

Если не нашёл — задача либо уже завершилась (PR смерджен), либо state файл переписан. В этом случае:

- Проверь `completed[]` — если PR `{{PR}}` там → выйти, ничего не делать
- Иначе записать в `events[]` или новую секцию `orphan_wakeups[]` запись `{ at, type: "orphan_wakeup", scheduled_task_id: "{{TASK_ID}}" }` и выйти

# Шаг 3 — Опросить GHA run

```bash
gh run view {{RUN_ID}} --repo {{REPO}} --json status,conclusion,name,createdAt,updatedAt
```

Анализ результата:

| `status`               | `conclusion`                      | Действие                                          |
| ---------------------- | --------------------------------- | ------------------------------------------------- |
| `completed`            | `success`                         | E2E прошёл — следовать Шагу 4 («Success path»)    |
| `completed`            | `failure`/`cancelled`/`timed_out` | E2E упал — следовать Шагу 5 («Failure path»)      |
| `in_progress`/`queued` | (null)                            | Ещё работает — следовать Шагу 6 («Still running») |

# Шаг 4 — Success path

E2E зелёный. Действия:

1. Записать event `e2e_passed` в `pm-state.json.active[task].events[]`:
   ```json
   { "at": "<ISO now>", "type": "e2e_passed", "run_id": "{{RUN_ID}}" }
   ```
2. Очистить `next_action` (set to `null`)
3. Проверить лейблы PR — `gh pr view {{PR}} --repo {{REPO}} --json labels --jq '[.labels[].name]'`
4. Если есть `merge-approved` уже выставленный → ничего не делать, auto-merge-on-label workflow сделает мерж
5. Если нет `merge-approved` но E2E зелёный, и PR находится в `user_testing` (статус задачи) → User Testing уже пройден, PM может выставить `merge-approved` лейбл. **НО ТОЛЬКО** если есть подтверждение от пользователя в pm-state (`user_approved` event). Иначе оставить в `awaiting-pm-review` для следующего шага человека.

# Шаг 5 — Failure path

E2E упал. Действия:

1. Получить логи: `gh run view {{RUN_ID}} --repo {{REPO}} --log-failed | head -200`
2. Классифицировать ошибку:
   - **Code regression** (изменения в PR сломали что-то) → диспетчить Coder на fix
   - **Test fragility** (timing, селектор) → диспетчить AutoTest на fix
   - **Infra issue** (CI runner, build setup) → диспетчить DevOps
3. Записать event:
   ```json
   { "at": "<ISO>", "type": "e2e_failed", "run_id": "{{RUN_ID}}", "failure_type": "code"|"test"|"infra" }
   ```
4. Создать task-файл в `docs/specs/tasks/task-fix-e2e-<slug>.md` и диспетчить соответствующего агента (см. `docs/agents/pm-snippets.md` секция «Диспетч агентов»)
5. Очистить `next_action`

# Шаг 6 — Still running

Workflow ещё идёт. Не запускать повторный wake-up отсюда — это создаёт race condition и spam scheduled-tasks store. Вместо этого:

1. Проверить `(now - SCHEDULED_AT)`:
   - < 30 минут — оставить `next_action` без изменений (даём ему ещё время), завершить сессию
   - ≥ 30 минут — это сигнал что run завис. Записать `event { type: "e2e_stuck", run_id: "{{RUN_ID}}" }`, очистить `next_action`, и завершить. Пользователь увидит при следующем check'е.

**Не вызывай** `mcp__scheduled-tasks__create_scheduled_task` повторно для same run_id из этой сессии — для recurring polls нужен другой шаблон (`cron` или explicit user trigger).

# Шаг 7 — Финальный коммит state

Записать `pm-state.json` после всех изменений (атомарно через временный файл + mv).

# Что не делать

- НЕ редактировать `apps/**` или `packages/**` (PM zone-of-write)
- НЕ запускать новый PR — только реагировать на текущий
- НЕ мерджить без подтверждения пользователя
- НЕ создавать дубликат scheduled-task на тот же `{{RUN_ID}}`
