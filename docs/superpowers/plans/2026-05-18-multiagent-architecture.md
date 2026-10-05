# Multi-Agent Architecture Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PM agent as the central orchestrator, parallel task dispatch via `docs/specs/tasks/`, an explicit E2E gate (`e2e.yml`), a User Testing stage, remove QA and simplify the escalation chain.

**Architecture:** The PM lives locally, launches GHA agents in parallel via `gh workflow run`, monitors via ScheduleWakeup + pm-state.json. After APPROVE the Reviewer adds the label `awaiting-pm-review` — the PM wakes up, analyzes, runs User Testing, then e2e.yml.

**Tech Stack:** GitHub Actions, claude-code-action@beta, bash (gh CLI), pnpm, Playwright (e2e.yml), Zod prompts in the YAML direct_prompt.

---

## Files — the full list of changes

| Action  | File                                                            |
| ------- | --------------------------------------------------------------- |
| CREATE  | `docs/specs/tasks/.gitkeep`                                     |
| CREATE  | `docs/specs/tasks/archive/.gitkeep`                             |
| CREATE  | `.github/workflows/e2e.yml`                                     |
| CREATE  | `docs/agents/pm.md`                                             |
| CREATE  | `docs/agents/CLAUDE-pm.md`                                      |
| MODIFY  | `.github/workflows/coder.yml`                                   |
| MODIFY  | `.github/workflows/devops.yml`                                  |
| MODIFY  | `.github/workflows/autotest.yml`                                |
| MODIFY  | `.github/workflows/ai-review.yml`                               |
| MODIFY  | `docs/agents/ba.md`                                             |
| MODIFY  | `docs/agents/CLAUDE-ba.md`                                      |
| MODIFY  | `docs/agents/coder.md`                                          |
| MODIFY  | `docs/agents/autotest.md`                                       |
| MODIFY  | `docs/agents/reviewer.md`                                       |
| MODIFY  | `docs/agents/devops.md`                                         |
| MODIFY  | `CLAUDE.md`                                                     |
| ARCHIVE | `docs/agents/qa.md` → `docs/agents/archive/qa.md`               |
| ARCHIVE | `docs/agents/CLAUDE-qa.md` → `docs/agents/archive/CLAUDE-qa.md` |
| ARCHIVE | `docs/specs/active-task.md` → `docs/specs/archive/`             |
| ARCHIVE | `docs/specs/active-devops-task.md` → `docs/specs/archive/`      |
| DELETE  | `.github/workflows/ba-escalation.yml`                           |

---

## Task 1: Initialize the tasks directory and the GitHub label

**Files:**

- Create: `docs/specs/tasks/.gitkeep`
- Create: `docs/specs/tasks/archive/.gitkeep`

- [ ] **Step 1: Create the directories**

```bash
mkdir -p docs/specs/tasks/archive
touch docs/specs/tasks/.gitkeep
touch docs/specs/tasks/archive/.gitkeep
```

- [ ] **Step 2: Add the label `awaiting-pm-review` to the repo**

```bash
gh label create "awaiting-pm-review" \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --color "FFA500" \
  --description "PM needs to analyze review before E2E"
```

- [ ] **Step 3: Add the label `pm-blocker` to the repo**

```bash
gh label create "pm-blocker" \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --color "FF0000" \
  --description "Agent blocked, PM needs to resolve"
```

- [ ] **Step 4: Commit**

```bash
git add docs/specs/tasks/.gitkeep docs/specs/tasks/archive/.gitkeep
git commit -m "chore: initialize tasks/ directory for PM parallel dispatch"
```

---

## Task 2: The new `e2e.yml` workflow

**Files:**

- Create: `.github/workflows/e2e.yml`

- [ ] **Step 1: Create `.github/workflows/e2e.yml`**

```yaml
name: E2E Tests

# Запускается только PM-агентом после User Testing APPROVE.
# Никогда не запускается автоматически.
on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to run E2E against'
        required: true
        type: string

concurrency:
  group: e2e-pr-${{ inputs.pr_number }}
  cancel-in-progress: true

jobs:
  e2e:
    name: E2E Tests
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: crm_user
          POSTGRES_PASSWORD: password
          POSTGRES_DB: crm_db
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7-alpine
        ports: ['6379:6379']
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - name: Get PR head ref
        id: pr_head
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          REF=$(gh pr view "${{ inputs.pr_number }}" \
            --repo ${{ github.repository }} \
            --json headRefName --jq '.headRefName')
          echo "ref=${REF}" >> $GITHUB_OUTPUT

      - uses: actions/checkout@v4
        with:
          ref: ${{ steps.pr_head.outputs.ref }}
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with:
          version: 7.32.4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      - name: Run migrations + seed
        run: |
          pnpm --filter @crm/api db:migrate
          pnpm --filter @crm/api db:seed
        env:
          DATABASE_URL: postgresql://crm_user:password@localhost:5432/crm_db
          REDIS_URL: redis://localhost:6379
          JWT_SECRET: ${{ secrets.JWT_SECRET }}
          NODE_ENV: test

      - name: Build web
        run: pnpm --filter @crm/web build
        env:
          VITE_API_URL: http://localhost:3001

      - name: Start API + Web (background)
        run: |
          pnpm --filter @crm/api start:prod &
          pnpm --filter @crm/web preview --port 3000 &
          npx wait-on \
            http://localhost:3001/api/health \
            http://localhost:3000 \
            --timeout 60000 \
            --interval 2000
        env:
          DATABASE_URL: postgresql://crm_user:password@localhost:5432/crm_db
          REDIS_URL: redis://localhost:6379
          JWT_SECRET: ${{ secrets.JWT_SECRET }}
          NODE_ENV: production
          PORT: 3001

      - name: Install Playwright browsers
        run: pnpm --filter @crm/e2e exec playwright install --with-deps chromium

      - name: Run Playwright E2E
        run: pnpm --filter @crm/e2e test
        env:
          BASE_URL: http://localhost:3000
          API_URL: http://localhost:3001

      - name: Post E2E result to PR
        if: always()
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          PR="${{ inputs.pr_number }}"
          REPO="${{ github.repository }}"
          if [ "${{ job.status }}" = "success" ]; then
            STATUS="✅ E2E passed — ready to merge"
          else
            STATUS="❌ E2E failed — see artifacts below"
          fi
          gh pr comment "$PR" --repo "$REPO" \
            --body "## 🎭 E2E Results
          ${STATUS}
          Run: https://github.com/${REPO}/actions/runs/${{ github.run_id }}"

      - name: Upload E2E artifacts on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-results-pr-${{ inputs.pr_number }}
          path: |
            apps/e2e/test-results/
            apps/e2e/playwright-report/
          retention-days: 7

  merge:
    name: Squash Merge
    runs-on: ubuntu-latest
    needs: [e2e]
    if: needs.e2e.result == 'success'
    permissions:
      contents: write
      pull-requests: write

    steps:
      - name: Dismiss stale CHANGES_REQUESTED reviews
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          PR="${{ inputs.pr_number }}"
          REPO="${{ github.repository }}"
          gh api "repos/${REPO}/pulls/${PR}/reviews" \
            --jq '[.[] | select(.state == "CHANGES_REQUESTED")] | .[].id' | \
          while read -r REVIEW_ID; do
            gh api "repos/${REPO}/pulls/${PR}/reviews/${REVIEW_ID}/dismissals" \
              --method PUT \
              --field message="Superseded: E2E passed and PM approved" \
              2>/dev/null || true
          done

      - name: Squash merge
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh pr merge "${{ inputs.pr_number }}" \
            --squash \
            --repo ${{ github.repository }} \
            --delete-branch
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/e2e.yml
git commit -m "feat(ci): add standalone e2e.yml triggered by PM after user testing"
```

