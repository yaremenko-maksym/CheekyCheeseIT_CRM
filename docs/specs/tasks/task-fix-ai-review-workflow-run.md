# Задача: Fix ai-review.yml — workflow_run несовместим с claude-code-action

## Агент: devops
## Приоритет: critical

---

## Проблема

`ai-review.yml` запускается через `workflow_run` триггер (когда завершается "CI").
`claude-code-action@beta` падает с ошибкой:

```
Prepare step failed with error: Unsupported event type: workflow_run
```

Действие не поддерживает `workflow_run` event type. Нужно перестроить workflow так,
чтобы claude-агенты всегда видели `workflow_dispatch` событие.

---

## Решение

Добавить в `ai-review.yml` новый Job `redispatch` в начало `jobs:`:

```yaml
  redispatch:
    name: Re-dispatch as workflow_dispatch
    runs-on: ubuntu-latest
    if: |
      github.event_name == 'workflow_run' &&
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.actor.login != 'github-actions[bot]' &&
      github.event.workflow_run.pull_requests[0] != null
    permissions:
      actions: write
    steps:
      - name: Trigger workflow_dispatch with PR number
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.workflow_run.pull_requests[0].number }}
          REPO: ${{ github.repository }}
        run: |
          echo "Re-dispatching ai-review.yml for PR #${PR}"
          gh workflow run ai-review.yml \
            --repo "$REPO" \
            -f pr_number="$PR"
```

Изменить условие `if` у job `autotest` — убрать ветку `workflow_run`, оставить ТОЛЬКО `workflow_dispatch`:

```yaml
  autotest:
    name: AutoTest
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch'
```

Изменить условие `if` у job `reviewer` — убрать строку с `workflow_run.actor.login`:

```yaml
  reviewer:
    if: |
      always() &&
      needs.autotest.result == 'success'
```

---

## Файл для изменений

`.github/workflows/ai-review.yml`

---

## Алгоритм

1. Создать ветку `fix/ai-review-workflow-run-event` от main
2. Внести изменения в `.github/workflows/ai-review.yml` согласно описанию выше
3. Убедиться что YAML синтаксис валиден (`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ai-review.yml'))"`)
4. Закоммитить, запушить
5. Создать PR с label `ai-review-ready` через GitHub MCP

---

## Критерии приёмки

- [ ] Job `redispatch` добавлен — срабатывает ТОЛЬКО на `workflow_run`
- [ ] Job `autotest` — условие `if: github.event_name == 'workflow_dispatch'`
- [ ] Job `reviewer` — убрана строка `github.event.workflow_run.actor.login != 'github-actions[bot]'`
- [ ] YAML синтаксически валиден
- [ ] PR создан
