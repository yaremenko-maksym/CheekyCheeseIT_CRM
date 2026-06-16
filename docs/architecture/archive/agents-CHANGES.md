> **ARCHIVED 2026-06-16:** исторический changelog агентной инфраструктуры (миграция architecture v2). Сохранён для retrospective. Актуальная история — `.claude/agents/README.md` §История.

# docs/agents/ Changelog

Append-only changelog для multi-agent инфраструктуры.

---

## 2026-06-04 — UI/UX Designer agent + ECC frontend skills adoption

PR: `infra(agents): add ui-ux-designer + 4 ECC frontend skills`
Branch: `infra/register-manual-qa-and-designer` (объединено в один PR с Manual QA registration)

### Added

- **`ui-ux-designer.md`** — новый агент, model: sonnet. 4 режима:
  - **Mode A — Design Direction (pre-feature):** brief → `docs/design/<slug>.md` spec (purpose / audience / tone / tokens / components / motion / a11y critical paths) → handoff Coder.
  - **Mode B — Visual Audit (post-impl):** PR с UI changes → 10-dimension audit (`design-system` Mode 2) + WCAG check → PR comment с verdict `PASS | POLISH-REQUESTED | BLOCK`.
  - **Mode C — AI-slop check:** generic AI pattern detection (purple gradients / glass morphism без обоснования / oversized hero) → `BLOCK` с fix proposal.
  - **Mode D — Polish pass:** cosmetic Edit в `apps/web/**` (concentric radius / tabular-nums / transition scope / hit areas) с re-verify скриншотом.
- **`memory/ui-ux-designer/lessons.md`** + `lessons.archive.md` — placeholder.
- **`.claude/skills/accessibility/SKILL.md`** — adopt из ECC (WCAG 2.2 Level AA, POUR principles, cross-platform mapping). Origin: ECC.
- **`.claude/skills/frontend-design-direction/SKILL.md`** — adopt из ECC (5-question direction framework, anti-patterns, review checklist). Origin: community salvage из ECC.
- **`.claude/skills/design-system/SKILL.md`** — adopt из ECC (Mode 1 Generate / Mode 2 Audit 10-dim / Mode 3 AI-slop detection). Origin: ECC.
- **`.claude/skills/make-interfaces-feel-better/SKILL.md`** — adopt из ECC (concentric radius / optical alignment / tabular numerals / motion defaults / hit areas). Origin: community salvage из ECC.

### Changed

- **`README.md`** — добавлен row UI/UX Designer в Agent system prompts + 4 новых skills в Skills таблице.
- **`contracts.md`** — Designer добавлен в:
  - §1 High-level flow Mermaid (BA brief → PM → Designer Mode A → spec → Coder; PR → Designer Mode B параллельно с Reviewer / Manual QA).
  - §4 Task file → agent mapping (`task-design-<slug>.md` для Mode A, inline brief для Mode B / C / D).
  - новая §5.2 UI/UX Designer dispatch decision.
- **`pm-snippets.md`** — добавлен dispatch snippet для UI/UX Designer (4 режима, fallback через `claude` subagent_type до cache refresh).

### Rationale

Multi-agent flow до этого не имел дизайнерского слоя — UI решения принимались inline в Coder workflow без proper design direction (1+ итерация design rework в каждом UI PR). Также не было systematic visual audit перед merge (только code-reviewer статика + Manual QA реальный flow). Designer закрывает gap между BA brief и Coder implementation для UI-heavy фич + добавляет structured visual audit как параллельный 4-й verdict наряду с code-reviewer / security-reviewer / Manual QA.

ECC skills (`accessibility` / `frontend-design-direction` / `design-system` / `make-interfaces-feel-better`) — battle-tested на ECC user-base, adopt'аются без modifications (origin field сохранён). Skills работают вместе с локальным `playwright-patterns` skill (CRM-specific cookbook).

### Migration notes

- Future PRs: PM для UI-heavy фич dispatch'ит Designer Mode A в начале (до Coder); для любого UI PR — Designer Mode B параллельно с code-reviewer.
- До harness cache refresh — fallback `subagent_type: claude` + inline system prompt из `ui-ux-designer.md`.
- `docs/design/` папка создаётся при первом Mode A dispatch'е (не pre-emptively).

---

## 2026-06-04 — Manual QA agent registration

(в том же PR что и UI/UX Designer registration выше — branch `infra/register-manual-qa-and-designer`)

Файл `.claude/agents/manual-qa.md` существовал с 2026-06-04 (PM Mode 4 ad-hoc dispatch через `claude` catch-all с inline-системным промптом), но НЕ был закоммичен → harness не подхватывал `subagent_type: manual-qa`. Этот PR фиксит это и регистрирует Manual QA как полноценную часть multi-agent сетапа.

### Added

- **`manual-qa.md`** (committed) — YAML frontmatter + system prompt:
  - Role: интерактивный visual / functional QA на живом стеке через Playwright MCP (отличие от AutoTest, который пишет `.spec.ts` с mocks).
  - Tools: Bash, Read, Edit, Grep, Glob + Playwright MCP (navigate / click / fill_form / take_screenshot / snapshot / console_messages / evaluate) + postgres + eslint + github + ast-grep.
  - Model: sonnet.
  - Golden rules: stale stack ban, screenshot proof, no `git add . / -A`, no backend edits (Coder zone), re-verify after fix, console-check, RBAC под разными ролями, edge cases.
  - Mandatory skills: using-superpowers / systematic-debugging / browser_snapshot перед click / ECC design-quality / verification-before-completion.
  - Zone-of-write: `apps/web/**` cosmetic only + `/tmp/manual-qa-<runid>/`. Backend / `apps/api/**` / `packages/**` / `apps/e2e/**` / `.github/**` / schema — read-only.
- **`memory/manual-qa/lessons.md`** + **`lessons.archive.md`** — placeholder под per-agent memory.

### Changed

- **`README.md`** — добавлен row Manual QA в Agent system prompts таблицу.
- **`contracts.md`** — Manual QA добавлен в:
  - §1 High-level flow Mermaid (PM → Manual QA параллельно с Reviewer)
  - §4 Task file → agent mapping (no task pattern — dispatch через PR brief inline)
  - новая §5.1 Manual QA dispatch decision (trigger zones: PR трогает UI surface / new visible feature / pre-merge final check)
- **`pm-snippets.md`** — добавлен dispatch snippet для Manual QA (mode: PR-final visual check).

### Migration notes

- Будущие сессии (после PR merge) автоматически подхватят `subagent_type: manual-qa` через harness, который читает `.claude/agents/*.md` с YAML frontmatter.
- До merge — fallback через `subagent_type: claude` + inline-системный промпт из `manual-qa.md` (как делалось 2026-06-04 manually).
- `.github/workflows/` пока не запускают Manual QA в CI — это локальный субагент диспатчится только PM (после Coder push, до merge). См. `contracts.md` §5.1.

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
