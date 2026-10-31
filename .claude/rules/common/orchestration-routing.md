# Rule: Orchestration routing — agent vs workflow vs light-track

**Status:** Always-on (enforcement **procedural** — orchestrator judgment, NOT a blocking hook)
**Applies to:** Master (USER session) — the one who makes the launch decision. Executor agents do not run this tree.

> Rationale: `docs/architecture/rules-rationale/orchestration-routing.md`

---

## The rule — the parallelism axis (evaluate top to bottom; the first match wins)

This rule adds ONE decision axis — **the degree of parallelism**. It does **not** introduce a second
orchestrator and does **not** rewrite the dispatch logic.

**Preconditions** — these fire FIRST, beat everything below, and are owned elsewhere (do NOT rewrite them here):

- A task in critical-path zones — auth / finance / RBAC / wallets / transactions / Drizzle migrations
  / company-account (USDT) — → FULL PIPELINE + a **MANDATORY** security-reviewer (`contracts.md` §2.1
  "Critical-path trigger zones").
- Trivial / reversible / docs — cosmetic / ≤30 LOC / 1 file without business logic and without a
  security surface → LIGHT-TRACK single-pass, Master himself (`light-track.md`). STOP —
  workflows/agents are not needed.
- **The model tier** (haiku / sonnet / opus + escalation triggers) is orthogonal to all of this:
  `model-routing.md`. Tier ≠ track.

If the task passed the preconditions and requires code / agent work — choose ONE:

### Decision 1 — one pipeline vs a parallel wave

**A machine-checkable anchor (an artifact, not intuition):** a parallel fan-out is justified ONLY if
Master's decomposition yielded **≥3 task files** that simultaneously:

- have path sets that do NOT overlap by `zone-of-write` (disjoint files), AND
- have no explicit `depends_on` / "waits for another agent's output" (no sequential dependency).

→ **all conditions YES** → **WAVE-FANOUT**: Master dispatches in waves of ≤ 3-4 simultaneous
(`light-track.md` "Concurrency ceiling"), staggered, sweeping zombie ports. This is "agent
orchestration", NOT a separate artifact.
→ **otherwise** → **SINGLE-PIPELINE**: the ordinary sequential Master track (coder → review). Most
tasks are here.

The artifact decides (task files); intuition is only a hint. Mostly "no" → single-pipeline.

### Decision 2 — code-work vs read-only breadth-first audit

If the task is a **survey / audit of ≥3 independent controller-modules, the material exceeds one
context window, WITHOUT writing code** (RBAC sweep, dead-code, security surface, "how X works across
the whole repo"):

→ **AUDIT-FANOUT** via the skill `codebase-audit` (N × haiku explore in waves of ≤ 3-4 → opus synth).
The engine — the Workflow tool OR `superpowers:dispatching-parallel-agents`. This is the ONLY case
with genuinely new value over Master's direct dispatch.

### DEFAULT-DENY

No decision matched explicitly → **SINGLE-PIPELINE / one agent**. A parallel fan-out is launched ONLY
on an explicit match of Decision 1-YES or Decision 2 — never "just in case".

### Middle path BEFORE any fan-out

An ambiguous-but-bounded task → first the cheapest tier (`model-routing.md`: haiku reconnaissance /
sonnet work), escalation to opus only on a quality-gate failure. Removes 40-70% of the cost without
the compounding-context tax of a fan-out. A full fan-out — only on genuine breadth (Decision 2).

## Coupling agents + workflows (integration model)

- **Master (the Agent tool) is the sole owner** of the interactive pipeline: decomposition, the launch
  decision, monitoring, the aggregate verdict, User Testing, merge-gating. Master is **ABOVE**
  workflows, not a stage within.
- **The Workflow tool / fan-out is a narrow instrument UNDER the orchestrator** — read-only audit /
  research. **We do NOT encode the dev pipeline in a JS workflow** (a second executable source of
  truth, desync).
- **The deterministic layer already in place and NOT touched:** `auto-merge-on-label.yml` (label →
  squash) + CI gates.

## Enforcement and tracking

- **Procedural** (orchestrator judgment): routing is a DECISION, not a violation; no blocking hook.
- **Tracking — in the task file / Master's notes**: a non-standard track (wave / audit) is marked with
  a `routing_decision` line — `{ track: "wave-fanout" | "audit-fanout", reason }` (like an A1 decision
  per `autonomy-levels.md`). The standard track (light-track / single-pipeline) is not logged, so as
  not to make noise.

## Red lines (inherited by any fan-out / workflow)

- `merge-approved` + labels — ONLY Master/owner on the owner's explicit "merge" (golden rule #1).
- security-reviewer is MANDATORY on the critical path — this tree STRENGTHENS it, does not bypass it.
- Agents only `Agent(isolation=worktree)` + a post-check `git -C <main> status` (recurring MAIN contamination).
- Concurrency ≤ 3-4 in waves; `DATABASE_URL=` (empty) when pushing feature branches.

## Related rules

- `.claude/rules/common/light-track.md` — "trivial → light-track" + the concurrency ceiling (we link, do not duplicate).
- `.claude/rules/common/model-routing.md` — the model tier (orthogonal axis) + the middle-path escalation.
- `.claude/agents/contracts.md` §3 — dispatch matrices (WHICH agent); this rule — WHAT degree of parallelism.
- `.claude/skills/codebase-audit/SKILL.md` — the mechanics of the audit-fanout (Decision 2).
- `.claude/agents/workflow-registry.md` — a catalog of 10 read-only workflows + triggers + launch discipline.
