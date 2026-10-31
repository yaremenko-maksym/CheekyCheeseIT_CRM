# Rationale: autonomy-levels

Rationale layer for `.claude/rules/common/autonomy-levels.md`. Not auto-loaded — read on demand.

**Source:** Owner request 2026-08-22 ("I work remotely, commands for a human are not needed") + study
of `mattpocock/skills` (`grilling`, `loop-me`). ADR:
`docs/architecture/2026-08-22-afk-pipeline-migration.md`.

---

## Why the rule exists

The owner works remotely and answers with a delay. A pipeline that calls the human at every fork
simply stalls in this mode. A pipeline that never calls spends money on irreversible decisions.
Neither failure mode is a matter of degree — they are different defects, and the classifier exists to
separate them.

## The pre-rule state

Before this rule the human checkpoints were scattered and shapeless:

| Checkpoint                                           | Problem                      |
| ---------------------------------------------------- | ---------------------------- |
| A blocker from an agent (`.blocked.md`)              | no format, no deadline       |
| Mode 4 User Testing                                  | not a fork at all            |
| "clarify with USER" in the edit-classification table | no reversibility distinction |
| "merge"                                              | a separate gate, conflated   |

No format, no deadline, and no distinction of reversible from irreversible — so the agent either
stalled where it could decide itself, or decided where it should not have. The three-level classifier
plus the brief format replace all four.

## Provenance of the two borrowed mechanics

- **The frontier rule** ("the subtree is blocked, not the session") comes from `grilling` in
  `mattpocock/skills`. Its original form: a launched reconnaissance is an unresolved premise, so only
  questions below it in the tree wait while the rest of the frontier is asked now. Transferred
  verbatim to questions addressed to the owner.
- **The batched brief** comes from `loop-me`, adapted to be readable on a phone, because that is the
  owner's actual reading device when remote.

The `decision-frontier` skill is the executable half of the same design: it builds the tree and
extinguishes branches from the repository **before** classification, so that the A1/A2/A3 call is made
only on the irreducible remainder.

## Why "a recommendation is always present" is a hard format rule

A question without a recommendation transfers the analysis, not just the decision — which is the exact
failure the boundary statement ("finding facts is the agent's job") forbids one paragraph earlier. The
recommendation is also what makes the A2 deadline safe: silence can only be auto-accepted into
something specific.

## Why the A1 line is mandatory even though nothing checks it mechanically

A decision made without a line is indistinguishable from a decision that was forgotten. There is no
way to audit "did the agent decide this deliberately" after the fact except by the record, so the line
**is** the observability — the same device as the `Findings: … (N)` control line in
`review-findings-transfer.md`: arithmetic instead of attentiveness. The reconciliation rows in the
core rule are what make it checkable at acceptance.

## Sources

- Owner request 2026-08-22 — remote work, no human-at-keyboard assumption.
- `mattpocock/skills` — `grilling` (frontier), `loop-me` (batched brief).
- ADR `docs/architecture/2026-08-22-afk-pipeline-migration.md`.

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

A decision made without a line is indistinguishable from a decision that was forgotten: **the line is
the observability**. It is the same device as the control line `Findings: … (N)` in
`review-findings-transfer.md` — arithmetic instead of attentiveness.
