# Rule: Transferring review findings into the task — by identifier, with a report on each

**Status:** Always-on (procedural gate; observability — identifier reconciliation, see below)
**Applies to:** code-reviewer, security-reviewer, spec-reviewer, copy-reviewer, ui-ux-designer (Mode B), manual-qa — all number; Master / orchestrator transfer; Coder / any executor of a fix task reports
**Source:** PR #504, 2026-08-11 — while compiling the "what to finish" list the orchestrator lost a security finding (a glyph-check bypass). Did not reject it as insignificant — simply did not transfer it. The coder naturally did not do it; it was caught only by reconciling the report against the original review, on the ninth round.

---

## Why

We have gates on code, tests, guards, measurements — and not one on "all review
findings reached the task". The review → fix-task channel rested on attentiveness,
and it failed exactly where the round was the ninth.

The existing rule "all H/M/L findings are resolved before merge"
(`feedback_reviewer_findings`, aggregate verdict in `contracts.md`) is **not duplicated** here: it is about
the _result_ (nothing left unclosed), while this file is about the _channel_ (nothing
lost along the way). A lost finding passes the first rule unnoticed,
because it is simply not in the list that gets reconciled.

## The rule

### 1. The reviewer numbers the findings

Each finding in the review body gets a **stable identifier** of the form
`<ROLE>-<SEV>-<N>`:

```
CR-H-1   code-reviewer, HIGH, first
CR-M-2   code-reviewer, MED
SR-H-1   security-reviewer, HIGH
SPEC-H-1 spec-reviewer, HIGH
UX-M-2   ui-ux-designer (Mode B), MED
QA-H-1   manual-qa, HIGH
COPY-L-3 copy-reviewer, LOW
```

**The full list of prefixes — one per aggregate axis.** A UI PR collects up to six verdicts, and
until an axis has a prefix, the arithmetic reconciliation below does not work for it: a finding is lost by exactly
the channel for which the rule was created.

| Axis                 | Prefix  | Verdict line                           |
| -------------------- | ------- | -------------------------------------- |
| `code-reviewer`      | `CR-`   | `Verdict: APPROVE \| BLOCK`            |
| `security-reviewer`  | `SR-`   | `Security Review: APPROVE \| BLOCK`    |
| `spec-reviewer`      | `SPEC-` | `Spec Review: PASS \| ISSUES \| BLOCK` |
| `ui-ux-designer` (B) | `UX-`   | `Design Review:` + `Fidelity:`         |
| `manual-qa`          | `QA-`   | the report's severity table            |
| `copy-reviewer`      | `COPY-` | `Copy Review: PASS \| ISSUES \| BLOCK` |

**Added 2026-08-22** (`SPEC-`, `UX-`, `QA-`): the rule was created after a lost security
finding, but two of the four axes in the UI aggregate remained outside its protection, and `spec-reviewer` is
a new axis. An extension of the existing rule, not a new rule.

The identifier is set **at the moment of writing the review** — not retroactively during
transfer. Otherwise the same person who loses a finding is the one numbering it.

At the end of the review body — a control line:

```
Findings: CR-H-1, CR-H-2, CR-M-1, CR-M-2 (4)
```

### 2. The orchestrator transfers as a list, not a retelling

The fix task contains **all** identifiers from the control line — including those
it was decided not to do. A "do not do" decision is legitimate; a silent disappearance is
not.

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

A mismatch is not "probably a trifle" but an unclosed finding until proof
to the contrary. It was exactly this reconciliation (report against the original review) that caught the loss on
#504 — the rule merely makes it mandatory and cheap instead of accidental and late.

## Mechanical check: decision and rationale (AC9)

**Decision: we do NOT introduce a fully mechanical CI gate. We introduce the arithmetic
reconciliation in the Master aggregate (above) + the `Findings:` control line, which makes this
reconciliation a one-liner.**

Rationale — why not CI:

1. **There is nothing to compare against.** The executor's report lives in the agent chat and in the PR
   body, the review — in GitHub. CI sees only the PR. The gate would have to be fed the review
   body via the API and parse the free markdown of two different agents — i.e. a
   gate on text formatting, not on substance.
2. **It would catch formatting, not the loss.** A reviewer who forgot to put
   `Findings:` reddens the PR; an orchestrator who lost a finding but rewrote the
   line — does not. This is a negative sample: it is noisy on the harmless, silent on the
   dangerous. Exactly the class of checks we have been cleaning out all month.
3. **The cheap part already gives ~the whole effect.** The control line `Findings: … (N)`
   turns the reconciliation into a comparison of two numbers. The cost — one line per review;
   the cost of a CI gate — a parser plus its own false positives.

What would make a mechanical check justified (reconsider if it happens):
a repeated loss of a finding **with** the control line present — i.e.
proof that the arithmetic is not done either. Then the check would be placed not on text but
on structure: the reviewer posts findings as a machine-readable block (JSON in
`<!-- findings: [...] -->`), and CI compares the identifier sets
review ↔ PR body. That becomes cheaper only after the format is already observed.

## Related rules

- `.claude/rules/common/agent-isolation.md` — an adjacent channel without a gate (the same family of defects).
- `.claude/skills/code-review-discipline/SKILL.md` §7 — how to number when writing a review.
- `.claude/agents/contracts.md` §4 — aggregate verdict; "all H/M/L closed before merge" (the result, not the channel).

## Sources

- PR #504 (2026-08-11) — the lost glyph-check bypass finding.
- `docs/architecture/2026-08-17-agent-collision-mechanics.md` §AC7–AC9.
