# Rule: Model routing — the minimally sufficient model

**Status:** Always-on
**Applies to:** Master (dispatch via `Agent()`), all agents, USER sessions

> Rationale, the 2026-09-21 token measurement, price table and superseded editions:
> `docs/architecture/rules-rationale/model-routing.md`

---

## Principle

Each task is done by **the cheapest model whose capacity is guaranteed to close it precisely**.

**The minimally sufficient model is the DEFAULT, not an exception.** The cheapest tier that is
**guaranteed** to suffice is tried **FIRST**. A higher tier only when (a) the task is knowingly
judgment-heavy / critical (money, RBAC, security, migrations, cross-zone contracts, architecture)
**or** (b) the lower tier failed. New and strong model versions — for the complex or after the
weaker one failed, **not by default**.

## Static assignment (fixed in the agents' frontmatter)

- **opus** — `architect`, `legal` — Judgment-heavy ADR / legal analysis. Orchestration is Master's (tier via `/model`)
- **sonnet** — `coder`, `autotest`, `code-reviewer`, `spec-reviewer`, `security-reviewer`, `copy-reviewer`, `manual-qa`, `ui-ux-designer`, `devops` — The workhorse: code, tests, review, QA
- **haiku** — no permanent agents; a pointed `model="haiku"` override — simple mechanics, reconnaissance, mechanical verification
- **fable** — **NEVER for agents** (and in general not without dire need) — The most expensive

Do NOT change the agents' frontmatter `model:` without updating this table (single source).

**The static `model:` is a CEILING by default, not an assignment to a task.** `model: sonnet` on
`coder` means "do not go above sonnet without a reason", not "all coding goes on sonnet". Master
**MUST** pass `model=` (and effort, where the harness permits) into `Agent()` per the concrete task
by the table below, dropping to `haiku` on mechanics. Dispatching a coder without `model=` on a task
falling under the haiku row is overpayment and a finding at acceptance.

## Task type → tier (coder and edit executors)

- **Mechanics:** string / literal replacement; `i18n:extract` catalog sync; rebase / merge without semantics; editing comments and docs; configs without a runtime effect; test-only edits without new logic; finishing off surviving mutants by a ready list; moving by a map (rename / moving imports) — **haiku** + effort low
- An ordinary feature / logic within a single module — **sonnet** + medium
- Cross-zone contracts (api ↔ web ↔ shared); finance / RBAC / security / money; Drizzle migrations and prod data; architecture. **Or** a fix task after a lower tier failed — **opus** + high

The haiku limits from "Downgrade" below apply here too: an automatic gate (typecheck + tests) is
needed, zero business logic, nothing from critical-path zones. "Test-only edits" means edits to
existing specs without new logic (AutoTest zone); writing new specs — sonnet.

**Effort** — a second axis to the tier: **low** — mechanics; **medium** — the default, ordinary
logic; **high** — hard / critical. Passed into `Agent()` where the harness supports it; where it
does not, the effect is achieved by choosing the tier — do not invent a separate parameter.

## Reviewers — the minimal tier, NOT the top model

