# Rule: The watchdog kills on silence, not on duration

**Status:** Always-on
**Applies to:** every agent (the one at risk) and everyone who dispatches one (so this stops being
retyped into each brief)

> Rationale, the seven cuts of one session and why this is a rule rather than a pointer:
> `docs/architecture/rules-rationale/stream-watchdog.md`

---

## The mechanism

The harness cuts an agent off after **600 s with nothing written to its stream**. The clock measures
**silence**, not work: a forty-minute task that reports every few minutes survives, a twelve-minute
one that reports nothing does not. Long work is not the hazard — an unbroken silent stretch is, and
four produce one by default: environment provisioning, a dev-server boot, a full integration run,
and reading a large file whole.

## Break the silence

- **Announce a long step before taking it**, not after. The output that saves you is the one written
  before the quiet part starts.
- **`wip:` commit and push as you go** — the chunking cadence is in `git-policy.md`. A cut after a
  push costs the next agent a re-read; a cut before it costs the whole stretch.
- **Start anything long with `run_in_background: true`** and let the completion notification reach
  you. Readiness is then checked with **single bounded probes** (one `curl --max-time 5`, one
  `gh pr checks`, re-issued later), never a polling loop — `pre:bash:unbounded-wait` refuses one
  anyway (`light-track.md`).
- **Read a large file by window** (`offset` / `limit`, or `codegraph_node`), not whole. One
  2000-line read is one long silence and most of it is context you did not need.

## How we know it is violated

| What is reconciled                                                                                   | Who                          |
| ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| A transcript that ends mid-stretch, with no tool output for ~10 min and no `wip:` commit             | Master at acceptance         |
| A dispatch brief that spells these four moves out — the rule is not being inherited, so fix the rule | the brief author             |
| A foreground Bash call expected to run minutes (install, full suite, dev server)                     | the agent, before sending it |

A cut agent looks identical to a finished one that forgot to report: the `wip:` commits are what tell
them apart, which is why the cadence is load-bearing rather than tidy.

## Related rules

- `.claude/rules/common/git-policy.md` — the `wip:` cadence and what a `wip:` commit is free of.
- `.claude/rules/common/light-track.md` — `pre:bash:unbounded-wait`, and how to wait correctly.
- `.claude/skills/dev-flow-resilience/SKILL.md` — recovery **after** a cut (sentinel, write-then-post).
