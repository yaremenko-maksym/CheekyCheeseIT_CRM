# Rule: Transferring review findings into the task — by identifier, with a report on each

**Status:** Always-on (procedural gate; observability — identifier reconciliation, see below)
**Applies to:** code-reviewer, security-reviewer, spec-reviewer, copy-reviewer, ui-ux-designer (Mode B), manual-qa — all number; Master / orchestrator transfer; Coder / any executor of a fix task reports

> Rationale: `docs/architecture/rules-rationale/review-findings-transfer.md`

---

## Why

The review → fix-task channel had no gate and rested on attentiveness; it failed (PR #504).

The rule "all H/M/L findings are resolved before merge" (`contracts.md`) covers the _result_; this file covers the _channel_ — a lost finding is not in the list that gets reconciled.

---

## The rule

### 1. The reviewer numbers the findings

Each finding in the review body gets a **stable identifier** of the form `<ROLE>-<SEV>-<N>`:

```
CR-H-1   code-reviewer, HIGH, first
CR-M-2   code-reviewer, MED
SR-H-1   security-reviewer, HIGH
SPEC-H-1 spec-reviewer, HIGH
UX-M-2   ui-ux-designer (Mode B), MED
QA-H-1   manual-qa, HIGH
COPY-L-3 copy-reviewer, LOW
```

**The full list of prefixes — one per aggregate axis.** A UI PR collects up to six verdicts, and until
an axis has a prefix, the arithmetic reconciliation below does not work for it: a finding is lost by
exactly the channel for which the rule was created.

| Axis                 | Prefix  | Verdict line                           |
| -------------------- | ------- | -------------------------------------- |
| `code-reviewer`      | `CR-`   | `Verdict: APPROVE \| BLOCK`            |
| `security-reviewer`  | `SR-`   | `Security Review: APPROVE \| BLOCK`    |
| `spec-reviewer`      | `SPEC-` | `Spec Review: PASS \| ISSUES \| BLOCK` |
| `ui-ux-designer` (B) | `UX-`   | `Design Review:` + `Fidelity:`         |
| `manual-qa`          | `QA-`   | the report's severity table            |
| `copy-reviewer`      | `COPY-` | `Copy Review: PASS \| ISSUES \| BLOCK` |

The identifier is set **at the moment of writing the review** — not retroactively during transfer.
Otherwise the same person who loses a finding is the one numbering it.

At the end of the review body — a control line:

```
Findings: CR-H-1, CR-H-2, CR-M-1, CR-M-2 (4)
```

### 2. The orchestrator transfers as a list, not a retelling

The fix task contains **all** identifiers from the control line — including those it was decided not
to do. A "do not do" decision is legitimate; a silent disappearance is not.

### 3. The executor reports on each one

In the report and in the PR body — a line for **each** identifier, including refusals:

```
CR-H-1  done   — <what was done>
CR-H-2  done   — <what was done>
CR-M-1  not done — <reason: not reproducible / out of scope / separate task #N>
```

"Did not do it, because…" is a valid answer. The absence of a line is not.

## How we know it is violated

A miss is visible by **arithmetic**, not attentiveness:

| What is reconciled                                                                    | Who                           |
| ------------------------------------------------------------------------------------- | ----------------------------- |
| the number of identifiers in the review's `Findings:` == the number in the fix task   | Master when creating the task |
| the number of lines in the executor's report == the number of identifiers in the task | Master at acceptance          |
| every identifier from the review appears in the report                                | Master at acceptance          |

A mismatch is not "probably a trifle" but an unclosed finding until proof to the contrary.

## Mechanical check — deliberately NOT a CI gate

**Decision:** arithmetic reconciliation + the `Findings:` control line; no CI parser (reasons and the reconsider condition: rationale file).

## Related rules

- `.claude/rules/common/agent-isolation.md` — an adjacent channel without a gate (the same family of defects).
- `.claude/skills/code-review-discipline/SKILL.md` §7 — how to number when writing a review.
- `.claude/agents/contracts.md` §4 — aggregate verdict; "all H/M/L closed before merge" (the result, not the channel).
- `.claude/rules/common/verification-integrity.md` — the `Findings: … (N)` line as a checkable assertion.
