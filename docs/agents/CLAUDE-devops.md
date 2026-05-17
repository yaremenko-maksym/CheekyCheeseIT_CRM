# DevOps — Agent Notes

## Воркфлоу пайплайна

```
.github/workflows/
  ai-review.yml    # PR Review: Reviewer → AutoTest → Merge
  autotest.yml     # Docs → Tests: обновляет E2E при изменении docs/business/
  coder.yml        # Реализует задачу из docs/specs/active-task.md
  devops.yml       # Реализует задачу из docs/specs/active-devops-task.md
  ba-escalation.yml # Эскалация от QA к BA
  ci.yml           # CI: quality (lint, typecheck, unit) + E2E — теперь с workflow_dispatch
```

## claude-code-action@beta — критичные правила

- Надійний тригер: ТІЛЬКИ `workflow_dispatch`. `pull_request` з типами `ready_for_review` або `labeled` дає "No trigger found, skipping" — Claude не запускається
- `mode: agent` обов'язковий для `workflow_dispatch`
- `github_token: ${{ github.token }}` обов'язковий на всіх Claude кроках
- `allowed_bots: '*'` потрібен щоб бот-PR'и теж тригерили ревью
- **workflow_dispatch inputs: тільки `string`, `boolean`, `choice`, `environment`** — `type: number` є невалідним і GitHub не реєструє dispatch тригер (HTTP 422 на `gh workflow run`)

## GitHub Secrets (обязательные)

- `CLAUDE_CODE_OAUTH_TOKEN` — OAuth токен для claude-code-action

## Branch Protection (main)

- Требует PR для merge
- Required checks: только "Typecheck · Lint · Unit Tests" (ci.yml job)
- Required reviews: УБРАНЫ (AI Review pipeline является review)
- `strict: false` — PR не обязан быть актуальным с main перед merge
- Прямой push в main: разрешён только для bootstrap (CI pipeline fixes)

## Concurrency паттерн

```yaml
concurrency:
  group: <workflow>-${{ github.event.pull_request.number || inputs.pr_number }}-${{ github.event_name }}
  cancel-in-progress: true
```
`${{ github.event_name }}` — обязателен, чтобы `workflow_dispatch` и `pull_request` не отменяли друг друга.

## ai-review.yml — архитектура jobs (актуально)

```
autotest      → пишет E2E тесты ДО ревью; при logic error → BA escalation + trigger_coder
reviewer      → runs if autotest succeeded; Check E2E health (блокирует если e2e-broken)
              → outputs: approved, review_state
merge         → squash merge if reviewer approved; triggers ci.yml and polls only Quality check
               → НЕ ждёт E2E Tests (нет такого job'а в ci.yml пока)
trigger_coder → runs if autotest failed OR reviewer == CHANGES_REQUESTED
               → git fetch/checkout PR branch, пишет active-task.md, push в PR ветку
               → gh workflow run coder.yml
```

## Флаги между jobs

- `autotest-logic-error.flag` — AutoTest создаёт при логической ошибке → autotest.result = failure
- `autotest-approved.flag` — Reviewer создаёт при APPROVE → разрешает merge
- Флаги создаются через Write tool в Claude шагах

## trigger_coder — critical rule

**Нельзя пушить в main из GITHUB_TOKEN** — branch protection блокирует.
Решение: trigger_coder checkout'ит без `ref` (детачится на HEAD), затем `git fetch origin "${BRANCH}" && git checkout "${BRANCH}"`, пишет `docs/specs/active-task.md`, пушит в `${BRANCH}` (PR ветку).
Coder workflow читает active-task.md из PR ветки.

## merge job — только Quality check, не E2E

`ci.yml` имеет только один job: `Typecheck · Lint · Unit Tests`.
Merge job ждёт только его. Когда добавят E2E job в ci.yml — добавить проверку сюда.

## E2E на main — правило "красного флага"

**Когда E2E падают на `push` в main:**
1. `ci.yml notify_e2e` job автоматически создаёт GitHub issue с меткой `e2e-broken`
2. `ai-review.yml reviewer` job проверяет наличие этого issue — блокирует новые PR review
3. Coder агент проверяет issue в шаге 0 — не начинает новые задачи

**Разрешено пока E2E сломаны:**
- PR с фиксом E2E тестов (AI Review не блокирует их — только "новые задачи")

**Восстановление:**
- После merge PR с фиксом → E2E проходят на main → `notify_e2e` закрывает issue автоматически
- Команда видит закрытый issue → возобновляет работу

## Docker (локальная разработка)

