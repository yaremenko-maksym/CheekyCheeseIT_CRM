# .claude/agents/ — Entry point

Multi-agent infrastructure for the Cheeky Cheese IT CRM. Contains agent system prompts, cross-agent rules, project facts, interaction contracts.

After the **2026-06-02** refactor (architecture v2) — a unified structure with zero-tolerance golden rules at the top of each agent doc + a single source of truth for cross-cutting concerns.

The agent-infra migration history is in git history (doc archives removed 2026-06-29).

---

## Quick navigation

### Cross-cutting docs (read first)

| Doc                                    | Content                                                                                                                                                                                   | For whom                                                                | Size  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----- |
| [`RULES.md`](RULES.md)                 | Cross-agent rules: MCP priority, git hygiene, skill catalog, session-recovery, zone-of-write, lessons protocol, version pins                                                              | **All agents** upfront                                                  | ~9 KB |
| [`project-state.md`](project-state.md) | Phases, tech stack, RBAC matrix, business rules, migrations, shared schemas, auth, design system, gotchas, CI/CD pipeline                                                                 | **All agents** upfront                                                  | ~7 KB |
| [`contracts.md`](contracts.md)         | Master-direct-dispatch contracts: labels lifecycle, dispatch triggers (AutoTest / Manual QA / Designer / spec-reviewer), Reviewer verdict semantics, flaky-E2E SLA, Coder watchdog layers | Master (on cross-cutting dispatch), Coder/Reviewer/AutoTest (on-demand) | ~6 KB |

### Agent system prompts

> **The orchestrator is Master (the USER session), not an agent.** It directly dispatches the agents below via
> the `Agent` tool, decomposes tasks into `.claude/tasks/`, aggregates verdicts, gates labels,
> runs User Testing. There is no separate PM agent (removed 2026-10-05). The orchestration contract —
> `contracts.md`.

| Agent                 | Doc                                            | Purpose                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Coder**             | [`coder.md`](coder.md)                         | Fullstack developer: workflow, wip-push, watchdog, vision check                                                                                                                                                                      |
| **code-reviewer**     | [`code-reviewer.md`](code-reviewer.md)         | Narrow code review: TypeScript strict, ESLint, zone-of-write, write-then-post (default)                                                                                                                                              |
| **spec-reviewer**     | [`spec-reviewer.md`](spec-reviewer.md)         | The second review axis: diff ↔ task (uncovered AC / scope creep / false `ac_verified`)                                                                                                                                              |
| **copy-reviewer**     | [`copy-reviewer.md`](copy-reviewer.md)         | Review of client/candidate-facing text (multilingual en/uk/ru/es/pt)                                                                                                                                                                 |
| **security-reviewer** | [`security-reviewer.md`](security-reviewer.md) | Security review: OWASP, npm audit, secrets, USDT/ETH (for auth/finance/wallets PRs)                                                                                                                                                   |
| **Architect**         | [`architect.md`](architect.md)                 | Migration architect: ECC migration phases, ADRs, rollback granularity                                                                                                                                                                |
| **Legal**             | [`legal.md`](legal.md)                         | UA jurisdictional legal advisor: 4 modes (consult / pr-review / brief-check / strategic)                                                                                                                                             |
| **AutoTest**          | [`autotest.md`](autotest.md)                   | E2E QA: 3 modes, AC-first, anti-patterns (ECC frontmatter, model: sonnet, Phase 3e)                                                                                                                                                  |
| **Manual QA**         | [`manual-qa.md`](manual-qa.md)                 | Visual / interactive QA on the live stack via Playwright MCP: real data, RBAC, screenshots, complements AutoTest (dynamics vs `.spec.ts`)                                                                                            |
| **UI/UX Designer**    | [`ui-ux-designer.md`](ui-ux-designer.md)       | Design direction (Mode A pre-feature) / visual audit (Mode B post-impl) / AI-slop check (Mode C) / polish pass (Mode D cosmetic). ECC skills: accessibility / frontend-design-direction / design-system / make-interfaces-feel-better |
| **DevOps**            | [`devops.md`](devops.md)                       | CI/CD, workflows, branch protection + ECC build-error-resolver / harness-optimizer delegation (Phase 3e)                                                                                                                             |

**Reviewer split (Phase 3b ECC migration, 2026-06-03):** the monolithic `reviewer.md` → split into `code-reviewer.md` + `security-reviewer.md` per ADR § 2.1.5. `reviewer.md` is **removed** — the content lives entirely in `code-reviewer.md` + `security-reviewer.md`. See [`docs/architecture/2026-06-03-phase3b-deliverable.md`](../architecture/2026-06-03-phase3b-deliverable.md).

### On-demand reference

| Doc                                            | What                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| [`workflow-registry.md`](workflow-registry.md) | Catalog of read-only audit/research workflows (10) + triggers + launch discipline |

