# PM Snippets — On-Demand Reference

Готовые сниппеты для диспетча агентов, проверки PR, прогона CI и User Testing.

**PM не читает этот файл upfront** — обращается через локальный skill `pm-dispatching` когда реально нужен сниппет.

---

## Диспетч агентов

### Coder — новая фича

```
Agent(
  isolation="worktree",
  description="Coder: task-<slug>",
  prompt="""Ты — Coder-агент для CRM Cheeky Cheese IT.
Прочитай .claude/agents/coder.md — системный промпт (golden rules + workflow + recovery).
Прочитай .claude/RULES.md — cross-agent rules (MCP, git, skills, zone-of-write).
Прочитай .claude/agents/project-state.md — фазы / миграции / RBAC / shared schemas / технические gotchas.
Прочитай .claude/agents/memory/coder/lessons.md — накопленные уроки.
Task-файл: .claude/tasks/task-<slug>.md
Repo: yaremenko-maksym/CheekyCheeseIT_CRM"""
)
```

**Phase 3d.2 (ECC):** PM dispatches только Coder shell. Coder **сам** инвоукает ECC sub-agents в своём workflow:

- §1.5 — `tdd-guide` (TDD план для новой фичи)
- §2.5 — `typescript-reviewer` (self-review TS/TSX ДО push)

PM не передаёт дополнительные prompts для sub-agents — Coder читает свою же coder.md.

### Coder — фикс в существующую ветку

```
Agent(
  isolation="worktree",
  description="Coder: fix-<slug>",
  prompt="""Ты — Coder-агент. Прочитай .claude/agents/coder.md (golden rules + recovery).
Прочитай .claude/RULES.md (cross-agent rules).
Прочитай .claude/agents/project-state.md (фазы / миграции / gotchas).
Прочитай .claude/agents/memory/coder/lessons.md.
Task: .claude/tasks/task-fix-<slug>.md
target_branch: <pr_branch>
Ветка уже существует — переключись: git checkout <pr_branch>"""
)
```

**Phase 3d.2 (ECC) — для bugfix:** `tdd-guide` НЕ диспатчится (это для новых фич). Coder использует `superpowers:systematic-debugging` skill (см. coder.md §1.5). `typescript-reviewer` self-review остаётся обязательным для milestones с TS/TSX изменениями.

### AutoTest — post-approval тесты

```
Agent(
  description="AutoTest: PR #<N>",
  prompt="""Ты — AutoTest-агент. Прочитай .claude/agents/autotest.md (golden rules + 3 режима).
Прочитай .claude/RULES.md (cross-agent rules).
Прочитай .claude/agents/project-state.md (RBAC / seed users).
Прочитай .claude/agents/memory/autotest/lessons.md.
PR для анализа: #<N>, repo: yaremenko-maksym/CheekyCheeseIT_CRM.
Режим 1: Post-approval — написать E2E тесты для новых AC."""
)
```

### AutoTest — фикс упавшего E2E

```
Agent(
  isolation="worktree",
  description="AutoTest: fix-e2e-<slug>",
  prompt="""Ты — AutoTest-агент. Прочитай .claude/agents/autotest.md.
Прочитай .claude/RULES.md.
Прочитай .claude/agents/project-state.md.
Прочитай .claude/agents/memory/autotest/lessons.md.
Task: .claude/tasks/task-fix-e2e-<slug>.md
target_branch: <pr_branch>
Ветка: git checkout <pr_branch>"""
)
```

### code-reviewer — default code review (любой PR)

**Phase 3b split:** sonnet, default на каждый PR с product-code changes. Зона: TypeScript strict / ESLint / arch patterns / zone-of-write / write-then-post / Verdict: BLOCK first-line. Использует `mcp__eslint__lint-files` ДО review и Pre-Report Gate (HIGH→body / MED→warnings / LOW→summary-only).

```
Agent(
  description="code-reviewer: PR #<N>",
  prompt="""Ты — code-reviewer агент. Прочитай .claude/agents/code-reviewer.md (golden rules + write-then-post + Pre-Report Gate).
Прочитай .claude/RULES.md (zero-tolerance patterns).
Прочитай .claude/agents/project-state.md (canonical architecture / version pins / RBAC).
Прочитай .claude/agents/memory/reviewer/lessons.md (legacy общий с security-reviewer до Phase 4 split).
PR для review: #<N>, repo: yaremenko-maksym/CheekyCheeseIT_CRM
Sensitive paths flag: <none|list>  # PM передаёт если задеты critical-path zones — это сигнал что security-reviewer диспатчится параллельно""",
  run_in_background=True
)
```

При aggregate-verdict logic — code-reviewer всегда даёт `code_review_done` event с verdict APPROVE/BLOCK. См. `pm.md` Mode 2 "Aggregate verdict logic".

### security-reviewer — для critical-path PR (auth/finance/USDT/wallets)

**Phase 3b split:** opus, диспатчится **параллельно** с code-reviewer когда PR трогает critical-path trigger zones (см. `pm.md` §"Critical-path trigger zones" — единый DRY-список). Зона: OWASP Top 10 / npm audit / secrets detection / USDT-ETH patterns / write-then-post / Verdict: BLOCK first-line.