```yaml
# docker-compose.yml
services:
  postgres: image postgres:16-alpine, port 5432
  redis: image redis:7-alpine, port 6379
```
`docker-compose up -d` для запуска.

## CI environment variables

```
NODE_ENV=test
DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_db
REDIS_URL=redis://localhost:6379
API_PORT=3001
JWT_SECRET=ci-jwt-secret-at-least-32-chars-long
SESSION_SECRET=ci-session-secret-32-chars-minimum-x
FRONTEND_URL=http://localhost:3000
VITE_API_URL=http://localhost:3001/api
```

## КРИТИЧНО: Workflow файлы требуют особых прав

`GITHUB_TOKEN` (Actions) НЕ имеет `workflows` scope — пуш в `.github/workflows/` будет отклонён:
```
refusing to allow a GitHub App to create or update workflow without `workflows` permission
```

**Если задача затрагивает `.github/workflows/`:**
- Сообщи об ограничении в PR description
- DevOps задачи с workflow файлами применяются вручную (bootstrap) владельцем репо

## CI — бот-коміти не тригерять workflow

**Проблема:** GitHub Actions pushes (через `GITHUB_TOKEN`) НЕ тригерять нові workflow runs (анти-loop захист GitHub).
Коли AutoTest/Coder пушають коміти в PR гілку — CI (`pull_request: synchronize`) НЕ запускається.
Результат: `statusCheckRollup: []` → `mergeStateStatus: BLOCKED` при спробі merge.

**Ознаки:**
- `gh pr view N --json statusCheckRollup` повертає `[]`
- `mergeStateStatus: "BLOCKED"` але `mergeable: "MERGEABLE"`
- CI runs для гілки є, але для старих комітів — нові bot-коміти без CI

**Рішення:**
1. `gh workflow run ci.yml --ref <branch>` — ci.yml тепер має `workflow_dispatch`
2. Або пушити порожній коміт від реального юзера: `git commit --allow-empty && git push`

## Критичні правила для reviewer/autotest jobs (workflow_dispatch)

**Проблема:** `actions/checkout@v4` без `ref:` при `workflow_dispatch` checkout-ить main, не PR ветку.
**Рішення:** Обидва jobs (reviewer, autotest) починають з кроку "Get PR head ref":

```yaml
- name: Get PR head SHA
  id: pr_head
  env:
    GH_TOKEN: ${{ github.token }}
  run: |
    if [ -n "${{ github.event.pull_request.head.sha }}" ]; then
      echo "sha=${{ github.event.pull_request.head.sha }}" >> $GITHUB_OUTPUT
    else
      SHA=$(gh pr view "${{ inputs.pr_number }}" \
        --repo ${{ github.repository }} \
        --json headRefOid --jq '.headRefOid')
      echo "sha=${SHA}" >> $GITHUB_OUTPUT
    fi
- uses: actions/checkout@v4
  with:
    ref: ${{ steps.pr_head.outputs.sha }}
    fetch-depth: 0
```

Для reviewer: `headRefOid` (checkout by SHA для read-only review).
Для autotest: `headRefName` (checkout by branch name — потрібен щоб пушати коміти назад).

**КРИТИЧНО:** `headRefSha` — НЕ існує в `gh pr view --json`. Використовувати `headRefOid`.

## Merge job — правила

- **НЕ використовувати `gh pr update-branch`** — створює новий коміт, інвалідує CI перевірку
- Dismiss CHANGES_REQUESTED reviews перед merge
- `strict: false` в branch protection — PR не зобов'язаний бути актуальним з main
- Required review НЕ потрібен (прибраний з branch protection — AI Review pipeline є review)
- Required CI check: тільки "Typecheck · Lint · Unit Tests"

## github-actions[bot] — обмеження на reviews

- Bot з CHANGES_REQUESTED не може APPROVE ту ж PR без попереднього dismiss
- **Рішення:** крок "Dismiss stale CHANGES_REQUESTED reviews" перед Claude Code Review
- `dismiss_stale_reviews` в branch protection має бути відключений (або прибрати required reviews)
  - Якщо увімкнено: AutoTest пушає коміти → GitHub авто-dismiss-ить APPROVE reviewer'а → merge блокується

## Git workflow DevOps агента

```bash
git checkout -b infra/<slug>
# вносить изменения
git add <конкретные файлы>  # НЕ git add .
git commit -m "chore(ci): ..."
# push + создать PR через mcp__github__create_pull_request
# добавить label ai-review-ready
# ВНИМАНИЕ: если меняешь .github/workflows/ — push будет отклонён (см. выше)
```
