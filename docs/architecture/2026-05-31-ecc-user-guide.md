# ECC Migration — Practical User Guide

**Audience:** Maksym (founder of CheekyCheeseIT). Has technical command but no expertise in multi-agent systems — this document fills that gap.

**Purpose:** not theory, but **what you have NOW**, **what appears after migration**, **how to use it** (by scenario), and **where to turn when stuck**.

**Related documents:**

- [`2026-05-31-ecc-migration-design.md`](2026-05-31-ecc-migration-design.md) — Master ADR (10 sections), decisions and justifications.
- [`2026-05-31-architect-discovery-report.md`](2026-05-31-architect-discovery-report.md) — discovery report the ADR is built on.
- [`2026-05-31-legal-agent-design.md`](2026-05-31-legal-agent-design.md) — Legal agent design (separate subsystem).

**Honest disclaimer:** ECC patterns are assumed working based on Discovery Report + ADR analysis. Some capabilities (e.g. continuous-learning observer, exact security profile skill list, ECC `developer` profile install behaviour in our monorepo) are **confirmed in the Phase 1 spike** — until then their description here is based on ECC docs, not on personal experience.

---

## Table of contents

1. [What you have NOW](#section-1)
2. [What appears per migration phase](#section-2)
3. [Practical workflows after migration](#section-3)
4. [Slash commands](#section-4)
5. [Skills — what is invokable](#section-5)
6. [Hooks — what fires automatically](#section-6)
7. [Memory & lessons — how knowledge accumulates](#section-7)
8. [Direct agent dispatch (advanced)](#section-8)
9. [Decision tree — where to turn per request](#section-9)
10. [FAQ + gotchas](#section-10)
11. [Quick start — first 5 minutes after Phase 6](#section-11)

---

## Section 1 — What you have NOW {#section-1}

**Pre-migration baseline (2026-06-03).** This is a snapshot _before_ ECC migration starts.

### 1.1 Active agents (7)

| Agent        | Role                                                          | Type                 | Where it lives                                               |
| ------------ | ------------------------------------------------------------- | -------------------- | ------------------------------------------------------------ |
| **BA**       | Business consultant — writes `docs/specs/pm-brief.md`         | Human role (non-LLM) | `docs/agents/ba.md` (documentation for the role)             |
| **PM**       | Orchestrator: brief → tasks → dispatch → User Testing → merge | LLM (orchestrator)   | `docs/agents/pm.md` + `pm-snippets.md` + `CLAUDE-pm.md` stub |
| **Coder**    | Fullstack dev: feature, fix, test                             | LLM (worker)         | `docs/agents/coder.md`                                       |
| **AutoTest** | E2E test developer (Playwright specs)                         | LLM (worker)         | `docs/agents/autotest.md`                                    |
| **Reviewer** | Code review on PRs (Verdict: BLOCK pattern)                   | LLM (gatekeeper)     | `docs/agents/reviewer.md`                                    |
| **DevOps**   | CI/CD, GHA workflows, infra                                   | LLM (worker)         | `docs/agents/devops.md`                                      |
| **Legal**    | UA jurisdictional advisor (4 modes)                           | LLM (advisor)        | `docs/agents/legal.md` + `docs/legal/` knowledge base        |

### 1.2 How they work today

**Standard cycle:**

```
USER (you) → BA writes pm-brief.md → PM reads brief
                                         ↓
PM decomposes into task-files (docs/specs/tasks/task-*.md)
                                         ↓
PM dispatches agents via Agent(isolation="worktree", run_in_background=True)
                                         ↓
Coder/DevOps work in an isolated worktree, open a PR with wip-push checkpoints + a final ac_verified commit
                                         ↓
PM dispatches Reviewer on each PR (gate) + AutoTest conditionally (if no E2E coverage in the diff)
                                         ↓
Reviewer APPROVE → label awaiting-pm-review → PM starts User Testing
                                         ↓
PM brings up the env via scripts/pm/prep-user-testing.sh → Serveo tunnel → sends the URL to the user
                                         ↓
USER tests from desktop / phone → replies "approve" / "changes"
                                         ↓
APPROVE:  PM adds label merge-approved → GHA auto-merge-on-label.yml → squash-merge
CHANGES:  PM groups into pending_fixes → batch to Coder → back to Reviewer
```

**Legal (stands apart):** not in the main pipeline. Triggers:

- User asks "ask the lawyer about X" → PM Mode 5
- PM Mode 1 Step 1.5 (brief-check) — auto if the brief has finance/data/contract triggers
- PM Mode 2 (auto PR review) — auto if the PR diff touches critical zones (`apps/api/src/{finance,auth,documents,users}/**`)

### 1.3 Pain points of the current system

- **Custom hooks (5 shell scripts)** — `.claude/hooks/{safety,block-production-edits,coder-pre-push,coder-progress-marker,eslint-feedback}.sh`. Each matcher is broad (`Bash` / `Edit|Write`), with no JSON-format predicates. Hooks fire on every command, not on a specific pattern — overhead + hard to maintain.
- **Monolithic agent prompts** — `coder.md` ~34 KB, `pm.md` 502 lines. Each agent carries all rules inline. Updating a rule means cutting across N files.
- **No skills layer** — knowledge of NestJS / TanStack / Playwright / TypeScript patterns lives inline in agent prompts or in `lessons.md` (free-form text). No structured durable workflow patterns.
- **No slash commands** — invocation only via a raw `Agent(...)` tool call. You can't say "/plan feature X", you need writeFile + dispatch.
- **No specialized reviewers** — a single Reviewer covers code + security + architecture concerns. Finance / auth is reviewed by the same prompt as UI.
- **No automated TDD-cycle agent** — TDD is enforced via a text rule in `coder.md`, not via a dedicated `tdd-guide` agent with a RED→GREEN→IMPROVE workflow.
- **Memory without rotation** — `lessons.md` grew unbounded. The v2 refactor (PR #78, merged 2026-06-02) introduced a 20-line threshold + the `anthropic-skills:consolidate-memory` skill for rotation, but **promotion to skill-format is not done yet**.

### 1.4 What is unavailable now (but appears after migration)

| Capability                                                             | Now                     | After ECC migration                        |
| ---------------------------------------------------------------------- | ----------------------- | ------------------------------------------ |
| Slash commands (`/plan`, `/tdd`, `/code-review`)                       | NO                      | Phase 5+                                   |
| Language-specific reviewers (TypeScript, security)                     | NO                      | Phase 3 (split Reviewer)                   |
| Automated TDD-cycle agent                                              | NO (text-only rule)     | Phase 3 (`tdd-guide`)                      |
| Stack-specific skills (NestJS / React / Drizzle / Playwright patterns) | inline in agent prompts | Phase 4+                                   |
| Cross-harness portability (Codex, Cursor, Gemini, OpenCode, Zed)       | NO                      | Phase 5 (placeholders) / Phase 7+ (active) |
| Architect, planner, build-error-resolver, harness-optimizer agents     | NO                      | Phase 3                                    |
| JSON-matcher hooks (specific predicates)                               | NO (broad shell)        | Phase 2                                    |
| Continuous-learning observer (pattern discovery from tool-use)         | NO                      | Phase 2 (TBD spike)                        |

See [ADR Section 2 — Per-Component Mapping](2026-05-31-ecc-migration-design.md#section-2--per-component-mapping) for the full breakdown of decisions per artifact.

---

## Section 2 — What appears per migration phase {#section-2}

Per [ADR Section 6 — Phase Plan (0 → 6)](2026-05-31-ecc-migration-design.md#section-6--phase-plan-0--6). Each phase is a separate PR (or multi-PR for Phase 3), and requires your approval before it starts.

**Total timing:** 6-9 weeks, 43-69 hours of Architect dispatch.

### 2.1 Phase timeline + what becomes available

| Phase                                            | When (target) | Effort | Risk | What becomes available after merge                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ------------- | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** — Discovery + ADR                          | Done          | 8-12h  | NONE | ✅ Already done — ADR + Discovery Report + 10 Open Questions answered                                                                                                                                                                                                                                                                                                                                                                                 |
| **1** — ECC Skeleton install                     | Week 1        | 4-8h   | LOW  | ECC reference directories (`agents/`, `skills/`, `hooks/`, `rules/`, `manifests/`, `mcp-configs/`) appear. Coexistence with the current system — existing workflows change nothing. Adapted `AGENTS.md`, `SOUL.md`, `WORKING-CONTEXT.md`, `RULES.md` for our project (with Russian language note + Legal listing + zone-of-write rules)                                                                                                               |
| **2** — Hooks migration                          | Week 2        | 4-6h   | MED  | Hooks rewritten in JSON-matcher format with **specific predicates** (not broad `Bash`). Dangerous-command blocking, auto-format on edits, dev server tmux enforcement, pre-push verification gate — all **predicate matchered**. D1-D4 resilience preserved via smoke tests                                                                                                                                                                           |
| **3** — Agents migration                         | Weeks 3-5     | 16-24h | HIGH | TypeScript reviewer + Security reviewer (split out of the single Reviewer), Code reviewer, TDD-guide, Planner, Architect, Build-error-resolver, E2E-runner (if it comes with the `developer` profile) — all ECC core agents available. PM/Coder/AutoTest/DevOps/Legal ported to ECC YAML frontmatter format (Russian preserved, all Mode 1-5 logic preserved)                                                                                         |
| **4** — Lessons → Skills                         | Weeks 5-6     | 4-8h   | LOW  | Lessons (atomic lessons in `memory/<agent>/lessons.md`) **promoted to durable skills** (`skills/<topic>/SKILL.md`). Skills follow ECC structure: `name` / `description` / `origin` frontmatter + `When to Activate` / `Workflow` / `Tested examples` sections. UA-legal skill stubs created. Recruiting-domain skill (business invariants) — single source of truth                                                                                   |
| **5** — Rules + GHA + cross-harness placeholders | Week 6-7      | 4-6h   | MED  | Top 5-8 cross-cutting rules extracted into the ECC `rules/` directory (Russian language, zone-of-write, confidence policy, conventional commits, AC verification, no `--no-verify`, hard escalation zones). GHA `ci.yml` gets an additive `ecc-code-review` job. Cross-harness placeholder directories (`.codex/`, `.cursor/`, `.gemini/`, `.opencode/`, `.zed/`) created with READMEs. `agent.yaml` manifests exported for cross-harness portability |
| **6** — Cleanup + retro                          | Weeks 7-9     | 3-5h   | LOW  | Legacy `docs/agents/_legacy/` perm-archived. Old `.claude/hooks/*.sh` deleted (after 2+ weeks of stability). Archived GHA workflows deleted. `CLAUDE.md` + `CONTRIBUTING.md` updated. Final `RULES.md` merged. Migration retrospective document published. **Stable end-state**                                                                                                                                                                       |

### 2.2 What the user can do after each phase

**After Phase 1 (Skeleton):**

- Read the new ECC reference docs (`AGENTS.md`, `SOUL.md`) — understand how the ECC community thinks about multi-agent architecture.
- Existing workflows work **unchanged** (coexistence). PM/Coder/Reviewer dispatch — no regression.
- You can start trying invokable ECC skills/agents manually (via `Agent(...)`), but they are not yet integrated into PM dispatch.

**After Phase 2 (Hooks):**

- Hooks fire more precisely — less overhead, fewer false-positives.
- D1-D4 resilience (intent markers, pre-push verification, AC-verified gate) preserved.
- Old `.claude/hooks/*.sh` stay in the repo for another week (rollback safety).
- **What you do:** nothing new — hooks work invisibly. If something is blocked — the error message tells you which hook + why.

**After Phase 3 (Agents):**

- Dispatch `code-reviewer` directly for a quick check without the full Reviewer pipeline.
- Dispatch `security-reviewer` for finance/auth/USDT paths.
- Dispatch `tdd-guide` to write a failing test BEFORE the fix.
- Dispatch `planner` to decompose a tricky task.
- Dispatch `architect` for a design decision (trade-offs).
- Dispatch `build-error-resolver` when `pnpm build` fails with an unclear error.
- PM starts internally delegating to ECC sub-agents (planner for plan drafting, architect for design choices).
- Russian language preserved in all ported agents — an override in the YAML frontmatter.

**After Phase 4 (Skills):**

- Invoke a skill directly: `Skill("nestjs-patterns")` loads durable knowledge of NestJS conventions without reading all of `docs/agents/coder.md`.
- UA-legal skill stubs (5 of them — FOP regimes, CFC, NDA, IP, GDPR/personal data) ready to fill with content as Legal experience accumulates.
- `skills/recruiting-domain-rules/SKILL.md` — single source of business invariants (1 JUNIOR / project, ACCOUNTANT auto-in-team, max 10 teams, JUNIOR derived from project_members).

**After Phase 5 (Rules + GHA):**

- Slash commands available: `/plan`, `/tdd`, `/code-review`, `/e2e`, etc. (see Section 4).
- GHA `ci.yml` runs `ecc-code-reviewer` on every PR (initially informational, does not block merge).
- Cross-harness directories (`.codex/`, `.cursor/`, etc.) — placeholders for a future multi-harness setup.

**After Phase 6 (Cleanup):**

- Single coherent architecture — no legacy duplicates.
- `CLAUDE.md` updated — references to the new structure.
- Migration retrospective available for future reference.
- **Stable end-state** — can start the quarterly ECC sync cycle (see ADR Section 7).

---

## Section 3 — Practical workflows after migration {#section-3}

Per [ADR Section 6](2026-05-31-ecc-migration-design.md#section-6--phase-plan-0--6) + integration with the current `docs/agents/pm.md` Mode 1-5.

After Phase 6 (the cleanup phase is complete) — typical work scenarios.

### 3.1 Workflow A — New feature (full cycle)

**Trigger:** "I want to add functionality X" (UI + backend + tests + docs).

**Steps:**

1. **BA** (you) write `docs/specs/pm-brief.md` with a feature description + business context + acceptance scenarios.
2. **PM Mode 1** (Step 1) — reads the brief.
3. **PM Mode 1 Step 1.5** — heuristic check for legal touchpoints. If present (finance / data / contract / crypto / 3rd-party / hiring) — dispatches **Legal Mode C (brief-check)** _before_ decomposition, adds recommendations to AC.
4. **PM Mode 1 Step 2 (Decomposition)** — invokes `superpowers:writing-plans`. For a complex scope — delegates to `planner` (ECC agent) for plan drafting. For design trade-offs — delegates to `architect` (ECC agent).
5. **PM Mode 1 Step 3-5** — creates task-files (`task-<slug>.md` per agent), writes `pm-state.json`, dispatches agents in parallel.
6. **TDD path (Coder):** _before_ implementation — `tdd-guide` (ECC) writes a failing test (RED). Coder implements the minimum for GREEN. After — `simplify` (superpowers skill) for IMPROVE.
7. **Coder + TypeScript reviewer parallel:** Coder works in a worktree, the TypeScript reviewer (ECC) checks the code _while_ it is being written on each Edit — faster feedback.
8. **PM Mode 2** — after Coder creates a PR with `ac_verified: 1,2,3` + `vision: ✓ /crm/<route>`:
   - **MUST dispatch Reviewer** (code-reviewer, ECC) — gate.
   - **MUST dispatch security-reviewer** (ECC) — if the PR touches `apps/api/src/{finance,auth,documents,users}/**` or USDT paths.
   - **MUST dispatch Legal Mode B** (parallel) — if the diff matches legal critical zones.
   - **MUST dispatch AutoTest** (or skip with reason `coder-added-e2e-covering-ac` — record an event).
   - **MUST dispatch e2e-runner** (ECC, if present) for critical flow validation.
9. **Reviewer APPROVE** → label `awaiting-pm-review` → **PM Mode 4** (User Testing).
10. **PM Mode 4** — `scripts/pm/prep-user-testing.sh <pr_branch>` (production build + Serveo tunnel + Dev Login). PM sends you `🔗 https://<hash>.serveousercontent.com`.
11. **USER (you)** test → "approve" or "changes".
12. **APPROVE:** PM adds the `merge-approved` label → CI auto-squash-merge.
13. **PM** — appends 1-3 lessons to `memory/<agent>/lessons.md` per merged PR. On the 20-line threshold or a batch of merged PRs → invoke `anthropic-skills:consolidate-memory` for skills promotion.

### 3.2 Workflow B — Bug fix (fast cycle)

**Trigger:** "Something doesn't work / regression / edge-case bug".

**Steps:**

1. **Direct dispatch `tdd-guide`** (ECC) — writes a failing test reproducing the bug. This is **mandatory** (per `superpowers:test-driven-development` + ECC pattern).
2. **Dispatch Coder** with `target_branch=<bugfix-branch>` for the fix.
3. **Dispatch Reviewer** (code-reviewer) — gate.
4. **Skip AutoTest** if `tdd-guide` already added a spec covering the bug → write event `autotest_skipped` with reason `coder-added-e2e-covering-ac`.
5. **Skip User Testing** for trivial bugs (1-line typo) — direct merge-approved label after Reviewer APPROVE. For non-trivial bugs — full Mode 4 cycle.
6. **PM** — append a lesson to `memory/coder/lessons.md`: "<date> [P1] [task-fix-<slug>] (#bug) <concrete lesson about root cause / prevention>".

### 3.3 Workflow C — Legal consultation (our custom flow)

**Trigger (Mode A):** USER in chat "ask the lawyer about X" where X is a concrete feature / PR / task. Or PM itself spots a legal question.

**Trigger (Mode D):** USER "ask the lawyer — can we do X" where X is a strategic question outside a concrete feature (hire a JUNIOR under FOP 2, open a branch, switch to a new tax regime).

**Steps (Mode A):**

1. **PM Mode 5 — Mode A handler:**
   - Creates `docs/specs/tasks/task-legal-<slug>.md` from the `templates/task-legal.md.tpl` template — fills in `## Context` + `## Question`.
   - Dispatches Legal via the "Legal — Mode A" snippet from `pm-snippets.md`.
2. **Legal agent** — reads the knowledge base (`docs/legal/*`), when needed WebSearches recent UA legal updates (Tax Code, Law 2074-IX, NBU memorandum), appends `## Lawyer's answer` to the task-file per the structure in `legal.md` (TL;DR + Confidence + full analysis + citations + escalation triggers).
3. **PM** — reads the result, shows the USER:
   - TL;DR
   - Confidence (HIGH/MED/LOW)
   - 1-2 key recommendations
   - If Confidence: LOW + an action-critical decision → explicit warning: "verification by a human lawyer is needed BEFORE acting".
4. **PM** — records event `legal_dispatched` with `mode: consult`, `target: task-file` in `pm-state.json`.
5. After archiving the task — the task-file moves to `docs/specs/tasks/archive/`.

**Steps (Mode D):**

1. **PM Mode 5 — Mode D handler:**
   - Creates `docs/specs/legal-consultations/YYYY-MM-DD-<slug>.md` with `## Question` + `## Context`.
   - Dispatches Legal via the "Legal — Mode D" snippet from `pm-snippets.md`.
2. **Legal agent** — analyzes the strategic question (deeper context, often WebSearch for recent rulings/precedents), appends `## Lawyer's answer`.
3. **PM** — shows the USER the TL;DR + Confidence + 1-2 key recommendations + **the full path to the file for details**.
4. **Permanent reference** — the file stays in `docs/specs/legal-consultations/`, not deleted (it is a log of strategic decisions).

### 3.4 Workflow D — Architecture decision

**Trigger:** "Which approach to take for Y" (where trade-offs analysis is needed). Examples: "State via context or Redux", "WebSocket or polling", "Migration strategy for X".

**Steps:**

1. **PM dispatches `architect`** (ECC) — task: trade-offs analysis (3-5 options + pros/cons + recommendation).
2. **Architect** — research via `context7` MCP (NestJS / TanStack / Drizzle docs), `ast-grep` for existing patterns in the codebase, produces an ADR draft in `docs/architecture/2026-XX-XX-<slug>.md` with:
   - Executive summary (TL;DR)
   - Options considered
   - Trade-offs matrix
   - Recommendation + justification
   - Open questions for the USER
3. **USER (you)** — decision: "do option B" or "revise [aspect]".
4. **PM** — implementation phase: breaks it into task-files → dispatches Coder / DevOps per the plan.

**Example (real):** `docs/architecture/2026-05-31-ecc-migration-design.md` (this ADR) — was written by Architect in this workflow.

### 3.5 Workflow E — Refactoring / cleanup

**Trigger:** "This code is shaped badly, it needs cleanup" (dead code, duplication, naming, structure).

**Steps:**

1. **PM dispatches `refactor-cleaner`** (ECC, if it comes with the `developer` profile) or **Coder + skill `superpowers:simplify`** — for cleanup without a feature change.
2. **PM dispatches TypeScript reviewer** (ECC) — to validate that types are preserved + no regression.
3. **PM dispatches code-reviewer** (ECC) — for a general code quality check.
4. **Quick PR** — typically skip Reviewer round 2 + AutoTest (no behavior change). Direct `merge-approved` after User Testing visual verification (if UI is involved) or after lint+typecheck+test green (if backend-only).

**Special case:** "page refactoring" — in our lexicon this means a **UI/UX visual change**, NOT code-level DRY cleanup. See memory item `feedback_refactor_pages` — first a screenshot via Playwright, then a discussion of the visual changes.

### 3.6 Workflow F — Documentation update

**Trigger:** "Docs are stale after feature X" or "the codemap needs a refresh".

**Steps:**

1. **PM dispatches `doc-updater`** (ECC, if present) — refreshes:
   - `CLAUDE.md` (root) — if phases / business rules / RBAC changed.
   - `docs/agents/project-state.md` — phases / migrations / shared schemas inventory / tech gotchas.
   - `README.md` in the affected modules.
2. **Direct PR** — typically skip Reviewer (docs-only change, no executable code). PM checks the diff visually and sets `merge-approved` directly.

**Alternative (if `doc-updater` doesn't come with the profile):** PM updates `docs/business/` itself (zone-of-write allows) or dispatches Coder with a task-file "update `docs/business/modules/<X>.md` per spec [...]".

---

## Section 4 — Slash commands {#section-4}

After Phase 5+ the user can invoke common workflows with one line instead of writing a task-file. Slash commands are a shortcut for a `Skill` invocation or a predefined `Agent` dispatch.

**Confidence:** medium — the exact list of commands in the `developer` profile is confirmed by the Phase 1 spike. Below is based on the ECC docs reference + scenarios typical for our project.

### 4.1 Core slash commands (expected from the ECC `developer` profile)

| Command                           | What it does                                                                                                                                         | When to use                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/plan <feature>`                 | Invokes `planner` (ECC) to decompose into atomic tasks with dependencies + estimated effort. Output — a task draft that PM converts into task-files. | Complex feature (4+ files, multiple agents). An alternative to spending PM cycles on decomposition.                    |
| `/tdd <bug-or-feature>`           | Invokes `tdd-guide` (ECC) — writes a failing test FIRST, then dispatches Coder for the GREEN implementation.                                         | **Any** bug fix + any feature with non-trivial behavior. Default workflow for bugs.                                    |
| `/code-review [<PR>]`             | Invokes `code-reviewer` (ECC) manually on the current diff (if no PR) or on a specific PR.                                                           | Quick check without the full Reviewer pipeline. Polling Coder's work without a gate.                                   |
| `/security-review [<PR>]`         | Invokes `security-reviewer` (ECC) — OWASP Top 10 scan, npm audit, secret leak check, auth/finance critical paths.                                    | Before merging finance / auth / wallet changes. Without waiting for the PM Mode 2 auto-dispatch.                       |
| `/e2e [<spec-file>]`              | Runs Playwright e2e tests locally via `pnpm --filter @crm/e2e test`. Optional filter — a specific spec.                                              | Before push (memory item `feedback_e2e_before_push` — mandatory), after a UI batch fix.                                |
| `/refactor-clean [<file-or-dir>]` | Invokes `refactor-cleaner` (ECC) — dead code, duplication, unused imports.                                                                           | After finishing a feature, before merge. Cleanup phase.                                                                |
| `/orchestrate <complex-task>`     | Invokes `loop-operator` (ECC) for multi-agent coordination in an autonomous loop with stop conditions.                                               | Long-running task where the user wants fire-and-forget (PM dispatches multiple agents sequentially based on outcomes). |
| `/learn`                          | Invoke `superpowers:using-superpowers` + capture session lessons. Append to `memory/<role>/lessons.md`.                                              | After a merged PR — explicit lesson capture (instead of PM auto-append).                                               |
| `/skill-create <topic>`           | Invoke `superpowers:writing-skills` or ECC `skill-creator` — bootstrap a new skill in `skills/<topic>/SKILL.md`.                                     | When a recurring lesson (5+ repetitions in lessons.md) is promotable to a durable skill.                               |

### 4.2 Project-specific slash commands (custom, per ADR Section 4.7)

These commands are created as part of Phase 5 (4 custom skills) or Phase 6:

| Command                                               | What it does                                                                                                                                           | Where it is defined                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `/legal-consult <topic>`                              | Invokes Legal Mode A — creates task-legal-\* + dispatches the Legal agent                                                                              | Custom skill `legal-mode-orchestration` (Phase 5)                 |
| `/legal-strategic <topic>`                            | Invokes Legal Mode D — creates a consultation file in `docs/specs/legal-consultations/`                                                                | Same skill                                                        |
| `/user-testing <pr_branch>`                           | Runs `scripts/pm/prep-user-testing.sh <pr_branch>` via `run_in_background=True`. After start — prints the Serveo URL for the USER.                     | Custom skill `user-testing-tunnel` (Phase 5, per ADR Section 4.7) |
| `/pm-state`                                           | Prints a summary of the current `pm-state.json` (active tasks, blocked, pending_fixes, blocking_issue)                                                 | Custom skill `pm-mode-orchestration` (Phase 5)                    |
| `/coder-recover`                                      | Read `.claude/coder-activity.log` last 5 INTENT + 10 edits → diagnose if hung → recovery flow per the `pm-snippets.md` "Coder hung — recovery" section | Custom skill `dev-flow-resilience` (Phase 5)                      |
| `/cross-session-wakeup <delay-min> <prompt-template>` | Generate parameters via `scripts/pm/pm-schedule.sh` + call `mcp__scheduled-tasks__create_scheduled_task`                                               | Custom skill `cross-session-orchestration` (Phase 5)              |

**Note:** the exact slash command syntax is determined by ECC harness conventions — the Phase 1 spike confirms it.

### 4.3 Built-in slash commands (Claude Code CLI)

These are **already available** (without migration) — built into the harness:

| Command   | What it does                      |
| --------- | --------------------------------- |
| `/help`   | List of available commands        |
| `/clear`  | Clear chat history (new session)  |
| `/config` | Settings UI                       |
| `/agents` | List active agents in the session |

---

## Section 5 — Skills {#section-5}

Skills are **durable workflow patterns** in the format `skills/<topic>/SKILL.md`. They are invokable directly via the `Skill` tool, or auto-loaded when an agent matches the trigger description.

**ECC philosophy** (per ADR Section 4.3): skills are the primary knowledge unit, lessons.md is secondary (an append-log for new observations, periodically consolidated into skills via `anthropic-skills:consolidate-memory`).

### 5.1 Stack-relevant skills (expected from the ECC `developer` profile, Phase 1 spike confirms)

These skills _already exist_ in the ECC reference catalog and are loaded as part of the `developer` install profile (Phase 1).

| Skill                        | What's inside                                                                                              | When to invoke                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `skills/nestjs-patterns`     | NestJS 11 conventions: modules, DTOs via Zod, RolesGuard, JwtGuard, exception filters, Drizzle integration | Before writing a new NestJS module / controller / service |
| `skills/react-patterns`      | React 18 hooks, context, suspense, error boundaries, performance patterns                                  | Before writing a new React component                      |
| `skills/react-testing`       | RTL + Vitest patterns, userEvent quirks (delay:null per `feedback_test_fixing`), act() warnings            | Before writing a unit test for a React component          |
| `skills/typescript-strict`   | `exactOptionalPropertyTypes`, type narrowing, satisfies, branded types                                     | On TypeScript errors or strict mode debugging             |
| `skills/playwright-patterns` | Page Object pattern, fixtures, retry strategy, screenshot diff testing                                     | Before writing an E2E spec                                |

### 5.2 Cross-cutting ECC skills (Phase 1 install)

| Skill                                        | What's inside                                           | When to invoke                                        |
| -------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| `superpowers:using-superpowers`              | Bootstrap for all superpower skills                     | Session starts (always)                               |
| `superpowers:brainstorming`                  | Structured brainstorm before creative work              | Any creative task                                     |
| `superpowers:writing-plans`                  | Plan template + decomposition                           | Multi-step task before implementation                 |
| `superpowers:test-driven-development`        | RED→GREEN→IMPROVE workflow                              | **Any** feature/fix before implementation             |
| `superpowers:systematic-debugging`           | Hypothesis-driven debugging                             | Bug / test failure / unexpected behavior              |
| `superpowers:verification-before-completion` | Pre-completion verification checklist                   | Before PR / completion claim                          |
| `superpowers:security-review`                | OWASP Top 10 + dependency check                         | PR touches auth / finance / wallets / smart-contracts |
| `superpowers:requesting-code-review`         | Reviewer dispatch protocol                              | Start of each Reviewer cycle                          |
| `superpowers:receiving-code-review`          | How to respond to review feedback (push back vs accept) | Receiving review feedback                             |
| `superpowers:simplify`                       | Cleanup code post-implementation                        | After writing code                                    |
| `superpowers:using-git-worktrees`            | Worktree workflow for parallel work                     | PM dispatches Coder isolated                          |
| `superpowers:executing-plans`                | Multi-step plan execution                               | PM Mode 1 Step 4 (dispatch)                           |
| `superpowers:dispatching-parallel-agents`    | Parallel `Agent()` patterns                             | PM multi-task dispatch                                |
| `superpowers:finishing-a-development-branch` | Pre-PR checklist                                        | Coder before opening a PR                             |
| `frontend-design:frontend-design`            | Distinctive UI design (non-generic)                     | New page / complex UI                                 |
| `anthropic-skills:consolidate-memory`        | Lessons rotation + skill promotion                      | After a merged PR at the 20-line threshold            |

### 5.3 Project-specific skills (created in Phase 4-5)

These are **created by us** in Phase 4 (lessons → skills) + Phase 5 (custom for our patterns):

| Skill                                | What's inside                                                                                                                                                                                               | Phase                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `skills/recruiting-domain-rules`     | Business invariants: max 1 active JUNIOR / project, ACCOUNTANT auto-in-team, max 10 teams, JUNIOR derived from `project_members`, SENIOR can't be deleted (only team), team_members does not contain JUNIOR | Phase 4                                                  |
| `skills/ua-tax-fop`                  | UA FOP group 2-3 tax rules, edge cases (subject change, recharacterization risk, USDT income treatment)                                                                                                     | Phase 4 (stub) — fill at the first relevant consultation |
| `skills/ua-cfc-rules`                | CFC art. 39² of the Tax Code, controlled foreign company obligations                                                                                                                                        | Phase 4 (stub)                                           |
| `skills/ua-nda-ip`                   | NDA / IP clauses for UA contracts, non-circumvention enforceability                                                                                                                                         | Phase 4 (stub)                                           |
| `skills/ua-gdpr-personal-data`       | Law 2297-VI + GDPR territorial scope for CRM passport/wallet/email storage                                                                                                                                  | Phase 4 (stub)                                           |
| `skills/ua-crypto-banking`           | NBU memorandum (USDT caps), Law 2074-IX virtual assets, bank/crypto interaction limits                                                                                                                      | Phase 4 (stub)                                           |
| `skills/cross-session-orchestration` | `mcp__scheduled-tasks` + `pm-schedule.sh` workflow, Layer 1 vs Layer 2 decision matrix                                                                                                                      | Phase 5                                                  |
| `skills/user-testing-tunnel`         | Serveo SSH tunnel + production build + Dev Login flow, troubleshooting (build/DB/tunnel/port-clash)                                                                                                         | Phase 5                                                  |
| `skills/dev-flow-resilience`         | D1-D4 fixes summary, intent markers, pre-push gate, AC verification, watchdog recovery                                                                                                                      | Phase 5                                                  |
| `skills/pm-mode-orchestration`       | PM Mode 1-5 state-machine, transitions, when to enter each mode                                                                                                                                             | Phase 5                                                  |

### 5.4 How to invoke a skill

```python
Skill("nestjs-patterns")
# or with an argument:
Skill("anthropic-skills:consolidate-memory", "after-merge-batch")
```

Skill output — markdown with workflow / examples / triggers. The agent reads + applies it. Skills are durable — they don't depend on session memory.

---

## Section 6 — Hooks {#section-6}

Hooks are **automatically firing** interceptors on tool invocations. After Phase 2 (migration to ECC JSON-matcher format) they become:

- **Specific** — fire only when the matcher matches (vs broad `Bash` / `Edit|Write`).
- **Composable** — multiple hooks can react to the same event without conflicting.
- **Centralized** — registered in `.claude/settings.json` (ECC format).

### 6.1 Hooks after Phase 2

| Hook | Trigger (matcher) | What it blocks / does | How to override (if possible) |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `safety` (port of `safety.sh`) | `tool == "Bash" && command matches "<dangerous-pattern>"` | Blocks `rm -rf /`, `git push --force origin main`, etc. dangerous commands | Cannot override without USER consent via an explicit flag |
| `block-production-edits` (zone-of-write) | `tool in ["Edit","Write","MultiEdit","NotebookEdit"] && file_path matches "apps/\*\*                               | packages/\*\*" && agent != "coder"` | Blocks PM/Architect/Legal/etc. from editing production code. Only Coder allowed. | `.claude/.allow-direct-edits` — **only for the USER in their session**, not for agents |
| `coder-pre-push` (AC verification) | `tool == "Bash" && command matches "git push"` + last commit branch matches `feature/* / fix/* / infra/* / test/*` | Blocks push if the last commit does not contain an `ac_verified: N` marker | Finish the AC → an honest commit with `ac_verified: 1,2,3`. **NEVER** `--no-verify` (per RULES.md §2.1 zero-tolerance) |
| `eslint-feedback` (reduced scope per MCP-first) | `tool in ["Edit","Write"] && file_path matches "*.ts*"` | Triggers `mcp__eslint__lint-files` on the changed file, surfaces remaining issues. Does not block — informational. | Edit hook config in `.claude/settings.json` |
| `russian-language-enforcement` (new — Phase 5 rule) | Per-agent system prompt directive | Not a technical hook — it is a rule in agent prompts. The agent must respond in Russian (chat output, comments, task-files). | N/A — it is a convention, not an enforceable hook |
| `continuous-learning` (ECC observer, Phase 2 spike confirms) | `*` PreToolUse — pattern observer | Captures tool-use patterns for skill discovery. Informational, never blocks. | Disable in settings.json if noise is too high |
| `dev-server-tmux-enforcement` (TBD if it exists in the ECC `developer` profile) | `tool == "Bash" && command matches "pnpm dev                                                                       | nest start --watch"` | Routes dev server start through a tmux session — prevents stale processes (memory item `feedback_post_feature_checklist`) | Phase 1 spike confirms availability |
| `pre-push-verification-gate` (composite) | `tool == "Bash" && command matches "git push"` | Runs `pnpm test:unit && pnpm typecheck` locally before push. Blocks on any failure (per `feedback_e2e_before_push`). | Finish failing tests / fix types. Do not override. |

### 6.2 Hooks that existed (deleted after Phase 6)

| Old (pre-migration)                       | Replaced by                                                                                         | Phase                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `.claude/hooks/safety.sh`                 | ECC JSON-matcher `safety` hook                                                                      | Phase 2 (coexistence 1 week) → Phase 6 delete |
| `.claude/hooks/block-production-edits.sh` | ECC JSON-matcher `block-production-edits`                                                           | Phase 2 → Phase 6 delete                      |
| `.claude/hooks/coder-pre-push.sh`         | ECC JSON-matcher `coder-pre-push`                                                                   | Phase 2 → Phase 6 delete                      |
| `.claude/hooks/coder-progress-marker.sh`  | **REMOVED** if ECC `continuous-learning` covers it (Phase 1 spike confirms) OR ECC PostToolUse port | Phase 2 (decision deferred to Phase 1 spike)  |
| `.claude/hooks/eslint-feedback.sh`        | ECC JSON-matcher `eslint-feedback` (reduced scope, MCP-first)                                       | Phase 2 → Phase 6 delete                      |

### 6.3 When a hook blocks — what to do

1. **Read the error message** — ECC hooks output a specific reason (e.g. "`ac_verified` marker missing in last commit").
2. **Don't bypass via `--no-verify`** — this is zero-tolerance (RULES.md §2.1). Real incidents 2026-06-02: 3× in one session.
3. **Fix the root cause:**
   - AC marker missing → finish the AC → an honest commit with `ac_verified: 1,2,3`.
   - Production edit blocked → create a task-file for Coder (PM does not edit code directly, per `pm.md` Write zones).
   - Dangerous command blocked → rewrite the command without force-flags.
4. **If the hook misfires** (false positive) — a task for DevOps: fix the matcher in `.claude/settings.json` + test the trigger conditions.

---

## Section 7 — Memory & lessons {#section-7}

Per `docs/agents/memory/README.md` (v2, 2026-06-02). Here — a practical guide.

### 7.1 Where lessons live

```
docs/agents/memory/
├── README.md          (convention)
├── coder/
│   ├── lessons.md          (active, ≤ 20 lines)
│   └── lessons.archive.md  (historical, full record)
├── autotest/
│   ├── lessons.md
│   └── lessons.archive.md
├── reviewer/
│   ├── lessons.md
│   └── lessons.archive.md
├── devops/
│   ├── lessons.md
│   └── lessons.archive.md
├── legal/
│   ├── lessons.md
│   └── lessons.archive.md
└── pm/
    ├── lessons.md
    └── lessons.archive.md
```

After Phase 4 (lessons → skills) — **additionally** appear:

```
skills/
├── nestjs-patterns/SKILL.md      (ECC reference, Phase 1)
├── recruiting-domain-rules/SKILL.md  (Phase 4)
├── ua-tax-fop/SKILL.md           (Phase 4 stub)
├── cross-session-orchestration/SKILL.md  (Phase 5)
└── ...
```

### 7.2 When to add a lesson

**After every merged PR (no exceptions)** — this is PM workflow Mode 2 (completed):

```
<YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic) <concrete lesson in one phrase>
```

**Good example:**

```
2026-06-02 [P0] [task-pr74-pdf-refresh] (#visual-verify) PDF/SVG verified only via a playwright screenshot — UTF-16 grep is not enough for a bodyflate stream
```

**Bad example (don't write):**

```
2026-06-02 [P2] [task-X] Did the task. Used TanStack Query.
```

### 7.3 Priority guide (rule of thumb)

- **P0** — critical (data loss / security gap / repeat regression / system failure). The agent MUST read it at session start.
- **P1** — important (rework / more review rounds / pipeline slowdown). Must be taken into account.
- **P2** — nice-to-know. Helps optimize, does not block.

Lesson about a **mechanism** (gate, label, hook) → P0
Lesson about **safety/security/data** → P0
Lesson about **regression-prevention** → P0 or P1
Lesson about **process/communication** → P1
Lesson about **optimization/style** → P2

### 7.4 Rotation flow (when `lessons.md` reaches 20 lines)

PM invokes `anthropic-skills:consolidate-memory`:

1. **The skill analyzes** duplicates / simplifies / extracts patterns.
2. **P0 lessons (5+ repetitions)** → promote to the Golden rules of the corresponding agent doc (`<agent>.md`).
3. **P1 lessons** → consolidate into `RULES.md` (if cross-agent) or `<agent>.md` (if agent-specific).
4. **P2 lessons** → archive to `lessons.archive.md`.

After Phase 4 — one more level is added:

5. **Topic cluster (≥3 lessons on one topic)** → promote to `skills/<topic>/SKILL.md` (durable knowledge primitive).

### 7.5 Quarterly skill review process

Per ADR Section 7 (ECC version sync) + the Phase 6 retrospective recommendation:

- **Every quarter** (or after a major ECC release) — a full review:
  - `skills/` directory — which skills are current, which are stale.
  - `lessons.md` — which grew into a topic cluster (promote to a skill).
  - ECC upstream sync — merge new patterns from the `evergreen-claude-coding` upstream.
  - Update `RULES.md` per consolidated patterns.

### 7.6 When to extract a recurring lesson → permanent skill

**Trigger for promotion (lesson → skill):**

- 5+ repetitions of the same pattern in lessons.md over the last 6 months.
- The lesson is about a **workflow/pattern** (not a one-off incident).
- Applicable for **multiple agents** or **multiple modules**.

**Steps:**

1. Identify the cluster (via `anthropic-skills:consolidate-memory` or manually).
2. Invoke `superpowers:writing-skills` or ECC `skill-creator` to bootstrap.
3. Write `skills/<topic>/SKILL.md` per the ECC format:
   - Frontmatter: `name` / `description` / `origin`
   - `## When to Activate` (trigger conditions)
   - `## Workflow` (step-by-step)
   - `## Tested examples` (real cases with outcomes)
4. PR — review focuses on accuracy + reusability.
5. After merge — the lessons (that were promoted) move to `lessons.archive.md` with a link to the new skill.

---

## Section 8 — Direct agent dispatch (advanced) {#section-8}

For a tech-fluent user who wants direct control without PM overhead. After Phase 3 — all ECC agents are invokable via the `Agent` tool directly.

### 8.1 Basic pattern

```python
Agent(
  subagent_type="planner",  # or another ECC agent
  description="Plan: <feature>",
  prompt="""Plan implementation of <feature>.
Context: <our project specifics>.
Output: atomic tasks with dependencies + effort estimate."""
)
```

**Parameters:**

- `subagent_type` — the name of an agent from the ECC `AGENTS.md` catalog (per ADR Section 2 + ECC reference).
- `description` — human-readable, for display in the session UI.
- `prompt` — the task for the agent (with context).
- `isolation="worktree"` — for write-agents (Coder, DevOps, AutoTest, Architect) — gives an isolated worktree.
- `run_in_background=True` — for long-running agents (Coder 15-40 min), a background notification when complete.

### 8.2 Per-scenario agent reference (post Phase 6)

| Scenario                               | Agent                                   | When to invoke directly (without PM)                                                                      |
| -------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Decompose complex task into a plan     | `planner` (ECC)                         | When the task is clear at a high level but the decomposition isn't obvious. Output — a plan draft.        |
| Architecture design with trade-offs    | `architect` (ECC)                       | An open design question with multiple valid options. Output — an ADR-style document.                      |
| Write a failing test first (RED phase) | `tdd-guide` (ECC)                       | Any bug fix. Any non-trivial feature. **Default** for bugs.                                               |
| Code review one PR                     | `code-reviewer` (ECC)                   | Quick check without the full Reviewer gate.                                                               |
| Security scan on finance/auth          | `security-reviewer` (ECC)               | Before merging finance/auth changes.                                                                      |
| Diagnose a build failure               | `build-error-resolver` (ECC)            | `pnpm build` fails with an unclear error.                                                                 |
| Tune harness config                    | `harness-optimizer` (ECC)               | Settings.json optimization, hook tuning.                                                                  |
| TypeScript-specific review             | `typescript-reviewer` (ECC)             | Strict mode issues, type narrowing problems.                                                              |
| Run E2E (or fix flaky)                 | `e2e-runner` (ECC, if in profile)       | Spec changes, flaky test debugging.                                                                       |
| Refactor cleanup                       | `refactor-cleaner` (ECC, if in profile) | Post-feature dead code / duplication cleanup.                                                             |
| Docs refresh                           | `doc-updater` (ECC, if in profile)      | After a feature merge — refresh codemaps + READMEs.                                                       |
| Auto-loop coordination                 | `loop-operator` (ECC)                   | Long-running multi-agent task with stop conditions.                                                       |
| Skill creation                         | `skill-creator` (ECC)                   | Promote a lesson cluster to a durable skill.                                                              |
| Legal consultation                     | `Legal` (custom, ours)                  | UA jurisdictional question. PM Mode 5 normally, but direct dispatch is also valid.                        |
| Full Coder cycle                       | `Coder` (custom, ours)                  | Only through PM (worktree isolation + task-file pattern). Direct dispatch — only for hot-fix emergencies. |

### 8.3 Anti-patterns (when NOT to direct-dispatch)

- **Don't bypass PM for the standard feature flow** — PM tracks state (`pm-state.json`), dispatches Reviewer in parallel, manages User Testing. Bypass = loss of state + a missing review gate.
- **Don't invoke Coder directly for production code** — worktree isolation requires a PM-managed dispatch. Direct = risk of a broken state in the current worktree.
- **Don't invoke multiple write-agents simultaneously without `isolation="worktree"`** — a conflict in the working directory.

### 8.4 When direct dispatch is useful

- **You need a quick answer** (planner / architect) without the full task-file overhead.
- **Diagnostic check** before the full PM cycle (security-reviewer on a draft PR).
- **Skill / pattern lookup** (skill-creator, harness-optimizer).
- **Emergency hot-fix** (Coder with a minimal task description).

---

## Section 9 — Decision tree {#section-9}

Quick reference: which request → which agent / sequence.

### 9.1 Main table

| USER request                                       | Agent (or sequence)                                                                                                                                                                                  | PM Mode                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| "I want a new feature X"                           | BA (you) write a brief → PM Mode 1 → planner → tdd-guide → Coder + typescript-reviewer parallel → code-reviewer + (opt.) security-reviewer + Legal Mode B (if critical zone) + AutoTest + e2e-runner | Mode 1 → 2 → 4                        |
| "Something doesn't work / regression"              | tdd-guide (RED) → Coder (GREEN + IMPROVE) → code-reviewer                                                                                                                                            | Mode 2.A (if blocked) or quick Mode 2 |
| "Legal / tax question about the current feature"   | PM Mode 5 Mode A → Legal                                                                                                                                                                             | Mode 5 (A)                            |
| "Strategic legal question (hire, open, switch to)" | PM Mode 5 Mode D → Legal                                                                                                                                                                             | Mode 5 (D)                            |
| "Which approach to take for Y"                     | architect → trade-offs ADR → USER decides → implementation phase                                                                                                                                     | Mode 1 (after the decision)           |
| "Code quality concern"                             | code-reviewer (+ opt. security-reviewer if critical zone)                                                                                                                                            | Mode 2.D (if BLOCK)                   |
| "Unclear build error"                              | build-error-resolver                                                                                                                                                                                 | (inside Mode 1 dispatch)              |
| "Refactor request"                                 | refactor-cleaner + typescript-reviewer + code-reviewer                                                                                                                                               | Mode 1 quick cycle                    |
| "E2E test broken (flaky)"                          | e2e-runner → AutoTest (fix spec) → re-run                                                                                                                                                            | Mode 2.C                              |
| "Docs outdated"                                    | doc-updater (if present) OR PM updates `docs/business/` directly OR a Coder task                                                                                                                     | Mode 1                                |
| "Migration plan / architecture change"             | architect → ADR → USER decides → multi-phase plan                                                                                                                                                    | Mode 1                                |
| "Harness/settings tuning"                          | harness-optimizer                                                                                                                                                                                    | (via PM or direct)                    |
| "Promote a lesson to a skill"                      | skill-creator or `superpowers:writing-skills`                                                                                                                                                        | Phase 4 ongoing                       |
| "PR is stuck / Coder hung"                         | PM Mode 2.E (state sync) → `coder-recover` flow → restart                                                                                                                                            | Mode 2.E                              |
| "User Testing tunnel went down"                    | PM checks `/tmp/pm-{api,web}.log` + Serveo log → classify (build/DB/tunnel/port-clash) → fix-task for Coder/DevOps → retry                                                                           | Mode 4 (Step 0 recovery)              |

### 9.2 Critical zones decision matrix

| PR diff matches                                                 | MUST dispatch                                                                        | Optional dispatch                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| `apps/api/src/finance/**` or `apps/api/src/payments/**`         | code-reviewer + security-reviewer + Legal Mode B                                     | AutoTest (if no e2e in the diff)        |
| `apps/api/src/auth/**`                                          | code-reviewer + security-reviewer + Legal Mode B (for passport/wallet/personal data) | —                                       |
| `apps/api/src/documents/**` (S3 / passport storage)             | code-reviewer + security-reviewer + Legal Mode B                                     | —                                       |
| `packages/shared/src/schemas/{auth,finance,users,documents}.ts` | code-reviewer + Legal Mode B                                                         | typescript-reviewer                     |
| Smart contracts / USDT paths                                    | code-reviewer + security-reviewer + Legal Mode B                                     | architect (if design change)            |
| `.github/workflows/**`                                          | code-reviewer + DevOps review                                                        | security-reviewer (if secrets handling) |
| `apps/api/drizzle/migrations/**`                                | code-reviewer + DevOps (smoke test fresh DB)                                         | architect (if breaking change)          |
| `apps/web/**` (UI only, no API)                                 | code-reviewer + AutoTest                                                             | —                                       |
| `docs/**` only                                                  | (skip review)                                                                        | doc-updater                             |
| `CLAUDE.md` / `RULES.md`                                        | architect                                                                            | —                                       |

Per `docs/agents/pm.md` Mode 2 — auto-dispatch decisions are encoded in an event table.

### 9.3 Confidence escalation flow

Per ADR Section 4 + Legal escalation zones:

```
Confidence: HIGH    → Standard flow, no extra escalation
Confidence: MED     → PM notes it in the response, the user may ignore
Confidence: LOW     → PM **must** notify the USER: "Verify with a human lawyer / specialist BEFORE acting"
Confidence: LOW + hard zone → PM records a `legal_escalated_to_human` event, does NOT dispatch auto-actions, waits for the USER decision
```

**Hard zones** (per `docs/legal/cross-cutting/escalation-zones.md`):

- UA Tax compliance + recharacterization risk (FOP → labor)
- CFC obligations (controlled foreign company)
- Crypto/banking caps (NBU memorandum)
- Personal data (GDPR territorial + UA Law 2297-VI)
- Contract enforceability (NDA, IP, non-circumvention)

---

## Section 10 — FAQ + gotchas {#section-10}

### 10.1 "I want to bypass an agent" — when and how

**When bypassing is right:**

- Hot-fix prod (1-2 line typo, found via a user error)
- Documentation typo
- Script config tweak (settings.json, not code)

**How:**

- Create `.claude/.allow-direct-edits` (escape hatch — **only in your USER session, not for agents**, per `pm.md` Write zones + RULES.md §5).
- Direct Edit/Write via native tools.
- Commit + push via the standard git flow.

**When bypass is WRONG:**

- "Quick 30-second fix" feature work — this is an **anti-pattern** (per `pm.md` Write zones). 10 minutes of overhead on a task-file is a sign of the right discipline.
- Bypassing AC verification via `--no-verify` — **NEVER** (RULES.md §2.1 zero-tolerance). Real incidents 2026-06-02: 3× in one session.
- Bypassing zone-of-write via a manual edit when an agent should do it.

### 10.2 "An agent made a mistake / did it badly" — recovery patterns

| Symptom                                                    | Recovery                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coder wrote garbage (broken code, doesn't work)            | PM Mode 2.D (Reviewer Verdict: BLOCK) → fix-task for Coder. If `review_rounds >= 3` — STOP, escalate to USER                                                        |
| Reviewer false-positive (approved a good PR with an issue) | USER in chat "Reviewer missed X" → PM creates a fix-task → Coder fixes → re-review                                                                                  |
| AutoTest no-op (0 specs added)                             | PM creates a new task with a **selector map** → restarts AutoTest. Per `pm.md` Mode 2 (autotest no-op handler)                                                      |
| Legal Confidence: LOW in a hard zone                       | PM **already** recorded `legal_escalated_to_human`, does **not** dispatch auto-actions, waits for USER. USER decides: verify with a human lawyer or accept the risk |
| PM got confused (state desync)                             | USER "read pm-state.json and describe the current state" → PM Mode 3 (resume) → manual reconciliation                                                               |
| Hung Coder (>10 min silence)                               | PM Mode 2.E → `coder-recover` flow → restart from the last milestone                                                                                                |

### 10.3 "Too much dispatch overhead" — when NOT to use agents

- **Trivial typo** in a comment / log message → direct edit (USER, escape hatch).
- **Config tweak** in settings.json / `.gitignore` → direct edit.
- **Quick question** "how does X work" — no dispatch needed, the USER reads the code via MCP `ast-grep` / `context7`.
- **Pure docs read** (understand the architecture) → the USER reads directly.

**When dispatch overhead _is_ justified:**

- Any change in `apps/**` / `packages/**` — production code.
- Any write of more than 1 file.
- Any change with testable behavior.
- Any decision with trade-offs.

### 10.4 "Conflict between agents" — who wins (priority order)

| Conflict                                                                | Winner                                                                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Coder vs Reviewer (Coder push, Reviewer BLOCK)                          | Reviewer wins, fix-task for Coder                                                                                       |
| Coder vs AutoTest (both write to `apps/e2e/`)                           | AutoTest — zone-of-write owner for `apps/e2e/tests/*.spec.ts`. Coder must hand off via `.blocked.md` or a fix-task      |
| AutoTest vs Reviewer (test wrong vs code wrong)                         | PM Mode 2.C classification: code → Coder fix, test → AutoTest fix                                                       |
| Architect vs Coder (design recommendation contradicts existing pattern) | USER decides. Architect output — a recommendation, not a mandate.                                                       |
| Legal vs Coder (Legal flagged a risk, Coder reluctant)                  | USER decides — Legal info-only (label `legal-noted`), not a gate. USER can either accept the risk or cancel the feature |
| Reviewer vs Security-reviewer (code OK, security issue)                 | Security wins — `Verdict: BLOCK`, fix-task                                                                              |

### 10.5 "Request a human professional's opinion" — escalation patterns

| Domain                      | When                                                                                             | To whom                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Legal (jurisdictional)      | Confidence: LOW in a hard zone (UA tax / CFC / crypto / personal data / contract enforceability) | UA-licensed lawyer (UA-law attorney)                                 |
| Security audit (production) | Before a production launch (Phase 8+)                                                            | External security audit firm                                         |
| Financial compliance        | Income > FOP threshold, a TOV transition decision                                                | UA tax consultant (CPA / tax advisor)                                |
| Smart-contract audit        | Phase 8 USDT contract deployment                                                                 | Solidity audit firm (Trail of Bits / Consensys Diligence equivalent) |
| GDPR compliance             | EU user data processing                                                                          | Privacy lawyer + DPO consultation                                    |

### 10.6 "Pause migration mid-phase" — how

- **Stop dispatching Architect** — don't start a new Phase until approval.
- **Coexistence preserved** — all intermediate phases leave the old structure intact (Phase 2: hooks coexist 1 week; Phase 3: agents in `_legacy/`; Phase 6 only deletes).
- **Rollback per-phase** — each phase PR has an explicit Rollback Strategy in ADR Section 6.
- **State sync** — `pm-state.json` captures migration progress, can resume.

### 10.7 "Roll back an assistance change" — rollback granularity

| Granularity     | How                                                                                 |
| --------------- | ----------------------------------------------------------------------------------- |
| Single PR       | `git revert <commit>` on main, PR closed                                            |
| Single Phase    | All phase PRs reverted in reverse order                                             |
| Multiple Phases | Sequential revert per Phase ADR Rollback Strategy                                   |
| Full migration  | Per Phase 6 ADR Rollback Strategy — legacy files restored from `migration-archive/` |

### 10.8 "Control token usage" — best practices

- **PM writes `pm-state.json` minimally** — events only, no verbose context dumps.
- **Agent prompts**: use a reference (e.g. "Read docs/agents/coder.md") rather than inline (the full prompt every time).
- **Background dispatch** — not chat-blocking, doesn't duplicate context until notify.
- **Skill invocations** — durable knowledge, not duplicated on every agent dispatch.
- **MCP first** — token-efficient vs reading whole files (e.g. `mcp__postgres__query` vs reading `schema.ts`).
- **lessons.md ≤ 20 lines** — rotation prevents unbounded context growth.

### 10.9 "What if ECC doesn't come with an expected agent / skill"

**The Phase 1 spike** confirms the actual content of the `developer` install profile. If an agent/skill is missing:

- **Scenario A** — the agent exists in ECC but not in the `developer` profile → install with `--with-extras <agent-name>` (per ECC `REPO-ASSESSMENT.md`).
- **Scenario B** — the agent doesn't exist in the ECC catalog → keep custom (if it already was custom) or skip (if it was optional).
- **Scenario C** — a skill is missing → create a custom one in Phase 5 (per ADR Section 4.7 — 4 custom skills already planned).

### 10.10 "Cross-harness portability — when is it realistic"

ADR Section 6 Phase 5 creates **placeholders** (`.codex/`, `.cursor/`, `.gemini/`, `.opencode/`, `.zed/`). Real portability:

- **Phase 7+** (post-migration, not in the current 6-9 week plan).
- Requires ECC pattern adoption in each harness — Codex / Cursor / Gemini don't equally support `agent.yaml` manifests.
- Realistic timeline — 2027+ given significant ECC community adoption.
- Today's value — **future-proofing infrastructure**, not an immediate capability.

---

## Section 11 — Quick start "first 5 minutes after Phase 6" {#section-11}

Once Phase 6 is merged and the migration is complete — the top 5 things to do right away:

### Step 1 — Verify ECC install

```bash
# Check pin is honored
cat ecc-pin.txt
# Expected: ECC tag SHA (e.g. v2.0.0-rc.1 commit SHA)

# Check reference dirs present
ls -d agents/ skills/ hooks/ rules/ manifests/ mcp-configs/ 2>/dev/null || \
  ls -d .claude/ecc/agents/ .claude/ecc/skills/ 2>/dev/null
# (depending on Q6 outcome — root vs .claude/ecc/)

# Check no regression in existing tests
pnpm test
pnpm typecheck
```

**If something is missing** — the Phase 1 install did not complete fully. Read `docs/architecture/2026-XX-XX-ecc-migration-retrospective.md` (Phase 6 deliverable) for details.

### Step 2 — List available agents

```python
# In the Claude Code session:
Skill("anthropic-skills:using-superpowers")
# (bootstrap)

# List ECC agents:
Bash("ls agents/ 2>/dev/null || ls .claude/ecc/agents/ 2>/dev/null")
```

Or via the `/agents` slash command (if registered).

**Expected output** — a list of ~10-15 agent files:

- `planner.md`, `architect.md`, `code-reviewer.md`, `security-reviewer.md`, `tdd-guide.md`, `typescript-reviewer.md`, `build-error-resolver.md`, `harness-optimizer.md`, `loop-operator.md`, plus our custom: `pm.md`, `coder.md`, `autotest.md`, `devops.md`, `legal.md`, `ba.md`.

### Step 3 — Try a slash command on a small change

Find a small PR (1-2 file change, no critical zone):

```
/code-review
```

If it works — the agent dispatches, reads the diff, produces a review. If not — the Phase 5 slash command registration is incomplete.

**Alternative** (if the slash command isn't registered):

```python
Agent(
  subagent_type="code-reviewer",
  description="Manual code-reviewer test",
  prompt="Review the diff in current branch vs main. Report issues by severity."
)
```

### Step 4 — Trigger the TDD workflow

Create a trivial bug fix scenario:

```
/tdd "fix typo in /api/users response"
```

Or manually:

```python
Agent(
  subagent_type="tdd-guide",
  description="TDD: typo fix",
  prompt="""Write a failing test that catches typo 'usrname' instead of 'username' in /api/users response.
Repo: yaremenko-maksym/CheekyCheeseIT_CRM
Branch: main"""
)
```

Verify: the agent created a failing test → the spec is runnable → the RED phase is visible. This validates that TDD-guide works.

### Step 5 — Browse the skills catalog

```bash
ls -la skills/ 2>/dev/null || ls -la .claude/ecc/skills/ 2>/dev/null
```

**Expected** — ~10-15 skill directories, each with a `SKILL.md`. Read the interesting ones:

- `skills/nestjs-patterns/SKILL.md` — NestJS conventions.
- `skills/recruiting-domain-rules/SKILL.md` — our business invariants.
- `skills/ua-tax-fop/SKILL.md` — placeholder for UA tax knowledge.

**Try invoke:**

```python
Skill("nestjs-patterns")
```

Output — markdown content. Use it in the next dispatch as context.

### Step 6 (bonus) — Verify cross-harness placeholders

```bash
ls -d .codex/ .cursor/ .gemini/ .opencode/ .zed/ 2>/dev/null
cat .codex/README.md 2>/dev/null
```

Expected — placeholder dirs with a README explaining "not active yet, Phase 7+".

### Step 7 (bonus) — Try the Legal consultation flow

In chat:

```
USER: ask the lawyer — can we store passport scans on S3 without encryption for UA users
```

PM Mode 5 Mode A:

1. Creates `docs/specs/tasks/task-legal-passport-s3-encryption.md`
2. Dispatches Legal via the "Legal — Mode A" snippet
3. Legal analyzes (Law 2297-VI personal data + GDPR territorial + AWS encryption defaults)
4. Returns TL;DR + Confidence + recommendation
5. PM shows a summary with a warning if Confidence: LOW

Validates: the Legal Mode A pipeline works post-migration.

---

## Appendix A — Cross-references

| Topic                                                        | Source                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Full migration timeline + per-phase AC                       | [ADR Section 6](2026-05-31-ecc-migration-design.md#section-6--phase-plan-0--6)                       |
| Per-component mapping (Adopt / Adapt / Keep custom / Remove) | [ADR Section 2](2026-05-31-ecc-migration-design.md#section-2--per-component-mapping)                 |
| Identified gaps + local adaptations                          | [ADR Section 4](2026-05-31-ecc-migration-design.md#section-4--identified-gaps--local-adaptations)    |
| Risk matrix                                                  | [ADR Section 5](2026-05-31-ecc-migration-design.md#section-5--risk-matrix)                           |
| ECC version sync policy                                      | [ADR Section 7](2026-05-31-ecc-migration-design.md#section-7--ecc-version-pin--upstream-sync-policy) |
| Open Questions resolution                                    | [ADR Section 9](2026-05-31-ecc-migration-design.md#section-9--open-questions-for-user)               |
| Legal agent design                                           | [`2026-05-31-legal-agent-design.md`](2026-05-31-legal-agent-design.md)                               |
| Architect discovery report                                   | [`2026-05-31-architect-discovery-report.md`](2026-05-31-architect-discovery-report.md)               |
| Dev-flow RCA (D1-D4 fixes)                                   | [`2026-05-23-dev-flow-rca.md`](2026-05-23-dev-flow-rca.md)                                           |
| Current PM agent (Mode 1-5)                                  | [`../agents/pm.md`](../agents/pm.md)                                                                 |
| PM dispatch snippets (on-demand)                             | [`../agents/pm-snippets.md`](../agents/pm-snippets.md)                                               |
| Cross-agent rules                                            | [`../agents/RULES.md`](../agents/RULES.md)                                                           |
| Cross-agent contracts (state-machine)                        | [`../agents/contracts.md`](../agents/contracts.md)                                                   |
| Project state (phases / RBAC / migrations)                   | [`../agents/project-state.md`](../agents/project-state.md)                                           |
| Memory convention (lessons / rotation)                       | [`../agents/memory/README.md`](../agents/memory/README.md)                                           |
| Legal escalation zones                                       | [`../legal/cross-cutting/escalation-zones.md`](../legal/cross-cutting/escalation-zones.md)           |
| Legal citation rules                                         | [`../legal/cross-cutting/citation-rules.md`](../legal/cross-cutting/citation-rules.md)               |

---

## Appendix B — Glossary

| Term                            | Meaning                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **ECC**                         | Evergreen Claude Coding — open-source multi-agent reference architecture (`v2.0.0-rc.1` pinned per ADR Section 7)              |
| **Adopt**                       | Use ECC artifact as-is (no project customization)                                                                              |
| **Adapt**                       | ECC base + local override (e.g. agent prompt + Russian language note)                                                          |
| **Keep custom**                 | No ECC equivalent worth adopting (e.g. PM business logic, Legal UA jurisdictional knowledge)                                   |
| **Phase 0-6**                   | Migration phases per ADR Section 6 (Discovery → Skeleton → Hooks → Agents → Skills → Rules+GHA → Cleanup)                      |
| **Agent shell**                 | Custom agent prompt that delegates sub-tasks to ECC agents (e.g. Coder shell delegates to `tdd-guide` + `typescript-reviewer`) |
| **Zone-of-write**               | Per-agent allowed/forbidden file paths, enforced via the `block-production-edits` hook                                         |
| **Confidence policy**           | HIGH/MED/LOW labels on agent outputs (per ECC `code-reviewer` pattern) — PM uses LOW for USER escalation                       |
| **Mode 1-5**                    | PM workflow modes (1=new feature, 2=event handling, 3=resume, 4=User Testing, 5=Legal)                                         |
| **Legal Mode A-D**              | Legal agent modes (A=consult, B=PR review, C=brief check, D=strategic)                                                         |
| **Slash command**               | Shortcut invocation (e.g. `/plan`, `/tdd`) for common workflows — Phase 5+                                                     |
| **Skill**                       | Durable workflow pattern in `skills/<topic>/SKILL.md` — invokable via the `Skill` tool                                         |
| **JSON-matcher hook**           | ECC hook format with specific predicates (vs the old broad shell matcher) — Phase 2                                            |
| **`developer` install profile** | ECC install profile recommended in ADR Section 3 (vs `minimal` / `full`)                                                       |
| **Cross-harness**               | Multiple coding harnesses (Claude Code, Codex, Cursor, Gemini, OpenCode, Zed) sharing the same agent definitions — Phase 7+    |
| **AC verified marker**          | `ac_verified: 1,2,3` in a commit message — the pre-push hook enforces it per RULES.md §2.2                                     |
| **Worktree isolation**          | `isolation="worktree"` parameter on an `Agent()` dispatch — gives an isolated git worktree, prevents conflicts                 |
| **`pm-state.json` schema v2**   | PM state file format with an events log + agent_invocations + metrics aggregates (see the `pm-snippets.md` section)            |

---

**End of document.** If something is unclear — ask PM in chat; PM consults the ADR / agent docs per topic. This guide is an entry point, not a replacement for the detailed docs.
