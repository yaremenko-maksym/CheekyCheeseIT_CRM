# PM Snippets — On-Demand Reference

Готовые сниппеты для диспетча агентов, проверки PR, прогона CI и User Testing.

**PM не читает этот файл upfront** — обращается через локальный skill `pm-dispatching` когда реально нужен сниппет.

---

## Диспетч агентов

### Coder — новая фича

```
Agent(
  isolation="worktree",
  description="Coder: task-<slug>",
  prompt="""Ты — Coder-агент для CRM Cheeky Cheese IT.
Прочитай docs/agents/coder.md — системный промпт.
Прочитай docs/agents/CLAUDE-coder.md — архитектура монорепо.
Прочитай docs/agents/memory/coder/lessons.md — накопленные уроки.
Task-файл: docs/specs/tasks/task-<slug>.md
Repo: yaremenko-maksym/CheekyCheeseIT_CRM"""
)
```

### Coder — фикс в существующую ветку

```
Agent(
  isolation="worktree",
  description="Coder: fix-<slug>",
  prompt="""Ты — Coder-агент. Прочитай docs/agents/coder.md.
Прочитай docs/agents/CLAUDE-coder.md.
Прочитай docs/agents/memory/coder/lessons.md.
Task: docs/specs/tasks/task-fix-<slug>.md
target_branch: <pr_branch>
Ветка уже существует — переключись: git checkout <pr_branch>"""
)
```

### AutoTest — post-approval тесты

```
Agent(
  description="AutoTest: PR #<N>",
  prompt="""Ты — AutoTest-агент. Прочитай docs/agents/autotest.md.
Прочитай docs/agents/memory/autotest/lessons.md.
PR для анализа: #<N>, repo: yaremenko-maksym/CheekyCheeseIT_CRM.
Режим 1: Post-approval — написать E2E тесты для новых AC."""
)
```

### AutoTest — фикс упавшего E2E

```
Agent(
  isolation="worktree",
  description="AutoTest: fix-e2e-<slug>",
  prompt="""Ты — AutoTest-агент. Прочитай docs/agents/autotest.md.
Прочитай docs/agents/memory/autotest/lessons.md.
Task: docs/specs/tasks/task-fix-e2e-<slug>.md
target_branch: <pr_branch>
Ветка: git checkout <pr_branch>"""
)
```

### Reviewer — code review

```
Agent(
  description="Reviewer: PR #<N>",
  prompt="""Ты — Reviewer-агент. Прочитай docs/agents/reviewer.md.
Прочитай docs/agents/memory/reviewer/lessons.md.
PR для review: #<N>, repo: yaremenko-maksym/CheekyCheeseIT_CRM"""
)
```

### DevOps — инфра-задача

```
Agent(
  isolation="worktree",
  description="DevOps: task-infra-<slug>",
  prompt="""Ты — DevOps-агент. Прочитай docs/agents/devops.md.
Прочитай docs/agents/memory/devops/lessons.md.
Task: docs/specs/tasks/task-infra-<slug>.md"""
)
```

### Параллельный запуск (Coder + DevOps)

В одном сообщении — оба `Agent` вызова с `run_in_background=True`:

```
Agent(isolation="worktree", run_in_background=True, description="Coder: task-<slug>", prompt="...")
Agent(isolation="worktree", run_in_background=True, description="DevOps: task-infra-<slug>", prompt="...")
```

---

## PR и CI команды

### Найти PR по ветке

```bash
gh pr list --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --head "feature/<slug>" --json number,title --jq '.[0]'
```

### Статус CI на PR

```bash
gh pr view <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --json statusCheckRollup --jq '.statusCheckRollup[] | {name, conclusion}'
```

Или через MCP:
```
mcp__github__get_pull_request_status({owner: "yaremenko-maksym", repo: "CheekyCheeseIT_CRM", pull_number: <N>})
```

### Лейблы на PR

```bash
gh pr view <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --json labels --jq '[.labels[].name]'
```

### Управление лейблами

```bash
# Pre-review (Reviewer выставляет когда APPROVE)
gh pr edit <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM --add-label "awaiting-pm-review"

# После User Testing апрува (PM выставляет)
gh pr edit <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --add-label "merge-approved" \
  --remove-label "awaiting-pm-review"

# Снять CI-failed после фикса
gh pr edit <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM --remove-label "ci-failed"
```

