# DevOps — Agent Notes

## Воркфлоу пайплайна

```
.github/workflows/
  ai-review.yml    # PR Review: Reviewer → QA (если нужно) → AutoTest → Merge
  autotest.yml     # Docs → Tests: обновляет E2E при изменении docs/business/
  coder.yml        # Реализует задачу из docs/specs/active-task.md
  devops.yml       # Реализует задачу из docs/specs/active-devops-task.md
  ba-escalation.yml # Эскалация от QA к BA
  ci.yml           # Обычный CI (lint, typecheck, test)
```

## claude-code-action@beta — критичные правила

- Поддерживает ТОЛЬКО `workflow_dispatch` и `pull_request` события (`push` → ошибка)
- `mode: agent` обязателен для `workflow_dispatch` (иначе "Tag mode cannot handle workflow_dispatch")
- `github_token: ${{ github.token }}` обязателен на всех Claude шагах
- `allowed_bots: '*'` нужен чтобы бот-PR'ы тоже триггерили ревью

## GitHub Secrets (обязательные)

- `CLAUDE_CODE_OAUTH_TOKEN` — OAuth токен для claude-code-action

## Branch Protection (main)

- Требует PR для merge
- Required checks: 4 status checks
- Прямой push в main: разрешён только для bootstrap (CI pipeline fixes)

## Concurrency паттерн

```yaml
concurrency:
  group: <workflow>-${{ github.event.pull_request.number || inputs.pr_number }}-${{ github.event_name }}
  cancel-in-progress: true
```
`${{ github.event_name }}` — обязателен, чтобы `workflow_dispatch` и `pull_request` не отменяли друг друга.

## ai-review.yml — архитектура jobs

```
reviewer → (creates autotest-approved.flag if APPROVE)
         → (creates qa-task.md if QA needed)
qa       → runs if qa-task.md exists
         → (creates qa-autotest-approved.flag if APPROVE)
autotest → runs if reviewer + qa approved
merge    → squash merge если autotest succeeded
```

## Флаги между jobs

- `autotest-approved.flag` — reviewer создаёт при APPROVE → запускает autotest
- `qa-autotest-approved.flag` — QA создаёт при APPROVE → разрешает autotest
- Флаги создаются через Write tool в Claude шагах

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

## Git workflow DevOps агента

```bash
git checkout -b infra/<slug>
# вносить изменения
git add <конкретные файлы>  # НЕ git add .
git commit -m "chore(ci): ..."
# push + создать PR через mcp__github__create_pull_request
# добавить label ai-review-ready
```
