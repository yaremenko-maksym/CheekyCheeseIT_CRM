# RULES — Cross-Agent Rules (TOC + references)

Single source of truth for rules applicable to all agents (Coder, AutoTest, Reviewer, DevOps, Architect, Legal). Orchestration is run by Master (USER session) — there is no separate PM agent (removed 2026-10-05). **Phase 5 of the migration** split topics into separate files under `.claude/rules/common/`. This document is the entry point: TOC + brief summaries + links.

**Who should read:** all agents upfront at session start. First this file (~3 KB), then the relevant `.claude/rules/common/<topic>.md` files on-demand.

> ECC pattern: `.claude/rules/common/` + `rules/<language>/` (see `.claude/rules/ecc/README.md`). We use only the common namespace in Phase 5; language extensions (typescript / web) — optional later.

---

## 0. Two layers: mechanism (always-on) and rationale (on demand)

**Added 2026-10-16** (progressive-disclosure restructure).

A rule file under `.claude/rules/common/` **without** a `paths:` frontmatter block is injected into
**every** request of every session and every subagent. So the always-on layer is kept to what an agent
must obey, and the reasons behind it live one pointer away:

| Layer         | Location                                      | Loaded                              | Contains                                                                                                                                                                      |
| ------------- | --------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mechanism** | `.claude/rules/common/<rule>.md`              | **always** (unless `paths:`-scoped) | Hook ids and refusal predicates, gates, mandatory report lines, zero-tolerance patterns, commit format, exact pins, zone rows, classifiers, "how we know it is violated" rows |
| **Rationale** | `docs/architecture/rules-rationale/<rule>.md` | on demand                           | Incidents and dates, precedent lists, rejected alternatives, root-cause analyses, measurement narratives, `Sources`                                                           |

Each core rule carries one pointer line near the top. **Read the rationale file before changing a
rule** — most of those files exist because the obvious alternative was already tried and failed in a
recorded way. Index and reading guidance: `docs/architecture/rules-rationale/README.md`.

**Path-scoped (NOT always-on), load only when matching files are touched:** `design-gate.md`,
`design-fidelity-review.md`, `responsive-design.md` (`apps/web/**`, `apps/landing/**`),
`eslint-mcp-first.md` (`**/*.ts(x)`), `mutation-gate-integration-specs.md` (`**/*.spec.ts(x)`).

---

## 1. Tool priority — `.claude/rules/common/mcp-first.md`

**Summary:** An MCP tool fits → MCP. No MCP, there is a native one (Read / Edit / Write) → native. Shell only → Bash. Never use Bash where a suitable MCP exists.

**Catalog highlights:** `ast-grep` for AST search, `postgres query` instead of reading `schema.ts`, `context7` for NestJS / TanStack / Zod / Drizzle, `eslint lint-files` instead of a post-edit hook (see also `.claude/rules/common/eslint-mcp-first.md` for Phase 2.5 details), `playwright browser_snapshot` before getByRole, `github` MCP for PR review.

See the full catalog + specific mandatory rules: **[`.claude/rules/common/mcp-first.md`](rules/common/mcp-first.md)**.

---

## 2. Git policy — `.claude/rules/common/git-policy.md`

**Summary:** Zero-tolerance forbidden: `--no-verify`, `git add .`, pushing to main directly, force-push to main, `--admin` merge. Commit format: `<type>(<scope>): <subject>` + `ac_verified: 1,2,3` + optionally `vision:` for UI. WIP chunking: push after 2 files / 5 minutes / before an operation > 1 min.

CI hard-block: `check-no-skip-hooks.yml` fails on any `--no-verify` in the diff. Pre-push hook (`pre-bash-coder-push-gate.sh`) requires `ac_verified:` on non-`wip:` commits.

See the full list of forbidden patterns + commit format + chunking: **[`.claude/rules/common/git-policy.md`](rules/common/git-policy.md)**.

---

## 3. Skill invocation (mandatory triggers) — `.claude/rules/common/skills-invocation.md`

**Summary:** If a trigger applies — the agent **must** invoke the skill via the `Skill` tool, not "remember" it. If a skill is absent — explicit failure via the `Skill` tool error (better than a silent skip).