```
Agent(
  description="security-reviewer: PR #<N>",
  prompt="""Ты — security-reviewer агент. Прочитай .claude/agents/security-reviewer.md (golden rules + OWASP чеклист + write-then-post + Pre-Report Gate).
Прочитай .claude/RULES.md.
Прочитай .claude/agents/project-state.md (RBAC матрица / shared schemas / auth flow).
Прочитай .claude/agents/memory/reviewer/lessons.md (legacy общий с code-reviewer до Phase 4 split).
PR для security review: #<N>, repo: yaremenko-maksym/CheekyCheeseIT_CRM
Sensitive paths которые тригернули dispatch: <list, e.g. apps/api/src/finance/**, packages/shared/src/schemas/finance.ts>
Code-reviewer параллельно — не дублируй его code/lint checks.""",
  run_in_background=True
)
```

При aggregate-verdict logic — security-reviewer даёт `security_review_done` event с verdict APPROVE/BLOCK. PM объединяет с code-reviewer verdict (см. `pm.md` Mode 2).

### DevOps — инфра-задача

```
Agent(
  isolation="worktree",
  description="DevOps: task-infra-<slug>",
  prompt="""Ты — DevOps-агент. Прочитай .claude/agents/devops.md (golden rules + workflow).
Прочитай .claude/RULES.md (version pins / git / skills).
Прочитай .claude/agents/project-state.md (CI/CD pipeline актуальный — §11).
Прочитай .claude/agents/memory/devops/lessons.md.
Task: .claude/tasks/task-infra-<slug>.md"""
)
```

### Параллельный запуск (Coder + DevOps)

В одном сообщении — оба `Agent` вызова с `run_in_background=True`:

```
Agent(isolation="worktree", run_in_background=True, description="Coder: task-<slug>", prompt="...")
Agent(isolation="worktree", run_in_background=True, description="DevOps: task-infra-<slug>", prompt="...")
```

### Legal — Mode A (on-demand consult)

```
Agent(
  description="Legal: consult-<slug>",
  prompt="""Ты — Legal-агент. Прочитай .claude/agents/legal.md (golden rules + 4 modes).
Прочитай .claude/agents/CLAUDE-legal.md.
Прочитай .claude/RULES.md (cross-agent rules).
Прочитай .claude/agents/project-state.md.
Прочитай .claude/agents/memory/legal/lessons.md.
Прочитай .claude/knowledge/legal/cross-cutting/escalation-zones.md.
Прочитай .claude/knowledge/legal/cross-cutting/citation-rules.md.

mode: consult
Task: .claude/tasks/task-legal-<slug>.md

Append `## Ответ юриста` в task-файл по структуре из legal.md.
После завершения верни PM summary: Confidence + TL;DR."""
)
```

### Legal — Mode B (auto PR review, critical zones)

```
Agent(
  description="Legal: pr-review-<N>",
  prompt="""Ты — Legal-агент. Прочитай .claude/agents/legal.md.
Прочитай .claude/agents/CLAUDE-legal.md.
Прочитай .claude/RULES.md.
Прочитай .claude/agents/project-state.md.
Прочитай .claude/agents/memory/legal/lessons.md.
Прочитай .claude/knowledge/legal/cross-cutting/escalation-zones.md.
Прочитай .claude/knowledge/legal/cross-cutting/citation-rules.md.

mode: pr-review
pr_number: <N>
repo: yaremenko-maksym/CheekyCheeseIT_CRM

Используй write-then-post pattern (CLAUDE-legal.md секция).
Постить с event: COMMENT (НЕ APPROVE / REQUEST_CHANGES).
Первая строка body: `Legal Review: <CONFIDENCE>`.
Добавь label `legal-noted` на PR через gh."""
)
```

### Legal — Mode C (pre-feature brief check)

```
Agent(
  description="Legal: brief-check",
  prompt="""Ты — Legal-агент. Прочитай .claude/agents/legal.md.
Прочитай .claude/agents/CLAUDE-legal.md.
Прочитай .claude/RULES.md.
Прочитай .claude/agents/project-state.md.
Прочитай .claude/agents/memory/legal/lessons.md.
Прочитай .claude/knowledge/legal/cross-cutting/escalation-zones.md.
Прочитай .claude/knowledge/legal/cross-cutting/citation-rules.md.

mode: brief-check
brief_file: .claude/briefs/pm-brief.md

Идентифицируй legal touchpoints в brief. Вывод — `.claude/briefs/pm-brief-legal-check.md` с акцентом на Recommendations для AC."""
)
```

### Legal — Mode D (strategic advisor, direct user question)

```
Agent(
  description="Legal: strategic-<slug>",
  prompt="""Ты — Legal-агент. Прочитай .claude/agents/legal.md.
Прочитай .claude/agents/CLAUDE-legal.md.
Прочитай .claude/RULES.md.
Прочитай .claude/agents/project-state.md.
Прочитай .claude/agents/memory/legal/lessons.md.
Прочитай .claude/knowledge/legal/cross-cutting/escalation-zones.md.
Прочитай .claude/knowledge/legal/cross-cutting/citation-rules.md.

mode: strategic
consultation_file: .claude/knowledge/legal-consultations/<YYYY-MM-DD-slug>.md

