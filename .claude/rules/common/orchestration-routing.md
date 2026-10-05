# Rule: Orchestration routing — agent vs workflow vs light-track

**Status:** Always-on (enforcement **procedural** — orchestrator judgment, NOT a blocking hook)
**Applies to:** Master (USER session) — the one who makes the launch decision. Executor agents do not run this tree.
**Source:** USER request 2026-06-22 (use agents AND workflows together; the orchestrator decides rationally) + an audit of the agent architecture (workflow `agent-architecture-audit`) + best-practices reconnaissance (Anthropic multi-agent research, Augment Code overkill rubric, Anthropic cookbook).

---

## Why

Orchestration is run by Master (USER session) directly via the Agent tool — this is the strongest orchestrator-worker. This rule does **NOT** introduce a second orchestrator and does **NOT** rewrite the dispatch logic. It adds ONE missing decision axis — **the degree of parallelism**: one agent pipeline vs a parallel wave vs a read-only audit-fanout — and fixes when parallelism is justified and when it is over-spawn (multi-agent ≈ 15× the chat tokens; ~64% of tasks a single agent ≥ multi-agent at equal context).

The two already-existing decision axes are **NOT duplicated** here (re-reading them = that very "third source of truth" we avoid) — they fire earlier as they are:

- **Cost-of-error** (auth / finance / RBAC / wallets / transactions / Drizzle migrations / company-account (USDT) → FULL PIPELINE + a **MANDATORY** security-reviewer) — lives in `contracts.md` §2.1 "Critical-path trigger zones". It fires FIRST and beats everything below.
- **Triviality / reversibility** (docs / cosmetic / ≤30 LOC / 1 file without business logic and without a security surface → light-track single-pass) — lives in `light-track.md`.
- **The model tier** (haiku / sonnet / opus + escalation triggers) — orthogonal, `model-routing.md` (tier ≠ track).

This tree is run **after** the cost-of-error and light-track gates have fired as usual.

## The rule — the parallelism axis (evaluate top to bottom; the first match wins)

**Precondition** (not part of this tree, fires earlier — do NOT rewrite):

- a task in critical-path zones (`contracts.md` §2.1) → FULL PIPELINE + security-reviewer. Not overridden by anything below.
- trivial / reversible / docs (`light-track.md`) → LIGHT-TRACK single-pass (Master himself). STOP — workflows/agents are not needed.

If the task passed the precondition and requires code / agent work — choose ONE:

### Decision 1 — one pipeline vs a parallel wave

**A machine-checkable anchor (an artifact, not intuition):** a parallel fan-out is justified ONLY if Master's decomposition yielded **≥3 task files** that simultaneously:

- have path sets that do NOT overlap by `zone-of-write` (disjoint files), AND
- have no explicit `depends_on` / "waits for another agent's output" (no sequential dependency).

→ **all conditions YES** → **WAVE-FANOUT**: Master dispatches in waves of ≤ 3-4 simultaneous (`light-track.md` "Concurrency ceiling"), staggered, sweeping zombie ports. This is "agent orchestration", NOT a separate artifact.
→ **otherwise** → **SINGLE-PIPELINE**: the ordinary sequential Master track (coder → review). Most tasks are here ("most coding tasks involve fewer truly parallelizable tasks than research" — Anthropic).

