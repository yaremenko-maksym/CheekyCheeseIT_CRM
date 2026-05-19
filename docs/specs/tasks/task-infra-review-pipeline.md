# task-infra-review-pipeline

## Агент: devops
## Приоритет: high
## Ветка: infra/review-pipeline

## Контекст

Переработать AI Review пайплайн: убрать comment-статус из PR, заменить на GitHub Check Runs для
каждого job-а, перевести Reviewer агента на inline-комментарии прямо к строкам кода. Настроить
branch protection с обязательными проверками и авто-добавлением пользователя как ревьюера.

Текущий ai-review.yml постит и обновляет один PR-комментарий с таблицей статусов
(маркер `<!-- ai-review-pipeline-status -->`). Это нужно заменить на GitHub Check Runs.
Reviewer уже использует `mcp__github__create_pull_request_review`, но без inline-комментариев.

---

## Конкретные изменения

### 1. `.github/workflows/ai-review.yml` — Check Runs вместо комментария

**Убрать** все step-ы, которые постят/обновляют комментарий `<!-- ai-review-pipeline-status -->`:
- "Post pipeline status — AutoTest running"
- "Update pipeline status — AutoTest result"
- "Update pipeline status — Code Review running"
- "Update pipeline status — Code Review result"
- "Update pipeline status — Coder triggered"

**Добавить** GitHub Check Runs вместо них. Каждый job создаёт Check Run в начале (`in_progress`)
и обновляет в конце (`success`/`failure`):

```
Job autotest → Check Run name: "CI / AutoTest"
Job reviewer → Check Run name: "AI Code Review"
```

Для создания/обновления Check Run — GitHub Checks API:

```bash
# Начало job-а (создать check run in_progress):
HEAD_SHA=$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)
CHECK_ID=$(gh api "repos/$REPO/check-runs" \
  --method POST \
  -f name="CI / AutoTest" \
  -f head_sha="$HEAD_SHA" \
  -f status="in_progress" \
  --jq '.id')
echo "$CHECK_ID" > /tmp/check_id.txt

# Конец job-а (обновить):
CONCLUSION="success"  # или "failure"
gh api "repos/$REPO/check-runs/$(cat /tmp/check_id.txt)" \
  --method PATCH \
  -f status="completed" \
  -f conclusion="$CONCLUSION"
```

Check Run "CI / AutoTest":
- `in_progress` — когда AutoTest Agent запускается
- `success` — когда завершился без ошибок
- `failure` — если нашёл логическую ошибку (файл `autotest-logic-error.flag`)

Check Run "AI Code Review":
- `in_progress` — когда Reviewer Agent запускается
- `success` — если Reviewer вернул APPROVE (файл `autotest-approved.flag`)
- `failure` — если Reviewer вернул REQUEST_CHANGES

**Добавить** триггер `synchronize` к pull_request event-у (чтобы при push в PR всё перезапускалось):

```yaml
on:
  pull_request:
    types: [ready_for_review, synchronize]
  workflow_dispatch:
    inputs:
      pr_number: ...
```

### 2. `docs/agents/CLAUDE-reviewer.md` — Inline комментарии

Обновить инструкции Reviewer-агента: при вызове `mcp__github__create_pull_request_review`
обязательно передавать массив `comments` с inline-комментариями к конкретным строкам файлов.

Добавить в CLAUDE-reviewer.md секцию:

```
## Inline-комментарии (ОБЯЗАТЕЛЬНО)

При каждом вызове create_pull_request_review передавай параметр `comments` —
массив объектов для каждой найденной проблемы:

{
  "path": "apps/web/app/routes/crm/team/$teamId.tsx",
  "line": 42,
  "body": "Описание проблемы и рекомендация"
}

Требования:
- path: относительный путь от корня репо (без leading slash)
- line: номер строки в файле (из diff — используй новую версию файла)
- body: конкретное описание + что нужно исправить

Каждая проблема из review body должна быть продублирована как inline-комментарий
к соответствующей строке кода. Общий review body содержит summary всех проблем,
inline-комментарии крепятся к конкретным местам в коде.

НЕ использовать gh pr comment для posting результатов — только create_pull_request_review.
```

### 3. `.github/CODEOWNERS`

Создать файл в корне `.github/`:

```
# All files require review from yaremenko-maksym
* @yaremenko-maksym
```

Это автоматически добавляет @yaremenko-maksym как обязательного ревьюера при открытии любого PR.

### 4. Branch protection для `main`

Обновить через GitHub API используя `ADMIN_PAT` (secret уже есть в репо):

```bash
curl -X PUT \
  -H "Authorization: token $ADMIN_PAT" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/yaremenko-maksym/CheekyCheeseIT_CRM/branches/main/protection" \
  -d '{
    "required_status_checks": {
      "strict": true,
      "contexts": [
        "CI / Typecheck · Lint · Unit Tests",
        "CI / E2E Tests",
        "CI / AutoTest",
        "AI Code Review"
      ]
    },
    "required_pull_request_reviews": {
      "required_approving_review_count": 1,
      "dismiss_stale_reviews": true,
      "require_code_owner_reviews": true
    },
    "enforce_admins": false,
    "restrictions": null
  }'
```

`dismiss_stale_reviews: true` — при push новых коммитов апрув yaremenko-maksym сбрасывается.
Check Runs автоматически привязаны к SHA коммита — для нового коммита нужны новые.

---

## Acceptance criteria

- [ ] В PR нет comment-таблицы `<!-- ai-review-pipeline-status -->`
- [ ] В PR видны Check Runs: "CI / AutoTest" и "AI Code Review" с индикаторами (⏳/✅/❌) во вкладке Checks
- [ ] Reviewer агент постит review с inline-комментариями прямо к строкам кода (вкладка Files changed)
- [ ] При открытии PR — @yaremenko-maksym автоматически добавлен как requested reviewer
- [ ] Branch protection main: обязательные checks = CI/Typecheck+Lint+Unit Tests, CI/E2E Tests, CI/AutoTest, AI Code Review
- [ ] Branch protection main: required reviews = 1 от code owner, dismiss stale reviews on push
- [ ] При push нового коммита в ветку PR — апрув yaremenko-maksym сбрасывается, ci-review перезапускается

## Запрещено трогать

- `apps/`, `packages/` — только разработчики
- `docs/specs/` — только PM
- Не ломать trigger `workflow_dispatch` (PM тригерит вручную)
- Не менять логику job-ов autotest/reviewer/trigger_coder — только обёртки Check Runs и комментарии