Append `## Ответ юриста` в consultation-файл по структуре из legal.md.
После завершения верни PM summary для отправки USER в чат: Confidence + TL;DR + 1-2 ключевые recommendation."""
)
```

### Параллельный запуск code-reviewer + security-reviewer + Legal (critical-path PR)

**Триггер:** PR трогает любой путь из `pm.md` §"Critical-path trigger zones" (auth/finance/transactions/payouts/wallets/documents/users + соответствующие shared schemas + package.json/lockfile + contracts/**).

**Все три агента параллельно — один dispatch message, все `run_in_background=True`:**

```
# code-reviewer (sonnet) — default reviewer
Agent(
  description="code-reviewer: PR #<N>",
  prompt="""Ты — code-reviewer. Прочитай .claude/agents/code-reviewer.md.
Прочитай .claude/RULES.md.
Прочитай .claude/agents/project-state.md.
Прочитай .claude/agents/memory/reviewer/lessons.md.
PR для review: #<N>, repo: yaremenko-maksym/CheekyCheeseIT_CRM
Sensitive paths flag: <list>  # security-reviewer параллельно""",
  run_in_background=True
)

# security-reviewer (opus) — обязателен для critical-path
Agent(
  description="security-reviewer: PR #<N>",
  prompt="""Ты — security-reviewer. Прочитай .claude/agents/security-reviewer.md.
Прочитай .claude/RULES.md.
Прочитай .claude/agents/project-state.md.
Прочитай .claude/agents/memory/reviewer/lessons.md.
PR: #<N>, repo: yaremenko-maksym/CheekyCheeseIT_CRM
Triggered paths: <list>
Code-reviewer параллельно — не дублируй его проверки.""",
  run_in_background=True
)

# Legal Mode B (info-only) — диспатчится по тому же DRY-списку trigger paths
Agent(
  description="Legal: pr-review-<N>",
  prompt="""Ты — Legal-агент. Прочитай .claude/agents/legal.md.
Прочитай .claude/agents/CLAUDE-legal.md.
Прочитай .claude/RULES.md.
Прочитай .claude/agents/project-state.md.
Прочитай .claude/agents/memory/legal/lessons.md.
Прочитай .claude/knowledge/legal/cross-cutting/escalation-zones.md.
Прочитай .claude/knowledge/legal/cross-cutting/citation-rules.md.

mode: pr-review
pr_number: <N>
repo: yaremenko-maksym/CheekyCheeseIT_CRM
Triggered paths: <list>""",
  run_in_background=True
)
```

**Verdict aggregation для PM:**

- code-reviewer event: `code_review_done` (APPROVE | BLOCK) — **gate** (parsed Verdict: first line).
- security-reviewer event: `security_review_done` (APPROVE | BLOCK) — **gate** (parsed Verdict: first line).
- Legal event: `legal_review_posted` с `confidence` — **info-only**, label `legal-noted`, не блокирует merge.

PM ждёт оба review events (code + security) перед принятием решения. Aggregate = BLOCK если любой BLOCK; APPROVE если оба APPROVE. См. `pm.md` Mode 2 "Aggregate verdict logic".

### Параллельный запуск code-reviewer только (без security/Legal — обычный PR)

Для PR который **не** трогает critical-path zones — диспатчить только code-reviewer:

```
Agent(description="code-reviewer: PR #<N>", prompt="...", run_in_background=True)
```

Только `code_review_done` event ожидается. PM не ждёт `security_review_done` потому что security-reviewer не диспатчен.

---

## PR и CI команды

### Найти PR по ветке

```bash
gh pr list --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --head "feature/<slug>" --json number,title --jq '.[0]'
```

### Статус CI на PR

```bash
gh pr view <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --json statusCheckRollup --jq '.statusCheckRollup[] | {name, conclusion}'
```

Или через MCP:

```
mcp__github__get_pull_request_status({owner: "yaremenko-maksym", repo: "CheekyCheeseIT_CRM", pull_number: <N>})
```

### Лейблы на PR

```bash
gh pr view <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --json labels --jq '[.labels[].name]'
```

### Управление лейблами

```bash
# Pre-review (code-reviewer выставляет когда code-reviewer APPROVE; security-reviewer ставит security-noted)
gh pr edit <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM --add-label "awaiting-pm-review"

# После User Testing апрува (PM выставляет)
gh pr edit <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --add-label "merge-approved" \
  --remove-label "awaiting-pm-review"

# Снять CI-failed после фикса
gh pr edit <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM --remove-label "ci-failed"
```

### Review-комментарии (через MCP, не gh api)

```
mcp__github__get_pull_request_reviews({owner: "yaremenko-maksym", repo: "CheekyCheeseIT_CRM", pull_number: <N>})
mcp__github__get_pull_request_comments({owner: "yaremenko-maksym", repo: "CheekyCheeseIT_CRM", pull_number: <N>})
```

---

## User Testing подготовка окружения

Все шаги в одном скрипте — выполнить перед каждым User Testing:

```bash
bash scripts/pm/prep-user-testing.sh <pr_branch>
```

Скрипт делает: `git fetch && checkout` (auto-detect worktree) → миграции → unit-тесты (api/web/shared, без e2e) → **production build (api + web с `VITE_API_URL=/api` + `VITE_DEV_LOGIN=true`)** → kill prev по PORT → старт API + Vite preview → wait-for-services → **Serveo SSH tunnel** (`ssh -R 80:localhost:3000 serveo.net`) → блокирует foreground.

Через tunnel демка отдаётся как production bundle (не dev) — быстрее на мобильнике, без flaky HMR через туннель. URL формат `https://<hash>.serveousercontent.com`. OAuth через tunnel НЕ работает — использовать Dev Login (email на `/crm/login`).

