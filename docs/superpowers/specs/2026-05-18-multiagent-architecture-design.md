# Multi-Agent Architecture Design
**Date:** 2026-05-18
**Status:** Approved

---

## Контекст

Проект CheekyCheeseIT CRM имеет рабочий AI-пайплайн (BA, Coder, AutoTest, Reviewer, DevOps).
Цель — добавить PM-агента как центрального оркестратора, параллельный диспетч задач, явный E2E gate, User Testing stage, и упростить эскалационную цепочку.

---

## Секция 1: Состав команды агентов

| Агент | Где живёт | Пишет | Читает | Superpowers skills |
|-------|-----------|-------|--------|--------------------|
| **Master (Claude Code)** | Локально | Всё | — | Все |
| **BA** | Локально | `docs/business/`, `docs/specs/pm-brief.md` | `apps/` через Playwright | `brainstorming`, `writing-plans` |
| **PM** | Локально | `docs/specs/tasks/`, `docs/specs/pm-state.json`, `docs/business/` | `pm-brief.md`, весь репо | `writing-plans`, `executing-plans`, `dispatching-parallel-agents`, `brainstorming` |
| **Coder** | GHA | `apps/`, `packages/`, `task-xxx.blocked.md` | `docs/specs/tasks/task-xxx.md`, `docs/business/` | `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `frontend-design`, `simplify`, `security-review` |
| **AutoTest** | GHA | `apps/e2e/`, `task-xxx.blocked.md` | task file, `docs/business/` | `test-driven-development`, `systematic-debugging`, `verification-before-completion` |
| **DevOps** | GHA | `.github/workflows/`, `docker-compose.yml`, `task-xxx.blocked.md` | task file | `writing-plans`, `verification-before-completion`, `systematic-debugging` |
| **Reviewer** | GHA | review comments | всё в PR | `code-review`, `receiving-code-review`, `security-review` |
| ~~QA~~ | **архив** | — | — | — |

**Все агенты имеют доступ ко всем MCP:** ast-grep, context7, postgres, eslint, playwright, github.

### Разделение BA ↔ PM

```
BA  →  высокоуровневый бриф + бизнес-правила  →  docs/specs/pm-brief.md
PM  →  детализация до задач + RBAC + API + DB  →  docs/specs/tasks/task-xxx.md
PM  →  после User Testing и merge: анализирует review-комментарии → обновляет docs/business/
```

**BA** — профессиональный консультант. Работает с пользователем только до начала разработки. Не участвует в процессе разработки, не получает эскалации.

**PM** — детализирует бриф, следит за агентами, разрешает конфликты с пользователем напрямую, ведёт `docs/business/` актуальным.

---

## Секция 2: Файловая система задач и PM state

### Структура директорий

```
docs/specs/
├── pm-brief.md                      # BA → PM: высокоуровневый бриф
├── pm-state.json                    # PM state машина
├── tasks/
│   ├── task-auth-api.md             # задача для Coder
│   ├── task-auth-api.blocked.md     # блокер (если найден агентом)
│   ├── task-auth-ui.md              # параллельная задача для Coder
│   ├── task-e2e-auth.md             # задача для AutoTest
│   └── task-infra-redis.md          # задача для DevOps
└── archive/
    └── 2026-05-18-auth-feature/     # завершённые задачи
```

### Формат `pm-brief.md` (BA пишет)

```markdown
# Бриф: <название фичи>

## Бизнес-контекст
## Бизнес-правила
## RBAC
## Известные коллизии
## Acceptance criteria (высокий уровень)
## Что НЕ входит в scope
```

### Формат `task-xxx.md` (PM пишет)

```markdown
# task-auth-api

## Агент: coder | autotest | devops
## Приоритет: high | medium | low
## Зависит от: task-xxx (опционально)

## Контекст
## Конкретные изменения (файлы + что делать)
## API endpoints
## DB schema
## RBAC детали
## Acceptance criteria
## Запрещено
```

### Формат `task-xxx.blocked.md` (агент пишет)

```markdown
# BLOCKER: task-auth-api

## Агент: coder
## Задача: docs/specs/tasks/task-auth-api.md
## GHA Run ID: 12345678

