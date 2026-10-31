# Rule: The watchdog kills on silence; only a pushed commit survives it

**Status:** Always-on (hook `post:edit-write:undurable-work` + the heartbeat ledger — see "How we
know it is violated")
**Applies to:** every agent (the one at risk) and everyone who dispatches one

> Rationale: `docs/architecture/rules-rationale/stream-watchdog.md`

---

## The mechanism

The harness cuts an agent off after **600 s with nothing written to its stream**. The clock measures
**silence**, not work: a forty-minute task that reports every few minutes survives, a twelve-minute
one that reports nothing does not.

Silence comes from **waiting** (provisioning, dev-server boot, a foreground suite, a whole-file read) and from **producing** (a long think; composing a large file in one call; two suites back to back; a long report). Producing has no subprocess in it.

## The unit of safety is a pushed commit

A cut is survivable or total, and which one it is does not depend on how long the agent worked. It
depends on what exists **outside the agent's worktree** at the moment the stream goes quiet.

| State at the cut   | What it costs                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **pushed**         | the next agent re-reads a branch. The work is a fact on the remote                                                                           |
| **committed only** | the commit is reachable only through a ref inside a worktree the harness may remove and the next agent cannot name — recovery is archaeology |
| **neither**        | the harness removes a worktree it judges unchanged, and the stretch is gone outright                                                         |

So the chunking cadence in `git-policy.md` is read as **commit _and push_**, and the first push
comes **before** the first long stretch, not after it. "I committed it" is not a durability claim;
`git push` is.

**Every agent's report carries one line for it**, the same device as the `Worktree:` line in
`agent-isolation.md` — an assertion Master can check in one command instead of inferring:

```
Pushed: <branch> @ <sha>          (or: Pushed: nothing — <why>)
```

## Break the silence

- **Announce a long step before taking it.**
- **Produce in pieces, and end each piece with a push.** A large file is a skeleton pushed first,
  then one section per call.
- **Start anything long with `run_in_background: true`**, then check with **single bounded probes**
  (one `curl --max-time 5`, one `gh pr checks`, re-issued later), never a polling loop —
  `pre:bash:unbounded-wait` refuses one anyway (`light-track.md`).
- **Read a large file by window** (`offset` / `limit`, or `codegraph_node`), not whole.

## How we know it is violated

| What is reconciled                                                                                                                                                                                     | Who                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `post:edit-write:undurable-work` — tells an agent that has accumulated substantial work in a worktree with **no commit of its own** to commit and push before producing more                           | the hook, at the moment of the write |
| The report line `Pushed: <branch> @ <sha>` — the agent's own claim that its work is outside its worktree, checkable in one command (`git ls-remote origin <branch>`). Its absence is a missing verdict | Master at acceptance                 |
| `scripts/devops/check-stream-silence.sh` — gaps ≥ 480 s between consecutive tool calls of one agent workspace, read from `.claude/agent-heartbeat.log` (written by `post:any:heartbeat`)               | Master at acceptance                 |
| An agent whose last heartbeat is minutes before its report, with nothing pushed on its branch                                                                                                          | Master at acceptance                 |
| A foreground Bash call expected to run minutes (install, full suite, dev server)                                                                                                                       | the agent, before sending it         |

The ledger separates **cut** from **finished and silent**: a cut agent's heartbeats stop mid-stretch.

## Related rules

- `.claude/rules/common/git-policy.md` — the `wip:` cadence and what a `wip:` commit is free of.
- `.claude/rules/common/light-track.md` — `pre:bash:unbounded-wait`, and how to wait correctly.
- `.claude/rules/common/agent-isolation.md` — why the worktree the work sits in is removable at all.
- `.claude/skills/dev-flow-resilience/SKILL.md` — recovery **after** a cut (sentinel, write-then-post).
- `.claude/rules/common/verification-integrity.md` — the `Pushed:` line (assert the artifact, never the exit status).