A helper heuristic if on the edge (Augment Code's 5 questions): independent? disjoint files? specifiable without another's in-flight output? no sequential deps? is there review bandwidth? Mostly "no" → single-pipeline. **The artifact decides (task files); the questions are only a hint.**

### Decision 2 — code-work vs read-only breadth-first audit

If the task is a **survey / audit of ≥3 independent controller-modules, the material exceeds one context window, WITHOUT writing code** (RBAC sweep, dead-code, security surface, "how X works across the whole repo"):

→ **AUDIT-FANOUT** via the skill `codebase-audit` (N × haiku explore in waves of ≤ 3-4 → opus synth). The engine — the Workflow tool OR `superpowers:dispatching-parallel-agents`. This is the ONLY case with genuinely new value over Master's direct dispatch.

### DEFAULT-DENY

No decision matched explicitly → **SINGLE-PIPELINE / one agent**. A parallel fan-out is launched ONLY on an explicit match of Decision 1-YES or Decision 2 — never "just in case".

### Middle path BEFORE any fan-out

An ambiguous-but-bounded task → first the cheapest tier (`model-routing.md`: haiku reconnaissance / sonnet work), escalation to opus only on a quality-gate failure. Removes 40-70% of the cost without the compounding-context tax of a fan-out. A full fan-out — only on genuine breadth (Decision 2).

## Coupling agents + workflows (integration model)

- **Master (the Agent tool) is the sole owner** of the interactive pipeline: decomposition, the launch decision (this tree), event→action monitoring, the aggregate verdict, User Testing, merge-gating. Master is **ABOVE** workflows, not a stage within.
- **The Workflow tool / fan-out is a narrow instrument UNDER the orchestrator**, justified where the logic is predicate-based and there is measurable new value. In fact this is read-only audit / research (this audit is a live precedent). **We do NOT encode the dev pipeline in a JS workflow** — it would duplicate Master's orchestration (a second executable source of truth, desync).
- **The deterministic layer that already exists and is NOT touched:** `auto-merge-on-label.yml` (label → squash) + CI gates.

## Enforcement and tracking

- **Procedural** (orchestrator judgment), modeled on `design-gate.md`: routing is a DECISION, not a violation; a blocking hook would give a false negative on legitimate edge cases.
- **Tracking — in the task file / Master's notes**: a non-standard track (wave / audit) is marked with a `routing_decision` line — `{ track: "wave-fanout" | "audit-fanout", reason }` (like an A1 decision per `autonomy-levels.md`). The standard track (light-track / single-pipeline) is not logged, so as not to make noise.
- Startup-burst guard (≥5 `Agent()` in one message → 529 / CPU starvation) — for now procedural (the end of Decision 1: waves of ≤ 3-4). A non-blocking hook nudge is a possible follow-up, NOT in this rule (a flaky hook next to a battle-tested one would undermine trust in the whole hook infra).

## Red lines (inherited by any fan-out / workflow)

- `merge-approved` + labels — ONLY Master/owner on the owner's explicit "merge" (golden rule #1; see the reviewer-self-merge incident).
- security-reviewer is MANDATORY on the critical path — this tree STRENGTHENS it, does not bypass it.
- Agents only `Agent(isolation=worktree)` + a post-check `git -C <main> status` (recurring MAIN contamination).
- Concurrency ≤ 3-4 in waves; `DATABASE_URL=` (empty) when pushing feature branches.

## Related rules

- `.claude/rules/common/light-track.md` — "trivial → light-track" + the concurrency ceiling (we link, do not duplicate).
- `.claude/rules/common/model-routing.md` — the model tier (orthogonal axis) + the middle-path escalation.
- `.claude/agents/contracts.md` §3 — dispatch matrices (WHICH agent); this rule — WHAT degree of parallelism.
- `.claude/skills/codebase-audit/SKILL.md` — the mechanics of the audit-fanout (Decision 2).
- `.claude/agents/workflow-registry.md` — a catalog of 10 read-only workflows + triggers + launch discipline (default-deny / opt-in / `routing_decision` log).

## Sources

- USER request 2026-06-22: agents + workflows together + a rational launch decision.
- Anthropic "How we built our multi-agent research system" (~15× tokens vs chat; coding mostly not parallelizable; effort-scaling 1 / 2-4 / 10+).
- Augment Code "When Multi-Agent AI Is Overkill" (5-gate independence; ≥3 independent modules before parallel).
- Anthropic cookbook "orchestrator-workers" (orchestrator-worker vs fan-out vs routing).
- Audit of the agent architecture 2026-06-22 (workflow `agent-architecture-audit`: design + adversarial critique NEEDS_REVISION → must-fixes accounted for).