---

## Task 3: Update `coder.yml` — the `task_file` parameter

**Files:**

- Modify: `.github/workflows/coder.yml`

- [ ] **Step 1: Add the `task_file` input and update concurrency**

Find the block `on:` → `workflow_dispatch:` → `inputs:` and replace:

```yaml
# БЫЛО:
inputs:
  task_hint:
    description: 'Optional: short hint for branch name (e.g. "fix-finance-rbac")'
    required: false
    type: string

# СТАЛО:
inputs:
  task_file:
    description: 'Path to task file (e.g. docs/specs/tasks/task-auth-api.md)'
    required: true
    type: string
  task_hint:
    description: 'Short hint for branch name (e.g. "auth-api")'
    required: false
    type: string
```

- [ ] **Step 2: Update the concurrency key**

```yaml
# БЫЛО:
concurrency:
  group: coder-${{ github.sha }}
  cancel-in-progress: false

# СТАЛО:
concurrency:
  group: coder-${{ inputs.task_file }}
  cancel-in-progress: false
```

- [ ] **Step 3: Update `direct_prompt` — read from `task_file`**

Find the line in `direct_prompt`:

```
Прочитай docs/specs/active-task.md — это твоя текущая задача.
```

Replace with:

```
Прочитай ${{ inputs.task_file }} — это твоя текущая задача.
```

- [ ] **Step 4: Add all the MCP to `allowed_tools`**

```yaml
allowed_tools: |
  Read
  Write
  Edit
  Bash
  mcp__ast-grep__find_code
  mcp__ast-grep__find_code_by_rule
  mcp__ast-grep__dump_syntax_tree
  mcp__context7__resolve-library-id
  mcp__context7__query-docs
  mcp__eslint__lint-files
  mcp__postgres__query
  mcp__playwright__browser_navigate
  mcp__playwright__browser_take_screenshot
  mcp__playwright__browser_snapshot
  mcp__github__create_pull_request
  mcp__github__create_branch
  mcp__github__get_pull_request
  mcp__github__get_pull_request_files
  mcp__github__add_issue_comment
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/coder.yml
git commit -m "feat(ci): coder.yml accepts task_file param for parallel dispatch"
```

---

## Task 4: Update `devops.yml` — the `task_file` parameter

**Files:**

- Modify: `.github/workflows/devops.yml`

- [ ] **Step 1: Add the `task_file` input**

```yaml
# БЫЛО:
inputs:
  task_hint:
    description: 'Optional: short hint for branch name (e.g. "add-devops-agent")'
    required: false
    type: string

# СТАЛО:
inputs:
  task_file:
    description: 'Path to task file (e.g. docs/specs/tasks/task-infra-redis.md)'
    required: true
    type: string
  task_hint:
    description: 'Short hint for branch name'
    required: false
    type: string
```

- [ ] **Step 2: Update the concurrency key**

```yaml
# БЫЛО:
concurrency:
  group: devops-${{ github.sha }}
  cancel-in-progress: false

# СТАЛО:
concurrency:
  group: devops-${{ inputs.task_file }}
  cancel-in-progress: false
```

- [ ] **Step 3: Update `direct_prompt`**

Find:

```
Прочитай docs/specs/active-devops-task.md — это твоя текущая задача.
```

Replace with:

```
Прочитай ${{ inputs.task_file }} — это твоя текущая задача.
```

- [ ] **Step 4: Add all the MCP to `allowed_tools`**

```yaml
allowed_tools: |
  Read
  Write
  Edit
  Bash
  mcp__ast-grep__find_code
  mcp__ast-grep__find_code_by_rule
  mcp__context7__resolve-library-id
  mcp__context7__query-docs
  mcp__github__create_pull_request
  mcp__github__create_branch
  mcp__github__get_pull_request
  mcp__github__add_issue_comment
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/devops.yml
git commit -m "feat(ci): devops.yml accepts task_file param for parallel dispatch"
```

---

## Task 5: Update `autotest.yml` — the `task_file` parameter

**Files:**

- Modify: `.github/workflows/autotest.yml`

- [ ] **Step 1: Add the optional `task_file` input**

```yaml
# БЫЛО:
inputs:
  module:
    description: 'Module to update tests for (e.g. finance, team, interviews) — empty = full scan'
    required: false
    type: string

# СТАЛО:
inputs:
  task_file:
    description: 'Path to task file from PM (e.g. docs/specs/tasks/task-e2e-auth.md) — optional'
    required: false
    type: string
  module:
    description: 'Module to update tests for (e.g. finance, team, interviews) — empty = full scan'
    required: false
    type: string
```

- [ ] **Step 2: Update the concurrency key**

```yaml
# БЫЛО:
concurrency:
  group: autotest-docs-${{ github.ref }}

# СТАЛО:
concurrency:
  group: autotest-${{ inputs.task_file || inputs.module || github.ref }}
```

- [ ] **Step 3: Update `direct_prompt`**

In the `direct_prompt` section add at the beginning:

```yaml
direct_prompt: |
  Ты — AutoTest-агент для CRM Cheeky Cheese IT.

  Прочитай docs/agents/autotest.md — это твой полный системный промпт.
  Прочитай docs/agents/CLAUDE-autotest.md — структура тестов, паттерны, seed.

  {% if inputs.task_file %}
  Работай в РЕЖИМЕ 3: PM task-driven.
  Прочитай ${{ inputs.task_file }} — задача от PM.
  Напиши или обнови E2E тесты для описанного функционала.
  {% else %}
  Работай в РЕЖИМЕ 2: docs/business/** Push.
  {% endif %}
```

Since GitHub Actions does not support Jinja conditions in strings, instead add to `direct_prompt`:

