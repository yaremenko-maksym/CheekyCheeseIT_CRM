# Task: dev-flow post-mortem — agent .md fixes

## Агент: ai-architect (PM-zone, не Coder)

## Ветка: infra/dev-flow-fixes (та же что у DevOps — соавторы)

## Файлы:

- `.claude/agents/{pm,coder,reviewer,autotest,devops}.md` — поведенческие фиксы
- `.claude/agents/CLAUDE-pm.md` — schema + лимитации ScheduleWakeup
- `.claude/agents/memory/README.md` — приоритетная схема + topic tag
- `.claude/agents/memory/*/lessons.md` — retro-tag существующих уроков (P0/P1/P2)
- `.github/labels.yml` (NEW) — labels-as-code, в т.ч. `ci-failed` который сейчас отсутствует
- `docs/architecture/2026-05-23-dev-flow-rca.md` (NEW) — RCA-документ
- `.claude/tasks/task-*.md` (NEW sub-tasks для follow-up работы)

## Контекст

После сессии `2026-05-23 projects-senior-share-override` всплыли 7 проблем dev-flow (C1-C3 для агентов, D1-D4 для оркестрации). DevOps в той же ветке `infra/dev-flow-fixes` фиксит `scripts/pm/prep-user-testing.sh` (см. `task-infra-dev-flow-scripts.md`). Architect добавляет коммиты для `.md` файлов агентов и их взаимодействий.

Цель: устранить корневые причины, не симптомы. Manual workarounds после каждой грабли уже накопили технический долг.

## Каталог проблем

### C-группа (Coder/Reviewer стабильность)

**C1 [P0] — Coder silently завершается без push.**
Runtime watchdog обрезает stream после ~12 мин / ~200k токенов. Summary показывает «Let me check...» midway, `git log` пуст — работа потеряна. Текущая защита (секция 7 «task chunking» с `wip:` пушами на > 3 файлов) недостаточна — Coder часто не доходит до первого милстоуна.

Решение: ужесточить threshold (`wip:` после **каждых 2 файлов ИЛИ каждых 5 минут**), плюс sentinel-pattern `<task>.progress.md` — Coder пишет статус после каждого милстоуна, PM проверяет наличие при таймауте.

**C2 [P1] — Reviewer stall на posting через `mcp__github__create_pull_request_review`.**
Review-тело сформировано, но MCP-вызов висит >10 мин → watchdog crash → review не появляется на PR.

Решение: bounded retry + fallback на `gh pr review` через Bash. Сохранять тело review в файл ДО posting attempt → manual recovery если MCP не отвечает.

**C3 [P2] — Worktree isolation leaks.**

- Coder screenshots появляются в чужих worktrees (через широкий `git add .` или scratch-файлы вне `.gitignore`)
- Coder discardит PM-патчи к `scripts/pm/` (думает «PM scripts — не настоящий код, можно перезаписать»)

Решение: явная zone-of-write в `coder.md` — `scripts/pm/**` запрещён для Coder; гигиена git add ужесточена.

### D-группа (оркестрация)

**D1 [P0] — ScheduleWakeup не выживает между sessions.**
PM ставит ScheduleWakeup на 2 часа, session заканчивается до fire'а → wake-up теряется. Это harness-level баг. PM-агент не должен полагаться на ScheduleWakeup для cross-session ожидания.

Решение: документировать лимитацию в `CLAUDE-pm.md`; fallback — polling-pattern для cross-session ожидания; sub-task для harness-level fix (out of scope этого PR).

**D2 [P1] — Label `ci-failed` упоминается в `pm.md`, но не существует в repo.**
PM пытается читать/выставлять label, который GitHub отвечает 404.

Решение: создать `.github/labels.yml` как декларативный source of truth для всех labels (включая `ci-failed`). Sub-task для DevOps — GHA workflow синхронизирующий yml с repo через `crazy-max/ghaction-github-labeler`.

**D3 [P2] — AutoTest dispatch redundant.**
Если Coder уже добавил comprehensive E2E (`apps/e2e/tests/<module>.spec.ts` с покрытием AC), PM запускает AutoTest зря — он либо дублирует, либо вообще no-op'ит.

Решение: в `pm.md` Mode 2 — условный диспетч. PM проверяет diff PR на наличие spec-файлов; если есть и покрытие выглядит достаточным — записывает `autotest_skipped` с `reason: "coder-added-e2e"` без диспетча.

**D4 [P2] — Memory lessons.md без приоритетного шаблона.**
Все уроки равноправны в plain markdown. Невозможно отличить «критичное правило» от «полезного замечания».

Решение: приоритетный префикс `[P0]/[P1]/[P2]` + опциональный topic-тег `#tunnel/#tdd/#review` в формате строки. Retroactive tag для существующих уроков. Документация в `memory/README.md`.

## Архитектурные вопросы (обсудить в RCA)

1. **Single source of truth для PM-only scripts** — как помешать Coder перезаписывать `scripts/pm/`?
2. **User Testing flow** — hot-reload vs production rebuild? Сейчас production — 30-40s rebuild на каждый цикл.
3. **Coder retry self-check** — sentinel-pattern или harness-level integration?
4. **PM memory** — структурный (YAML/JSON) vs append-md?

## Acceptance Criteria

- [ ] **AC1.** Каждая из 7 проблем (C1-C3, D1-D4) либо имеет фикс в `.md`, либо явно отложена в sub-task с обоснованием.
- [ ] **AC2.** `pnpm typecheck` зелёный (касаемся только .md и .yml).
- [ ] **AC3.** `pnpm lint` зелёный.
- [ ] **AC4.** RCA-документ `docs/architecture/2026-05-23-dev-flow-rca.md` создан, содержит:
  - Корневую причину (не симптом) по каждой группе
  - Дизайн-решение что применено
  - Open questions для follow-up
- [ ] **AC5.** `.github/labels.yml` создан, включает `ci-failed` + все существующие labels.
- [ ] **AC6.** Sub-tasks для harness-level фиксов (D1) и follow-up DevOps (label-sync GHA) созданы по шаблону `templates/task.md.tpl`.
- [ ] **AC7.** `pm.md` Mode 4 step 0 синхронизирован с DevOps-фиксом скрипта (LocalTunnel → Serveo + SKIP_UNIT_TESTS env).
- [ ] **AC8.** Все коммиты имеют explicit reasoning в body (не только subject).

## Out of scope

- `scripts/pm/**` — DevOps зона
- `apps/`, `packages/` — продукт
- `docs/specs/pm-state-archive/` — read-only
- Harness-level фиксы для D1 (ScheduleWakeup persistence) — sub-task для будущей итерации
- GHA workflow для label-sync — sub-task для DevOps

## PR

Совместный PR `infra/dev-flow-fixes` — DevOps + Architect. Title уже выставлен DevOps'ом (`infra: prep-user-testing.sh macOS compat + idempotency + auto-detect worktree`), в финальном body будет секция «AI Architect commits» от меня.