Env overrides: `SKIP_TUNNEL=1`, `SKIP_UNIT_TESTS=1`, `POSTGRES_*`.

Если упал — не показывать пользователю, читать `/tmp/pm-api.log` + `/tmp/pm-web.log` + Serveo лог → классифицировать (build/DB/tunnel/port-clash) → fix-задача для Coder/DevOps. Troubleshooting — `docs/runbooks/user-testing-tunnel.md`.

---

## E2E запуск (GHA workflow_dispatch)

```bash
# Запустить E2E workflow
gh workflow run e2e.yml --repo yaremenko-maksym/CheekyCheeseIT_CRM

# Последние run'ы
gh run list --repo yaremenko-maksym/CheekyCheeseIT_CRM --workflow=e2e.yml --limit=3

# Статус конкретного run
gh run view <run_id> --repo yaremenko-maksym/CheekyCheeseIT_CRM --json status,conclusion

# Логи провалившегося run
gh run view <run_id> --repo yaremenko-maksym/CheekyCheeseIT_CRM --log-failed
```

**PM ждёт E2E двумя способами — выбрать по длительности:**

- **Короткий wait (< 30 мин), активная сессия** — `ScheduleWakeup(delay=270)`. Простой harness API, но **не выживает session boundary**.
- **Длинный wait или критичный fire** — `mcp__scheduled-tasks` через `pm-schedule.sh` (см. секцию ниже). Survives session boundary, но stand-up'ит fresh Claude-сессию.

Полная матрица — секция «⚠️ ScheduleWakeup limitations» ниже в этом файле.

---

## ⚠️ ScheduleWakeup limitations (D1 [P0])

**ScheduleWakeup не выживает session boundary.** Real incident: 2026-05-23 PM поставил wake-up на 2 часа, session завершилась → wake-up потерян → PR висел без действия.

PM имеет **два слоя** для wake-up'ов с разными гарантиями. Выбирать по длительности и критичности.

### Layer 1 — `ScheduleWakeup` (in-session, < 30 минут)

Прямой harness API. Дёшево, быстро, но **умирает с сессией**.

**Используй когда:**

- Wait < 30 минут (короткий CI poll)
- Чёткая уверенность что сессия не закроется (active interactive turn)
- Wake-up — нежёсткое требование (если потеряется, USER увидит и перезапустит)

**Workaround pattern (если всё-таки используешь Layer 1 для важного wait):**

```python
# Перед wake-up — сохрани действие в state, чтобы новая сессия могла catch-up
pm_state["active"][task_idx]["next_action"] = {
    "type": "poll_e2e_run",
    "run_id": run_id,
    "scheduled_at": now_iso(),
    "max_age_min": 30
}
ScheduleWakeup(delay=270)  # 4.5 мин для GHA E2E

# При старте новой session (Mode 3) — catch-up:
for task in pm_state["active"]:
    if next_action := task.get("next_action"):
        age_min = (now() - parse_iso(next_action["scheduled_at"])).total_seconds() / 60
        if age_min > next_action["max_age_min"]:
            handle_next_action(next_action)  # missed wake-up — immediate execute
```

### Layer 2 — `mcp__scheduled-tasks__*` (cross-session, любая длительность)

External scheduler, **выживает session boundary**. Запускает fresh Claude-сессию на запланированное время с self-contained prompt. Полноценный workaround D1.

**Используй когда:**

- Wait ≥ 30 минут (длинный CI, GHA E2E, deploy verification)
- Жёсткое требование fire'а (потеря недопустима)
- Длительный wait через session timeout

**Workflow (PM шаги):**

1. **Сгенерировать параметры** через `pm-schedule.sh`:

```bash
bash scripts/pm/pm-schedule.sh \
  --delay-min 15 \
  --task-id-hint poll-e2e-pr42 \
  --description "Poll E2E run 26298999300 for PR #42" \
  --prompt-template poll-e2e-run \
  --prompt-var REPO=yaremenko-maksym/CheekyCheeseIT_CRM \
  --prompt-var RUN_ID=26298999300 \
  --prompt-var PR=42 \
  --state-file .claude/state/pm-state.json \
  --state-task-id task-knowledge-api
```

Это:

- Вычисляет `fireAt` в local TZ (BSD/GNU date compat)
- Генерит unique `taskId` (kebab-case + UTC timestamp suffix)
- Материализует self-contained prompt из `scripts/pm/wakeup-prompts/<template>.md`
- Append event `wakeup_scheduled` + `next_action` в pm-state.json
- Печатает JSON в stdout

2. **Прочитать materialized prompt:**

```bash
cat $(jq -r .promptPath <stdout-json>)
```

3. **Вызвать MCP-tool** прямо из PM-сессии:

```
mcp__scheduled-tasks__create_scheduled_task({
  taskId: "<from JSON>",
  description: "<from JSON>",
  fireAt: "<from JSON>",
  prompt: "<contents of promptPath>"
})
```

### Матрица выбора