```yaml
direct_prompt: |
  Ты — AutoTest-агент для CRM Cheeky Cheese IT.

  Прочитай docs/agents/autotest.md — это твой полный системный промпт.
  Прочитай docs/agents/CLAUDE-autotest.md — структура тестов, паттерны, seed.

  TASK_FILE: "${{ inputs.task_file }}"
  MODULE: "${{ inputs.module }}"

  Если TASK_FILE не пустой — прочитай его и работай по описанной задаче (Режим 3).
  Если TASK_FILE пустой — работай в Режиме 2: docs/business/** Push.

  Изменились следующие бизнес-документы (для Режима 2):
  ${{ steps.changed.outputs.files }}
  hint для ветки: ${{ steps.changed.outputs.hint }}
  Repo: ${{ github.repository }}
```

- [ ] **Step 4: Add all the MCP to `allowed_tools`**

```yaml
allowed_tools: |
  Read
  Write
  Edit
  Bash
  mcp__ast-grep__find_code
  mcp__ast-grep__find_code_by_rule
  mcp__playwright__browser_navigate
  mcp__playwright__browser_snapshot
  mcp__playwright__browser_take_screenshot
  mcp__github__create_pull_request
  mcp__github__create_branch
  mcp__github__get_pull_request
  mcp__github__add_issue_comment
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/autotest.yml
git commit -m "feat(ci): autotest.yml accepts optional task_file from PM"
```

---

## Task 6: Update `ai-review.yml` — remove merge, add awaiting-pm-review

**Files:**

- Modify: `.github/workflows/ai-review.yml`

This is the most important change. Three specific edits:

### 6.A — Add the label after APPROVE (in the job `reviewer`)

- [ ] **Step 1: Find the step `check_approved` in the job `reviewer` and add a new step after it**

After the step `Check reviewer decision` add:

```yaml
- name: Add awaiting-pm-review label on APPROVE
  if: steps.check_approved.outputs.approved == 'true'
  env:
    GH_TOKEN: ${{ github.token }}
  run: |
    PR="${{ github.event.pull_request.number || inputs.pr_number }}"
    gh pr edit "$PR" --repo ${{ github.repository }} \
      --add-label "awaiting-pm-review"
```

### 6.B — Update the pipeline status comment (in the job `reviewer`)

- [ ] **Step 2: Find the step `Update pipeline status — Code Review result` and replace the merge status**

```bash
# БЫЛО (в строке MG):
if [ -f autotest-approved.flag ]; then
  CR="✅ Approved"
  MG="⏳ Waiting"
else
  CR="❌ Changes requested — Coder triggered"
  MG="—"
fi

# СТАЛО:
if [ -f autotest-approved.flag ]; then
  CR="✅ Approved"
  MG="⏳ Awaiting PM review analysis"
else
  CR="❌ Changes requested — Coder triggered"
  MG="—"
fi
```

### 6.C — Remove the job `merge` entirely

- [ ] **Step 3: Remove the whole block of the job `merge`** (the lines from `merge:` to the end of this job, roughly lines 365–440 in the current file)

Remove the block:

```yaml
  # ─────────────────────────────────────────────
  # Job 3: Merge PR
  # ...
  merge:
    name: Merge PR
    ...
    steps:
      ...
```

### 6.D — Update the job `trigger_coder` — pass `task_file`

- [ ] **Step 4: In the job `trigger_coder` replace the step `Write and commit active-task.md`**

```yaml
- name: Write and commit fix-task file
  if: steps.review.outputs.has_review == 'true'
  env:
    GH_TOKEN: ${{ github.token }}
  run: |
    PR="${{ steps.review.outputs.pr }}"
    BRANCH=$(gh pr view "$PR" --repo ${{ github.repository }} --json headRefName --jq '.headRefName')
    git fetch origin "${BRANCH}"
    git checkout "${BRANCH}"

    TASK_FILE="docs/specs/tasks/task-fix-pr-${PR}.md"

    cat > "${TASK_FILE}" << TASK_EOF
    # Fix PR #${PR} — Review REQUEST_CHANGES

    ## Агент: coder
    ## Приоритет: high
    ## Ветка: ${BRANCH}
    ## НЕ створювати нову гілку — пушити в існуючу: \`${BRANCH}\`

    ## Findings від Reviewer

    ${{ steps.review.outputs.body }}

    ## Алгоритм
    1. git fetch origin ${BRANCH} && git checkout ${BRANCH}
    2. Виправити всі знайдені проблеми
    3. pnpm typecheck && pnpm lint && pnpm test
    4. git add <конкретні файли> && git commit -m "fix: ..."
    5. git push origin ${BRANCH}
    TASK_EOF

    git add "${TASK_FILE}"
    git commit -m "task: fix PR #${PR} — reviewer changes requested"
    git push origin "${BRANCH}"
    echo "task_file=${TASK_FILE}" >> $GITHUB_OUTPUT
  id: write_task
```

- [ ] **Step 5: Update the step `Trigger Coder` — pass `task_file`**

```yaml
- name: Trigger Coder
  if: steps.review.outputs.has_review == 'true'
  env:
    GH_TOKEN: ${{ github.token }}
  run: |
    PR="${{ steps.review.outputs.pr }}"
    TASK_FILE="${{ steps.write_task.outputs.task_file }}"
    gh workflow run coder.yml \
      --repo ${{ github.repository }} \
      -f task_file="${TASK_FILE}" \
      -f task_hint="fix-pr-${PR}"
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ai-review.yml
git commit -m "feat(ci): ai-review stops at PM gate after APPROVE, removes auto-merge"
```

---

## Task 7: Create `docs/agents/pm.md`

**Files:**

- Create: `docs/agents/pm.md`

- [ ] **Step 1: Create the file**

````markdown
# PM-агент (Project Manager)

## Роль

Ты — Project Manager для CRM компании Cheeky Cheese IT. Получаешь высокоуровневый бриф от BA, детализируешь до исполнимых задач, параллельно запускаешь агентов (Coder, AutoTest, DevOps), следишь за их работой, разрешаешь блокеры с пользователем напрямую, организуешь User Testing и управляешь E2E-пайплайном до merge.

**Ты никогда не пишешь код сам.** Всё что касается кода, тестов, инфраструктуры — делегируется агентам через task-файлы.

---

## Обязательное чтение при старте

1. `docs/agents/CLAUDE-pm.md` — статус фаз, типичные duration, secrets
2. `docs/specs/pm-brief.md` — бриф от BA (если новая задача)
3. `docs/specs/pm-state.json` — если существует → ты продолжаешь прерванную работу
4. `docs/business/overview.md` — бизнес-модель

---

## Режим 1 — Старт новой фичи

_Запускается когда BA написал новый `docs/specs/pm-brief.md`_

### Шаг 1: Анализ

```bash
cat docs/specs/pm-brief.md
# Если pm-state.json существует — прочитать его
```
````

Если найдена незавершённая работа в `pm-state.json` → перейти в **Режим 2**.

### Шаг 2: Декомпозиция

Вызвать skill `superpowers:writing-plans` для декомпозиции фичи.
Для каждой задачи определить:

- Агент: `coder` | `autotest` | `devops`
- Зависимости (какие задачи нужно завершить первыми)
- Ожидаемая длительность (см. CLAUDE-pm.md)

### Шаг 3: Создать task-файлы

Для каждой задачи создать `docs/specs/tasks/task-<slug>.md` по шаблону из Appendix A.

### Шаг 4: Параллельный запуск независимых задач

```bash
# Запускать независимые задачи одновременно
gh workflow run coder.yml \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  -f task_file="docs/specs/tasks/task-<slug>.md" \
  -f task_hint="<slug>"

gh workflow run devops.yml \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  -f task_file="docs/specs/tasks/task-infra-<slug>.md" \
  -f task_hint="infra-<slug>"

# Получить run_id последнего запуска
gh run list --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --workflow=coder.yml --limit=1 --json databaseId --jq '.[0].databaseId'
```

### Шаг 5: Записать pm-state.json

```json
{
  "feature": "<название из pm-brief>",
  "brief": "docs/specs/pm-brief.md",
  "started_at": "<ISO timestamp>",
  "tasks": [
    {
      "id": "task-<slug>",
      "file": "docs/specs/tasks/task-<slug>.md",
      "agent": "coder",
      "workflow": "coder.yml",
      "run_id": "<run_id>",
      "branch": "feature/<slug>",
      "pr_number": null,
      "status": "running",
      "started_at": "<ISO timestamp>",
      "expected_duration_min": 15
    }
  ],
  "blocked": [],
  "merged": [],
  "phase": "development"
}
```

### Шаг 6: ScheduleWakeup

```
ScheduleWakeup(delay = max(expected_duration_min) * 60 + 120 секунды)
```

---

## Режим 2 — Мониторинг (пробуждение)

### Шаг 1: Сканировать блокеры

```bash
ls docs/specs/tasks/*.blocked.md 2>/dev/null
```

Если найдены `.blocked.md` → перейти в **Режим 2.A**.

### Шаг 2: Обновить статусы задач в pm-state.json

Для каждой задачи со статусом `running`:

```bash
gh run view <run_id> \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --json status,conclusion \
  --jq '{status, conclusion}'
```

| conclusion    | Действие                                                  |
| ------------- | --------------------------------------------------------- |
| (in_progress) | Ждать — ScheduleWakeup                                    |
| success       | → статус `pr_open`, найти PR через `gh pr list` по branch |
| failure       | → статус `failed`, читать лог, создать fix-задачу         |

Найти PR по ветке:

```bash
gh pr list --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --head "feature/<slug>" --json number --jq '.[0].number'
```

### Шаг 3: Обработать PR-статусы

Для задач со статусом `pr_open`:

```bash
gh pr view <pr_number> \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --json labels --jq '[.labels[].name]'
```

Если `awaiting-pm-review` в labels → **Режим 2.B**.

### Шаг 4: E2E статусы

Для задач со статусом `e2e_running`:

```bash
gh run view <e2e_run_id> \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --json status,conclusion --jq '{status, conclusion}'
```

- `success` → PR merged → task в archive → обновить pm-state.json → финальный отчёт
- `failure` → **Режим 2.C**

### Шаг 5: Решение

- Есть незавершённые задачи → `ScheduleWakeup(delay=900)`
- Все `merged` → финальный отчёт пользователю → архивировать pm-state.json

---

### Режим 2.A — Блокер

```bash
cat docs/specs/tasks/<name>.blocked.md
```

1. Прочитать файл — понять вопрос агента
2. Задать вопрос пользователю напрямую в разговоре
3. Получить ответ
4. Если нужно → обновить `docs/business/`
5. Удалить `.blocked.md`
6. Перезапустить агента:

```bash
gh workflow run <workflow.yml> \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  -f task_file="<task_file_из_blocked>" \
  -f task_hint="<slug>"
```

---

### Режим 2.B — Post-Review анализ

Читать review-комментарии:

```bash
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/<pr>/reviews \
  --jq '.[] | {state, body, submitted_at}' | head -50
```

Если комментарии касаются бизнес-логики → обновить `docs/business/`.

Убрать label:

```bash
gh pr edit <pr_number> \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --remove-label "awaiting-pm-review"
```

Перейти в **Режим 4 (User Testing)**.

---

### Режим 2.C — E2E fail

1. Читать лог:

```bash
gh run view <run_id> \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --log-failed 2>&1 | tail -100
```

2. Определить тип проблемы:
   - Баг в коде → `docs/specs/tasks/task-fix-e2e-<slug>.md` для Coder
   - Баг в тесте → `docs/specs/tasks/task-fix-test-<slug>.md` для AutoTest

3. Запустить fix-агента (пушит в ту же ветку PR — указать в task-файле):

```bash
gh workflow run coder.yml \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  -f task_file="docs/specs/tasks/task-fix-e2e-<slug>.md" \
  -f task_hint="fix-e2e-<slug>"
```

4. После фикса — перезапустить ai-review:

```bash
gh workflow run ai-review.yml \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  -f pr_number=<PR>
```

---

## Режим 3 — Продолжение после перерыва

1. Прочитать `docs/specs/pm-state.json`
2. Восстановить контекст
3. Перейти в Режим 2

---

## Режим 4 — User Testing

### Шаг 1: Запустить проект

```bash
pnpm dev
```

Подождать старта серверов (:3001 API, :3000 Web).

### Шаг 2: Описать пользователю

```
✅ PR #<N> готов к тестированию. Проект запущен на localhost:3000.

**Что реализовано:**
- <конкретно что сделано>

**Где смотреть:**
- Sidebar → "<раздел>" (URL: /crm/<path>)
- <второй экран если есть>

**Что проверить:**
1. <конкретный сценарий для ROLE>
2. <сценарий для другой ROLE>
3. <edge case — что должно быть запрещено>

Апрув или список правок?
```

### Шаг 3: Реакция

**АПРУВ:**

```bash
gh workflow run e2e.yml \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  -f pr_number=<N>

# Получить run_id
gh run list --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --workflow=e2e.yml --limit=1 --json databaseId --jq '.[0].databaseId'
```

Записать `e2e_run_id` в pm-state.json → статус `e2e_running` → `ScheduleWakeup(delay=900)`

**ПРАВКИ:** → Режим 4.A

---

### Режим 4.A — Анализ правок

Для каждой правки от пользователя определить тип:

| Правка                 | Агент                             | Skill                     |
| ---------------------- | --------------------------------- | ------------------------- |
| UI/визуал/отступы      | Coder                             | `frontend-design`         |
| Бизнес-логика неверная | Coder + обновить `docs/business/` | `systematic-debugging`    |
| Новая фича в scope     | Coder                             | `writing-plans`           |
| Новая фича вне scope   | Уточнить у пользователя           | —                         |
| E2E тест не покрывает  | AutoTest                          | `test-driven-development` |

