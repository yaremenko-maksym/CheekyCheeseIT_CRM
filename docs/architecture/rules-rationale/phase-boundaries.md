# Rationale: phase-boundaries

Rationale layer for `.claude/rules/common/phase-boundaries.md`. Not auto-loaded — read on demand.

---

## Provenance

Adapted from `mattpocock/skills` (`ask-matt/PHASE-BOUNDARIES.md`). ADR:
`docs/architecture/2026-08-22-afk-pipeline-migration.md` item 17.

**One option is ours and is not in the source: option 5, the external scheduler.** It follows from the
orchestrator's cross-session practice — `mcp__scheduled-tasks` survives a session boundary while
`ScheduleWakeup` does not, so a wait longer than the session needs a layer the source never had to
consider. The "do not combine two layers on one wait" clause exists because we did combine them once
and got duplicate fires.

## Why this file was barely cut in the 2026-10-16 restructure

Almost the entire file is the decision tree plus the primary/secondary-source trade that justifies the
tree's **order** — and the order is the mechanism. The "cost of error is one-sided" note on `/clear`
and the "continuing costs nothing — rule it out first" note on option 1 are what stop the default
drift to compaction; stripping them would leave six options with no reason to prefer the top one.

Only the provenance line moved here.

## Sources

- `mattpocock/skills` — `ask-matt/PHASE-BOUNDARIES.md`.
- ADR `docs/architecture/2026-08-22-afk-pipeline-migration.md` item 17.

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

## Primary source and secondary source

Everything but "continue" turns the **primary source** (the session as it was) into a **secondary**
one (the summary). The trade is always of one form:

| Source                      | Information | Noise | Room to maneuver |
| --------------------------- | ----------- | ----- | ---------------- |
| Primary (continue)          | full        | much  | little           |
| Secondary (compact/handoff) | lossy       | less  | much             |

That is why question 1 comes first: you pay for the loss only when staying costs more than you save.

---

The hook `pre:edit-write:suggest-compact`
(`.claude/hooks/pre-edit-write-suggest-compact.sh`) already **triggers** the thought of a compact, but
does not say what to do. Without a tree the agent compacts by default — and gets a fresh session, confidently
wrong about a decision the summary flattened.

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

These are judgments, not gates. The value is in asking the five questions **in order** and **at the
boundary**, not in the objectivity of each.
