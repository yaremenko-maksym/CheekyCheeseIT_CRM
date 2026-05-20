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

## pm-state.json формат

```json
{
  "feature": "Knowledge Base",
  "brief": "docs/specs/pm-brief.md",
  "started_at": "2026-05-18T10:00:00Z",
  "tasks": [
    {
      "id": "task-knowledge-api",
      "file": "docs/specs/tasks/task-knowledge-api.md",
      "agent": "coder",
      "branch": "feature/knowledge-api",
      "pr_number": null,
      "status": "running",
      "started_at": "2026-05-18T10:00:00Z",
      "review_rounds": 0,
      "max_review_rounds": 5
    }
  ],
  "blocked": [],
  "merged": [],
  "phase": "development",
  "pending_fixes": []
}
```

**`pending_fixes`** — массив правок от пользователя во время User Testing, ещё не отправленных в Coder.
Каждый элемент — строка с описанием правки. Очищается после создания task-файла и запуска Coder.

Пример с накопленными правками:
```json
"pending_fixes": [
  "Кнопка 'Добавить' не активна для роли HR — должна быть активна",
  "Поле телефона не валидируется при сохранении",
  "Заголовок модалки обрезается на мобильном"
]
```

**Статусы задачи:** `running` → `pr_open` → `awaiting_pm_review` → `e2e_running` → `merged` | `failed`
