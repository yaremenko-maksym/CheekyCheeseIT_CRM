# Rationale: orchestration-routing

Rationale layer for `.claude/rules/common/orchestration-routing.md`. Not auto-loaded — read on demand.

**Source:** USER request 2026-06-22 (use agents AND workflows together; the orchestrator decides
rationally) + an audit of the agent architecture (workflow `agent-architecture-audit`) +
best-practices reconnaissance (Anthropic multi-agent research, Augment Code overkill rubric, Anthropic
cookbook).

---

## The measured cost of over-spawning

The numbers that set the default to DEFAULT-DENY rather than "parallelize when you can":

- **Multi-agent ≈ 15× the chat tokens** (Anthropic, "How we built our multi-agent research system").
- **~64% of tasks: a single agent ≥ multi-agent at equal context.** I.e. for roughly two thirds of
  tasks the fan-out buys nothing and costs 15×.
- **Coding specifically is mostly not parallelizable** — "most coding tasks involve fewer truly
  parallelizable tasks than research" (same source). That is why Decision 1 routes most tasks to
  SINGLE-PIPELINE and the exception needs an artifact to justify it.
- Effort scaling from the same source: 1 agent / 2-4 agents / 10+ agents as three distinct regimes.

## Why the anchor is an artifact and not a judgment

Augment Code's "When Multi-Agent AI Is Overkill" supplies a five-gate independence rubric
(independent? disjoint files? specifiable without another's in-flight output? no sequential deps?
review bandwidth?) and the "≥3 independent modules before parallel" threshold.

We kept the threshold but **moved the decision onto an artifact** — the ≥3 task files with disjoint
`zone-of-write` path sets and no `depends_on`. The five questions survive only as a tie-breaker hint.
Reason: a rubric answered from intuition at dispatch time is answered optimistically, and the cost of
being wrong is the 15× above. A task-file set is something that either exists or does not.

## Why the dev pipeline is not encoded as a workflow

The Workflow tool could express the dev pipeline. It is deliberately not used for it, because Master
(the USER session) already owns that pipeline end to end: decomposition, dispatch, monitoring,
aggregate verdict, User Testing, merge-gating. Encoding it a second time in JS would create **a
second executable source of truth** and the two would desync — the same defect class this rules
corpus keeps finding in prose (two descriptions of one zone, two reviewer tier tables).

The audit-fanout (Decision 2) is the one case with genuinely new value, because there the logic
really is predicate-based and read-only: no merge gate, no review bandwidth, no ordering.

## Why enforcement is procedural

Modeled on `design-gate.md`: routing is a **decision**, not a violation. A blocking hook would have to
decide, at `Agent()` time, whether a fan-out is justified — and it cannot see the task files' content
or their dependency structure. It would therefore give false negatives on legitimate edge cases, and
by the argument in `docs/architecture/rules-rationale/agent-isolation.md` §"The cost of a false
positive", a flaky gate next to battle-tested ones costs trust in the whole hook infra.

The `routing_decision` line in the task file is the observability substitute, and it is deliberately
asymmetric: only the **non-standard** track is logged. Logging the standard track would produce a line
on every task and therefore be ignored.

The startup-burst threshold (≥5 `Agent()` in one message → 529 / CPU starvation) stayed procedural for
the same reason; a non-blocking hook nudge was considered and left as a possible follow-up, explicitly
out of scope of the rule.

## Provenance of the audit itself

The rule was produced by the `agent-architecture-audit` workflow on 2026-06-22, whose design went
through an adversarial critique returning NEEDS_REVISION; the must-fixes from that critique are
incorporated. The audit is itself a live precedent for Decision 2 — it was a read-only breadth-first
survey exceeding one context window.

## Sources

- USER request 2026-06-22: agents + workflows together + a rational launch decision.
- Anthropic "How we built our multi-agent research system" (~15× tokens vs chat; coding mostly not parallelizable; effort-scaling 1 / 2-4 / 10+).
- Augment Code "When Multi-Agent AI Is Overkill" (5-gate independence; ≥3 independent modules before parallel).
- Anthropic cookbook "orchestrator-workers" (orchestrator-worker vs fan-out vs routing).
- Audit of the agent architecture 2026-06-22 (workflow `agent-architecture-audit`).

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

A helper heuristic if on the edge: independent? disjoint files? specifiable without another's
in-flight output? no sequential deps? is there review bandwidth? Mostly "no" → single-pipeline. **The
artifact decides (task files); the questions are only a hint.**

---

- **Procedural** (orchestrator judgment), modeled on `design-gate.md`: routing is a DECISION, not a
  violation; a blocking hook would give a false negative on legitimate edge cases.

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

- Startup-burst guard (≥5 `Agent()` in one message → 529 / CPU starvation) — procedural (the end of
  Decision 1: waves of ≤ 3-4).