Создать task-файлы → запустить агентов (пушат в ту же ветку PR):

```bash
gh workflow run coder.yml \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  -f task_file="docs/specs/tasks/task-fix-<slug>.md" \
  -f task_hint="fix-<slug>"
```

После push → перезапустить ai-review:

```bash
gh workflow run ai-review.yml \
  --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  -f pr_number=<N>
```

→ Мониторинг → APPROVE → User Testing снова.

---

## Зоны записи

- ✅ `docs/specs/tasks/` — создавать, обновлять, архивировать
- ✅ `docs/specs/pm-state.json` — state машина
- ✅ `docs/business/` — при резолве блокеров и post-review
- ❌ `apps/`, `packages/` — только разработчики
- ❌ `.github/workflows/` — только DevOps

---

## MCP серверы

| Задача                | MCP                                                |
| --------------------- | -------------------------------------------------- |
| Читать review         | `mcp__github__get_pull_request_reviews`            |
| Читать комментарии    | `mcp__github__get_pull_request_comments`           |
| Управление labels     | `gh pr edit --add-label / --remove-label` (Bash)   |
| Проверить схему БД    | `mcp__postgres__query`                             |
| Найти паттерны в коде | `mcp__ast-grep__find_code`                         |
| Документация          | `mcp__context7__resolve-library-id` + `query-docs` |

---

## Appendix A: Шаблон task-файла

```markdown
# task-<slug>

## Агент: coder | autotest | devops

## Приоритет: high | medium | low

## Зависит от: (опционально, id другой задачи)

## Ветка: feature/<slug>

## (Для фиксов в существующей ветке — указать её имя)

## Контекст

<зачем эта задача, какую проблему решает>

## Конкретные изменения

1. `packages/shared/src/schemas/<module>.ts` — <что добавить/изменить>
2. `apps/api/src/<module>/<file>.ts` — <что реализовать>
3. `apps/web/app/routes/crm/<module>/` — <UI изменения>

## API endpoints (если новые)

- `GET /api/...` — описание, RBAC: ADMIN/SENIOR видят

## DB schema (если новые таблицы)

\`\`\`sql
-- таблица / колонки
\`\`\`

## RBAC

| Роль   | Доступ |
| ------ | ------ |
| ADMIN  |        |
| SENIOR |        |

## Acceptance criteria

- [ ] <проверяемый критерий>
- [ ] <второй критерий>

## Запрещено трогать

- `<файлы не входящие в задачу>`
```

````

- [ ] **Step 2: Commit**

```bash
git add docs/agents/pm.md
git commit -m "feat(agents): add PM agent system prompt with 4 operating modes"
````

---

## Task 8: Create `docs/agents/CLAUDE-pm.md`

**Files:**

- Create: `docs/agents/CLAUDE-pm.md`

- [ ] **Step 1: Create the file**

````markdown
# PM — Agent Notes

## Репо

Repo: `yaremenko-maksym/CheekyCheeseIT_CRM`
Локальний шлях: `~/Desktop/programming/CheekyCheeseIT_CRM`
Main branch: `main`

## GHA Secrets

| Secret                    | Для чого                             |
| ------------------------- | ------------------------------------ |
| `CLAUDE_CODE_OAUTH_TOKEN` | claude-code-action auth (всі агенти) |
| `JWT_SECRET`              | E2E тести (auth через cookie)        |

## Типові тривалості (expected_duration_min)

| Тип задачі                 | Хв    |
| -------------------------- | ----- |
| Coder: 1-2 файли           | 8-12  |
| Coder: модуль (3-6 файлів) | 15-25 |
| Coder: великий модуль (7+) | 25-40 |
| AutoTest: оновлення тестів | 8-15  |
| DevOps: workflow зміни     | 5-10  |
| E2E workflow (e2e.yml)     | 10-20 |

## Іменування гілок

- `feature/<slug>` — нова фіча (Coder)
- `test/<slug>` — тести (AutoTest standalone)
- `infra/<slug>` — інфраструктура (DevOps)
- `fix/<slug>` — фікс бага або E2E

## Поточний статус фаз

- ✅ PHASE 1: Layout (Sidebar + Header)
- ✅ PHASE 2: Команда (Teams)
- ✅ PHASE 3: Проекти (Projects)
- ✅ PHASE 4: Співбесіди (Interviews Kanban)
- ✅ PHASE 5: Фінанси (моніторинг)
- ✅ PHASE 7 (частково): Профілі
- ⏳ **PHASE 6: База знань + Документи** ← НАСТУПНА
- ⏳ PHASE 8: Смарт-контракти
- ⏳ PHASE 9: Дашборд

## Корисні команди моніторингу

```bash
# Список запущених workflows (останні 10)
gh run list --repo yaremenko-maksym/CheekyCheeseIT_CRM --limit 10

# Статус конкретного run
gh run view <run_id> --repo yaremenko-maksym/CheekyCheeseIT_CRM --json status,conclusion

# Лог падіння
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

# Отримати run_id щойно запущеного workflow
gh run list --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --workflow=<name>.yml --limit=1 \
  --json databaseId --jq '.[0].databaseId'
```
````

## Структура docs/specs/tasks/

```
docs/specs/tasks/
├── task-<slug>.md          # активна задача
├── task-<slug>.blocked.md  # блокер від агента (PM читає і резолвить)
└── archive/
    └── <date>-<slug>/      # завершені задачі
```

## Правила іменування task-файлів

- Нова фіча: `task-<module>-<aspect>.md` (напр. `task-knowledge-api.md`)
- Фікс від reviewer: `task-fix-pr-<N>.md` (автоматично, з ai-review.yml)
- Фікс E2E: `task-fix-e2e-<slug>.md`
- Фікс тесту: `task-fix-test-<slug>.md`
- Фікс від user testing: `task-fix-<short-description>.md`

````

- [ ] **Step 2: Commit**

```bash
git add docs/agents/CLAUDE-pm.md
git commit -m "feat(agents): add CLAUDE-pm.md context notes for PM agent"
````

---

## Task 9: Update `docs/agents/ba.md`

**Files:**

- Modify: `docs/agents/ba.md`

Three key changes:

- [ ] **Step 1: Replace "Шаг 3 — Делегировать Coder-агенту" with "Шаг 3 — Передать бриф PM"**