**Trigger highlights:** session start → `superpowers:using-superpowers`; creative task → `superpowers:brainstorming`; feature/fix → `superpowers:test-driven-development`; long-running ops → `dev-flow-resilience`; review → `code-review-discipline`; security PR → `security-review`; .spec.ts → `playwright-patterns`; Legal mode → `ua-tax-compliance` / `ua-crypto-compliance` / `ua-it-contract` / `legal-escalation-patterns`.

See the full trigger → skill mapping (superpowers + project-local Phase 4 lift + ECC workflow surface policy): **[`.claude/rules/common/skills-invocation.md`](rules/common/skills-invocation.md)**.

---

## 4. Session recovery (after compaction / cold start)

Each agent — ALWAYS reads its golden rules + this section at the start of a new session. (This section stays in RULES.md, not extracted — it is navigational and tightly coupled to this document.)

### 4.1 Universal checklist (all agents)

1. Read `.claude/agents/<self>.md` section Golden rules + Recovery checklist.
2. Read `.claude/RULES.md` (this file) — TOC + links to topics.
3. Read the **relevant** `.claude/rules/common/<topic>.md` on-demand.
4. Read `.claude/agents/project-state.md` — current phases / migrations / RBAC.
5. Read your own `.claude/agents/memory/<self>/lessons.md`.

### 4.2 Per-agent additional steps

**Coder (after compaction):**

1. `git status && git log --oneline -10` — find out where you stopped
2. `cat .claude/tasks/<my-task>.progress.md` (if present) — milestone N/M
3. `tail -5 .claude/coder-activity.log | grep INTENT` — what you planned
4. Resume: if milestone N completed — continue from N+1. If the intent was "starting test run" without a push after — check you did not break anything locally.

**Master / orchestrator (after compaction):**

1. `ls .claude/tasks/*.md` — active tasks; `ls .claude/tasks/*.blocked.md` — blocked
2. `gh pr list --state open` — open PRs from agents + their labels / checks
3. For a cross-session wait — the external scheduler (`mcp__scheduled-tasks__*`), not in-session `ScheduleWakeup` (does not survive a session boundary). See §4.3.

**Reviewer / AutoTest / DevOps (after compaction):**

1. Re-read the PR / task file in full (without trusting conversation history).
2. If in the middle of work — `git status` / `git log --oneline -5`.

### 4.3 Wake-up layers — which when

Master uses two layers for cross-session waits.

| Layer                                | Survives session? | When                           |
| ------------------------------------ | ----------------- | ------------------------------ |
| `ScheduleWakeup` (in-session)        | NO                | Wait < 30 min, active session  |
| `mcp__scheduled-tasks__*` (external) | YES               | Wait ≥ 30 min OR critical fire |

Do not combine both layers on one wait — duplicate fires.

---

## 5. Zone-of-write — `.claude/rules/common/zone-of-write.md`

**Summary:** Each agent writes ONLY in its own zone. Reviewer issues `Verdict: BLOCK` on cross-zone diffs. Active hook `.claude/hooks/pre-edit-write-zone-of-write.sh` blocks Coder from the main repo when attempting `apps/**` / `packages/**` without the orchestrator's permission (live since Phase 2.5).

**Zone highlights:**

- **Coder** → `apps/**`, `packages/**`, its own task progress / blocked
- **AutoTest** → any test file in the repo (`**/*.spec.ts(x)` / `__tests__/` / `apps/e2e/**`), NOT product code
- **DevOps** → `.github/workflows/`, root scripts, `scripts/devops/**`
- **Master (orchestrator)** → `.claude/tasks/`, `.claude/briefs/`, `.claude/agents/memory/<X>/lessons.md` (append), `scripts/pm/**`
- **Architect** → `docs/architecture/**`, `rules/**`, `.claude/hooks/**`, `.claude/skills/**`, `.claude/RULES.md`, `<agent>.md` frontmatter + golden rules, `.claude/settings*.json` (hook registration)

See the full matrix + enforcement + worktree caveat + Architect-specific notes: **[`.claude/rules/common/zone-of-write.md`](rules/common/zone-of-write.md)**.

---

## 6. Memory & lessons protocol