| Сценарий                                              | Layer                      | Почему                              |
| ----------------------------------------------------- | -------------------------- | ----------------------------------- |
| `pnpm test` finishing, ждать unit (~5 мин)            | 1 (ScheduleWakeup)         | Сессия active, короткий wait        |
| GHA E2E workflow (~10-20 мин)                         | 2 (mcp\_\_scheduled-tasks) | Может пережить session timeout      |
| Daily morning check (12 часов)                        | 2                          | Точно cross-session                 |
| Сразу после dispatch агента, проверить через 2 мин    | 1                          | Foreground agent уже notify'ит      |
| User Testing wait → пользователь даст ответ через ~1ч | 2                          | Сессия закроется во time of waiting |

**Не комбинируй оба слоя на same wait** — это дублирует wake-up'ы и spamит scheduled-tasks store.

**Связанная задача:** `.claude/tasks/task-harness-schedule-wakeup-persistence.md` — изначально NEEDS-USER. Layer 2 — полноценный workaround, harness-fix остаётся nice-to-have для unification API.

---

## Cross-session wake-up (mcp\_\_scheduled-tasks через pm-schedule.sh)

Используется для wait'ов которые могут не уложиться в текущую PM-сессию: длинный GHA E2E, deploy verification, daily checks.

### Generate parameters + create scheduled task

```bash
# 1. Подготовить параметры (вычисляет fireAt, материализует prompt, апдейтит pm-state.json)
JSON=$(bash scripts/pm/pm-schedule.sh \
  --delay-min 15 \
  --task-id-hint poll-e2e-pr42 \
  --description "Poll E2E run 26298999300 for PR #42" \
  --prompt-template poll-e2e-run \
  --prompt-var REPO=yaremenko-maksym/CheekyCheeseIT_CRM \
  --prompt-var RUN_ID=26298999300 \
  --prompt-var PR=42 \
  --state-file .claude/state/pm-state.json \
  --state-task-id task-knowledge-api)

# 2. Извлечь параметры из JSON
TASK_ID=$(echo "$JSON" | jq -r .taskId)
FIRE_AT=$(echo "$JSON" | jq -r .fireAt)
DESCRIPTION=$(echo "$JSON" | jq -r .description)
PROMPT=$(cat "$(echo "$JSON" | jq -r .promptPath)")
```

### Call MCP tool (из PM сессии)

```
mcp__scheduled-tasks__create_scheduled_task({
  taskId: <TASK_ID>,
  description: <DESCRIPTION>,
  fireAt: <FIRE_AT>,
  prompt: <PROMPT>
})
```

PM получает обратно taskId — это совпадает с `next_action.scheduled_task_id` в pm-state.json.

### Список и управление

```
mcp__scheduled-tasks__list_scheduled_tasks()
# → возвращает массив с taskId, description, fireAt, enabled, nextRunAt, lastRunAt, path

mcp__scheduled-tasks__update_scheduled_task({
  taskId: "<existing>",
  enabled: false   // disable не удаляя
})
```

### Доступные templates

| Template         | Use case                   | Required vars          |
| ---------------- | -------------------------- | ---------------------- |
| `poll-e2e-run`   | GHA E2E workflow result    | `REPO`, `RUN_ID`, `PR` |
| `poll-pr-checks` | Все CI checks на PR        | `REPO`, `PR`           |
| `poll-pr-merged` | Verify auto-merge сработал | `REPO`, `PR`           |

Подробнее — `scripts/pm/wakeup-prompts/README.md`.

### Dry-run (smoke test без реального scheduled task)

```bash
bash scripts/pm/pm-schedule.sh \
  --delay-min 5 \
  --task-id-hint smoke \
  --description "test" \
  --prompt-template poll-pr-checks \
  --prompt-var REPO=yaremenko-maksym/CheekyCheeseIT_CRM \
  --prompt-var PR=42 \
  --dry-run

# → JSON печатается в stdout, материализованный prompt в /tmp/pm-schedule-<id>.prompt.md,
# pm-state.json НЕ изменяется
```

---

## Workflow lookups (verification AutoTest не no-op)

```bash
# Сколько e2e-файлов изменил PR
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/<N>/files \
  --jq '[.[] | select(.filename | startswith("apps/e2e"))] | length'
```

Если `0` после AutoTest запуска — он не сделал работу (no-op). Создать новый task-файл и перезапустить.

---

## Coder hung — recovery (C1 detection layer)

После dev-flow RCA hook `.claude/hooks/post-edit-write-coder-progress.sh` пишет activity лог в `<main-repo>/.claude/coder-activity.log` (gitignored, TSV). PM использует его для detection silent termination.

Лог содержит **два типа** rows (поле `$2`):

- **`Edit`/`Write`/`MultiEdit`/`NotebookEdit`** — auto-hook PostToolUse, что Coder писал. Покрывает «живой ли».
- **`INTENT`** — explicit marker от Coder через `bash scripts/coder/coder-intent.sh "<text>"`. Покрывает «что планировал». См. `coder.md` секция 8.1.1.

Recovery flow: сначала смотри intents (контекст), потом file activity (progress).

### Шаг 1: Latest Coder activity

```bash
LOG="$(git rev-parse --git-common-dir 2>/dev/null)/../.claude/coder-activity.log"
LOG=$(cd "$(dirname "$LOG")" && pwd)/$(basename "$LOG")  # absolute path

# Семантический контекст — что Coder намеревался делать (intent markers, opt-in)
echo "── Last intents ──────────────────────────────"
awk -F'\t' '$2=="INTENT"' "$LOG" | tail -5

# Прогресс — какие файлы Coder реально писал (auto-hook)
echo "── Last edits ────────────────────────────────"
awk -F'\t' '$2!="INTENT"' "$LOG" | tail -10
```

