# task-infra-review-pipeline

## Агент: devops
## Приоритет: high
## Ветка: infra/review-pipeline

## Контекст

Комплексный рефактор GHA пайплайна по результатам аудита архитектуры и ретроспективы
Teams UI Redesign. Семь конкретных изменений в workflow и agent-notes файлах.

Ключевые проблемы которые решает этот PR:
- ai-review не перезапускается автоматически когда Coder пушит фикс (PM делал вручную)
- Нет валидации task-файла → агент стартует без задачи и галлюцинирует
- Reviewer не знает что было в спеке → не может проверить acceptance criteria
- Comment-таблица статусов захламляет PR → заменить на GitHub Check Runs
- Нет branch protection → прямые пуши в main возможны

Текущий ai-review.yml постит и обновляет один PR-комментарий с таблицей статусов
(маркер `<!-- ai-review-pipeline-status -->`). Это нужно заменить на GitHub Check Runs.
Reviewer уже использует `mcp__github__create_pull_request_review`, но без inline-комментариев.

---

## Конкретные изменения

### 1. `.github/workflows/ai-review.yml` — synchronize trigger + защита от рекурсии

**Добавить** тип `synchronize` к pull_request триггеру — чтобы ai-review перезапускался
автоматически когда Coder пушит фикс в ветку PR:

```yaml
on:
  pull_request:
    types: [ready_for_review, synchronize]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to review'
        required: true
        type: string
```

**Добавить** защиту от рекурсии в условие `if:` каждого job (autotest, reviewer, trigger_coder):

```yaml
jobs:
  autotest:
    if: |
      github.actor != 'github-actions[bot]' &&
      github.event.pull_request.draft == false &&
      (
        github.event_name == 'workflow_dispatch' ||
        contains(github.event.pull_request.labels.*.name, 'ai-review-ready')
      )
```

Когда AutoTest пушит тесты в ветку PR — это `synchronize` от `github-actions[bot]`.
Условие `github.actor != 'github-actions[bot]'` обрывает рекурсию.

### 2. `.github/workflows/coder.yml`, `devops.yml`, `autotest.yml` — валидация task-файла

**Добавить** шаг сразу после `actions/checkout@v4` во все три workflow:

```yaml
      - name: Verify task file exists
        if: inputs.task_file != ''
        run: |
          if [ ! -f "${{ inputs.task_file }}" ]; then
            echo "::error::Task file '${{ inputs.task_file }}' not found in repository HEAD"
            echo "::error::PM must commit and push the task file before running the workflow"
            exit 1
          fi
          echo "✅ Task file verified: ${{ inputs.task_file }}"
```

Этот шаг должен идти **до** Setup branch и **до** pnpm install — fail fast.

### 3. `.github/workflows/ai-review.yml` — Reviewer читает task-файл

**Обновить** `direct_prompt` Reviewer (job `reviewer`), добавить после чтения docs/agents:

```yaml
          direct_prompt: |
            Ты — Reviewer-агент для CRM Cheeky Cheese IT.

            Прочитай docs/agents/reviewer.md — полный системный промпт и чек-лист.
            Прочитай docs/agents/CLAUDE-reviewer.md — архитектурные решения и ограничения.

            ВАЖНО: Прочитай описание PR через mcp__github__get_pull_request.
            Найди в описании ссылку на task-файл (формат: docs/specs/tasks/task-*.md).
            Прочитай task-файл — раздел "Acceptance criteria".
            Для каждого AC пункта проверь: реализован ли он в diff этого PR.
            AC которые не реализованы → обязательно указать в REQUEST_CHANGES.

            ...остальной промпт без изменений...
```

### 4. `.github/workflows/ai-review.yml` — Check Runs вместо комментария

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

### 5. `docs/agents/CLAUDE-reviewer.md` — Inline комментарии

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

### 6. `.github/CODEOWNERS` (уже описан выше, пункт 3 — оставить без изменений)

### 7. Branch protection для `main`

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

### Synchronize trigger (изменение 1)
- [ ] При пуше Coder в ветку существующего PR — ai-review.yml перезапускается автоматически
- [ ] При пуше от `github-actions[bot]` — ai-review.yml НЕ запускается (нет рекурсии)
- [ ] `workflow_dispatch` по-прежнему работает для ручного запуска PM-ом

### Task file validation (изменение 2)
- [ ] `gh workflow run coder.yml -f task_file="docs/specs/tasks/nonexistent.md"` → job падает с понятной ошибкой сразу после checkout
- [ ] При корректном task_file — шаг проходит и workflow продолжается

### Reviewer читает AC (изменение 3)
- [ ] В review-комментарии Reviewer есть секция "Acceptance criteria проверены" с отметками ✅/❌ по каждому пункту из task-файла

### Check Runs (изменение 4)
- [ ] В PR нет comment-таблицы `<!-- ai-review-pipeline-status -->`
- [ ] Во вкладке Checks видны "CI / AutoTest" и "AI Code Review" с корректными статусами
- [ ] При провале AutoTest — Check Run "CI / AutoTest" показывает failure

### Inline комментарии Reviewer (изменение 5)
- [ ] Во вкладке Files changed видны inline-комментарии Reviewer к конкретным строкам кода

### CODEOWNERS (изменение 6)
- [ ] При открытии любого PR — @yaremenko-maksym автоматически добавлен как requested reviewer

### Branch protection (изменение 7)
- [ ] Прямой пуш в main заблокирован
- [ ] Обязательные checks: CI/Typecheck+Lint+Unit Tests, CI/AutoTest, AI Code Review
- [ ] Required reviews = 1, dismiss stale reviews при новом пуше

## Запрещено трогать

- `apps/`, `packages/` — только разработчики
- `docs/specs/` — только PM
- `docs/agents/*.md` — уже обновлены PM, не трогать
- Не ломать trigger `workflow_dispatch` — PM тригерит вручную
- Не менять бизнес-логику job-ов autotest/reviewer/trigger_coder — только инфраструктурные обёртки