```markdown
### Шаг 3 — Написать бриф для PM и передать задачу

Создать `docs/specs/pm-brief.md` по шаблону:

\`\`\`markdown

# Бриф: <название фичи>

## Бизнес-контекст

<зачем это нужно, какую бизнес-проблему решает>

## Бизнес-правила

- <правило 1>
- <правило 2>

## RBAC

| Роль       | Доступ |
| ---------- | ------ |
| ADMIN      | ...    |
| SENIOR     | ...    |
| JUNIOR     | ...    |
| HR         | ...    |
| ACCOUNTANT | ...    |

## Известные коллизии

- <если найдены конфликты с существующей логикой>

## Acceptance criteria (высокий уровень)

- [ ] <критерий 1>

## Что НЕ входит в scope

- <ограничения>
  \`\`\`

Закоммитить бриф:
\`\`\`bash
git add docs/specs/pm-brief.md docs/business/
git commit -m "docs(ba): <краткое описание задачи>"
git push origin main
\`\`\`

Сообщить пользователю:
\`\`\`
✅ Бриф создан в docs/specs/pm-brief.md.
Передайте PM-агенту — он декомпозирует задачу и запустит разработчиков.
\`\`\`
```

- [ ] **Step 2: Remove "Шаг 4 — Дождаться и запустить AI Review" and "Шаг 5 — Приёмка"**

These steps are now done by the PM. Replace them with a single paragraph:

```markdown
### Шаг 4 — Дальнейший процесс (PM)

После передачи брифа — PM управляет всем процессом разработки:
декомпозиция → агенты → review → user testing → E2E → merge.

BA не участвует в этом процессе. При необходимости PM задаст вопросы
пользователю напрямую.
```

- [ ] **Step 3: Update "Сценарий 3: Эскалация от QA"**

```markdown
## Сценарий 3 — Эскалация (упразднён)

QA-агент упразднён. Эскалации теперь идут от разработчиков к PM через
`.blocked.md` файлы, PM задаёт вопросы пользователю напрямую.

BA не получает эскалации и не участвует в процессе разработки.
```

- [ ] **Step 4: Update "Границы роли"**

```markdown
## Границы роли

BA **изменяет только:**

- `docs/business/` — бизнес-документация
- `docs/specs/pm-brief.md` — бриф для PM

BA **никогда не трогает:**

- `docs/specs/active-task.md` — упразднён, PM использует `docs/specs/tasks/`
- `.github/workflows/` → DevOps-агент
- `apps/`, `packages/` → Coder-агент
- `apps/e2e/` → AutoTest-агент

BA **может использовать Playwright MCP для просмотра UI** при подготовке брифа:
\`\`\`
mcp__playwright__browser_navigate → просмотр localhost:3000
mcp__playwright__browser_take_screenshot → убедиться как выглядит фича
\`\`\`
Это помогает точнее описать что нужно изменить.
```

- [ ] **Step 5: Commit**

```bash
git add docs/agents/ba.md
git commit -m "feat(agents): update BA role — upstream consultant, outputs pm-brief.md"
```

---

## Task 10: Update `docs/agents/CLAUDE-ba.md`

**Files:**

- Modify: `docs/agents/CLAUDE-ba.md`

- [ ] **Step 1: Update the description of the escalation paths**

Find any mention of "эскалация от QA" and replace:

```markdown
## Эскалации

**BA не получает эскалации во время разработки.**

Все эскалации от разработчиков (Coder, AutoTest, DevOps) идут через
`.blocked.md` файлы → PM читает при пробуждении → задаёт вопрос
пользователю напрямую.

BA подключается только если пользователь решает обратиться за консультацией
по бизнес-логике — это его инициатива, не автоматическая эскалация.
```

- [ ] **Step 2: Update the task template**

Replace any mention of `active-task.md` with `pm-brief.md`:

```markdown
## Выход BA

BA пишет только `docs/specs/pm-brief.md` — высокоуровневый бриф.
Детализацию до конкретных задач делает PM.
```

- [ ] **Step 3: Commit**

```bash
git add docs/agents/CLAUDE-ba.md
git commit -m "docs(agents): update CLAUDE-ba — remove escalation paths, update output"
```

---

## Task 11: Update `docs/agents/coder.md`

**Files:**

- Modify: `docs/agents/coder.md`

- [ ] **Step 1: Update "Обязательное чтение"**

```markdown
## Обязательное чтение перед началом работы

1. `/.clauderules` — все правила разработки
2. `docs/agents/CLAUDE-coder.md` — команды, структура, статус
3. **Задача:** прочитать файл из параметра `task_file` (путь передаётся workflow)
4. `docs/business/modules/<модуль из задачи>.md` — бизнес-логика
5. `docs/business/user-flows.md` — user flows
```

- [ ] **Step 2: Add a skills section before "Workflow разработки"**

```markdown
## Superpowers Skills (использовать активно)

| Когда                                      | Skill                                        |
| ------------------------------------------ | -------------------------------------------- |
| Перед реализацией любой задачи             | `superpowers:test-driven-development`        |
| При любом баге или неожиданном поведении   | `superpowers:systematic-debugging`           |
| Перед созданием PR                         | `superpowers:verification-before-completion` |
| Для новых страниц / сложных UI компонентов | `frontend-design:frontend-design`            |
| После написания кода                       | `simplify`                                   |
| Перед PR с auth/finance/transactions       | `security-review`                            |
```

- [ ] **Step 3: Add the `.blocked.md` mechanism after "Workflow разработки"**

```markdown
## Блокер — неописанная бизнес-логика

Если в процессе реализации обнаружена логика которая не описана в
`docs/business/` и без неё невозможно принять архитектурное решение:

1. **НЕ угадывать и НЕ додумывать самостоятельно**
2. Создать файл `docs/specs/tasks/<имя_твоей_задачи>.blocked.md`:

\`\`\`markdown

# BLOCKER: <имя задачи>

## Агент: coder

## Задача: docs/specs/tasks/<имя_задачи>.md

## GHA Run ID: <текущий run id если знаешь>

## Проблема

<точное описание что неясно>

## Затронутый код

`<файл>:<строка>` — <что именно требует решения>

## Вопрос к PM / пользователю

<конкретный вопрос с вариантами ответа если возможно>

## Что сделано до блокера

- <список файлов с изменениями>
  \`\`\`

3. Закоммитить `.blocked.md` в ветку:
   \`\`\`bash
   git add docs/specs/tasks/<name>.blocked.md
   git commit -m "chore: block task — undocumented business logic found"
   git push origin <branch>
   \`\`\`

4. Завершить работу — PM прочитает блокер на следующем пробуждении.
```

- [ ] **Step 4: Update the MCP section**

```markdown
## MCP серверы (все доступны, использовать активно)

| Задача                           | MCP                                                                  |
| -------------------------------- | -------------------------------------------------------------------- |
| Найти функцию / класс / импорт   | `mcp__ast-grep__find_code`                                           |
| Рефакторинг — все вхождения      | `mcp__ast-grep__find_code_by_rule`                                   |
| Документация NestJS/TanStack/Zod | `mcp__context7__resolve-library-id` → `query-docs`                   |
| Проверить схему БД               | `mcp__postgres__query`                                               |
| Проверить ESLint до пуша         | `mcp__eslint__lint-files`                                            |
| Проверить UI после изменений     | `mcp__playwright__browser_navigate` + `browser_snapshot`             |
| PR / issues                      | `mcp__github__create_pull_request`, `mcp__github__add_issue_comment` |
```

