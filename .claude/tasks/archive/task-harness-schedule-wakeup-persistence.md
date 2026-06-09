# Task: ScheduleWakeup persistence через session boundaries (harness-level)

## Статус: PARTIALLY RESOLVED — Layer 2 (workaround) реализован 2026-05-23 в `infra/needs-user-d1-c1`

## Агент: NEEDS-USER — для harness API unification (опционально, P2)

## Приоритет: было P0 → стало P2 (функциональность есть через Layer 2, осталось унификация)

## Зависит от: `task-arch-agents-md-fixes.md` (RCA выявил проблему)

## Ветка: `infra/needs-user-d1-c1` (Layer 2 implementation)

## Контекст (исходный)

После dev-flow ретроспективы зафиксирована проблема **D1 [P0]: ScheduleWakeup пропускается между sessions**.

Текущее поведение (до Layer 2):

- PM-агент вызывает `ScheduleWakeup(delay=270)` чтобы ждать GHA E2E (~5 мин)
- Сессия PM-агента заканчивается (timeout, context cap) до fire'а
- ScheduleWakeup не выживает session boundary → wake-up теряется → PR висит без действия

## Resolution (Layer 2)

Реализован подход **B** из исходного task — PM использует `mcp__scheduled-tasks__create_scheduled_task` для cross-session waits через bash-wrapper.

**Артефакты:**

- `scripts/pm/pm-schedule.sh` — pre-processor для MCP-вызова:
  - Вычисляет `fireAt` в local TZ (BSD/GNU date compat)
  - Генерит unique `taskId` (kebab-case + UTC timestamp suffix)
  - Материализует self-contained prompt из `scripts/pm/wakeup-prompts/<template>.md`
  - Атомарно апдейтит `pm-state.json` (event `wakeup_scheduled` + `next_action`)
  - Output JSON: `{taskId, fireAt, description, promptPath, promptSize}`
- `scripts/pm/wakeup-prompts/` — self-contained PM continuation templates:
  - `poll-e2e-run.md` — GHA E2E workflow result
  - `poll-pr-checks.md` — все CI checks на PR
  - `poll-pr-merged.md` — verify auto-merge сработал
  - `README.md` — гайд по добавлению новых templates
- `docs/agents/CLAUDE-pm.md` — секция «⚠️ ScheduleWakeup limitations» с двумя слоями (Layer 1 = ScheduleWakeup, Layer 2 = mcp\_\_scheduled-tasks)
- `docs/agents/pm-snippets.md` — сниппет «Cross-session wake-up (mcp\_\_scheduled-tasks через pm-schedule.sh)»
- `docs/agents/memory/pm/lessons.md` — урок о выборе слоя

**Smoke tests:** 8 проверок прошли — `--help`, validation errors (exit 2/3/4), dry-run prompt materialization, реальный state-file update (event + next_action прописываются атомарно через jq), ghost state-task-id rejection.

**Acceptance criteria (исходные) — статус:**

- [x] Документация в `CLAUDE-pm.md` — оба слоя описаны с матрицей выбора
- [x] Тестовый случай для длинного wait — smoke tests покрывают (E2E можно мониторить через scheduled-tasks независимо от source session)
- [x] pm.md / CLAUDE-pm.md обновлены — Mode 2 wakeup logic ссылается на pm-snippets.md «Cross-session wake-up»

## Что остаётся (опционально, NEEDS-USER P2)

**Harness API unification:** добавить флаг `ScheduleWakeup(delay, persistent=True)` который транспарентно использует `mcp__scheduled-tasks` backend для `persistent=True`. Тогда PM не нужен bash-wrapper — single API.

**Не блокирует продакшен** — current Layer 2 решает D1 полноценно. Это nice-to-have для DX.

## Запрещено трогать

- `apps/`, `packages/` — это infra/harness, не продукт
- Прочие .md агентов — только pm.md и CLAUDE-pm.md
