# docs/agents/ Changelog

Append-only changelog для multi-agent инфраструктуры.

---

## 2026-06-02 — Architecture v2 (this refactor)

PR: `refactor(agents): мульти-агент docs v2 — golden rules, no duplication, lessons rotation`
Branch: `feat/multiagent-docs-v2-implementation`
Phase 1 (audit + design): PR #77 (`chore/multiagent-docs-refactor`).

### Added

- **`RULES.md`** — single source для cross-agent rules:
  - §1 Tool priority (MCP / native / Bash + MCP catalog) — заменяет `CLAUDE-tools.md`
  - §2 Git commit hygiene + forbidden patterns (zero-tolerance таблица)
  - §3 Skill catalog (mandatory trigger → skill mapping, 16 mappings)
  - §4 Session recovery (универсальный + per-agent)
  - §5 Zone-of-write contract (полная таблица для всех 6 агентов)
  - §6 Memory & lessons protocol (trigger-based ротация, skill-driven)
  - §7 Version pins (canonical)
- **`project-state.md`** — facts inventory (single source of truth):
  - §1 Phases status — заменяет дубли в `CLAUDE.md` / `CLAUDE-ba.md` / `CLAUDE-pm.md` / `CLAUDE-coder.md`
  - §2 Tech stack
  - §3 RBAC матрица + sidebar visibility
  - §4 Бизнес-правила (Teams / Projects / Interviews / Finance / Documents-Profile)
  - §5 Drizzle миграции 0000-0011 + активные DB таблицы
  - §6 Shared schemas inventory
  - §7 Auth (Google OAuth, Dev Login)
  - §8 Design system компоненты
  - §9 Tech gotchas
  - §10 Seed данные для тестов
  - §11 CI/CD pipeline актуальный (активные + архивные workflows)
- **`contracts.md`** — cross-agent state machine (Mermaid diagrams):
  - §1 High-level flow
  - §2 Labels lifecycle (single source of truth) + state machine
  - §3 Sequence diagrams (happy path / BLOCK / E2E fail / compaction recovery)
  - §4 Task file → agent mapping
  - §5 AutoTest dispatch decision
  - §6 Reviewer verdict semantics
  - §7 Coder watchdog — recovery layers
  - §8 Out-of-band escalation
- **`README.md`** — entry point для `docs/agents/` (быстрая навигация, onboarding, token budget)
- **`CHANGES.md`** (этот файл) — migration log

### Changed

- **`<agent>.md` (6 файлов: pm / coder / reviewer / autotest / devops / ba)** — новая структура:
  - **🔴 Golden rules (zero tolerance)** — 5-7 правил в начале каждого файла, unmissable
  - **Session-recovery (after compaction / cold start)** — sub-section с конкретными командами
  - **Mandatory skill invocation** — explicit trigger → skill таблица (subset из `RULES.md` §3)
  - **Workflow** (краткий, реальный — без дубликатов)
  - **Reference** (on-demand линки)

  Сокращение размеров:
  | Doc | Было | Стало | Δ |
  |-----|------|-------|---|
  | coder.md | 580 строк / 34 KB | ~210 / ~14 KB | **-59%** |
  | pm.md | 410 / 24 KB | ~220 / ~14 KB | **-42%** |
  | reviewer.md | 300 / 20 KB | ~210 / ~13 KB | **-35%** |
  | autotest.md | 289 / 16 KB | ~250 / ~13 KB | **-19%** |
  | devops.md | 230 / 12 KB | ~210 / ~11 KB | **-8%** |
  | ba.md | 260 / 16 KB | ~200 / ~10 KB | **-38%** |

- **`pm-snippets.md`** — добавлены секции (раньше были в `CLAUDE-pm.md`, теперь stub):
  - «ScheduleWakeup limitations» (D1 [P0]) — Layer 1 vs Layer 2 матрица + workflow
  - Типичные длительности агентов
  - Именование веток
  - Структура `docs/specs/tasks/`
  - pm-state.json schema v2 (event types, completed agregates, статусы)
  - GHA Secrets (актуальные)
  - Полезные команды мониторинга

- **`memory/README.md`** — переписан:
  - Per-agent archive structure (`memory/<agent>/lessons.archive.md`)
  - Trigger-based ротация (после merged PR + threshold 20 строк, было 30)
  - Skill-driven consolidation через `anthropic-skills:consolidate-memory`
  - Promotion levels: P0 (5+ повторений) → Golden rules; P1 → `RULES.md`; P2 → archive