## Проблема
## Затронутый код
## Вопрос к пользователю
## Что сделано до блокера
```

### Формат `pm-state.json`

```json
{
  "feature": "auth-google-phase2",
  "brief": "docs/specs/pm-brief.md",
  "started_at": "2026-05-18T10:00:00Z",
  "tasks": [
    {
      "id": "task-auth-api",
      "file": "docs/specs/tasks/task-auth-api.md",
      "agent": "coder",
      "workflow": "coder.yml",
      "run_id": "12345678",
      "branch": "feature/auth-api",
      "pr_number": null,
      "status": "running",
      "started_at": "2026-05-18T10:02:00Z",
      "expected_duration_min": 12
    }
  ],
  "blocked": [],
  "merged": [],
  "next_wakeup": "2026-05-18T10:16:00Z",
  "phase": "development"
}
```

**Статусы задачи:** `queued` → `running` → `pr_open` → `awaiting-pm-review` → `user-testing` → `e2e_running` → `merged` | `blocked` | `failed`

### PM Lifecycle — 4 режима

**Режим 1 — Старт новой фичи:**
```
① Читать pm-brief.md
② Проверить pm-state.json — нет ли незавершённой работы
③ skill: writing-plans — декомпозировать на задачи
④ Создать docs/specs/tasks/task-xxx.md для каждой задачи
⑤ Запустить независимые задачи параллельно:
   gh workflow run coder.yml -f task_file=... -f task_hint=...
   gh workflow run devops.yml -f task_file=... -f task_hint=...
