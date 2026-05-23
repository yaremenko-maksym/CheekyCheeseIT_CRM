# PM — Agent Notes

## Репо

Repo: `yaremenko-maksym/CheekyCheeseIT_CRM`
Main branch: `main`

## GHA Secrets

| Secret | Для чего |
|--------|----------|
| `CLAUDE_CODE_OAUTH_TOKEN` | claude-code-action auth (все агенты) |
| `JWT_SECRET` | E2E тесты (auth через cookie) |

## Типичные длительности агентов

| Тип задачи | Ожидаемое время |
|-----------|-----------------|
| Coder: 1-2 файла | 8-12 мин |
| Coder: модуль (3-6 файлов) | 15-25 мин |
| Coder: большой модуль (7+) | 25-40 мин |
| AutoTest: написание/обновление тестов | 8-15 мин |
| Reviewer: code review | 5-10 мин |
| DevOps: workflow изменения | 5-10 мин |
| E2E через e2e.yml (GHA) | 10-20 мин — использовать `ScheduleWakeup(delay=270)` |

**Foreground агенты** блокируют PM до завершения — результат приходит сразу.
**Background агенты** (`run_in_background=True`) — PM получает уведомление автоматически.
`ScheduleWakeup` использовать ТОЛЬКО для GHA E2E workflow (внешний процесс, не отслеживается).

### ⚠️ ScheduleWakeup limitations (D1 [P0])

**ScheduleWakeup не выживает session boundary.** Real incident: 2026-05-23 PM поставил wake-up на 2 часа, session завершилась → wake-up потерян → PR висел без действия.

**Правила использования:**
- Использовать ТОЛЬКО для wake-up'ов внутри текущей session (< 30 мин типично)
- Для cross-session ожидания (например GHA workflow > 30 мин на E2E) — НЕ полагаться только на ScheduleWakeup. Дополнительно записать в `pm-state.json.active[task].next_action`:
  ```json
  {
    "type": "poll_e2e_run",
    "run_id": "26298999300",
    "scheduled_at": "<ISO>",
    "max_age_min": 30
  }
  ```
- При старте новой session (Mode 3 continuation) — PM читает `next_action`, делает immediate check вместо ожидания wake-up'а
- Если `scheduled_at` старше `max_age_min` — это сигнал missed wake-up, делать catch-up

**Workaround pattern:**
```python
# Перед wake-up — сохрани действие в state
pm_state["active"][task_idx]["next_action"] = {
    "type": "poll_e2e_run",
    "run_id": run_id,
    "scheduled_at": now_iso(),
    "max_age_min": 30
}
ScheduleWakeup(delay=270)  # 4.5 мин для GHA E2E
```

```python
# При старте Mode 3 — catch-up logic
for task in pm_state["active"]:
    if next_action := task.get("next_action"):
        age_min = (now() - parse_iso(next_action["scheduled_at"])).total_seconds() / 60
        if age_min > next_action["max_age_min"]:
            # missed wake-up — immediate execute
            handle_next_action(next_action)
```

**Связанная задача:** `docs/specs/tasks/task-harness-schedule-wakeup-persistence.md` (NEEDS-USER, harness-level fix).

## Именование веток

- `feature/<slug>` — новая фича (Coder)
- `test/<slug>` — тесты (AutoTest standalone)
- `infra/<slug>` — инфраструктура (DevOps)
- `fix/<slug>` — фикс бага или E2E

## Текущий статус фаз

- ✅ PHASE 1: Layout (Sidebar + Header)
- ✅ PHASE 2: Команда (Teams)
- ✅ PHASE 3: Проекты (Projects)
- ✅ PHASE 4: Собеседования (Interviews Kanban)
- ✅ PHASE 5: Финансы (мониторинг)
- ✅ PHASE 7 (частично): Профили
- ⏳ **PHASE 6: База знаний + Документы** ← СЛЕДУЮЩАЯ
- ⏳ PHASE 8: Смарт-контракты (USDT ERC-20)
- ⏳ PHASE 9: Дашборд

## Полезные команды мониторинга

```bash
# Список open PR
gh pr list --repo yaremenko-maksym/CheekyCheeseIT_CRM --state open

# Labels на PR
gh pr view <pr_number> --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --json labels --jq '[.labels[].name]'

# PR reviews
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/<N>/reviews \
  --jq '.[] | {state, body}'

# Найти PR по ветке
gh pr list --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --head "feature/<slug>" --json number --jq '.[0].number'

# Мониторинг GHA E2E (только e2e.yml — внешний процесс)
gh run list --repo yaremenko-maksym/CheekyCheeseIT_CRM --workflow=e2e.yml --limit 5
gh run view <run_id> --repo yaremenko-maksym/CheekyCheeseIT_CRM --json status,conclusion
gh run view <run_id> --repo yaremenko-maksym/CheekyCheeseIT_CRM --log-failed

# Мерж PR (только после явного «мерджи» от пользователя)
gh pr merge <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM --squash --delete-branch
```

## Структура docs/specs/tasks/

```
docs/specs/tasks/
├── task-<slug>.md          # активная задача
├── task-<slug>.blocked.md  # блокер от агента (PM читает и резолвит)
└── archive/
    └── <date>-<slug>.md   # завершённые задачи
```

## Правила именования task-файлов

- Новая фича: `task-<module>-<aspect>.md` (напр. `task-knowledge-api.md`)
- Фикс от reviewer: `task-fix-pr-<N>.md` (автоматически, из ai-review.yml)
- Фикс E2E: `task-fix-e2e-<slug>.md`
- Фикс теста: `task-fix-test-<slug>.md`
- Фикс от user testing: `task-fix-<short-description>.md`