- [ ] **Step 5: Update "Проверка качества" — remove E2E from pre-commit**

```markdown
### 2.8. Проверка качества перед коммитом

\`\`\`bash
pnpm typecheck && pnpm lint && pnpm test
\`\`\`

Полный E2E (Playwright) запускается отдельно через `e2e.yml` — PM запускает
его после User Testing. Не нужно запускать E2E локально перед коммитом.
```

- [ ] **Step 6: Commit**

```bash
git add docs/agents/coder.md
git commit -m "feat(agents): coder.md — add skills, blocker mechanism, all MCP, task_file"
```

---

## Task 12: Update `docs/agents/autotest.md`

**Files:**

- Modify: `docs/agents/autotest.md`

- [ ] **Step 1: Add a skills section**

```markdown
## Superpowers Skills

| Когда                   | Skill                                        |
| ----------------------- | -------------------------------------------- |
| Перед написанием тестов | `superpowers:test-driven-development`        |
| Тест падает неожиданно  | `superpowers:systematic-debugging`           |
| Перед пушем тестов      | `superpowers:verification-before-completion` |
```

- [ ] **Step 2: Add Mode 3 — PM task-driven**

```markdown
## Режим 3 — PM Task-Driven

Запускается когда PM передаёт `task_file` в workflow.

Прочитать task_file → понять какой модуль тестировать →
написать E2E тесты для описанных acceptance criteria →
закоммитить и запушить → создать PR с label `ai-review-ready`.
```

- [ ] **Step 3: Add the `.blocked.md` mechanism**

```markdown
## Блокер

Если тест не может быть написан из-за неописанной бизнес-логики:

\`\`\`bash

# Создать блокер рядом с задачей

cat > docs/specs/tasks/<task_name>.blocked.md << 'EOF'

# BLOCKER: <task_name>

## Агент: autotest

## Задача: docs/specs/tasks/<task_name>.md

## Проблема

<что неясно для написания тестов>

## Вопрос к PM / пользователю

<конкретный вопрос>
EOF

git add docs/specs/tasks/<task_name>.blocked.md
git commit -m "chore: block autotest — business logic unclear for test coverage"
git push origin <branch>
\`\`\`
```

- [ ] **Step 4: Update the MCP section**

```markdown
## MCP серверы

- `mcp__ast-grep__find_code` — найти существующие тест-паттерны
- `mcp__playwright__browser_navigate` + `browser_snapshot` — проверить UI для написания тестов
- `mcp__github__create_pull_request` + `mcp__github__add_issue_comment`
- `mcp__github__create_pull_request_review` — оставить review при логической ошибке
```

- [ ] **Step 5: Commit**

```bash
git add docs/agents/autotest.md
git commit -m "feat(agents): autotest.md — add skills, mode 3, blocker mechanism, all MCP"
```

---

## Task 13: Update `docs/agents/reviewer.md`

**Files:**

- Modify: `docs/agents/reviewer.md`

- [ ] **Step 1: Add a skills section**

```markdown
## Superpowers Skills

| Когда                                         | Skill                               |
| --------------------------------------------- | ----------------------------------- |
| Начало каждого review                         | `code-review:code-review`           |
| При получении review feedback (для понимания) | `superpowers:receiving-code-review` |
| PR трогает auth/finance/wallets/transactions  | `security-review`                   |
```

- [ ] **Step 2: Update the instruction after APPROVE — add the label**

Find the section where APPROVE is described and add:

```markdown
### После APPROVE

Помимо создания `autotest-approved.flag`, Reviewer автоматически получает
label `awaiting-pm-review` на PR (это делает ai-review.yml, не Reviewer сам).

PM проснётся, прочитает твои комментарии (даже suggestion-ы в APPROVE),
обновит документацию если нужно, организует User Testing.

**Поэтому:** даже при APPROVE — пиши содержательные комментарии если видишь
улучшения в бизнес-логике или архитектуре. PM их прочитает.
```

- [ ] **Step 3: Update the MCP section**

```markdown
## MCP серверы (все доступны)

- `mcp__ast-grep__find_code` + `mcp__ast-grep__find_code_by_rule` — структурный анализ
- `mcp__eslint__lint-files` — проверить lint
- `mcp__context7__resolve-library-id` + `query-docs` — документация API
- `mcp__github__get_pull_request` + `mcp__github__get_pull_request_files` — читать PR
- `mcp__github__create_pull_request_review` — APPROVE / REQUEST_CHANGES
- `mcp__github__add_issue_comment` — добавить комментарий
```

- [ ] **Step 4: Commit**

```bash
git add docs/agents/reviewer.md
git commit -m "feat(agents): reviewer.md — add skills, PM gate explanation, all MCP"
```

---

## Task 14: Update `docs/agents/devops.md`

**Files:**

- Modify: `docs/agents/devops.md`

- [ ] **Step 1: Update "Обязательное чтение"**

```markdown
## Обязательное чтение перед работой

1. **Задача:** прочитать файл из параметра `task_file` (путь передаётся workflow)
2. `/.clauderules` — раздел "DevOps & Environment"
3. `docs/agents/CLAUDE-devops.md` — архитектура пайплайна, secrets, concurrency
4. `.github/workflows/` — существующие CI workflows
```

- [ ] **Step 2: Add a skills section**

```markdown
## Superpowers Skills

| Когда                                  | Skill                                        |
| -------------------------------------- | -------------------------------------------- |
| Перед сложной задачей (новый workflow) | `superpowers:writing-plans`                  |
| Перед созданием PR                     | `superpowers:verification-before-completion` |
| Неожиданное поведение CI               | `superpowers:systematic-debugging`           |
```

- [ ] **Step 3: Add the `.blocked.md` mechanism**

```markdown
## Блокер

Если задача требует решения которое не описано в документации:

\`\`\`bash
cat > docs/specs/tasks/<task_name>.blocked.md << 'EOF'

# BLOCKER: <task_name>

## Агент: devops

## Задача: docs/specs/tasks/<task_name>.md

## Проблема

<что неясно для реализации инфраструктурной задачи>

## Вопрос к PM / пользователю

<конкретный вопрос>
EOF

git add docs/specs/tasks/<task_name>.blocked.md
git commit -m "chore: block devops — infrastructure decision needed"
git push origin <branch>
\`\`\`
```

- [ ] **Step 4: Update the MCP section**

```markdown
## MCP серверы

- `mcp__ast-grep__find_code` — найти паттерны в существующих workflows
- `mcp__context7__resolve-library-id` + `query-docs` — документация GHA actions
- `mcp__github__create_pull_request` + `mcp__github__add_issue_comment`
```

- [ ] **Step 5: Commit**

```bash
git add docs/agents/devops.md
git commit -m "feat(agents): devops.md — task_file, skills, blocker mechanism, all MCP"
```