### Review-комментарии (через MCP, не gh api)

```
mcp__github__get_pull_request_reviews({owner: "yaremenko-maksym", repo: "CheekyCheeseIT_CRM", pull_number: <N>})
mcp__github__get_pull_request_comments({owner: "yaremenko-maksym", repo: "CheekyCheeseIT_CRM", pull_number: <N>})
```

---

## User Testing подготовка окружения

Все шаги в одном скрипте — выполнить перед каждым User Testing:

```bash
bash scripts/pm/prep-user-testing.sh <pr_branch>
```

Скрипт делает: `git fetch && checkout && pull` → миграции → unit-тесты → **production build (api + web)** → старт API + Vite preview → ожидание готовности → LocalTunnel → блокирует foreground.

Через tunnel демка отдаётся как production bundle (а не dev) — быстрее на мобильнике и без flaky HMR через туннель.

Если упал — не показывать пользователю, создать fix-задачу для Coder.

---

## E2E запуск (GHA workflow_dispatch)

```bash
# Запустить E2E workflow
gh workflow run e2e.yml --repo yaremenko-maksym/CheekyCheeseIT_CRM

# Последние run'ы
gh run list --repo yaremenko-maksym/CheekyCheeseIT_CRM --workflow=e2e.yml --limit=3

# Статус конкретного run
gh run view <run_id> --repo yaremenko-maksym/CheekyCheeseIT_CRM --json status,conclusion

# Логи провалившегося run
gh run view <run_id> --repo yaremenko-maksym/CheekyCheeseIT_CRM --log-failed
```

PM ждёт E2E через `ScheduleWakeup(delay=270)` — внешний GHA-процесс, не отслеживается локально.

---

## Workflow lookups (verification AutoTest не no-op)

```bash
# Сколько e2e-файлов изменил PR
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/<N>/files \
  --jq '[.[] | select(.filename | startswith("apps/e2e"))] | length'
```

Если `0` после AutoTest запуска — он не сделал работу (no-op). Создать новый task-файл и перезапустить.

---

## Common pitfalls — checklists

### После большого UI batch (User Testing → много правок)

После того как Coder завершил массовый UI fix-раунд, ДО объявления PR готовым к мерджу:

1. **Auto-dispatch AutoTest на specs update** — UI tests могут протухнуть от изменений селекторов:
   ```
   Agent(description="AutoTest: spec-update-PR-<N>",
     prompt="Ты — AutoTest. Прочитай docs/agents/autotest.md.
   PR #<N> содержит UI batch — обнови селекторы в apps/e2e/tests/<module>.spec.ts
   target_branch: <pr_branch>")
   ```
2. **Ожидать E2E rebuild** — после AutoTest push CI re-run; ждать второго зелёного раунда:
   ```bash
   gh pr view <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM \
     --json statusCheckRollup --jq '.statusCheckRollup'
   ```
3. **НЕ диспетчить merge-approved до второго зелёного CI.** Первый раунд мог быть до AutoTest update — нужен второй чтобы проверить что новые тесты тоже зелёные.
4. **Записать в pm-state.json** event `autotest_post_ui_batch` с PR номером — это маркер «UI rounds потребовали re-test».

### После migration rebuild (Drizzle schema change)

После того как Coder сделал миграцию, до User Testing:

1. **Создать DevOps task на `__drizzle_migrations` sync** если миграции были созданы вручную или переименованы:
   ```markdown
   # task-infra-migrations-sync
   ## Агент: devops
   ## Контекст
   В PR #<N> добавлена/изменена миграция. Проверить что `__drizzle_migrations` table sync с `drizzle/migrations/meta/_journal.json` — иначе db:migrate упадёт на fresh DB.
   ## AC
   - [ ] `pnpm --filter @crm/api db:init-tracking` синхронизирует state
   - [ ] Smoke test: `docker-compose down -v && docker-compose up -d && pnpm db:migrate && pnpm db:seed` проходит без ошибок
   ```
2. **Smoke test fresh-DB flow** до User Testing — если миграции не применяются на чистой БД, User Testing будет видеть данные но fresh deploy сломается.
3. **Записать в pm-state.json** event `migration_rebuild_required` с PR номером.
