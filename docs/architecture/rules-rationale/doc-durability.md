# Rationale: doc-durability

Rationale layer for `.claude/rules/common/doc-durability.md`. Not auto-loaded — read on demand.

---

## Provenance

Study of `mattpocock/skills` (`triage/AGENT-BRIEF.md`, "durability over precision"). ADR:
`docs/architecture/2026-08-22-afk-pipeline-migration.md` item 9.

## The cost that triggered it

Part of the 2026-08-17 session went to **live re-reading of `origin/main`** just to answer "which
backlog coordinates are still correct". The findings themselves were fine; their addresses had rotted,
and nothing in the records announced that. Verification cost more than the original finding had.

## Why task files are excluded rather than exempted "for convenience"

The orchestrator's coordinator discipline positively **requires** concrete paths and line numbers in a
task file: they are the evidence that Master synthesized the finding himself rather than handing the
executor a vague direction and the job of understanding it. Forbidding coordinates there would mean
fixing one rule by breaking another.

Hence the boundary runs along **lifespan**, not along document type — a task file is read the same day
it is written, so coordinate rot has no time to occur.

## Sources

- `mattpocock/skills` — `triage/AGENT-BRIEF.md` ("durability over precision").
- ADR `docs/architecture/2026-08-22-afk-pipeline-migration.md` item 9.
- Session 2026-08-17 — the backlog coordinate re-verification cost.