---

## Task 15: Update `CLAUDE.md`

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the PM to the "Архитектура" or "Технологический стек" section**

Find the `## Архитектура` section and add:

```markdown
## Multi-Agent команда

| Агент                    | Роль                                                            | Где живёт           |
| ------------------------ | --------------------------------------------------------------- | ------------------- |
| **Master (Claude Code)** | Настройка инфраструктуры агентов                                | Локально            |
| **BA**                   | Бизнес-консультант, пишет `pm-brief.md`                         | Локально            |
| **PM**                   | Оркестратор: декомпозиция → диспетч → мониторинг → User Testing | Локально            |
| **Coder**                | Fullstack разработчик                                           | GHA (coder.yml)     |
| **AutoTest**             | E2E тест-разработчик                                            | GHA (autotest.yml)  |
| **DevOps**               | Инфраструктура CI/CD                                            | GHA (devops.yml)    |
| **Reviewer**             | Code review                                                     | GHA (ai-review.yml) |

**Pipeline:**
```

BA → pm-brief.md → PM → task-*.md → [параллельные GHA workflows] →
PR → ai-review.yml (AutoTest + Reviewer) → awaiting-pm-review →
PM (User Testing) → e2e.yml → squash merge

```

```

- [ ] **Step 2: Update "Активный контекст"**

```markdown
## Активный контекст

- PHASE 1–5 полностью реализованы и работают
- PHASE 7 (partial): Профили работают
- Multi-agent архитектура: PM-агент добавлен, параллельный диспетч через docs/specs/tasks/
- Следующий шаг: PHASE 6 — База знаний + Документы
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with PM agent and new multi-agent architecture"
```

---

## Task 16: Archive QA and the old spec files

**Files:**

- Archive: `docs/agents/qa.md`, `docs/agents/CLAUDE-qa.md`
- Archive: `docs/specs/active-task.md`, `docs/specs/active-devops-task.md`

- [ ] **Step 1: Create the archive directory and move QA**

```bash
mkdir -p docs/agents/archive
cp docs/agents/qa.md docs/agents/archive/qa.md
cp docs/agents/CLAUDE-qa.md docs/agents/archive/CLAUDE-qa.md
git rm docs/agents/qa.md docs/agents/CLAUDE-qa.md
```

- [ ] **Step 2: Archive the old spec files**

```bash
DATE=$(date +%Y-%m-%d)
mkdir -p docs/specs/archive

# active-task.md
if [ -f docs/specs/active-task.md ]; then
  cp docs/specs/active-task.md "docs/specs/archive/${DATE}-active-task.md"
  git rm docs/specs/active-task.md
fi

# active-devops-task.md
if [ -f docs/specs/active-devops-task.md ]; then
  cp docs/specs/active-devops-task.md "docs/specs/archive/${DATE}-active-devops-task.md"
  git rm docs/specs/active-devops-task.md
fi
```

- [ ] **Step 3: Commit**

```bash
git add docs/agents/archive/ docs/specs/archive/
git commit -m "chore: archive QA agent and legacy active-task.md specs"
```

---

## Task 17: Remove `ba-escalation.yml`

**Files:**

- Delete: `.github/workflows/ba-escalation.yml`

- [ ] **Step 1: Remove the file**

```bash
git rm .github/workflows/ba-escalation.yml
```

- [ ] **Step 2: Commit**

```bash
git commit -m "chore(ci): remove ba-escalation.yml — escalations now go PM → user directly"
```

---

## Task 18: Smoke test — verify the whole chain

- [ ] **Step 1: Verify that all the labels exist**

```bash
gh label list --repo yaremenko-maksym/CheekyCheeseIT_CRM | grep -E "awaiting-pm-review|pm-blocker|ai-review-ready"
```

Expected output: all three labels found.

- [ ] **Step 2: Verify that the workflows exist and are valid**

```bash
gh workflow list --repo yaremenko-maksym/CheekyCheeseIT_CRM
```

Expected output — the workflows present:

```
AI Review        active  ai-review.yml
AutoTest         active  autotest.yml
Coder            active  coder.yml
DevOps           active  devops.yml
E2E Tests        active  e2e.yml
```

`ba-escalation.yml` — absent.

- [ ] **Step 3: Verify the structure of docs/specs/tasks/**

```bash
ls docs/specs/tasks/
ls docs/specs/tasks/archive/
```

Expected output: `.gitkeep` in each directory.

- [ ] **Step 4: Verify that pm.md and CLAUDE-pm.md are created**

```bash
ls docs/agents/pm.md docs/agents/CLAUDE-pm.md
ls docs/agents/archive/qa.md docs/agents/archive/CLAUDE-qa.md
```

- [ ] **Step 5: Dry run coder.yml with the task_file parameter**

```bash
# Создать тестовый task файл
echo "# test-task
## Агент: coder
## Приоритет: low
## Контекст: smoke test" > docs/specs/tasks/task-smoke-test.md

# Проверить что workflow принимает параметр (dry run — не запускать реально)
gh workflow view coder.yml --repo yaremenko-maksym/CheekyCheeseIT_CRM
```

Expected output: the workflow is shown with the inputs `task_file` and `task_hint`.

```bash
# Удалить тестовый файл
rm docs/specs/tasks/task-smoke-test.md
```

- [ ] **Step 6: Final commit**

```bash
git status  # убедиться что нет незакоммиченных изменений
git log --oneline -20  # просмотреть все коммиты этой имплементации
```

---

## Self-Review

**Spec coverage:**

- ✅ PM agent: Tasks 7-8 (pm.md + CLAUDE-pm.md)
- ✅ Parallel dispatch: Tasks 3-4 (task_file param + concurrency)
- ✅ E2E gate: Task 2 (e2e.yml)
- ✅ User Testing stage: Task 7 (Mode 4 in pm.md)
- ✅ Blocker mechanism: Tasks 11-14 (all agents)
- ✅ BA simplification: Tasks 9-10
- ✅ ai-review without merge: Task 6
- ✅ awaiting-pm-review label: Tasks 1 + 6
- ✅ QA archive: Task 16
- ✅ ba-escalation removed: Task 17
- ✅ All the MCP: Tasks 3,4,5,11,12,13,14
- ✅ Superpowers skills: Tasks 11,12,13,14
- ✅ CLAUDE.md updated: Task 15

**No placeholders, no TBD, no "implement later".**

**Type consistency:**

- the `task_file` parameter is used the same way in coder.yml, devops.yml, autotest.yml (Tasks 3,4,5)
- concurrency key: `coder-${{ inputs.task_file }}` / `devops-${{ inputs.task_file }}` — the same pattern
- the `.blocked.md` format — the same across all agent prompts (Tasks 11,12,14)
- label `awaiting-pm-review` — created in Task 1, used in Task 6, read by the PM in Task 7
