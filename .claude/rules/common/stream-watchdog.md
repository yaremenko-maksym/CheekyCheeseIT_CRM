# Rule: The watchdog kills on silence; only a pushed commit survives it

**Status:** Always-on (hook `post:edit-write:undurable-work` + the heartbeat ledger — see "How we
know it is violated")
**Applies to:** every agent (the one at risk) and everyone who dispatches one

> Rationale — the seven cuts of 2026-10-17, the five of 2026-10-20 that happened with this rule
> already injected into every one of those agents, and why the answer is a hook rather than a fifth
> paragraph: `docs/architecture/rules-rationale/stream-watchdog.md`

---

## The mechanism

The harness cuts an agent off after **600 s with nothing written to its stream**. The clock measures
**silence**, not work: a forty-minute task that reports every few minutes survives, a twelve-minute
one that reports nothing does not.

**Silence comes from two sources, and the second one has no subprocess in it:**

| Source        | What produces it                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **waiting**   | environment provisioning, a dev-server boot, a full suite in the foreground, a whole-file read                                      |
| **producing** | a long think; composing a large file in one tool call; two suites run back to back with nothing written between them; a long report |

The waiting half is the half that looks dangerous, and it is the half agents already guard. **The
producing half killed three of the five agents cut on 2026-10-20** — one of them after it had
correctly backgrounded its long command, because the silence came from the writing that followed the
wait rather than from the wait.

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

## Break the silence

- **Announce a long step before taking it.** The output that saves you is the one written before the
  quiet part starts.
- **Produce in pieces, and end each piece with a push.** A large file is a skeleton pushed first,
  then one section per call. The 231-line canary workflow of 2026-10-20 was lost once as a single
  compose and then completed in seven `wip:` pushes — same file, same agent role, opposite outcome.
- **Start anything long with `run_in_background: true`**, then check with **single bounded probes**
  (one `curl --max-time 5`, one `gh pr checks`, re-issued later), never a polling loop —
  `pre:bash:unbounded-wait` refuses one anyway (`light-track.md`).
- **Read a large file by window** (`offset` / `limit`, or `codegraph_node`), not whole.

## How we know it is violated

| What is reconciled                                                                                                                                                                                          | Who                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `post:edit-write:undurable-work` — refuses silently no longer: it tells an agent that has accumulated substantial work in a worktree with **no commit of its own** to commit and push before producing more | the hook, at the moment of the write |
| `scripts/devops/check-stream-silence.sh` — gaps ≥ 480 s between consecutive tool calls of one agent workspace, read from `.claude/agent-heartbeat.log` (written by `post:any:heartbeat`)                    | Master at acceptance                 |
| An agent whose last heartbeat is minutes before its report, with nothing pushed on its branch                                                                                                               | Master at acceptance                 |
| A foreground Bash call expected to run minutes (install, full suite, dev server)                                                                                                                            | the agent, before sending it         |

The ledger is what separates **cut** from **finished and silent** without relying on anybody's
attentiveness: a cut agent's heartbeats stop mid-stretch, and the gap between its last heartbeat and
its death is the silence that killed it, measured rather than inferred.

## Related rules

- `.claude/rules/common/git-policy.md` — the `wip:` cadence and what a `wip:` commit is free of.
- `.claude/rules/common/light-track.md` — `pre:bash:unbounded-wait`, and how to wait correctly.
- `.claude/rules/common/agent-isolation.md` — why the worktree the work sits in is removable at all.
- `.claude/skills/dev-flow-resilience/SKILL.md` — recovery **after** a cut (sentinel, write-then-post).
