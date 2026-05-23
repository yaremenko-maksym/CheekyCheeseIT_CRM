# Task: GHA workflow для синхронизации `.github/labels.yml` с repo labels

## Агент: devops
## Приоритет: medium
## Зависит от: `task-arch-agents-md-fixes.md` (создан `.github/labels.yml`)
## Ветка: `infra/labels-sync`

## Контекст

После dev-flow ретроспективы создан `.github/labels.yml` как декларативный source of truth для labels (включая `ci-failed`, которого раньше не было в repo). Сейчас labels синхронизируются с repo вручную через `gh label create/edit/delete`. Это ломается:
- Когда yml меняется → repo не получает обновление автоматически
- Когда кто-то меняет label через GitHub UI → yml расходится

Нужен GHA workflow, который при push в main с изменениями `.github/labels.yml` приводит repo labels к состоянию из yml.

## Конкретные изменения

### 1. Создать `.github/workflows/labels-sync.yml`

```yaml
name: Labels Sync

on:
  push:
    branches: [main]
    paths:
      - '.github/labels.yml'
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: crazy-max/ghaction-github-labeler@v5
        with:
          yaml-file: .github/labels.yml
          skip-delete: false  # удалять labels отсутствующие в yml
          dry-run: false
```

`crazy-max/ghaction-github-labeler@v5` — поддерживаемый action который читает yml-формат `[{name, color, description}]` и приводит repo labels к этому состоянию.

### 2. Smoke-test перед merge:
- `workflow_dispatch` запуск на dry-run=true → verify diff в логах workflow
- Затем `dry-run=false` коммитом на main → verify labels в repo соответствуют yml

## Acceptance criteria

- [ ] `.github/workflows/labels-sync.yml` создан
- [ ] `workflow_dispatch` доступен (для ручного запуска)
- [ ] Smoke-test на dry-run=true показывает корректный diff
- [ ] `actionlint` syntax check проходит

## Запрещено трогать

- `.github/labels.yml` — это source of truth, workflow его только читает
- Другие workflows — изолированная задача
