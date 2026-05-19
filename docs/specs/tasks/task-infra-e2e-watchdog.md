# task-infra-e2e-watchdog

## Агент: devops
## Приоритет: high
## Ветка: infra/e2e-watchdog

## Контекст

Когда E2E тесты падают на main — команда должна получать автоматическую реакцию.
Сейчас `notify_e2e` в `ci.yml` создаёт GitHub issue с лейблом `e2e-broken` — это хорошо.
Но дальше никто не реагирует: ни AutoTest не запускается, ни уведомление в чат не идёт.

Нужно добавить автоматический диспетч AutoTest при E2E failure на main.

## Решение

### Шаг 1: Добавить pre-baked task template для E2E фиксов

Создать файл `docs/specs/tasks/templates/task-fix-e2e-broken.md`:

```markdown
# task-fix-e2e-broken (auto-generated)

## Агент: autotest
## Приоритет: CRITICAL
## Ветка: fix/e2e-auto-{{timestamp}}

## Контекст
E2E тесты упали на main. Это задача автоматически создана watchdog-ом.
CI Run: {{run_url}}
Commit: {{sha}}

## Задача
1. Прочитай `apps/e2e/tests/` — все spec файлы
2. Запусти playwright локально (или изучи логи CI из артефактов)
3. Найди все упавшие тесты — определи причину (изменился UI или код?)
4. Исправь тесты — обнови локаторы, адаптируй под текущий UI
5. НЕ меняй бизнес-логику — только чини тесты

## Acceptance criteria
- [ ] Все тесты в apps/e2e/tests/ проходят
- [ ] Ветка запушена, PR создан
```

### Шаг 2: Новый workflow `e2e-watchdog.yml`

```yaml
name: E2E Watchdog

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]

jobs:
  dispatch-autotest:
    name: Dispatch AutoTest to fix E2E
    runs-on: ubuntu-latest
    if: github.event.workflow_run.conclusion == 'failure'
    permissions:
      actions: write
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Check if E2E job failed
        id: check
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          RUN_ID="${{ github.event.workflow_run.id }}"
          # Получаем jobs для этого run
          E2E_CONCLUSION=$(gh run view "$RUN_ID" \
            --repo "${{ github.repository }}" \
            --json jobs \
            --jq '.jobs[] | select(.name == "E2E Tests") | .conclusion')
          echo "e2e_conclusion=$E2E_CONCLUSION" >> $GITHUB_OUTPUT

      - name: Dispatch AutoTest if E2E failed
        if: steps.check.outputs.e2e_conclusion == 'failure'
        env:
          GH_TOKEN: ${{ secrets.ADMIN_PAT }}
        run: |
          TIMESTAMP=$(date +%Y%m%d-%H%M%S)
          SHA="${{ github.event.workflow_run.head_sha }}"
          RUN_URL="${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.event.workflow_run.id }}"

          # Генерируем task file (заполняем template)
          TASK_FILE="docs/specs/tasks/task-fix-e2e-auto-${TIMESTAMP}.md"
          sed \
            -e "s|{{timestamp}}|$TIMESTAMP|g" \
            -e "s|{{sha}}|$SHA|g" \
            -e "s|{{run_url}}|$RUN_URL|g" \
            docs/specs/tasks/templates/task-fix-e2e-broken.md > /tmp/task-content.md

          # Коммитим task file
          cp /tmp/task-content.md "$TASK_FILE"
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add "$TASK_FILE"
          git commit -m "chore(watchdog): auto-create E2E fix task for $SHA"
          git push

          # Диспатч AutoTest
          gh workflow run autotest.yml \
            --repo "${{ github.repository }}" \
            -f task_file="$TASK_FILE" \
            -f target_branch="fix/e2e-auto-${TIMESTAMP}"
```

### Важные детали

- Workflow использует `ADMIN_PAT` (уже в secrets) для `gh workflow run` — GITHUB_TOKEN не тригерит workflows
- `workflow_run` тригер — работает по той же схеме что `ai-review.yml` (уже проверено и работает)
- Диспатч только если `e2e` job конкретно упал (не только quality)
- Это НЕ заменяет issue #e2e-broken от notify_e2e — дополняет его

## Acceptance criteria
- [ ] `e2e-watchdog.yml` создан и работает
- [ ] `docs/specs/tasks/templates/task-fix-e2e-broken.md` создан
- [ ] При E2E failure на main → autotest.yml диспатчится автоматически
- [ ] Не диспатчится при quality-only failure (только typecheck/lint/unit)
- [ ] Workflow syntax валиден (`actionlint` или ручная проверка)

## Запрещено трогать
- `apps/`, `packages/`
- `ci.yml` — только новый файл e2e-watchdog.yml