Формат строки (5 tab-separated полей): `<ISO>\t<type>\t<branch>\t<cwd>\t<file_or_intent>`.

**Как интерпретировать пару intent+edit:**

| Последний INTENT                     | Последний Edit                 | Интерпретация                                                     |
| ------------------------------------ | ------------------------------ | ----------------------------------------------------------------- |
| `intent: starting test run for auth` | `apps/api/.../auth.service.ts` | Coder остановился в момент edit ПОСЛЕ старта tests                |
| `intent: AC #3 implementing`         | None после intent              | Coder обрывался ДО любого edit — задача на AC #3 не начата        |
| `intent: rebasing onto main`         | `apps/...` без вновь intent    | Rebase завершён, Coder начал работу — обрыв midway                |
| (нет INTENT в последнем часу)        | `apps/...`                     | Coder не записывал intent — recovery строится только на git state |

### Шаг 2: Detect hung

```bash
LAST_TS=$(tail -1 "$LOG" | cut -f1)
AGE_SEC=$(( $(date -u +%s) - $(date -u -d "$LAST_TS" +%s 2>/dev/null || date -ujf '%Y-%m-%dT%H:%M:%SZ' "$LAST_TS" +%s) ))

if [ "$AGE_SEC" -gt 600 ]; then
  echo "⚠️ Coder последний раз writeл $((AGE_SEC / 60)) мин назад — likely hung"
fi
```

### Шаг 3: Pick worktree from last entry

```bash
# Последняя активность ЛЮБОГО типа (INTENT или Edit) — для cwd/branch
LAST_CWD=$(tail -1 "$LOG" | cut -f4)
LAST_BRANCH=$(tail -1 "$LOG" | cut -f3)

echo "Last activity: $LAST_BRANCH в $LAST_CWD"
git -C "$LAST_CWD" log --oneline -5
git -C "$LAST_CWD" status --porcelain
```

### Шаг 4: Recover unpushed work

```bash
# Если есть uncommitted
git -C "$LAST_CWD" stash push -u -m "pm-recovery $(date -u +%Y%m%dT%H%M%SZ)"

# Если есть unpushed commits — push to remote (если pre-push hook требует ac_verified,
# либо проверить commit messages, либо использовать --no-verify в emergency).
git -C "$LAST_CWD" log --oneline HEAD..origin/$LAST_BRANCH  # обратное направление = unpushed
git -C "$LAST_CWD" push origin "$LAST_BRANCH"
```

### Шаг 5: Записать event

```json
{ "at": "<ISO>", "type": "coder_recovered", "branch": "<branch>", "unpushed_commits": <N>, "stashed": true/false }
```

### Для крупных задач — semantic milestone

Если Coder поддерживал `.claude/tasks/<task>.progress.md` (см. `coder.md` секция 8.2):

```bash
cat .claude/tasks/<task>.progress.md
# Видишь current_milestone — перезапускаешь Coder с явным "continue from milestone N+1"
```

---

## Common pitfalls — checklists

### После большого UI batch (User Testing → много правок)

После того как Coder завершил массовый UI fix-раунд, ДО объявления PR готовым к мерджу:

1. **Auto-dispatch AutoTest на specs update** — UI tests могут протухнуть от изменений селекторов:
   ```
   Agent(description="AutoTest: spec-update-PR-<N>",
     prompt="Ты — AutoTest. Прочитай .claude/agents/autotest.md.
   PR #<N> содержит UI batch — обнови селекторы в apps/e2e/tests/<module>.spec.ts
   target_branch: <pr_branch>")
   ```
2. **Ожидать E2E rebuild** — после AutoTest push CI re-run; ждать второго зелёного раунда:
   ```bash
   gh pr view <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM \
     --json statusCheckRollup --jq '.statusCheckRollup'
   ```
3. **НЕ диспетчить merge-approved до второго зелёного CI.** Первый раунд мог быть до AutoTest update — нужен второй чтобы проверить что новые тесты тоже зелёные.
4. **Записать в pm-state.json** event `autotest_post_ui_batch` с PR номером — это маркер «UI rounds потребовали re-test».

### После migration rebuild (Drizzle schema change)

После того как Coder сделал миграцию, до User Testing:

1. **Создать DevOps task на `__drizzle_migrations` sync** если миграции были созданы вручную или переименованы:

   ```markdown
   # task-infra-migrations-sync

   ## Агент: devops

   ## Контекст

   В PR #<N> добавлена/изменена миграция. Проверить что `__drizzle_migrations` table sync с `drizzle/migrations/meta/_journal.json` — иначе db:migrate упадёт на fresh DB.

   ## AC

   - [ ] `pnpm --filter @crm/api db:init-tracking` синхронизирует state
   - [ ] Smoke test: `docker-compose down -v && docker-compose up -d && pnpm db:migrate && pnpm db:seed` проходит без ошибок
   ```

2. **Smoke test fresh-DB flow** до User Testing — если миграции не применяются на чистой БД, User Testing будет видеть данные но fresh deploy сломается.
3. **Записать в pm-state.json** event `migration_rebuild_required` с PR номером.