- `copy-reviewer` — **haiku** for a simple catalog (uk/en error strings); **sonnet** for bulky/nuanced text. NOT opus
- `code-reviewer` / `spec-reviewer` — **haiku** for text-only / mechanical diffs; **sonnet** for diffs with real logic
- `security-reviewer` — **haiku** for text-only/low-logic migrations (checklist); **sonnet**/**opus** only for a really risky surface (new auth logic, money movement, crypto contracts)
- **Mechanical re-check** of one closed finding — **haiku** — a reconciliation of a fact, not judgment

- The orchestrator verifies the aggregate itself: a cheap reviewer + orchestrator reconciliation is
  cheaper than an expensive reviewer.
- **Authoring vs review:** generating a quality bilingual catalog — `sonnet`. **Review/verification**
  (checking against the list that there are no Russianisms) is mechanics, carried by `haiku`.
- Haiku in the re-check row reconciles **the execution of a concrete item**; it does not issue the
  `APPROVE` / `BLOCK` verdict on a PR — that stays with the reviewers above (the haiku ban on
  quality gates is preserved).

## Model versions — the lower ones by default

**For agents use the lower versions: Opus 4.8 / Sonnet 4.6 / Haiku 4.5. Sonnet 5+, Opus 5+, Fable —
ONLY for really complex tasks, not by default.**

The catch: the tier aliases (`sonnet`/`opus` in `Agent()` and in frontmatter) resolve to the
**newest** version (5.x). The levers:

- **The tier** (haiku < sonnet < opus < fable) — controlled from `Agent(model=)`; this is the MAIN
  saving: take the minimal sufficient tier, do not use fable.
- **The minor version** (4.x vs 5.x behind the alias) — set by the Claude Code config (the default
  model / subagents), NOT by a dispatch parameter (the enum accepts only tier aliases). Keep the
  default on 4.x; 5+/fable — deliberately and rarely.

## Dynamic overrides — Master passes `model=` into `Agent()`

### Escalation ladder: haiku → sonnet → opus

- **haiku → sonnet** when: the agent is stuck / looped on mechanics, the auto-gate does not pass on the second attempt
- **sonnet → opus** when: a second `Verdict: BLOCK` in a row or a failed run (see below)
- **straight to opus** when: a knowingly critical-path zone (money / RBAC / security / migrations / a cross-zone contract / architecture) — without trying the lower one

### Escalation → `opus`

- A second `Verdict: BLOCK` in a row on one task (`review_rounds == 2`) — Fix-task re-dispatch Coder with `model="opus"`
- Task file: a Drizzle migration + a cross-module refactor / finance calculation logic / company-account — Straight to `## Model: opus` in the task file
- Flaky Mode 4: sonnet-AutoTest did not find the root cause on the first pass — Re-dispatch with `model="opus"`
- An agent cut off / got lost twice on the same multi-step task — Re-dispatch with the top tier + a reduced scope

### Downgrade → `haiku` (only with an automatic verifying gate)

Allowed:

- Read-only reconnaissance / search over the codebase (Explore-style fan-out, collecting lists of files/occurrences)
- Triage of CI logs, summarizing long run outputs for Master
- Mechanical batches by an exact list (rename by a map, moving imports, uniform edits) — ONLY with an auto-gate present (typecheck + tests) and zero business logic
- Merge `origin/main` into a PR branch with additive conflicts (`.po`, barrels) + worktree/port cleanup — under the same auto-gates

FORBIDDEN for haiku: quality gates (code/security review, manual-qa, designer), business logic,
migrations, `*.spec.ts` **with new logic**, everything in critical-path zones.

## Accounting (otherwise the policy is not verifiable)

1. Task file: the `## Model:` field — the tier per the "Task type → tier" table (`haiku` on
   mechanics, `sonnet` on ordinary logic, `opus` — with one line of rationale per the trigger table).
   The field absent → `sonnet` as the ceiling, but Master still reconciles the task type against the
   table before dispatch.
2. Master records the chosen tier in the `## Model:` field of the task file (and in the dispatch prompt).
3. Dispatch without `model=` → Master adds the parameter itself per this table.

## USER main session (recommendation; chosen via `/model`)

- **Fable 5** — system audits, architectural decisions, complex cross-module debugging, meta-optimizations of processes.
- **Opus 4.8** — ordinary orchestration days (may use `/fast`). **Loop mode (merge on readiness, fix
  rounds, CI monitors) is an orchestration day by definition**, not an audit: the session switches to
  Opus before the cycle starts.
- **Sonnet 4.6** — the light track: docs, small edits, routine operations.

## The orchestrator's token diet

The expensive thing is not the intellect, but **the number of turns × the context size**.

- The orchestrator's model: a loop/orchestration day — **Opus**; Fable — audit/architecture/complex debug
- CI/deploy monitors — **Only terminal events**: one output on completion (result + head + `mergeStateStatus`), not on every check
- A non-terminal event — **Do not answer with text.** An "I'm waiting" turn is an error, not politeness
- A fix round for a coder — **≤ ~10 findings**; more — 2–3 coders by file groups (disjoint)
- Agent mechanics — **haiku** + an auto-gate: merge `origin/main`, cleanup, edits by an exact list
- Delta review rounds — copy-reviewer on the **delta** (checking its own findings are closed) — `model="sonnet"`; the first copy round and any security round — Opus
- Permanent context — The orchestrator's memory index — compact: closed projects older than a quarter into an archive file not loaded into the session

## How we know it is violated

A turn of the orchestrator whose body is one sentence "waiting for …" after a monitor event; a
monitor with an `echo` on every check; a fix-task with a control line `(N)` at N > 12 without
splitting; a loop-mode session on Fable (visible in the model menu). Checked by eye over the
transcript — there is no gate, and none is needed: the cost of a violation is counted in tokens
after the fact, not caught before.

## Related rules

- `.claude/rules/common/light-track.md` — the master session's light track.
- `.claude/agents/contracts.md` §3 — dispatch matrices (whom to dispatch); this rule — with which tier.