## pm-state.json schema v2

Файл локальный, gitignored. PM пишет и читает между сессиями. Формат поддерживает события и метрики — данные накапливаются для пост-анализа эффективности пайплайна.

```json
{
  "feature": "Knowledge Base",
  "brief": "docs/specs/pm-brief.md",
  "started_at": "2026-05-18T10:00:00Z",
  "phase": "development",
  "active": [
    {
      "id": "task-knowledge-api",
      "file": "docs/specs/tasks/task-knowledge-api.md",
      "agent": "coder",
      "branch": "feature/knowledge-api",
      "pr_number": null,
      "status": "running",
      "started_at": "2026-05-18T10:00:00Z",
      "review_rounds": 0,
      "max_review_rounds": 5,
      "agent_invocations": {
        "coder": 1,
        "reviewer": 0,
        "autotest": 0,
        "devops": 0
      },
      "events": [
        { "at": "2026-05-18T10:00:00Z", "type": "agent_started", "agent": "coder" }
      ],
      "pending_fixes": []
    }
  ],
  "completed": [
    {
      "id": "task-fix-pr22-ui-round5",
      "duration_min": 18,
      "rounds": 5,
      "regression_count": 1,
      "agent_invocations": {
        "coder": 5,
        "reviewer": 4,
        "autotest": 1,
        "devops": 0
      },
      "merged_at": "2026-05-20T07:03:35Z",
      "pr_number": 22
    }
  ],
  "blocked": [],
  "blocking_issue": null
}
```

### Поля

**Top-level:**
- `feature` — название текущей фичи (читаемое имя)
- `brief` — путь к pm-brief.md
- `started_at` — когда PM стартовал работу над фичей
- `phase` — `development` / `user-testing` / `merging` / `archived`
- `active[]` — текущие незавершённые задачи
- `completed[]` — завершённые задачи (для метрик)
- `blocked[]` — заблокированные задачи (с .blocked.md файлами)
- `blocking_issue` — если есть глобальный blocker (например, e2e-broken на main)

**Active task:**
- Базовые поля: `id`, `file`, `agent`, `branch`, `pr_number`, `status`
- `review_rounds` — счётчик раундов code review (circuit breaker при `>=3`)
- `agent_invocations` — счётчики сколько раз PM запускал каждого агента
- `events[]` — лог событий (см. ниже)
- `pending_fixes[]` — правки от User Testing, ещё не отправленные в Coder

**Event types** (записываются в `events[]`):
- `agent_started` — `{ at, type, agent, task_file? }`
- `agent_finished` — `{ at, type, agent, result: "success"|"blocked"|"no-op" }`
- `pr_opened` — `{ at, type, pr }`
- `review_approve` — `{ at, type, pr }`
- `review_blocked` — `{ at, type, pr, verdict: "BLOCK", rounds }` — Reviewer COMMENT с `Verdict: BLOCK` (см. Mode 2.D в pm.md)
- `review_rejected` — `{ at, type, pr, rounds }` — REQUEST_CHANGES от внешнего reviewer (редко, AI-агенты используют review_blocked)
- `autotest_skipped` — `{ at, type, reason }` — PM решил не диспетчить AutoTest (например, чисто стили без UI changes). **Skip без записи запрещён** — это пробел в покрытии.
- `worktree_isolation_warning` — `{ at, type, files: [...] }` — после `Agent(isolation="worktree")` обнаружены uncommitted changes в текущем worktree (см. Mode 2.E)
- `e2e_started` — `{ at, type, run_id }`
- `e2e_passed` — `{ at, type, run_id }`
- `e2e_failed` — `{ at, type, run_id, failure_type: "code"|"test" }`
- `user_approved` — `{ at, type, pr }` — пользователь сказал «мерджи»
- `merge_approved_label` — `{ at, type, pr }` — PM выставил лейбл
- `do_not_merge_label` — `{ at, type, pr, reason }` — PM выставил do-not-merge после Verdict: BLOCK
- `merged` — `{ at, type, pr }` — CI смерджил

**Completed task** (агрегаты для метрик):
- `duration_min` — от `started_at` до `merged_at` в минутах
- `rounds` — итоговое число review_rounds
- `regression_count` — сколько раз round_N сломал что-то из round_{N-1}
- `agent_invocations` — финальные счётчики
- `merged_at`, `pr_number` — для трассировки

### Статусы задачи

`running` → `pr_open` → `awaiting_pm_review` → `user_testing` → `e2e_running` → `merged` | `failed`

Промежуточные:
- `blocked` — есть `.blocked.md` файл, PM нужен резолв
- `pending_fixes` — User Testing вернул правки, ждёт следующего раунда Coder

### Метрики (выводятся из completed[])

PM может посчитать в любой момент:
- `avg(rounds)` — среднее число раундов на задачу
- `avg(duration_min)` — среднее время от старта до merge
- `sum(regression_count) / count(*)` — частота регрессий
- Распределение `agent_invocations.coder` — сколько раз перезапускали Coder в среднем

Эти числа — индикатор здоровья пайплайна. Цель из design v2: `avg(rounds) <= 2`.

### Migration со старого формата

Старый формат имел: `tasks`, `merged`, `pending_fixes` (top-level). Mapping:
- `tasks` → `active`
- `merged` → `completed` (доп. поля заполнить дефолтами для исторических: `rounds: null`, `duration_min: null`)
- `pending_fixes` (top-level) → внутрь `active[task].pending_fixes`

Migration происходит лениво — PM при чтении старого формата перепишет в новый при первом сохранении.