---

## Типичные длительности агентов

| Тип задачи                                        | Ожидаемое время                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| Coder: 1-2 файла                                  | 8-12 мин                                                         |
| Coder: модуль (3-6 файлов)                        | 15-25 мин                                                        |
| Coder: большой модуль (7+)                        | 25-40 мин                                                        |
| AutoTest: написание/обновление тестов             | 8-15 мин                                                         |
| code-reviewer: code review (small/medium PR)      | 5-10 мин                                                         |
| code-reviewer: large PR (>500 LOC)                | 10-15 мин                                                        |
| security-reviewer: small PR (auth/finance touch)  | 8-12 мин                                                         |
| security-reviewer: large PR + npm audit + WebSearch CVE | 15-25 мин                                                  |
| DevOps: workflow изменения                        | 5-10 мин                                                         |
| E2E через e2e.yml (GHA)                           | 10-20 мин — использовать `ScheduleWakeup(delay=270)` или Layer 2 |
| Legal: Mode A consult (static база покрывает)     | 5-8 мин                                                          |
| Legal: Mode A consult (нужен WebSearch)           | 10-15 мин                                                        |
| Legal: Mode B pr-review (small PR)                | 8-12 мин                                                         |
| Legal: Mode B pr-review (large finance/auth + S3) | 15-25 мин                                                        |
| Legal: Mode C brief-check                         | 8-12 мин                                                         |
| Legal: Mode D strategic (deep question)           | 10-20 мин                                                        |

**Foreground агенты** блокируют PM до завершения — результат приходит сразу.
**Background агенты** (`run_in_background=True`) — PM получает уведомление автоматически.

---

## Именование веток

- `feature/<slug>` — новая фича (Coder)
- `test/<slug>` — тесты (AutoTest standalone)
- `infra/<slug>` — инфраструктура (DevOps)
- `fix/<slug>` — фикс бага или E2E

---

## Структура `.claude/tasks/`

```
.claude/tasks/
├── task-<slug>.md            # активная задача
├── task-<slug>.blocked.md    # блокер от агента
├── task-<slug>.progress.md   # sentinel Coder для крупных задач (>4 файлов)
├── templates/
│   └── task.md.tpl
└── archive/
    └── <date>-<slug>.md      # завершённые задачи
```

### Правила именования task-файлов

- Новая фича: `task-<module>-<aspect>.md` (`task-knowledge-api.md`)
- Фикс от reviewer (code-reviewer / security-reviewer / оба): `task-fix-pr-<N>.md`
- Фикс E2E: `task-fix-e2e-<slug>.md`
- Фикс теста: `task-fix-test-<slug>.md`
- Фикс от user testing: `task-fix-<short-description>.md`

---

## pm-state.json schema v2

Файл локальный, gitignored. PM пишет и читает между сессиями. Формат поддерживает события и метрики.

```json
{
  "feature": "Knowledge Base",
  "brief": ".claude/briefs/pm-brief.md",
  "started_at": "2026-05-18T10:00:00Z",
  "phase": "development",
  "active": [
    {
      "id": "task-knowledge-api",
      "file": ".claude/tasks/task-knowledge-api.md",
      "agent": "coder",
      "branch": "feature/knowledge-api",
      "pr_number": null,
      "status": "running",
      "started_at": "2026-05-18T10:00:00Z",
      "review_rounds": 0,
      "max_review_rounds": 5,
      "agent_invocations": {
        "coder": 1,
        "code_reviewer": 0,
        "security_reviewer": 0,
        "autotest": 0,
        "devops": 0,
        "legal": 0
      },
      "events": [{ "at": "2026-05-18T10:00:00Z", "type": "agent_started", "agent": "coder" }],
      "pending_fixes": []
    }
  ],
  "completed": [
    {
      "id": "task-fix-pr22-ui-round5",
      "duration_min": 18,
      "rounds": 5,
      "regression_count": 1,
      "agent_invocations": {
        "coder": 5,
        "code_reviewer": 4,
        "security_reviewer": 2,
        "autotest": 1,
        "devops": 0,
        "legal": 1
      },
      "merged_at": "2026-05-20T07:03:35Z",
      "pr_number": 22
    }
  ],
  "blocked": [],
  "blocking_issue": null
}
```

### Поля

**Top-level:**

- `feature` — название текущей фичи
- `brief` — путь к pm-brief.md
- `started_at` — когда PM стартовал работу
- `phase` — `development` / `user-testing` / `merging` / `archived`
- `active[]` — текущие незавершённые задачи
- `completed[]` — завершённые задачи (для метрик)
- `blocked[]` — заблокированные (с `.blocked.md`)
- `blocking_issue` — глобальный blocker (например, `e2e-broken` на main)

**Active task:**

- Базовые: `id`, `file`, `agent`, `branch`, `pr_number`, `status`
- `review_rounds` — счётчик раундов (circuit breaker `>=3`)
- `agent_invocations` — счётчики dispatch
- `events[]` — лог событий
- `pending_fixes[]` — правки от User Testing

**Event types:**

