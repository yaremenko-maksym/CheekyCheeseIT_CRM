# docs/agents/ — Entry point

Multi-agent инфраструктура для CRM Cheeky Cheese IT. Содержит system-промпты агентов, cross-agent правила, факты проекта, контракты взаимодействия.

После рефакторинга **2026-06-02** (architecture v2) — единая структура с zero-tolerance golden rules в начале каждого agent doc + single source of truth для cross-cutting concerns.

См. [`CHANGES.md`](CHANGES.md) для миграции и истории.

---

## Быстрая навигация

### Cross-cutting docs (читать первым)

| Doc                                    | Содержание                                                                                                                                    | Кому                                             | Размер |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------ |
| [`RULES.md`](RULES.md)                 | Cross-agent rules: MCP priority, git hygiene, skill catalog, session-recovery, zone-of-write, lessons protocol, version pins                  | **Все агенты** upfront                           | ~9 KB  |
| [`project-state.md`](project-state.md) | Phases, tech stack, RBAC матрица, бизнес-правила, миграции, shared schemas, auth, design system, gotchas, CI/CD pipeline                      | **Все агенты** upfront                           | ~7 KB  |
| [`contracts.md`](contracts.md)         | High-level flow (Mermaid), labels lifecycle, sequence diagrams, AutoTest dispatch decision, Reviewer verdict semantics, Coder watchdog layers | PM (всегда), Coder/Reviewer/AutoTest (on-demand) | ~6 KB  |

### Agent system prompts

| Agent        | Doc                          | Назначение                                                             |
| ------------ | ---------------------------- | ---------------------------------------------------------------------- |
| **PM**       | [`pm.md`](pm.md)             | Project Manager: 4 режима, dispatch decision, User Testing, merge gate |
| **Coder**    | [`coder.md`](coder.md)       | Fullstack developer: workflow, wip-push, watchdog, vision check        |
| **Reviewer** | [`reviewer.md`](reviewer.md) | Code review: workflow, security, write-then-post resilience            |
| **AutoTest** | [`autotest.md`](autotest.md) | E2E QA: 3 режима, AC-first, anti-patterns                              |
| **DevOps**   | [`devops.md`](devops.md)     | CI/CD, workflows, branch protection                                    |
| **BA**       | [`ba.md`](ba.md)             | Business Analyst: brief writing, role boundaries                       |

### Human roles (not LLM agents)

- **BA** (`docs/agents/ba.md`) — Business consultant. Writes `docs/specs/pm-brief.md` for PM consumption. **Not an LLM agent.** Located here for project clarity (alongside LLM agent docs); no YAML frontmatter.

### On-demand reference

| Doc                                | Что                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| [`pm-snippets.md`](pm-snippets.md) | Все `Agent()` / `gh` / E2E / wakeup сниппеты + durations + pm-state.json schema |

### Memory (lessons)

| File                                                                   | Кто пишет / читает                       |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| [`memory/README.md`](memory/README.md)                                 | Правила формата + ротации                |
| [`memory/<agent>/lessons.md`](memory/coder/lessons.md)                 | PM аппендит после merged PR (1-3 уроков) |
| [`memory/<agent>/lessons.archive.md`](memory/coder/lessons.archive.md) | PM при rotation: P2 (>90 дней) сюда      |

### Deprecated (redirect stubs, для backward compat)

- [`CLAUDE-pm.md`](CLAUDE-pm.md) → `pm.md` + `project-state.md` + `pm-snippets.md`
- [`CLAUDE-coder.md`](CLAUDE-coder.md) → `coder.md` + `project-state.md`
- [`CLAUDE-reviewer.md`](CLAUDE-reviewer.md) → `reviewer.md` + `project-state.md`
- [`CLAUDE-autotest.md`](CLAUDE-autotest.md) → `autotest.md` + `project-state.md`
- [`CLAUDE-devops.md`](CLAUDE-devops.md) → `devops.md` + `project-state.md`
- [`CLAUDE-ba.md`](CLAUDE-ba.md) → `ba.md` + `project-state.md`
- [`CLAUDE-tools.md`](CLAUDE-tools.md) → `RULES.md` §1 + §3

Сохранены как 1-line redirect stubs для архивных workflows (`.github/workflows/archive/*.yml`) и legacy task-файлов.

### Audit / Design (Phase 1)

- [`architect-audit.md`](architect-audit.md) — inventory + duplicates + противоречия (snapshot 2026-06-02)
- [`architecture-v2.md`](architecture-v2.md) — design proposal с 14 секциями (approved 2026-06-02)

### Archive (упразднённые агенты)

- [`archive/qa.md`](archive/qa.md) — QA-агент (упразднён 2026-05-XX, его функции наследованы AutoTest + Reviewer)
- [`archive/CLAUDE-qa.md`](archive/CLAUDE-qa.md) — QA notes

---

## Token budget после refactor

| Метрика                          | До     | После   | Δ        |
| -------------------------------- | ------ | ------- | -------- |
| Total `docs/agents/**` size      | 228 KB | ~150 KB | **-34%** |
| Coder dispatch read (compulsory) | 58 KB  | ~22 KB  | **-62%** |
| PM dispatch read (compulsory)    | 48 KB  | ~22 KB  | **-54%** |

Reference / snippets / contracts — on-demand, не upfront.

---

## Onboarding для нового агента

1. Прочитать `RULES.md` (cross-agent rules — golden rules везде одинаковые).
2. Прочитать `project-state.md` (узнать фазы / миграции / RBAC / gotchas).
3. Прочитать `<agent>.md` (свой system-prompt: golden rules + recovery + workflow).
4. Прочитать `memory/<agent>/lessons.md` (учиться на прошлых ошибках).
5. (Optional) Прочитать `contracts.md` если задача cross-agent.

Это базовый ~25-30 KB обязательного чтения. Reference (`pm-snippets.md`, archive) — только когда реально нужно.

---

## Куда обращаться при разных вопросах

| Вопрос                                    | Куда                                                             |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Какие zero-tolerance запреты?             | `<agent>.md` секция «🔴 Golden rules»                            |
| Что делать после compaction?              | `<agent>.md` секция «Session-recovery»                           |
| Какой MCP / native tool взять?            | `RULES.md` §1                                                    |
| Какие skill вызвать?                      | `RULES.md` §3 + `<agent>.md` секция «Mandatory skill invocation» |
| Что в какой папке писать (zone-of-write)? | `RULES.md` §5                                                    |
| Какая роль что видит (RBAC)?              | `project-state.md` §3                                            |
| Какие миграции применены?                 | `project-state.md` §5                                            |
| Какие версии Node/pnpm/Vite/TanStack?     | `RULES.md` §7 + `project-state.md` §2                            |
| Pipeline flow (BA → PM → Coder → ...)?    | `contracts.md` §1                                                |
| Когда какой label ставить?                | `contracts.md` §2                                                |
| Когда диспетчить AutoTest?                | `contracts.md` §5                                                |
| Verdict: BLOCK semantics?                 | `contracts.md` §6                                                |
| Coder watchdog recovery?                  | `coder.md` секция 4 + `contracts.md` §7                          |
| PM scheduled wake-up?                     | `pm-snippets.md` секция «ScheduleWakeup limitations»             |

---

## История

- **2026-06-02** — Architecture v2 (этот рефактор). См. [`CHANGES.md`](CHANGES.md).
- **2026-05-23** — dev-flow RCA (wip-push, intent markers, sentinel).
- **2026-05-21** — Reviewer Verdict: BLOCK pattern (COMMENT + first-line marker).
- Ранее — итеративная эволюция в формате CLAUDE-X.md + X.md split.
