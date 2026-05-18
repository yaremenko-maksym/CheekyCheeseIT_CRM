# PM — Agent Notes

## Репо

Repo: `yaremenko-maksym/CheekyCheeseIT_CRM`
Main branch: `main`

## GHA Secrets

| Secret | Для чего |
|--------|----------|
| `CLAUDE_CODE_OAUTH_TOKEN` | claude-code-action auth (все агенты) |
| `JWT_SECRET` | E2E тесты (auth через cookie) |

## Типичные длительности (expected_duration_min)

| Тип задачи | Мин |
|-----------|-----|
| Coder: 1-2 файла | 8-12 |
| Coder: модуль (3-6 файлов) | 15-25 |
| Coder: большой модуль (7+) | 25-40 |
| AutoTest: обновление тестов | 8-15 |
| DevOps: workflow изменения | 5-10 |
| E2E workflow (e2e.yml) | 10-20 |

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
# Список запущенных workflows (последние 10)
gh run list --repo yaremenko-maksym/CheekyCheeseIT_CRM --limit 10

# Статус конкретного run
gh run view <run_id> --repo yaremenko-maksym/CheekyCheeseIT_CRM --json status,conclusion

# Лог падения
gh run view <run_id> --repo yaremenko-maksym/CheekyCheeseIT_CRM --log-failed

# Список open PR
gh pr list --repo yaremenko-maksym/CheekyCheeseIT_CRM --state open

# Labels на PR
gh pr view <pr_number> --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --json labels --jq '[.labels[].name]'

# Тригер workflow
gh workflow run <name>.yml \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  -f task_file="..." \
  -f task_hint="..."

# Получить run_id только что запущенного workflow
gh run list --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --workflow=<name>.yml --limit=1 \
  --json databaseId --jq '.[0].databaseId'

# PR reviews
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/<N>/reviews \
  --jq '.[] | {state, body}'
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
      "workflow": "coder.yml",
      "run_id": "12345678",
      "branch": "feature/knowledge-api",
      "pr_number": null,
      "status": "running",
      "started_at": "2026-05-18T10:00:00Z",
      "expected_duration_min": 20
    }
  ],
  "blocked": [],
  "merged": [],
  "phase": "development"
}
```

**Статусы задачи:** `running` → `pr_open` → `awaiting_pm_review` → `e2e_running` → `merged` | `failed`
