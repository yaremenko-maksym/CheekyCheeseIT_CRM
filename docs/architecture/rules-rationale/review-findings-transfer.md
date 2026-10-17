# Rationale: review-findings-transfer

Rationale layer for `.claude/rules/common/review-findings-transfer.md`. Not auto-loaded — read on demand.

**Source:** PR #504, 2026-08-11.

---

## The incident

While compiling the "what to finish" list, the orchestrator lost a security finding — a glyph-check
bypass. It did **not** reject it as insignificant; it simply did not transfer it. The coder naturally
did not do it. It was caught only by reconciling the executor's report against the original review —
**on the ninth round.**

That is the shape of the defect this rule addresses: not a judgment error, not a disagreement, but a
silent disappearance in a hand-off channel that had no gate on it, in a task that had already been
through eight rounds of scrutiny.

## Why the prefix list was extended (2026-08-22)

The rule was created after the lost security finding, so it initially carried only the prefixes of the
axes involved in that incident. But a UI PR collects up to **six** verdicts, and two of the four axes
in the UI aggregate (`ui-ux-designer` Mode B, `manual-qa`) had no prefix — plus `spec-reviewer` was a
newly added axis.

Until an axis has a prefix, the arithmetic reconciliation does not work for it, which means a finding
on that axis is lost by exactly the channel the rule was created to protect. The extension (`SPEC-`,
`UX-`, `QA-`) is therefore a completion of the existing rule, not a new rule.

## Mechanical check: decision and rationale (AC9)

**Decision: we do NOT introduce a fully mechanical CI gate. We introduce the arithmetic reconciliation
in the Master aggregate + the `Findings:` control line, which makes this reconciliation a one-liner.**

Rationale — why not CI:

1. **There is nothing to compare against.** The executor's report lives in the agent chat and in the
   PR body, the review — in GitHub. CI sees only the PR. The gate would have to be fed the review body
   via the API and parse the free markdown of two different agents — i.e. a gate on text formatting,
   not on substance.
2. **It would catch formatting, not the loss.** A reviewer who forgot to put `Findings:` reddens the
   PR; an orchestrator who lost a finding but rewrote the line — does not. This is a negative sample:
   noisy on the harmless, silent on the dangerous. Exactly the class of checks we spent a month
   cleaning out.
3. **The cheap part already gives ~the whole effect.** The control line `Findings: … (N)` turns the
   reconciliation into a comparison of two numbers. The cost — one line per review; the cost of a CI
   gate — a parser plus its own false positives.

### What would make a mechanical check justified

Reconsider if this happens: **a repeated loss of a finding _with_ the control line present** — i.e.
proof that the arithmetic is not being done either.

Then the check would be placed not on text but on **structure**: the reviewer posts findings as a
machine-readable block (JSON in `<!-- findings: [...] -->`), and CI compares the identifier sets review
↔ PR body. That becomes cheaper only after the format is already observed in practice — which is why
it is a contingency and not a plan.

## The device, named

This rule and `autonomy-levels.md` use the same device: **arithmetic instead of attentiveness.** A
count that must match is checkable by someone who was not in the session and has no opinion about the
content. `Findings: … (N)` and the `## Assumptions` line are the same invention applied to two
different channels. `agent-isolation.md` rules 7–8 use the third instance of it (the mandatory
`Worktree:` report line).

## Sources

- PR #504 (2026-08-11) — the lost glyph-check bypass finding.
- `docs/architecture/2026-08-17-agent-collision-mechanics.md` §AC7–AC9.