Full description — `.claude/agents/memory/README.md`. (This section stays in RULES.md as navigational to the orchestrator's workflow, not extracted into `.claude/rules/common/`.)

### 6.1 When to write (trigger-based)

**After every merged PR (no exceptions)** Master MUST append 1-3 lessons to `.claude/agents/memory/<agent>/lessons.md`:

```
<YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic) <specific lesson in one phrase>
```

This is not optional — it is part of the orchestrator's workflow when accepting a merged PR.

### 6.2 What counts as a lesson

Good: about **what was non-obvious**, what is reproducible, what is preventable.
Bad: "did the task", "used TanStack Query" — that is normal workflow.

### 6.3 Priorities

- **P0** — critical (data loss, security gap, repeat regression, system failure). The agent MUST read it at start.
- **P1** — important (rework, pipeline slowdown). Must take it into account.
- **P2** — nice-to-know. Helps optimize.

### 6.4 Consolidation (promote-and-prune, WITHOUT archive)

When `lessons.md` reaches **20 lines** OR after a batch of merged PRs Master consolidates (dedup → promote → prune; **there are no archive files — history lives in git**):

1. Dedup / simplification / pattern extraction.
2. **P0 (5+ repetitions)** → promote into the Golden rules of the corresponding `<agent>.md`.
3. **P1** → consolidate into `rules/common/<topic>.md` (cross-agent) or `<agent>.md` (agent-specific).
4. **The rest (one-off / absorbed by a promotion)** → **delete** (not archive).

> In-repo consolidation of `lessons.md` is a separate Master operation, NOT the skill `anthropic-skills:consolidate-memory` (that dedups personal user-memory `~/.claude`, a different tree).
> **To keep it from rusting:** a non-blocking warn in `.husky/pre-push` (`scripts/check-lessons-cap.sh`) flags over-cap `lessons.md` on every push; plus the structure-conformance arm of workflow #10 catches them during an audit. A CI annotation can be added separately (needs a workflow-scope token — DevOps).

### 6.5 Structure

```
.claude/agents/memory/<agent>/
└── lessons.md          (active, ≤ 20 lines; there are NO archive files)
```

The `.md` archiving mechanism was removed (2026-06-29) — the stale is deleted, history is recoverable from git.

### 6.6 Phase 4 substantive lift

Phase 4 (see `docs/architecture/2026-06-03-phase4-deliverable.md`) lifted 51 substantive patterns from lessons.md → 7 skills under `.claude/skills/`. lessons.md is preserved as an append-log; skills — primary surface for invocation.

---

## 7. Version pins — `.claude/rules/common/version-pins.md`

**Summary:** Node 22 LTS, pnpm 7.32.4, Vite ^6.4 (NOT 7.x), TanStack Router `1.170.15` + plugin `1.168.18` (peer-matched EXACT pair, the numbers do NOT match), Tailwind v4, NestJS 11, Fastify ^5.8.5 via pnpm.overrides, Zod v4, PostgreSQL 16-alpine, Redis 7-alpine.

**Forbidden overrides:** `@tanstack/router-*` in pnpm.overrides, Vite 7.x, Node major change without a DevOps task.

See the full list with rationale + forbidden overrides: **[`.claude/rules/common/version-pins.md`](rules/common/version-pins.md)**.

---

## 8. Other extracted rules (Phase 2.5 + earlier)

- **Language policy** — **[`.claude/rules/common/russian-language.md`](rules/common/russian-language.md)** (owner decision 2026-10-05, supersedes ADR Q7 Option C). Everything in the repo and all agent output is English; Russian lives only in the owner↔Claude direct chat (personal, out-of-repo). Product i18n (`uk` default + `en` via Lingui) is separate and unchanged.
- **ESLint MCP-first** — **[`.claude/rules/common/eslint-mcp-first.md`](rules/common/eslint-mcp-first.md)** (Phase 2.5 supersedes the post-edit hook). Before Edit / Write on `.ts` / `.tsx` → `mcp__eslint__lint-files`.
- **Orchestration routing (agent vs workflow vs light-track)** — **[`.claude/rules/common/orchestration-routing.md`](rules/common/orchestration-routing.md)** (2026-06-22). Master chooses the degree of parallelism: single-pipeline vs wave-fanout vs read-only audit-fanout. Cost-of-error (critical-path zones, `contracts.md`) + light-track + model tier (`model-routing.md`) are NOT duplicated — they run earlier. Enforcement is procedural (judgment, like `design-gate`).
- **Model routing (model tier per task)** — **[`rules/common/model-routing.md`](rules/common/model-routing.md)** (2026-06-11). The cheapest sufficient model; escalation by trigger.
- **Light-track (light track of the master session)** — **[`rules/common/light-track.md`](rules/common/light-track.md)**. Small edits without orchestration ceremony + concurrency ceiling ≈ 3-4.
- **Design-gate (designer-in-the-loop for ANY UI)** — **[`rules/common/design-gate.md`](rules/common/design-gate.md)** (2026-06-22). Before code — generation / conformance (tier 1/2/3).
- **Responsive design (4 device classes)** — **[`rules/common/responsive-design.md`](rules/common/responsive-design.md)** (2026-06-23). Any UI usable on mobile / tablet / laptop / large; hard-gate.
- **Design-fidelity review (mockup ↔ localhost on all screens)** — **[`rules/common/design-fidelity-review.md`](rules/common/design-fidelity-review.md)** (2026-06-23). Mandatory gate before a UI merge.
- **Agent isolation (each agent has its own workspace)** — **[`rules/common/agent-isolation.md`](rules/common/agent-isolation.md)** (2026-08-17). The session directory is derived from the agent's own identifier, not inherited from the orchestrator: the working directory is reset between Bash calls, so `cd` does not save you. A writing agent — always `isolation="worktree"`; read-only — without a worktree. Do not mutate another's tree, do not delete another's worktree, `pkill -f` / `killall` are forbidden. **First command — `git rev-parse --show-toplevel` and a check against the dispatched path; if it does not match or the worktree is gone → STOP and report.** Hooks `pre:bash:cross-agent-blast` + `pre:agent:dispatch-isolation`; smoke `bash .claude/hooks/tests/cross-agent-hooks-smoke.sh`.
- **Review findings transfer (review findings are not lost along the way)** — **[`rules/common/review-findings-transfer.md`](rules/common/review-findings-transfer.md)** (2026-08-17). The reviewer numbers findings (`CR-H-1`, `SR-M-2`) + a control line `Findings: … (N)`; the orchestrator transfers the whole list; the executor reports on each identifier, including "did not do, because…".
- **Autonomy levels (how much of a human a decision needs)** — **[`rules/common/autonomy-levels.md`](rules/common/autonomy-levels.md)** (2026-08-22). The agent gathers facts itself and is forbidden to ask them; decisions are classified: **A1** reversible — decide and record as a line in `## Assumptions`; **A2** — accumulate into the decision brief and ask in one batch with an auto-acceptance deadline; **A3** irreversible and blocking — stop, but only the branch stands, not the session. Critical-path zones automatically yield A3. Merge is still only on an explicit "merging".
- **Durability of long-lived records** — **[`rules/common/doc-durability.md`](rules/common/doc-durability.md)** (2026-08-22). A record with a lifespan > one day (backlog, `.out-of-scope/`, ADR, lessons) describes behavior and **symbols**, never line numbers. Task files and dispatch prompts are excluded deliberately: they are read the same day, and coordinator discipline requires coordinates.
- **Phase boundaries** — **[`rules/common/phase-boundaries.md`](rules/common/phase-boundaries.md)** (2026-08-22). Six options at a phase boundary, top to bottom, the first "yes" wins: continue → `/clear` → handoff → subagent → external scheduler → compact. Compact is at the bottom deliberately: everything except "continue" turns the primary source into a secondary one.
- **Mutation gate ↔ integration specs (`NoCoverage` there — not a hole)** — **[`rules/common/mutation-gate-integration-specs.md`](rules/common/mutation-gate-integration-specs.md)** (2026-08-18). The gate runs only the unit set; `*.integration.spec.ts` are structurally excluded from discovery (`vitest.config.mts`) — `NoCoverage` on a file exercised only by an integration spec is expected. Coverage for the gate is provided by unit doubles — this is a tool requirement, not duplication. `NoCoverage` is more serious than `Survived` (not executed at all vs executed and not caught), except for this exclusion.
- **Stream watchdog (the cut-off is caused by silence, not by long work; durability is a PUSHED commit)** — **[`rules/common/stream-watchdog.md`](rules/common/stream-watchdog.md)** (2026-10-17, reworked 2026-10-20 after five cuts in one day with the rule already in context). Silence has two sources: **waiting** (provisioning, a boot, a foreground suite, a whole-file read) and **producing** (a long think, a large file composed in one call, a long report). Announce a long step before taking it; produce in pieces that each end in a **push**, not merely a commit; start long processes with `run_in_background: true` and probe once, bounded; read large files by window. Hook `post:edit-write:undurable-work` demands commit+push once a worktree with no commit of its own carries 120 uncommitted lines; `scripts/devops/check-stream-silence.sh` measures the silence after the fact. Recovery after a cut — `.claude/skills/dev-flow-resilience/SKILL.md`.
- **Verification integrity (an instrument that did not look reports nothing, not a negative)** — **[`rules/common/verification-integrity.md`](rules/common/verification-integrity.md)** (2026-10-21, after seven instances in one day). Two shapes: **(A)** a failure on an unread channel consumed as a negative answer — `producer 2>/dev/null | counter` prints `0` for "nothing matched" and for "nothing was read" alike; a counter inside `&&` exits non-zero on no match and silently kills the rest of the chain; a terminating condition like "nothing pending" is also true _before_ the work is created. **(B)** exit 0 without the artifact — an install that links no binaries, a push that never reached origin, a commit that was never created. The cure is one line: **assert the artifact, never the exit status**, the device `stream-watchdog.md` (`Pushed:`) and `review-findings-transfer.md` (`Findings: … (N)`) already use, with a per-operation artifact table. zsh gotcha: write `${VAR}:path`, never `$VAR:path` (the Bash tool's shell is zsh; quoting does not help, braces do). **No gate on purpose** — both candidate gates were measured down; see the rationale file.

---

## 9. Quick reference — agent entry points

| Doc                                         | For whom                | Size   | What's inside                                                 |
| ------------------------------------------- | ----------------------- | ------ | ------------------------------------------------------------- |
| `RULES.md` (this file)                      | All                     | ~5 KB  | TOC + summary + links to .claude/rules/common/                |
| `.claude/rules/common/*.md`                 | **Auto-loaded**         | varies | Per-topic mechanism (MCP / git / skills / ...) — see §0       |
| `docs/architecture/rules-rationale/*.md`    | On-demand               | varies | Why each rule says what it says — see §0                      |
| `project-state.md`                          | All                     | ~7 KB  | Phases, migrations, RBAC, tech stack                          |
| `contracts.md`                              | Master, Coder, Reviewer | ~6 KB  | Master-direct-dispatch contracts + labels + verdict semantics |
| `coder.md`                                  | Coder                   | ~11 KB | Golden rules + workflow + recovery                            |
| `code-reviewer.md` + `security-reviewer.md` | Reviewer                | ~10 KB | Workflow + security + write-then-post                         |
| `autotest.md`                               | AutoTest                | ~10 KB | 3 modes + AC-first + anti-patterns                            |
| `devops.md`                                 | DevOps                  | ~9 KB  | Workflow + CI pipeline + secrets                              |
| `architect.md`                              | Architect               | ~12 KB | ADR / agent-infra workflow + zone-of-write                    |
| `legal.md`                                  | Legal                   | ~17 KB | 4 modes A/B/C/D + UA jurisdictional                           |
| `memory/<agent>/lessons.md`                 | Each agent              | varies | Accumulated lessons (Phase 4: skills primary)                 |
| `.claude/skills/<name>/SKILL.md`            | All (via Skill)         | varies | Invocable knowledge primitives (Phase 4 lift)                 |

---

## Phase 5 migration note

This document is the result of **Phase 5 ECC migration (2026-06-03)**. Topics 1 / 2 / 3 / 5 / 7 were extracted from inline content into `.claude/rules/common/<topic>.md`. Topics 4 / 6 / 9 stayed inline (navigational / tightly coupled to the orchestrator's workflow). Details — `docs/architecture/2026-06-03-phase5-deliverable.md` (extraction map).

Per ADR §2.8: rules extraction enables shorter agent prompts (via `@rule` references), a single source of truth, and cross-harness portability (Phase 7+).
