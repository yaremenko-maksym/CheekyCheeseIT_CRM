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

| Agent                 | Doc                                            | Назначение                                                                              |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| **PM**                | [`pm.md`](pm.md)                               | Project Manager: 4 режима, dispatch decision, User Testing, merge gate                  |
| **Coder**             | [`coder.md`](coder.md)                         | Fullstack developer: workflow, wip-push, watchdog, vision check                         |
| **code-reviewer**     | [`code-reviewer.md`](code-reviewer.md)         | Narrow code review: TypeScript strict, ESLint, zone-of-write, write-then-post (default) |
| **security-reviewer** | [`security-reviewer.md`](security-reviewer.md) | Security review: OWASP, npm audit, secrets, USDT/ETH (для auth/finance/wallets PR)      |
| **Architect**         | [`architect.md`](architect.md)                 | Migration architect: ECC migration phases, ADRs, rollback granularity                   |
| **Legal**             | [`legal.md`](legal.md)                         | UA jurisdictional legal advisor: 4 modes (consult / pr-review / brief-check / strategic) |
| **AutoTest**          | [`autotest.md`](autotest.md)                   | E2E QA: 3 режима, AC-first, anti-patterns (ECC frontmatter, model: sonnet, Phase 3e)    |
| **DevOps**            | [`devops.md`](devops.md)                       | CI/CD, workflows, branch protection + ECC build-error-resolver / harness-optimizer delegation (Phase 3e) |
| **BA**                | [`ba.md`](ba.md)                               | Business Analyst: brief writing, role boundaries                                        |

**Reviewer split (Phase 3b ECC migration, 2026-06-03):** монолитный `reviewer.md` → split на `code-reviewer.md` + `security-reviewer.md` per ADR § 2.1.5. `reviewer.md` остался как **deprecated shim** (redirect) во время Phase 3c PM dispatch transition. См. [`docs/architecture/2026-06-03-phase3b-deliverable.md`](../architecture/2026-06-03-phase3b-deliverable.md).

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

### Skills (Phase 4 ECC migration, 2026-06-03)

Skills — canonical workflow surface per ECC AGENTS.upstream.md. После Phase 4 в `.claude/skills/` доступны:

| Skill                       | Path                                                                                         | Когда инвоукать                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pm-dispatching`            | `.claude/skills/pm-dispatching/SKILL.md`                                                     | PM: загрузка `pm-snippets.md` для dispatch / PR / CI / User Testing      |
| `playwright-patterns`       | `.claude/skills/playwright-patterns/SKILL.md`                                                | AutoTest / Coder: перед написанием / правкой `.spec.ts` (CRM cookbook)   |
| `code-review-discipline`    | `.claude/skills/code-review-discipline/SKILL.md`                                             | Reviewers: перед post review (BLOCK / write-then-post / zone-violations) |
| `dev-flow-resilience`       | `.claude/skills/dev-flow-resilience/SKILL.md`                                                | Все: long-running / MCP I/O / cross-session — D1-D4 RCA patterns         |
| `ua-tax-compliance`         | `.claude/skills/ua-tax-compliance/SKILL.md`                                                  | Legal Mode A / Mode B на UA tax / company structure                      |
| `ua-crypto-compliance`      | `.claude/skills/ua-crypto-compliance/SKILL.md`                                               | Legal на crypto / wallets / smart contracts                              |
| `ua-it-contract`            | `.claude/skills/ua-it-contract/SKILL.md`                                                     | Legal на IT-contract structure / templates                               |
| `legal-escalation-patterns` | `.claude/skills/legal-escalation-patterns/SKILL.md`                                          | Legal / PM на evasion variants / hard refuse zones                       |

См. `docs/architecture/2026-06-03-phase4-deliverable.md` для full inventory + skipped candidates + cross-skill dependency graph.

### Deprecated (redirect stubs, для backward compat)

- [`reviewer.md`](reviewer.md) → `code-reviewer.md` + `security-reviewer.md` (Phase 3b ECC split, 2026-06-03)
- [`CLAUDE-pm.md`](CLAUDE-pm.md) → `pm.md` + `project-state.md` + `pm-snippets.md`
- [`CLAUDE-coder.md`](CLAUDE-coder.md) → `coder.md` + `project-state.md`
- [`CLAUDE-reviewer.md`](CLAUDE-reviewer.md) → `code-reviewer.md` + `security-reviewer.md` + `project-state.md`
- [`CLAUDE-autotest.md`](CLAUDE-autotest.md) → `autotest.md` + `project-state.md`
- [`CLAUDE-devops.md`](CLAUDE-devops.md) → `devops.md` + `project-state.md`
- [`CLAUDE-ba.md`](CLAUDE-ba.md) → `ba.md` + `project-state.md`
- [`CLAUDE-tools.md`](CLAUDE-tools.md) → `RULES.md` §1 + §3

Сохранены как redirect stubs для архивных workflows (`.github/workflows/archive/*.yml`) и legacy task-файлов.

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

- **2026-06-03** — Phase 4 ECC migration: skills lift из lessons.md + dev-flow-rca → `.claude/skills/<name>/SKILL.md`. 7 new skills (playwright-patterns, code-review-discipline, dev-flow-resilience, ua-tax/crypto/it-contract, legal-escalation-patterns) + agent mandatory tables update + viability matrix. См. [`docs/architecture/2026-06-03-phase4-deliverable.md`](../architecture/2026-06-03-phase4-deliverable.md).
- **2026-06-03** — Phase 3e ECC migration: AutoTest + DevOps frontmatter port + ECC `build-error-resolver` / `harness-optimizer` decomposition. См. [`docs/architecture/2026-06-03-phase3e-deliverable.md`](../architecture/2026-06-03-phase3e-deliverable.md).
- **2026-06-02** — Architecture v2 (этот рефактор). См. [`CHANGES.md`](CHANGES.md).
- **2026-05-23** — dev-flow RCA (wip-push, intent markers, sentinel).
- **2026-05-21** — Reviewer Verdict: BLOCK pattern (COMMENT + first-line marker).
- Ранее — итеративная эволюция в формате CLAUDE-X.md + X.md split.
