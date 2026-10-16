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
