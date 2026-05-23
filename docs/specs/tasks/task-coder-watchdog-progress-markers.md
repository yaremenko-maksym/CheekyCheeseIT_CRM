# Task: Coder progress sentinel pattern + harness watchdog hook

## Агент: NEEDS-USER (harness integration) + devops (hook implementation)
## Приоритет: high (P0 проблема C1 — Coder silently завершается без push)
## Зависит от: `task-arch-agents-md-fixes.md` (документированы threshold'ы в coder.md секция 7)
## Ветка: `infra/coder-watchdog`

## Контекст

**C1 [P0]:** Coder runtime watchdog обрезает stream после ~12 мин / ~200k токенов. Если Coder между `wip:` пушами обрывается — работа теряется (живёт в его worktree, недоступна PM кроме как `git -C <wt> log`).

В этом PR (`task-arch-agents-md-fixes.md`) уже:
- Ужесточены threshold'ы в `coder.md` секция 7: `wip:` push после **каждых 2 файлов ИЛИ каждых 5 минут**
- Документирован sentinel-pattern `docs/specs/tasks/<task>.progress.md` в `coder.md`

Что осталось — implementation:

## Конкретные изменения

### 1. Hook `.claude/hooks/coder-progress-marker.sh` (PostToolUse, Edit/Write/MultiEdit)

При каждом Edit/Write Coder автоматически обновляет `docs/specs/tasks/<task>.progress.md`:

```markdown
# Progress: task-<slug>

last_update: <ISO timestamp>
files_touched: <count>
files:
  - apps/api/src/projects/projects.service.ts (5 changes)
  - apps/web/app/routes/crm/projects/$projectId.tsx (3 changes)

current_milestone: <inferred from latest commit message or task plan>
last_commit: <git rev-parse HEAD>
last_push: <ISO от последнего `git push`>
```

При `git push` — hook записывает `last_push`. Если расхождение между `last_update` и `last_push` > 10 минут — это сигнал что Coder писал, но не пушил.

### 2. PM-side poll (Mode 2 in pm.md)

PM при таймауте Coder'а:
1. Читает `<task>.progress.md` — последний `last_update`
2. Если `last_update < now() - 10min` → Coder остановился. Запустить новую сессию с `target_branch + продолжить с last_commit`.
3. Если `last_update > now() - 10min` → Coder ещё работает, ждать.

### 3. Документация в `pm-snippets.md`

Сниппет «Coder hung — recovery»:
```bash
# 1. Прочитать progress
cat docs/specs/tasks/<task>.progress.md

# 2. Залезть в Coder worktree (через git worktree list)
git -C <worktree-path> log --oneline -10
git -C <worktree-path> diff --stat HEAD

# 3. Если есть незакоммиченные файлы — git stash → git push с stash apply в новой сессии
```

## Acceptance criteria

- [ ] Hook `.claude/hooks/coder-progress-marker.sh` создан, тестировал на 3 файлах
- [ ] Зарегистрирован в `.claude/settings.json` как PostToolUse Edit|Write|MultiEdit
- [ ] PM Mode 2 секция Recovery обновлена с poll-pattern
- [ ] Smoke-test: Coder делает 2 файла, останавливается; PM поллит progress, видит stale, забирает worktree state

## Why NEEDS-USER

Hook implementation = DevOps (понятная задача). Но **integration с harness watchdog** (чтобы Coder получал SIGTERM раньше hard kill и успевал flush sentinel) — harness level. Опционально без harness changes: sentinel-pattern уже даёт PM-side detection, что достаточно для recovery (хоть и не для prevention).
