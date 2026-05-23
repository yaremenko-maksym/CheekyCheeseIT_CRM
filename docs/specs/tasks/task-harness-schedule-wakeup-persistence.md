# Task: ScheduleWakeup persistence через session boundaries (harness-level)

## Агент: NEEDS-USER (требует harness changes, не делегируемо AI-агенту)
## Приоритет: high (P0 проблема, но workaround в `CLAUDE-pm.md` уже задокументирован)
## Зависит от: `task-arch-agents-md-fixes.md` (RCA выявил проблему)
## Ветка: TBD

## Контекст

После dev-flow ретроспективы зафиксирована проблема **D1 [P0]: ScheduleWakeup пропускается между sessions**.

Текущее поведение:
- PM-агент вызывает `ScheduleWakeup(delay=270)` чтобы ждать GHA E2E (~5 мин)
- Сессия PM-агента заканчивается (timeout, context cap) до fire'а
- ScheduleWakeup не выживает session boundary → wake-up теряется → PR висит без действия

Workaround в `CLAUDE-pm.md` (этот PR): polling-pattern с `ScheduleWakeup(delay=270)` + сохранение `next_wakeup_at` в `pm-state.json`. При старте новой session — Mode 3 (continuation) читает state и инициирует pollловку. Но это не решает корень — мы по-прежнему теряем wake-up'ы между sessions.

## Что нужно от harness

Один из двух подходов:

### A. Persistent ScheduleWakeup
ScheduleWakeup сохраняется в external scheduler (cron/system timer/Redis-queued task), при fire'е harness стартует новую Claude session с переданным `prompt`. Это уже частично реализовано в `mcp__scheduled-tasks__*` (Remote Agents / Routines) — нужно verify что MCP-серверная версия:
1. Гарантированно fire'ит независимо от source-session lifecycle
2. Получает текущий prompt + state from `pm-state.json` для контекста

### B. PM-side cron registration
PM-агент вместо `ScheduleWakeup` использует `mcp__scheduled-tasks__create_scheduled_task` для критичных wake-up'ов (E2E ожидание, deploy verification). Минус: создаёт «remote agents» которые могут не иметь нужного context'а.

## Acceptance criteria

- [ ] Документация в `CLAUDE-pm.md` — какой подход рекомендован
- [ ] Тестовый случай: создать PR с известным slow CI (~15 мин), PM ставит ScheduleWakeup, верифицировать что wake-up'ы fire'ятся даже если PM session завершилась
- [ ] Обновить pm.md Mode 4 / Mode 2 — какие именно wake-up'ы критичны для persistence

## Запрещено трогать

- `apps/`, `packages/` — это infra/harness, не продукт
- Прочие .md агентов — только pm.md и CLAUDE-pm.md

## Why this is NEEDS-USER

Требует решения на уровне harness Claude Code или интеграции с external scheduler — за пределами того что AI-агент может сделать в зоне записи. AI-агенты только используют harness API, не строят его.