- `agent_started` — `{ at, type, agent, task_file? }`
- `agent_finished` — `{ at, type, agent, result: "success"|"blocked"|"no-op" }`
- `brief_approved` — `{ at, type, brief }` — BA brief принят, PM приступил к decomposition
- `task_file_created` — `{ at, type, file }` — PM создал новый task-file для Coder/AutoTest/DevOps
- `pr_opened` — `{ at, type, pr }`
- **`code_review_started`** — `{ at, type, pr }` — PM dispatched code-reviewer
- **`code_review_done`** — `{ at, type, pr, verdict: "APPROVE"|"BLOCK", rounds, findings_count? }` — code-reviewer завершил, Verdict parsed из first line review body. Default reviewer post Phase 3b.
- **`security_review_started`** — `{ at, type, pr, triggered_paths: [...] }` — PM dispatched security-reviewer (только когда PR трогает critical-path zones)
- **`security_review_done`** — `{ at, type, pr, verdict: "APPROVE"|"BLOCK", rounds, owasp_categories_hit?: [...], findings_count? }` — security-reviewer завершил
- `security_dispatched` — `{ at, type, pr, triggered_paths: [...] }` — alias для security_review_started (PM шорт-форма при логировании в Mode 2 таблице)
- `review_timeout` — `{ at, type, pr, agent: "code-reviewer"|"security-reviewer", dispatched_at, timeout_at }` — reviewer не вернул verdict за 2× expected duration (Mode 2.F)
- `review_rejected` — `{ at, type, pr, rounds }` (от внешних non-AI reviewer-ов через REQUEST_CHANGES)
- `autotest_skipped` — `{ at, type, reason }` — skip без записи запрещён
- `worktree_isolation_warning` — `{ at, type, files: [...] }`
- `e2e_started` — `{ at, type, run_id }`
- `e2e_passed` — `{ at, type, run_id }`
- `e2e_failed` — `{ at, type, run_id, failure_type: "code"|"test"|"infra" }`
- `user_approved` — `{ at, type, pr }`
- `merge_approved_label` — `{ at, type, pr }`
- `do_not_merge_label` — `{ at, type, pr, reason }`
- `merged` — `{ at, type, pr }`
- `wakeup_scheduled` — `{ at, type, scheduled_task_id, fireAt }`
- `legal_dispatched` — `{ at, type, mode, target }` — PM запустил Legal через `Agent()`. `mode` ∈ {consult, pr-review, brief-check, strategic}. `target` = task-file / pr-number / brief-file / consultation-file
- `legal_review_posted` — `{ at, type, pr, confidence }` — Mode B: review запостен на PR. `confidence` ∈ {HIGH, MED, LOW}
- `legal_pre_feature_done` — `{ at, type, brief, recommendations_count }` — Mode C: Legal вернул recommendations для AC
- `legal_escalated_to_human` — `{ at, type, reason }` — Mode B/A: Confidence: LOW + hard zone → USER informed эскалировать к human-юристу

**Deprecated (historical, не пишутся новые) — преобразование post Phase 3b:**

- `review_approve` — заменено на `code_review_done` с `verdict: "APPROVE"`. Историческое legacy в `completed[]` оставить как есть.
- `review_blocked` — заменено на `code_review_done` ИЛИ `security_review_done` с `verdict: "BLOCK"`. Историческое legacy оставить.

**Aggregate verdict (не event, а derived state в memory PM):**

PM объединяет `code_review_done` + (опц.) `security_review_done` в aggregate per `pm.md` Mode 2 "Aggregate verdict logic". Aggregate не пишется как отдельный event — derived при чтении `events[]`.

Полный документ возможных types — `.claude/state/events.md`.

**Completed task** (агрегаты для метрик):

- `duration_min` — от `started_at` до `merged_at`
- `rounds` — итоговое число review_rounds
- `regression_count` — сколько раз round*N сломал что-то из round*{N-1}
- `agent_invocations` — финальные счётчики
- `merged_at`, `pr_number`

### Статусы задачи

`running` → `pr_open` → `awaiting_pm_review` → `user_testing` → `e2e_running` → `merged` | `failed`

Промежуточные: `blocked` (есть `.blocked.md`), `pending_fixes` (User Testing вернул правки).

### Метрики (из completed[])

- `avg(rounds)` — среднее число раундов на задачу (цель: ≤ 2)
- `avg(duration_min)` — среднее от старта до merge
- `sum(regression_count) / count(*)` — частота регрессий
- Распределение `agent_invocations.coder` — сколько раз перезапускали Coder

---

## GHA Secrets (актуальные)

| Secret                    | Для чего                      |
| ------------------------- | ----------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | claude-code-action auth       |
| `JWT_SECRET`              | E2E тесты (auth через cookie) |

---

## Полезные команды мониторинга

```bash
# Список open PR
gh pr list --repo yaremenko-maksym/CheekyCheeseIT_CRM --state open

# Labels на PR
gh pr view <pr_number> --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --json labels --jq '[.labels[].name]'

# PR reviews
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/<N>/reviews \
  --jq '.[] | {state, body}'

# Найти PR по ветке
gh pr list --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --head "feature/<slug>" --json number --jq '.[0].number'

# Мониторинг GHA E2E
gh run list --repo yaremenko-maksym/CheekyCheeseIT_CRM --workflow=e2e.yml --limit 5
gh run view <run_id> --repo yaremenko-maksym/CheekyCheeseIT_CRM --json status,conclusion
gh run view <run_id> --repo yaremenko-maksym/CheekyCheeseIT_CRM --log-failed
```
