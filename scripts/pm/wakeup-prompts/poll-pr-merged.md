<!--
Template: poll-pr-merged
Purpose: Verify что после выставления `merge-approved` лейбла auto-merge-on-label workflow
действительно смерджил PR. Если не смерджил — расследовать (CI висит? branch protection?
несовместимый base?).

Required vars (через --prompt-var KEY=val):
  REPO    — owner/repo, например yaremenko-maksym/CheekyCheeseIT_CRM
  PR      — PR number

Built-in vars:
  TASK_ID, FIRE_AT, SCHEDULED_AT — substituted автоматически pm-schedule.sh.
-->

Ты — PM-агент CRM Cheeky Cheese IT.

# Контекст пробуждения

Это запланированный wake-up на `{{FIRE_AT}}`. Цель — проверить что PR #`{{PR}}` в репо `{{REPO}}` действительно смерджен после выставления `merge-approved` лейбла.

`scheduled_task_id`: `{{TASK_ID}}`
`scheduled_at`: `{{SCHEDULED_AT}}`

# Шаг 1 — Bootstrap PM роли

Прочитай:
1. `docs/agents/pm.md`
2. `docs/agents/CLAUDE-pm.md`
3. `docs/specs/pm-state.json`

# Шаг 2 — Найти контекст в pm-state

В `active[]` найди задачу у которой `next_action.scheduled_task_id == "{{TASK_ID}}"`. Должна быть в статусе `merging` или `awaiting_pm_review`.

# Шаг 3 — Проверить состояние PR

```bash
gh pr view {{PR}} --repo {{REPO}} \
  --json state,merged,mergedAt,mergedBy,statusCheckRollup,labels \
  --jq '{
    state,
    merged,
    mergedAt,
    mergedBy: .mergedBy.login,
    failedChecks: [.statusCheckRollup[] | select(.conclusion == "FAILURE" or .conclusion == "CANCELLED") | .name],
    pendingChecks: [.statusCheckRollup[] | select(.status == "IN_PROGRESS" or .status == "QUEUED") | .name],
    labels: [.labels[].name]
  }'
```

# Шаг 4 — Классификация

| `state` | `merged` | Действие |
|---------|----------|----------|
| `MERGED` | `true` | Шаг 5 (success) |
| `OPEN` + есть `merge-approved` лейбл + есть `failedChecks` | `false` | Шаг 6 (auto-merge заблокирован failed CI) |
| `OPEN` + есть `merge-approved` лейбл + есть `pendingChecks` | `false` | Шаг 7 (CI ещё идёт, дать время) |
| `OPEN` + НЕТ `merge-approved` лейбла | `false` | Шаг 8 (лейбл был снят кем-то — orphan wake-up) |
| `OPEN` + есть `merge-approved` + НЕТ failed/pending | `false` | Шаг 9 (auto-merge workflow не сработал — investigate) |
| `CLOSED` без merged | `false` | Шаг 10 (PR закрыт без мерджа — investigate) |

# Шаг 5 — Success (PR merged)

1. Записать event `merged` в `events[]` с `mergedBy`, `mergedAt`
2. Переместить задачу из `active[]` в `completed[]` с агрегатами:
   - `duration_min` = (mergedAt - started_at) / 60
   - `rounds` = текущий `review_rounds`
   - `agent_invocations` копировать как есть
3. Очистить `next_action`
4. Если задача была в `phase: merging` глобально — сменить на `archived`
5. Не делать дополнительных действий — пользователь увидит уведомление о merge

# Шаг 6 — CI failed после merge-approved

Это значит auto-merge корректно остановился (правильно — не мерджить с красным CI). Действия:

1. Записать event `auto_merge_blocked_by_ci_fail` с list failedChecks
2. Снять `merge-approved` лейбл:
   ```bash
   gh pr edit {{PR}} --repo {{REPO}} --remove-label "merge-approved"
   ```
3. Выставить `ci-failed`:
   ```bash
   gh pr edit {{PR}} --repo {{REPO}} --add-label "ci-failed"
   ```
4. Создать task-файл для починки (см. `poll-pr-checks` Шаг 6)

# Шаг 7 — CI still running

auto-merge-on-label workflow умеет ждать `gh pr checks --watch` до 30 минут. Скорее всего ждёт.

1. Оставить `next_action` без изменений
2. Записать event `awaiting_ci_for_merge`
3. Завершить сессию

# Шаг 8 — merge-approved лейбл снят

Кто-то (пользователь или другой workflow) снял лейбл. Не вмешиваться — это intentional cancel.

1. Записать event `merge_approval_revoked` с `at`
2. Очистить `next_action`
3. Сменить статус задачи на `awaiting_pm_review`

# Шаг 9 — Лейбл есть, CI зелёный, но не смерджено

Anomaly. Возможные причины:
- `auto-merge-on-label.yml` сломан или не сконфигурирован
- Branch protection требует дополнительных проверок
- Merge conflict с base

1. Проверить мерж-conflict: `gh pr view {{PR}} --repo {{REPO}} --json mergeable,mergeStateStatus`
2. Проверить последний run auto-merge workflow:
   ```bash
   gh run list --repo {{REPO}} --workflow=auto-merge-on-label.yml --limit 3
   ```
3. Записать event `auto_merge_anomaly` с findings
4. **НЕ** мерджить вручную — это решение пользователя. Очистить `next_action`, оставить задачу в `merging` статусе с заметкой в `events[]`.

# Шаг 10 — PR закрыт без мерджа

Кто-то закрыл вручную. Не отменять.

1. Записать event `pr_closed_without_merge` с `closedAt`
2. Переместить задачу из `active[]` в `completed[]` с пометкой `outcome: "cancelled"` или новым полем
3. Очистить `next_action`

# Шаг 11 — Финальный коммит state

Атомарно перезаписать `pm-state.json`.

# Что не делать

- НЕ запускать ручной `gh pr merge` (auto-merge должен сработать сам)
- НЕ принимать решений за пользователя
- НЕ создавать новый wake-up из этой сессии (только пользователь решает retry)