### Memory (lessons)

| File                                                   | Who writes / reads                              |
| ------------------------------------------------------ | ----------------------------------------------- |
| [`memory/README.md`](memory/README.md)                 | Format + rotation rules                         |
| [`memory/<agent>/lessons.md`](memory/coder/lessons.md) | Master appends after a merged PR (1-3 lessons) |

### Skills (Phase 4 ECC migration, 2026-06-03)

Skills — the canonical workflow surface per ECC AGENTS.upstream.md. After Phase 4, available in `.claude/skills/`:

| Skill                         | Path                                                | When to invoke                                                                                                                          |
| ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `playwright-patterns`         | `.claude/skills/playwright-patterns/SKILL.md`       | AutoTest / Coder: before writing / editing `.spec.ts` (CRM cookbook)                                                                     |
| `code-review-discipline`      | `.claude/skills/code-review-discipline/SKILL.md`    | Reviewers: before posting a review (BLOCK / write-then-post / zone-violations)                                                           |
| `dev-flow-resilience`         | `.claude/skills/dev-flow-resilience/SKILL.md`       | All: long-running / MCP I/O / cross-session — D1-D4 RCA patterns                                                                         |
| `ua-tax-compliance`           | `.claude/skills/ua-tax-compliance/SKILL.md`         | Legal Mode A / Mode B on UA tax / company structure                                                                                     |
| `ua-crypto-compliance`        | `.claude/skills/ua-crypto-compliance/SKILL.md`      | Legal on crypto / wallets / smart contracts                                                                                             |
| `ua-it-contract`              | `.claude/skills/ua-it-contract/SKILL.md`            | Legal on IT-contract structure / templates                                                                                              |
| `legal-escalation-patterns`   | `.claude/skills/legal-escalation-patterns/SKILL.md` | Legal / Master on evasion variants / hard refuse zones                                                                                   |
| `accessibility`               | `.claude/skills/accessibility/SKILL.md`             | UI/UX Designer / Coder: WCAG 2.2 AA — ARIA / focus / contrast / target size (ECC adopt 2026-06-04)                                       |
| `frontend-design-direction`   | `.claude/skills/frontend-design-direction/SKILL.md` | UI/UX Designer Mode A: choosing purpose / audience / tone / memorable detail (ECC adopt)                                                 |
| `design-system`               | `.claude/skills/design-system/SKILL.md`             | UI/UX Designer Mode B / C: 10-dimension visual audit + AI-slop detection (ECC adopt)                                                     |
| `make-interfaces-feel-better` | `.claude/skills/make-interfaces-feel-better/SKILL.md` | UI/UX Designer Mode D / Coder polish: concentric radius / tabular-nums / motion / hit areas (ECC adopt)                               |
| `claude-design-workflow`      | `.claude/skills/claude-design-workflow/SKILL.md`    | Orchestrator (Master / ui-ux-designer) drives Claude Design for a UI task + a handoff artifact (design-gate Tier 1/2, added 2026-06-22)  |
| `decision-frontier`           | `.claude/skills/decision-frontier/SKILL.md`         | All: a fork without the owner — a decision tree → killing branches with facts → A1/A2/A3 (2026-08-22)                                    |
| `diagnosing-bugs`             | `.claude/skills/diagnosing-bugs/SKILL.md`           | All: a hard bug / flake — the gate "no red command — no hypotheses" (2026-08-22)                                                        |
| `codebase-design`             | `.claude/skills/codebase-design/SKILL.md`           | Coder / Architect / reviewer: the vocabulary of deep modules, the deletion test, design twice                                           |
| `resolving-merge-conflicts`   | `.claude/skills/resolving-merge-conflicts/SKILL.md` | Coder / Master / DevOps: a merge/rebase conflict resolved by intent from the source                                                      |
| `prototype`                   | `.claude/skills/prototype/SKILL.md`                 | Coder / designer: a one-off prototype for a single question (UI variants or an HTML logic demo)                                          |
| `external-research`           | `.claude/skills/external-research/SKILL.md`         | All: recon outside by primary sources → a citable file with an expiry date                                                              |
| `writing-for-agents`          | `.claude/skills/writing-for-agents/SKILL.md`        | Architect / Master: writing and weeding documents that agents read                                                                      |
| `codebase-audit`              | `.claude/skills/codebase-audit/SKILL.md`            | Master: read-only breadth-first audit of ≥3 independent modules (fan-out N×haiku → opus synth), Decision 2 of orchestration-routing (2026-06-22) |

See `docs/architecture/2026-06-03-phase4-deliverable.md` for the full inventory + skipped candidates + the cross-skill dependency graph.

### Deprecated (redirect stubs, for backward compat)