⑥ Записать pm-state.json (run_id, ветки, expected_duration)
⑦ ScheduleWakeup(delay = max(expected_duration) + 2min)
```

**Режим 2 — Мониторинг (пробуждение):**
```
① Сканировать docs/specs/tasks/*.blocked.md
   → задать вопрос пользователю напрямую
   → получить ответ → обновить docs/business/ → удалить .blocked.md
   → gh workflow run [agent].yml -f task_file=... (перезапуск)

② gh run list → обновить статусы в pm-state.json:
   running             → ждать
   failed              → читать лог → fix-задача → перезапустить
   pr_open             → проверить review статус
   awaiting-pm-review  →
     Читать review-комментарии через GitHub MCP
     Обновить docs/business/ если нужно
     → Режим 4 (User Testing)

③ Проверить e2e.yml runs:
   pass → PR merged → tasks в archive/ → обновить pm-state.json
   fail → читать артефакты → task-fix-e2e-xxx.md
          → gh workflow run coder.yml / autotest.yml
          → gh workflow run ai-review.yml -f pr_number=X

④ Все задачи merged?
   Нет → ScheduleWakeup(следующий интервал, max 15 мин)
   Да  → финальный отчёт пользователю + архивировать pm-state.json
```

**Режим 3 — Продолжение после перерыва:**
```
① Прочитать pm-state.json → восстановить контекст
② Перейти в Режим 2
```

**Режим 4 — User Testing:**
```
① pnpm dev (запустить проект локально)
② Описать пользователю текстом:
   - Что реализовано в этом PR
   - Где смотреть в UI (раздел, маршрут)
   - Конкретный список что проверить
③ Ждать ответа пользователя
④ АПРУВ → gh workflow run e2e.yml -f pr_number=X
   ПРАВКИ → skill: brainstorming → классифицировать каждую правку:
     UI-баг / визуал       → task-fix-ui.md → Coder (+ frontend-design skill)
     Логика неправильная   → обновить docs/business/ → task-fix-logic.md → Coder
     Новый scope           → уточнить у пользователя: этот PR или новая задача?
     Тест не покрывает     → task-fix-test.md → AutoTest
     Несколько правок      → несколько task файлов → параллельный запуск
   → агенты пушат в ту же ветку PR →
   → gh workflow run ai-review.yml -f pr_number=X →
   → APPROVE → PM анализ → User Testing снова
```

---

## Секция 3: Изменения в workflows

### Параллельный диспетч — `coder.yml` и `devops.yml`

**Новый input `task_file`:**
```yaml
inputs:
  task_file:
    description: 'Path to task file (e.g. docs/specs/tasks/task-auth-api.md)'
    required: true
    type: string
  task_hint:
    description: 'Short hint for branch name'
    required: false
    type: string
```

**Новый concurrency key:**
```yaml
concurrency:
  group: coder-${{ inputs.task_file }}
  cancel-in-progress: false
```

**В `direct_prompt`:** читать `${{ inputs.task_file }}` вместо `docs/specs/active-task.md`.

PM запускает параллельно:
```bash
gh workflow run coder.yml -f task_file="docs/specs/tasks/task-auth-api.md" -f task_hint="auth-api"
gh workflow run coder.yml -f task_file="docs/specs/tasks/task-auth-ui.md"  -f task_hint="auth-ui"
gh workflow run devops.yml -f task_file="docs/specs/tasks/task-infra-redis.md" -f task_hint="redis"
```

### `ai-review.yml` — обновлённая структура

**Jobs:**
```
autotest → reviewer → trigger_coder  (REQUEST_CHANGES)
                  └→ label awaiting-pm-review + стоп  (APPROVE)
```

- Job `merge` — **удалён полностью**
- Job `e2e` — **не добавляется в ai-review.yml**
- После APPROVE: добавить label `awaiting-pm-review` на PR, обновить pipeline статус, стоп

**`trigger_coder` job** — передаёт `task_file` из `pm-state.json` по branch → task_file mapping.

### Новый `e2e.yml` — запускается только PM-ом

```yaml
on:
  workflow_dispatch:
    inputs:
      pr_number: { required: true, type: string }

jobs:
  e2e:
    services:
      postgres: { image: postgres:16 }
      redis:    { image: redis:7 }
    steps:
      - checkout PR branch
      - pnpm install
      - db:migrate + db:seed
      - start API + Web (background, wait-on)
      - pnpm --filter @crm/e2e test
      - upload artifacts on failure

  merge:
    needs: [e2e]
    if: needs.e2e.result == 'success'
    steps:
      - gh pr merge --squash
```

**E2E fail цикл:**
```
PM читает артефакты → task-fix-e2e-xxx.md →
gh workflow run coder.yml / autotest.yml (фикс в той же ветке) →
gh workflow run ai-review.yml -f pr_number=X →
APPROVE → PM → gh workflow run e2e.yml → повторить
```

### Pre-commit (Coder)

Coder запускает перед коммитом только:
```bash
pnpm typecheck && pnpm lint && pnpm test
```
Полный E2E — только через `e2e.yml`.

---

## Секция 4: Системные промпты

### `docs/agents/pm.md` — структура

**Обязательное чтение при старте:**
1. `docs/agents/CLAUDE-pm.md` — статус фаз, типичные duration, secrets
2. `docs/specs/pm-brief.md` — бриф от BA
3. `docs/business/overview.md` — бизнес-модель
4. `docs/specs/pm-state.json` — если существует (продолжение)

**4 режима работы:** (описаны в Секции 2 выше)

**Инструменты PM:**

| Задача | Инструмент |
|--------|-----------|
| Декомпозиция | skill: `writing-plans` |
| Параллельный диспетч | skill: `dispatching-parallel-agents` |
| Анализ требований | skill: `brainstorming` |
| Выполнение плана | skill: `executing-plans` |
| Запуск/мониторинг GHA | `Bash: gh workflow run / gh run list / gh run view` |
| Чтение review | `mcp__github__get_pull_request_reviews` |
| Чтение комментариев | `mcp__github__get_pull_request_comments` |
| Управление labels | `gh pr edit --add-label / --remove-label` |
| Обновление docs | `Write / Edit` |
| Пробуждение | `ScheduleWakeup` |

**Зоны записи:**
- ✅ `docs/specs/tasks/` — задачи
- ✅ `docs/specs/pm-state.json` — state
- ✅ `docs/business/` — при резолве конфликтов и после merge
- ❌ `apps/`, `packages/` — только разработчики
- ❌ `.github/workflows/` — только DevOps

### `docs/agents/ba.md` — изменения

| До | После |
|----|-------|
| Пишет `docs/specs/active-task.md` | Пишет `docs/specs/pm-brief.md` |
| Запускает Coder напрямую | Передаёт бриф PM |
| Участвует в приёмке | Не участвует в процессе разработки |
| Получает эскалации от QA | Эскалации идут PM → пользователь |

**Остаётся:** Playwright MCP для UI-инспекции, проверка коллизий, консультация пользователя.

### Агенты — обновление skills и MCP

**Все агенты получают:**
- Доступ ко всем MCP (ast-grep, context7, postgres, eslint, playwright, github)
- Соответствующие роли Superpowers skills (см. Секцию 1)
- `.blocked.md` механизм в системном промпте

---

## Секция 5: Полный список файлов

### СОЗДАТЬ

| Файл | Что это |
|------|---------|
| `docs/agents/pm.md` | Системный промпт PM |
| `docs/agents/CLAUDE-pm.md` | Контекст: фазы, duration, secrets |
| `docs/specs/tasks/.gitkeep` | Инициализация директории задач |
| `docs/specs/tasks/archive/.gitkeep` | Архив завершённых задач |
| `.github/workflows/e2e.yml` | Новый E2E workflow |

### ИЗМЕНИТЬ

| Файл | Что меняется |
|------|-------------|
| `.github/workflows/coder.yml` | `task_file` input; новый concurrency key; читать из `task_file` |
| `.github/workflows/devops.yml` | То же самое |
| `.github/workflows/autotest.yml` | `task_file` input для Mode 2 |
| `.github/workflows/ai-review.yml` | Удалить job `merge`; после APPROVE → label `awaiting-pm-review`; убрать E2E |
| `docs/agents/ba.md` | `pm-brief.md` вместо `active-task.md`; убрать приёмку и эскалации; Playwright |
| `docs/agents/CLAUDE-ba.md` | Обновить эскалационные пути |
| `docs/agents/coder.md` | Skills + `.blocked.md` + все MCP + читать `task_file` |
| `docs/agents/autotest.md` | Skills + `.blocked.md` + все MCP |
| `docs/agents/reviewer.md` | Skills + `awaiting-pm-review` сигнал + все MCP |
| `docs/agents/devops.md` | Skills + `.blocked.md` + все MCP + `task_file` |
| `CLAUDE.md` | PM в архитектуре; обновить активный контекст |

### АРХИВИРОВАТЬ

| Откуда | Куда |
|--------|------|
| `docs/agents/qa.md` | `docs/agents/archive/qa.md` |
| `docs/agents/CLAUDE-qa.md` | `docs/agents/archive/CLAUDE-qa.md` |
| `docs/specs/active-task.md` | `docs/specs/archive/YYYY-MM-DD-active-task.md` |
| `docs/specs/active-devops-task.md` | `docs/specs/archive/YYYY-MM-DD-active-devops-task.md` |

### УДАЛИТЬ

| Файл | Причина |
|------|---------|
| `.github/workflows/ba-escalation.yml` | PM → пользователь напрямую, GitHub Issue не нужен |

### Порядок имплементации

```
1. e2e.yml (новый) + tasks/ директория
2. coder.yml + devops.yml (task_file параметр + concurrency)
3. ai-review.yml (убрать merge, добавить awaiting-pm-review)
4. pm.md + CLAUDE-pm.md
5. ba.md + CLAUDE-ba.md
6. coder.md + autotest.md + reviewer.md + devops.md
7. CLAUDE.md
8. Архивировать QA + старые spec файлы
9. Удалить ba-escalation.yml
```

---

## Итоговый полный pipeline

```
User + BA → pm-brief.md
PM (Режим 1) → task-*.md → gh workflow run [параллельно]
  ↓
  [Coder] [DevOps] [AutoTest Mode 2]  ← параллельно
  ↓
  PR + label ai-review-ready
  ↓
  ai-review.yml:
    AutoTest (пишет E2E тест-код в ветку) →
    Reviewer →
      REQUEST_CHANGES → trigger_coder → агент фиксит → ai-review снова
      APPROVE → label awaiting-pm-review → стоп
  ↓
PM (Режим 2) просыпается →
  читает review-комментарии → обновляет docs/business/
  ↓
PM (Режим 4) User Testing →
  pnpm dev → описывает что тестировать →
  АПРУВ пользователя → gh workflow run e2e.yml
  ПРАВКИ → task-fix-*.md → агенты → ai-review → User Testing снова
  ↓
e2e.yml:
  ✅ pass → squash merge
  ❌ fail → PM fix цикл → e2e снова
  ↓
PM архивирует задачи → финальный отчёт пользователю
```
