# Rule: Phase boundaries — what to do with context between phases

**Status:** Always-on
**Applies to:** All agents and the Master session. The decision is made **at the phase boundary**, not mid-work.
**Source:** Study of `mattpocock/skills` (`ask-matt/PHASE-BOUNDARIES.md`), adapted: a sixth option (external scheduler) was added, which the source does not have. ADR: `docs/architecture/2026-08-22-afk-pipeline-migration.md` item 17.

---

## Why

The hook `pre-edit-write-suggest-compact.sh` already **triggers** the thought of a compact, but does not say what
to do. Without a tree the agent compacts by default — and gets a fresh session, confidently wrong
about a decision the summary flattened.

A **phase** is a chunk of work within a session: reconnaissance, implementation, verification. The definition is deliberately
fuzzy: a phase ends where you think "okay, done with this".

A **phase boundary** is the only place where this decision belongs. Mid-phase there is no decision:
continue, or split the remainder into a subagent. A compact mid-phase loses the thread.

## The tree (top to bottom, first "yes" wins)

**1. Can you continue in this session?**
Two grounds for "yes": the next phase needs this one as a **primary source**, or there is objectively
enough context. Reconnaissance → implementation is a standard "yes": implementation needs the reasoning
verbatim, not its retelling. **Continuing costs nothing and loses nothing — rule it out first.**

**2. Is the context irrelevant to what comes next?**
Is everything in the session (reconnaissance, decisions, dead ends) single-use? Then **`/clear`**. The cheapest move:
instant, and it returns the whole window. The old session stays resumable.
The cost of error is one-sided: having cleared **relevant** context, you lose the **why**, and reading the diff
does not bring it back.

**3. Do you need to hand off externally?**
**Handoff** is narrow: a different harness, a different directory, a different person, or forking a side task
mid-phase. What it buys is **portability**. Nothing is being carried over — not needed.

**4. Is the task doable without supervision?**
Narrow enough to go without steering? Then a **subagent** — its own window, a report back, this session
untouched. An automatic review is the canonical case.

**5. Are we waiting for an external event longer than 30 minutes?**
Then an **external scheduler** (`mcp__scheduled-tasks` via `scripts/pm/pm-schedule.sh`):
it survives the session boundary, `ScheduleWakeup` does not. Do not combine two layers on one wait.
_(This option is not in the source; it is ours and follows from the orchestrator's cross-session practice.)_

**6. Otherwise — compact.**
Relevant context, the same harness, the same directory, and you need to stay in the loop. Pass an
instruction (`/compact continue QA of this section`), so the summary preserves what the next phase needs.

**A compact is the default, but not the first impulse.** It is at the bottom because the five questions above are cheaper or
more precise.

## Primary source and secondary source

Everything but "continue" turns the **primary source** (the session as it was) into a **secondary** one
(the summary). The trade is always of one form:

| Source                      | Information | Noise | Room to maneuver |
| --------------------------- | ----------- | ----- | ---------------- |
| Primary (continue)          | full        | much  | little           |
| Secondary (compact/handoff) | lossy       | less  | much             |

That is why question 1 comes first: you pay for the loss only when staying costs more than you save.

## How we know it is violated

- A compact **mid-phase** (not at the boundary) — the agent loses the thread; visible from the fact that after the compact
  it continues the same unclosed step rather than a new phase.
- Both wait layers on one event (`ScheduleWakeup` **and** the external scheduler) — duplicate fires,
  visible in the logs.
- A `/clear` before a phase that then re-asks what was already decided — a lost primary source.

These are judgments, not gates. The value is in asking the five questions **in order** and **at the
boundary**, not in the objectivity of each.

## Related rules

- `.claude/RULES.md` §4.3 — wake-up layers (survives the session or not).
- `.claude/skills/dev-flow-resilience/SKILL.md` — long-running operations, sentinel-recovery.
- `.claude/rules/common/agent-isolation.md` — a subagent always with its own working directory.