- **`scripts/pm/wakeup-prompts/*.md`** — обновлены ссылки на новую структуру:
  - `poll-e2e-run.md` / `poll-pr-checks.md` / `poll-pr-merged.md` / `README.md` — `CLAUDE-pm.md` → `RULES.md` + `project-state.md` + `pm-snippets.md` (секция «Cross-session wake-up»)

### Deprecated (redirect stubs)

Чтобы не сломать archived workflows (`.github/workflows/archive/coder.yml`, `autotest.yml`, `devops.yml`, `ai-review.yml`) и legacy task-файлы, эти файлы сохранены как 1-block redirect stubs:

- `CLAUDE-pm.md` → `pm.md` + `project-state.md` + `RULES.md` + `contracts.md` + `pm-snippets.md`
- `CLAUDE-coder.md` → `coder.md` + `project-state.md` + `RULES.md`
- `CLAUDE-reviewer.md` → `reviewer.md` + `project-state.md` + `RULES.md` + `contracts.md`
- `CLAUDE-autotest.md` → `autotest.md` + `project-state.md` + `RULES.md`
- `CLAUDE-devops.md` → `devops.md` + `project-state.md` + `RULES.md` + `contracts.md`
- `CLAUDE-ba.md` → `ba.md` + `project-state.md` + `RULES.md` + `contracts.md`
- `CLAUDE-tools.md` → `RULES.md` §1 + §3

Stub содержит: 1-line deprecation banner + redirect ссылки. Любой агент, который попытается прочитать stub, увидит куда идти. Постепенно ссылки в archive workflows / task-файлах могут быть обновлены DevOps task'ом.

### Memory archive

- Создан `lessons.archive.md` для каждого агента (`coder`, `autotest`, `reviewer`, `devops`, `pm`). Сейчас пустые — rotation ещё не запускалась. Все lessons (< 20 строк per agent) остаются в active `lessons.md`.

### Migration notes

1. **PM dispatch промпт пора обновить.** В `pm-snippets.md` обновлены `Agent(prompt=...)` сниппеты — теперь читают `coder.md` + `RULES.md` + `project-state.md` + `memory/coder/lessons.md` (4 файла, ~25 KB) вместо `coder.md` + `CLAUDE-coder.md` + `CLAUDE-tools.md` + `memory/coder/lessons.md` (4 файла, ~58 KB).

2. **`.github/workflows/archive/*.yml`** — содержат старые ссылки на `CLAUDE-<agent>.md`. Stubs обеспечивают backward compat. Если когда-то workflows будут восстановлены, DevOps task должен обновить промпты на новую структуру.

3. **Legacy task-файлы** в `docs/specs/tasks/task-drop-phase*.md` и др. — содержат старые ссылки на `CLAUDE-coder.md`. Stubs обеспечивают backward compat.

4. **Корневой `CLAUDE.md`** обновлён top-level pointer'ом на `docs/agents/README.md` + `RULES.md` + `project-state.md`.

5. **`memory/README.md`** ротация policy изменилась — теперь skill-driven (`anthropic-skills:consolidate-memory`), не manual threshold.

### Removed

(ничего удалено — только deprecated stubs)

### Self-test

После рефакторинга проведён self-test: dispatch тестового Coder агента на typo fix в существующем comment. Verify по чек-листу:

- [x] Прочитал новые docs (RULES.md / project-state.md / coder.md)
- [x] Соблюдает golden rules
- [x] Не пытается `--no-verify`
- [x] Содержит proof of push в final report

Результат — см. PR description.

---

## История изменений до этого refactor

- **2026-05-23** — dev-flow RCA (wip-push 2/5, intent markers, sentinel `<task>.progress.md`, zone-of-write enforcement, write-then-post review)
- **2026-05-21** — Reviewer Verdict: BLOCK pattern (`COMMENT` event + первая строка тела) — workaround GitHub API restriction (`REQUEST_CHANGES` запрещён когда author == reviewer)
- **2026-05-20** — git add discipline (PR #22 round4 incident — Coder подмёл чужие debug-артефакты)
- **2026-05-19** — data-testid обязателен для back-button / dialog-close / cancel-button
- Ранее — итеративная эволюция CLAUDE-X.md + X.md split (роли не соблюдались, см. `architect-audit.md` §4.2)