- `reviewer.md` — **removed** (Phase 3b ECC split 2026-06-03 → `code-reviewer.md` + `security-reviewer.md`; the shim was removed in a later cleanup). Content in `code-reviewer.md` + `security-reviewer.md`.
- [`CLAUDE-legal.md`](CLAUDE-legal.md) — **active** operational notes (durations / knowledge base structure), not a stub; read from `legal.md`.

6 thin redirect stubs (`CLAUDE-pm/coder/reviewer/autotest/devops/tools.md`) were **removed 2026-06-16** (wisdom-transfer cleanup) — the content lives in `coder.md` / `code-reviewer.md` + `security-reviewer.md` / `autotest.md` / `devops.md` / `project-state.md` / `RULES.md`. `CLAUDE-ba.md` was removed back in Phase 6. The PM agent and its orchestration docs were removed 2026-10-05 — orchestration is run by Master directly (`contracts.md`).

---

## Token budget after the refactor

| Metric                           | Before | After   | Δ        |
| -------------------------------- | ------ | ------- | -------- |
| Total `.claude/agents/**` size   | 228 KB | ~150 KB | **-34%** |
| Coder dispatch read (compulsory) | 58 KB  | ~22 KB  | **-62%** |

Reference / contracts — on-demand, not upfront.

---

## Onboarding for a new agent

1. Read `RULES.md` (cross-agent rules — the golden rules are the same everywhere).
2. Read `project-state.md` (learn the phases / migrations / RBAC / gotchas).
3. Read `<agent>.md` (your system prompt: golden rules + recovery + workflow).
4. Read `memory/<agent>/lessons.md` (learn from past mistakes).
5. (Optional) Read `contracts.md` if the task is cross-agent.

This is the base ~25-30 KB of mandatory reading. Reference (`contracts.md`, `workflow-registry.md`) — only when actually needed.

---

## Where to go for different questions

| Question                                  | Where                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| What are the zero-tolerance prohibitions? | `<agent>.md` section "🔴 Golden rules"                            |
| What to do after compaction?              | `<agent>.md` section "Session-recovery"                           |
| Which MCP / native tool to take?          | `RULES.md` §1                                                     |
| Which skill to invoke?                    | `RULES.md` §3 + `<agent>.md` section "Mandatory skill invocation" |
| What to write in which folder (zone-of-write)? | `RULES.md` §5                                                 |
| Which role sees what (RBAC)?              | `project-state.md` §3                                             |
| Which migrations are applied?             | `project-state.md` §5                                             |
| Which versions of Node/pnpm/Vite/TanStack? | `RULES.md` §7 + `project-state.md` §2                            |
| Who orchestrates development?             | Master (the USER session) — see `contracts.md` + `CLAUDE.md`     |
| When to set which label?                  | `contracts.md` §1                                                 |
| When to dispatch AutoTest?                | `contracts.md` §3                                                 |
| Verdict: BLOCK semantics?                 | `contracts.md` §4                                                 |
| Coder watchdog recovery?                  | `coder.md` section 8 + `contracts.md` §5                          |

---

## History

- **2026-06-03** — Phase 6 ECC migration: cleanup. Removed deprecated `.claude/hooks/*.sh` (replaced by `.claude/hooks/` in Phase 2.5) + `.claude/hooks-ecc-draft.json`. BA docs moved `.claude/agents/ba.md` → `docs/business/roles/ba.md` (ADR Q5 Option B, BA = human role). `CLAUDE-ba.md` removed. See [`docs/architecture/2026-06-03-phase6-deliverable.md`](../architecture/2026-06-03-phase6-deliverable.md).
- **2026-06-03** — Phase 4 ECC migration: skills lift from lessons.md + dev-flow-rca → `.claude/skills/<name>/SKILL.md`. 7 new skills (playwright-patterns, code-review-discipline, dev-flow-resilience, ua-tax/crypto/it-contract, legal-escalation-patterns) + agent mandatory tables update + viability matrix. See [`docs/architecture/2026-06-03-phase4-deliverable.md`](../architecture/2026-06-03-phase4-deliverable.md).
- **2026-06-03** — Phase 3e ECC migration: AutoTest + DevOps frontmatter port + ECC `build-error-resolver` / `harness-optimizer` decomposition. See [`docs/architecture/2026-06-03-phase3e-deliverable.md`](../architecture/2026-06-03-phase3e-deliverable.md).
- **2026-06-16** — Wisdom-transfer cleanup: `architecture-v2.md` / `architect-audit.md` / `CHANGES.md` → `docs/architecture/archive/`; 6 thin CLAUDE-* stubs removed. See [`docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md`](../architecture/2026-06-16-agent-infra-wisdom-transfer.md).
- **2026-06-02** — Architecture v2 (this refactor).
- **2026-05-23** — dev-flow RCA (wip-push, intent markers, sentinel).
- **2026-05-21** — Reviewer Verdict: BLOCK pattern (COMMENT + first-line marker).
- Earlier — iterative evolution in the CLAUDE-X.md + X.md split format.
