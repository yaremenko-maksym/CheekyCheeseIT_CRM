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

Скрипт делает: `git fetch && checkout` (auto-detect worktree) → миграции → unit-тесты (api/web/shared, без e2e) → **production build (api + web с `VITE_API_URL=/api` + `VITE_DEV_LOGIN=true`)** → kill prev по PORT → старт API + Vite preview → wait-for-services → **Serveo SSH tunnel** (`ssh -R 80:localhost:3000 serveo.net`) → блокирует foreground.

Через tunnel демка отдаётся как production bundle (не dev) — быстрее на мобильнике, без flaky HMR через туннель. URL формат `https://<hash>.serveousercontent.com`. OAuth через tunnel НЕ работает — использовать Dev Login (email на `/crm/login`).

Env overrides: `SKIP_TUNNEL=1`, `SKIP_UNIT_TESTS=1`, `POSTGRES_*`.

Если упал — не показывать пользователю, читать `/tmp/pm-api.log` + `/tmp/pm-web.log` + Serveo лог → классифицировать (build/DB/tunnel/port-clash) → fix-задача для Coder/DevOps. Troubleshooting — `docs/runbooks/user-testing-tunnel.md`.

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

## Coder hung — recovery (C1 detection layer)

После dev-flow RCA hook `.claude/hooks/coder-progress-marker.sh` пишет activity лог в `<main-repo>/.claude/coder-activity.log` (gitignored, TSV). PM использует его для detection silent termination.

### Шаг 1: Latest Coder activity

```bash
LOG="$(git rev-parse --git-common-dir 2>/dev/null)/../.claude/coder-activity.log"
LOG=$(cd "$(dirname "$LOG")" && pwd)/$(basename "$LOG")  # absolute path

tail -10 "$LOG"
```

Формат строки: `<ISO>\t<tool>\t<branch>\t<cwd>\t<file>`.

### Шаг 2: Detect hung

```bash
LAST_TS=$(tail -1 "$LOG" | cut -f1)
AGE_SEC=$(( $(date -u +%s) - $(date -u -d "$LAST_TS" +%s 2>/dev/null || date -ujf '%Y-%m-%dT%H:%M:%SZ' "$LAST_TS" +%s) ))

if [ "$AGE_SEC" -gt 600 ]; then
  echo "⚠️ Coder последний раз writeл $((AGE_SEC / 60)) мин назад — likely hung"
fi
```

### Шаг 3: Pick worktree from last entry

```bash
LAST_CWD=$(tail -1 "$LOG" | cut -f4)
LAST_BRANCH=$(tail -1 "$LOG" | cut -f3)

echo "Last activity: $LAST_BRANCH в $LAST_CWD"
git -C "$LAST_CWD" log --oneline -5
git -C "$LAST_CWD" status --porcelain
```

### Шаг 4: Recover unpushed work

```bash
# Если есть uncommitted
git -C "$LAST_CWD" stash push -u -m "pm-recovery $(date -u +%Y%m%dT%H%M%SZ)"

# Если есть unpushed commits — push to remote (если pre-push hook требует ac_verified,
# либо проверить commit messages, либо использовать --no-verify в emergency).
git -C "$LAST_CWD" log --oneline HEAD..origin/$LAST_BRANCH  # обратное направление = unpushed
git -C "$LAST_CWD" push origin "$LAST_BRANCH"
```

### Шаг 5: Записать event

```json
{ "at": "<ISO>", "type": "coder_recovered", "branch": "<branch>", "unpushed_commits": <N>, "stashed": true/false }
```

### Для крупных задач — semantic milestone

Если Coder поддерживал `docs/specs/tasks/<task>.progress.md` (см. `coder.md` секция 8.2):

```bash
cat docs/specs/tasks/<task>.progress.md
# Видишь current_milestone — перезапускаешь Coder с явным "continue from milestone N+1"
```

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
