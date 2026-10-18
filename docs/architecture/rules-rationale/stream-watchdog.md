# Rationale: stream-watchdog

Rationale layer for `.claude/rules/common/stream-watchdog.md`. Not auto-loaded — read on demand.

**Source:** the multi-agent session of 2026-10-17, in which seven agents were cut off, and the
dispatch briefs of that same session, in which the cure was typed out by hand seven times.

---

## Seven cuts, one shape

Every one of the seven happened during a stretch that produced **no output for 600 s**. The work
being done differed; the silence did not:

| What was running         | Why it was silent                                                   |
| ------------------------ | ------------------------------------------------------------------- |
| environment provisioning | `pnpm install --frozen-lockfile` in a fresh worktree, minutes of it |
| a dev-server boot        | vite + nest starting in the foreground, nothing printed until ready |
| a full integration run   | one long suite invocation, output buffered to the end               |
| reading large files      | no external process at all — just whole-file reads in sequence      |

The fourth row is the useful one. It rules out "the agent was waiting on something slow" as the
explanation: an agent can starve its own stream with nothing but reads. The invariant is therefore
about the **stream**, not about subprocesses — which is why the rule leads with silence and not with
"long operations".

## Why a rule and not a better dispatch brief

The cure was already known during the session and was applied, correctly, in every brief after the
first cut. That is exactly the failure mode `writing-for-agents` calls out: knowledge that lives in
the dispatcher's memory is re-typed per dispatch, drifts between dispatches, and is absent the one
time the dispatcher is in a hurry. Seven repetitions of the same paragraph is the measurement that
says it belongs in inherited context.

## Why not just point at `dev-flow-resilience`

The skill covers this ground — but on the **recovery** side: sentinel files, write-then-post, how
Master pulls work out of a worktree after a cut (patterns C1/C2). Two reasons that is not enough on
its own:

1. **A skill is reached by invocation, and the agent does not know it is at risk.** The trigger for
   invoking a resilience skill is "something went wrong"; here the decision that matters — background
   or foreground, windowed read or whole — is taken _before_ anything looks wrong, in the first
   minutes of a session.
2. **The prevention half was not written anywhere.** The skill assumes the cut and tells you how to
   survive it. Nothing told an agent how not to be cut.

So the split is: prevention in the always-on layer (four moves, ~40 lines), recovery in the skill,
and the rule points at the skill rather than restating it.

## Why this does not restate the `wip:` cadence

The "every ~2 files or ~5 minutes" number lives in `git-policy.md` and in the skill, and had already
been tightened once from 3/30 because agents were cut _before_ the first milestone. One meaning, one
place: the rule names the cadence as load-bearing for a different reason (it is what distinguishes a
cut agent from a silent finished one) and links for the number.

## Sources

- The 2026-10-17 session: seven cuts, four distinct silent stretches, cure applied by hand in each
  subsequent dispatch brief.
- `.claude/skills/dev-flow-resilience/SKILL.md` §C1 — the watchdog-asymmetry analysis and the origin
  of the chunking cadence (`docs/architecture/2026-05-23-dev-flow-rca.md`).
- `.claude/skills/writing-for-agents/SKILL.md` — the pointer-vs-inline test applied above.
