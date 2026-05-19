# task-infra-branch-protection

## Агент: devops
## Приоритет: high
## Ветка: infra/branch-protection
## НЕ создавать новую ветку — продолжать работу в существующей: `infra/branch-protection`
## PR: #16 (уже открыт, добавить изменения в него)

## Контекст

DevOps-агент уже создал scripts/*.sh для branch protection в PR #16.
Скрипты правильные — но branch protection так и не применён (скрипт не запускался).
Параллельно нужно реализовать рефактор GHA пайплайна из аудита архитектуры.

Всё идёт в одну ветку `infra/branch-protection` и один PR #16.

## Что уже сделано (НЕ трогать)

- `scripts/setup-branch-protection.sh` — скрипт настройки protection
- `scripts/apply-branch-protection.sh`
- `scripts/update-branch-protection.sh`
- `scripts/README-branch-protection.md`

---

## Конкретные изменения

### 1. Применить branch protection через ADMIN_PAT (ПРЯМО СЕЙЧАС в bash)

Не создавать новые скрипты. Применить защиту напрямую — ADMIN_PAT доступен как `$ADMIN_PAT` в env:

```bash
gh api \
  --method PUT \
  --header "Authorization: token $ADMIN_PAT" \
  repos/yaremenko-maksym/CheekyCheeseIT_CRM/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "Typecheck · Lint · Unit Tests" },
      { "context": "CI / AutoTest" },
      { "context": "AI Code Review" }
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
EOF
```

Проверить что применилось:
```bash
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/branches/main/protection \
  --header "Authorization: token $ADMIN_PAT" \
  --jq '{
    checks: [.required_status_checks.checks[].context],
    reviews: .required_pull_request_reviews.required_approving_review_count,
    codeowners: .required_pull_request_reviews.require_code_owner_reviews,
    dismiss_stale: .required_pull_request_reviews.dismiss_stale_reviews
  }'
```

`enforce_admins: false` — иначе PM-агент не сможет мержить через `gh pr merge`.

### 2. `.github/CODEOWNERS`

Создать файл:

```
# All files — yaremenko-maksym обязательный ревьюер для любого PR
* @yaremenko-maksym
```

### 3. `.github/workflows/ai-review.yml` — synchronize trigger + защита от рекурсии

**Изменить** секцию `on:` (добавить `synchronize`):

```yaml
on:
  pull_request:
    types: [ready_for_review, synchronize]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to review (e.g. 8)'
        required: true
        type: string
```

**Изменить** условие `if:` у job `autotest` — добавить проверку `github.actor`:

```yaml
  autotest:
    if: |
      github.actor != 'github-actions[bot]' &&
      github.event.pull_request.draft == false &&
      (
        github.event_name == 'workflow_dispatch' ||
        contains(github.event.pull_request.labels.*.name, 'ai-review-ready')
      )
```

Это блокирует рекурсию: AutoTest пушит тесты → `synchronize` → ai-review видит
`github.actor == 'github-actions[bot]'` → пропускает.

То же условие добавить в job `reviewer` (сейчас там нет проверки actor):
```yaml
  reviewer:
    if: |
      always() &&
      github.actor != 'github-actions[bot]' &&
      needs.autotest.result == 'success' &&
      ...
```

### 4. `.github/workflows/ai-review.yml` — Check Runs вместо PR-комментария

**Удалить** все шаги которые постят/обновляют комментарий с маркером
`<!-- ai-review-pipeline-status -->`:
- "Post pipeline status — AutoTest running"
- "Update pipeline status — AutoTest result"
- "Update pipeline status — Code Review running"
- "Update pipeline status — Code Review result"
- "Update pipeline status — Coder triggered"

**Добавить** GitHub Check Runs. В каждый job вставить два шага — создать в начале и обновить в конце:

```yaml
      - name: Create Check Run — in_progress
        id: check_run
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          PR="${{ github.event.pull_request.number || inputs.pr_number }}"
          REPO="${{ github.repository }}"
          HEAD_SHA=$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq '.headRefOid')
          CHECK_ID=$(gh api "repos/$REPO/check-runs" \
            --method POST \
            -f name="CI / AutoTest" \
            -f head_sha="$HEAD_SHA" \
            -f status="in_progress" \
            --jq '.id')
          echo "check_id=$CHECK_ID" >> $GITHUB_OUTPUT

      # ... (шаги AutoTest агента) ...

      - name: Update Check Run — result
        if: always()
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          CONCLUSION="success"
          if [ -f autotest-logic-error.flag ]; then CONCLUSION="failure"; fi
          gh api "repos/${{ github.repository }}/check-runs/${{ steps.check_run.outputs.check_id }}" \
            --method PATCH \
            -f status="completed" \
            -f conclusion="$CONCLUSION"
```

Для job `reviewer`: Check Run name = `"AI Code Review"`, conclusion = success если `autotest-approved.flag` существует, иначе failure.

### 5. `.github/workflows/ai-review.yml` — Reviewer читает acceptance criteria

**Обновить** `direct_prompt` в job `reviewer` — добавить ПОСЛЕ строки про CLAUDE-reviewer.md:

```
            Прочитай описание PR через mcp__github__get_pull_request.
            Найди в поле body ссылку на task-файл (формат: docs/specs/tasks/task-*.md).
            Прочитай task-файл — раздел "Acceptance criteria".
            Для каждого AC пункта явно укажи в review: ✅ реализован / ❌ не реализован.
            AC которые отсутствуют в коде → обязательно REQUEST_CHANGES.
```

### 6. `.github/workflows/coder.yml`, `devops.yml`, `autotest.yml` — валидация task-файла

В каждый из трёх файлов добавить шаг **сразу после `actions/checkout@v4`**, до любых других шагов:

```yaml
      - name: Verify task file exists
        if: inputs.task_file != ''
        run: |
          if [ ! -f "${{ inputs.task_file }}" ]; then
            echo "::error::Task file '${{ inputs.task_file }}' not found in repo HEAD"
            echo "::error::PM must commit and push the task file before running the workflow"
            exit 1
          fi
          echo "Task file verified: ${{ inputs.task_file }}"
```

### 7. `docs/agents/CLAUDE-reviewer.md` — inline-комментарии

Добавить секцию в конец файла:

```markdown
## Inline-комментарии (ОБЯЗАТЕЛЬНО при REQUEST_CHANGES)

При вызове `mcp__github__create_pull_request_review` с event: "REQUEST_CHANGES"
обязательно передавать параметр `comments` — массив объектов для каждой проблемы:

```json
{
  "path": "apps/web/app/routes/crm/team/$teamId.tsx",
  "position": 42,
  "body": "Описание проблемы и конкретная рекомендация"
}
```

- `path`: относительный путь от корня репо (без leading slash)
- `position`: позиция в unified diff (не номер строки файла)
- `body`: конкретная проблема + что исправить

Каждая проблема из review body дублируется как inline-комментарий к нужной строке.
```

---

## Порядок выполнения

1. Применить branch protection (пункт 1) — это bash-команда, не коммит
2. Создать `.github/CODEOWNERS` (пункт 2)
3. Обновить `.github/workflows/ai-review.yml` (пункты 3, 4, 5)
4. Обновить `.github/workflows/coder.yml`, `devops.yml`, `autotest.yml` (пункт 6)
5. Обновить `docs/agents/CLAUDE-reviewer.md` (пункт 7)
6. Закоммитить все файлы конкретными именами
7. Запушить в `infra/branch-protection`
8. PR #16 уже открыт — НЕ создавать новый PR, просто обновить описание если нужно

---

## Acceptance criteria

- [ ] Branch protection main применён: `gh api .../branches/main/protection` возвращает все 3 required checks
- [ ] `require_code_owner_reviews: true`, `dismiss_stale_reviews: true`
- [ ] `.github/CODEOWNERS` существует, содержит `* @yaremenko-maksym`
- [ ] `ai-review.yml` триггерится при `synchronize` событии
- [ ] При пуше от `github-actions[bot]` ai-review НЕ запускается (нет рекурсии)
- [ ] `ai-review.yml` не содержит шагов с маркером `ai-review-pipeline-status`
- [ ] В PR видны Check Runs "CI / AutoTest" и "AI Code Review" (вкладка Checks)
- [ ] Reviewer в `direct_prompt` получает инструкцию читать task-файл и проверять AC
- [ ] `coder.yml`, `devops.yml`, `autotest.yml` содержат шаг "Verify task file exists"
- [ ] `CLAUDE-reviewer.md` содержит секцию об inline-комментариях

## Запрещено трогать

- `apps/`, `packages/` — только разработчики
- `docs/specs/` — только PM
- `docs/agents/coder.md`, `autotest.md`, `pm.md` — уже обновлены, не трогать
- Существующие scripts/*.sh — уже в PR, оставить как есть
- Логику job-ов autotest/reviewer/trigger_coder — только инфраструктурные обёртки
