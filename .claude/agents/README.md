# .claude/agents/ — Entry point

Multi-agent инфраструктура для CRM Cheeky Cheese IT. Содержит system-промпты агентов, cross-agent правила, факты проекта, контракты взаимодействия.

После рефакторинга **2026-06-02** (architecture v2) — единая структура с zero-tolerance golden rules в начале каждого agent doc + single source of truth для cross-cutting concerns.

История миграции агент-инфры — в git-истории (доковые архивы удалены 2026-06-29).

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
| **Manual QA**         | [`manual-qa.md`](manual-qa.md)                 | Visual / interactive QA на живом стеке через Playwright MCP: реальные данные, RBAC, скриншоты, дополняет AutoTest (динамика vs `.spec.ts`) |
| **UI/UX Designer**    | [`ui-ux-designer.md`](ui-ux-designer.md)       | Design direction (Mode A pre-feature) / visual audit (Mode B post-impl) / AI-slop check (Mode C) / polish pass (Mode D cosmetic). ECC skills: accessibility / frontend-design-direction / design-system / make-interfaces-feel-better |
| **DevOps**            | [`devops.md`](devops.md)                       | CI/CD, workflows, branch protection + ECC build-error-resolver / harness-optimizer delegation (Phase 3e) |

**Reviewer split (Phase 3b ECC migration, 2026-06-03):** монолитный `reviewer.md` → split на `code-reviewer.md` + `security-reviewer.md` per ADR § 2.1.5. `reviewer.md` **удалён** — контент полностью живёт в `code-reviewer.md` + `security-reviewer.md`. См. [`docs/architecture/2026-06-03-phase3b-deliverable.md`](../architecture/2026-06-03-phase3b-deliverable.md).

### Human roles (not LLM agents)

- **BA** (`docs/business/roles/ba.md`) — Business consultant. Writes `.claude/briefs/pm-brief.md` for PM consumption. **Not an LLM agent.** Moved out of `.claude/agents/` in Phase 6 (2026-06-03) per ADR Q5 Option B; no YAML frontmatter. Cross-doc refs (`RULES.md`, `project-state.md`, `contracts.md`) point back to `.claude/agents/`.

### On-demand reference

| Doc                                | Что                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| [`pm-snippets.md`](pm-snippets.md) | Все `Agent()` / `gh` / E2E / wakeup сниппеты + durations + pm-state.json schema |

### Memory (lessons)

| File                                                                   | Кто пишет / читает                       |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| [`memory/README.md`](memory/README.md)                                 | Правила формата + ротации                |
| [`memory/<agent>/lessons.md`](memory/coder/lessons.md)                 | PM аппендит после merged PR (1-3 уроков) |
### Skills (Phase 4 ECC migration, 2026-06-03)

Skills — canonical workflow surface per ECC AGENTS.upstream.md. После Phase 4 в `.claude/skills/` доступны:

| Skill                       | Path                                                                                         | Когда инвоукать                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pm-dispatching`            | `.claude/skills/pm-dispatching/SKILL.md`                                                     | PM: загрузка `pm-snippets.md` для dispatch / PR / CI / User Testing            |
| `playwright-patterns`       | `.claude/skills/playwright-patterns/SKILL.md`                                                | AutoTest / Coder: перед написанием / правкой `.spec.ts` (CRM cookbook)         |
| `code-review-discipline`    | `.claude/skills/code-review-discipline/SKILL.md`                                             | Reviewers: перед post review (BLOCK / write-then-post / zone-violations)       |
| `dev-flow-resilience`       | `.claude/skills/dev-flow-resilience/SKILL.md`                                                | Все: long-running / MCP I/O / cross-session — D1-D4 RCA patterns               |
| `ua-tax-compliance`         | `.claude/skills/ua-tax-compliance/SKILL.md`                                                  | Legal Mode A / Mode B на UA tax / company structure                            |
| `ua-crypto-compliance`      | `.claude/skills/ua-crypto-compliance/SKILL.md`                                               | Legal на crypto / wallets / smart contracts                                    |
| `ua-it-contract`            | `.claude/skills/ua-it-contract/SKILL.md`                                                     | Legal на IT-contract structure / templates                                     |
| `legal-escalation-patterns` | `.claude/skills/legal-escalation-patterns/SKILL.md`                                          | Legal / PM на evasion variants / hard refuse zones                             |
| `accessibility`             | `.claude/skills/accessibility/SKILL.md`                                                      | UI/UX Designer / Coder: WCAG 2.2 AA — ARIA / focus / contrast / target size (ECC adopt 2026-06-04) |
| `frontend-design-direction` | `.claude/skills/frontend-design-direction/SKILL.md`                                          | UI/UX Designer Mode A: выбор purpose / audience / tone / memorable detail (ECC adopt) |
| `design-system`             | `.claude/skills/design-system/SKILL.md`                                                      | UI/UX Designer Mode B / C: 10-dimension visual audit + AI-slop detection (ECC adopt) |
| `make-interfaces-feel-better` | `.claude/skills/make-interfaces-feel-better/SKILL.md`                                      | UI/UX Designer Mode D / Coder polish: concentric radius / tabular-nums / motion / hit areas (ECC adopt) |
| `claude-design-workflow`    | `.claude/skills/claude-design-workflow/SKILL.md`                                            | Оркестратор (Master / PM / ui-ux-designer) драйвит Claude Design для UI-задачи + handoff-артефакт (design-gate Tier 1/2, добавлен 2026-06-22) |
| `codebase-audit`            | `.claude/skills/codebase-audit/SKILL.md`                                                    | Master / PM: read-only breadth-first аудит ≥3 независимых модулей (fan-out N×haiku → opus synth), Решение 2 orchestration-routing (2026-06-22) |

См. `docs/architecture/2026-06-03-phase4-deliverable.md` для full inventory + skipped candidates + cross-skill dependency graph.

### Deprecated (redirect stubs, для backward compat)

- `reviewer.md` — **удалён** (Phase 3b ECC split 2026-06-03 → `code-reviewer.md` + `security-reviewer.md`; shim убран в последующем cleanup). Контент в `code-reviewer.md` + `security-reviewer.md`.
- [`CLAUDE-legal.md`](CLAUDE-legal.md) — **active** operational notes (durations / knowledge base structure), не stub; читается из `legal.md` + `pm-snippets.md`.

6 thin redirect-стабов (`CLAUDE-pm/coder/reviewer/autotest/devops/tools.md`) **удалены 2026-06-16** (wisdom-transfer cleanup) — контент давно живёт в `pm.md` / `coder.md` / `code-reviewer.md` + `security-reviewer.md` / `autotest.md` / `devops.md` / `project-state.md` / `RULES.md`. `CLAUDE-ba.md` удалён ещё в Phase 6 (BA = human role).

---

## Token budget после refactor

| Метрика                          | До     | После   | Δ        |
| -------------------------------- | ------ | ------- | -------- |
| Total `.claude/agents/**` size      | 228 KB | ~150 KB | **-34%** |
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

Это базовый ~25-30 KB обязательного чтения. Reference (`pm-snippets.md`) — только когда реально нужно.

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

- **2026-06-03** — Phase 6 ECC migration: cleanup. Удалены deprecated `.claude/hooks/*.sh` (replaced by `.claude/hooks/` в Phase 2.5) + `.claude/hooks-ecc-draft.json`. BA docs перемещены `.claude/agents/ba.md` → `docs/business/roles/ba.md` (ADR Q5 Option B, BA = human role). `CLAUDE-ba.md` удалён. См. [`docs/architecture/2026-06-03-phase6-deliverable.md`](../architecture/2026-06-03-phase6-deliverable.md).
- **2026-06-03** — Phase 4 ECC migration: skills lift из lessons.md + dev-flow-rca → `.claude/skills/<name>/SKILL.md`. 7 new skills (playwright-patterns, code-review-discipline, dev-flow-resilience, ua-tax/crypto/it-contract, legal-escalation-patterns) + agent mandatory tables update + viability matrix. См. [`docs/architecture/2026-06-03-phase4-deliverable.md`](../architecture/2026-06-03-phase4-deliverable.md).
- **2026-06-03** — Phase 3e ECC migration: AutoTest + DevOps frontmatter port + ECC `build-error-resolver` / `harness-optimizer` decomposition. См. [`docs/architecture/2026-06-03-phase3e-deliverable.md`](../architecture/2026-06-03-phase3e-deliverable.md).
- **2026-06-16** — Wisdom-transfer cleanup: `architecture-v2.md` / `architect-audit.md` / `CHANGES.md` → `docs/architecture/archive/`; 6 thin CLAUDE-* стабов удалены. См. [`docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md`](../architecture/2026-06-16-agent-infra-wisdom-transfer.md).
- **2026-06-02** — Architecture v2 (этот рефактор).
- **2026-05-23** — dev-flow RCA (wip-push, intent markers, sentinel).
- **2026-05-21** — Reviewer Verdict: BLOCK pattern (COMMENT + first-line marker).
- Ранее — итеративная эволюция в формате CLAUDE-X.md + X.md split.
