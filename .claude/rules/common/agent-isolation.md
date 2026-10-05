# Rule: Agent isolation — each agent has its own workspace

**Status:** Always-on (2 hooks + report lines; see "How we know it is violated")
**Applies to:** all agents and everyone who dispatches agents (Master / orchestrator)
**Source:** seven agent-collision incidents 2026-08-07…2026-08-17 (PR #493, #497, #544, #545, #547, #551) — analysis in `docs/architecture/2026-08-17-agent-collision-mechanics.md`.

---

## One cause for seven cases

The seven incidents looked like seven different errors. The mechanism is one:

> **An agent works in a directory that does not belong to it,** because the working
> directory was not issued to it — it inherited it.

Then the second half kicks in, no longer an error but a property of the environment:
**an agent's working directory is reset to its session's directory between Bash calls.**
The harness says this in plain text in the subagent's system prompt ("Agent threads
always have their cwd reset between bash calls"); verified by a run 2026-08-17:
`cd <another directory> && pwd` shows the other directory, the next `pwd` call —
its own again. So a `cd` at the start of work is **not retained**, and an agent that was not
issued its own directory returns to the shared one on every next call.

A cwd reset is harmless by itself — it is harmful exactly when the session directory is
shared. Hence the cure, common to all seven cases, instead of seven pointed ones:

> **An agent's session directory is derived from the agent's own identifier and is never
> inherited from the orchestrator.**

For a write-agent this gives `isolation="worktree"`; for a reviewer — its own checkout in its own
scratchpad (and only when it really needs one, see below); for everyone — the fact that
a cwd reset now returns them to **their own** tree.

## What the harness already does itself (do not duplicate)

Verified by a run 2026-08-17 from an isolated agent:

| Command                                  | Result                |
| ---------------------------------------- | --------------------- |
| `git -C <foreign path> status`           | the harness refuses   |
| `cd <foreign path> && git rev-parse ...` | the harness refuses   |
| `cd <foreign worktree> && ls`            | **executes** — a hole |
| `git worktree remove <foreign worktree>` | **executes** — a hole |
| `pkill -f <pattern>`                     | **executes** — a hole |

Conclusion: the built-in protection is **only git-specific and only for isolated
agents**. A non-isolated agent is protected by nothing, and file and process
operations are not covered at all. These three holes are closed by `pre:bash:cross-agent-blast`.

## Rules

### 1. Dispatch: a write-agent — always with its own directory

`coder`, `autotest`, `devops`, `ui-ux-designer`, `manual-qa`, `legal`, `pm`,
`architect` are dispatched **only** with `isolation="worktree"` (or an explicit `cwd=`,
if a specific existing directory is needed — the parameters are mutually exclusive).

An error here is the **dispatcher's** error, not the agent's (PR #497: the coder behaved
correctly on seeing the hook's warning; the one who launched it that way was wrong).

### 2. A read-only agent is NOT forced a worktree

`code-reviewer`, `security-reviewer`, `copy-reviewer`, `Explore`, `Plan`,
the `codebase-audit` fan-out do **not** require isolation and should not pay for an extra worktree:
they read the diff via `gh pr diff` / GitHub MCP, not via a local
tree. The gate passes them silently (verified by a separate case in the smoke test).

**But:** as soon as a reviewer needs to **run or roll back** something (a redness check,
a measurement, a reproduction), it needs **its own** checkout — see rule 4.

### 3. A shared working directory is not issued in the prompt

The working directory path is **never** set by the orchestrator as an absolute path
of the form `/tmp/rev<PR>`: the PR number is the same for all reviewers of that PR, so such
a path is shared by construction. On PR #493 two reviewers ended up in one
directory, and someone else's edit got into the measurements **as a property of the code** — "858 px" went into
the report as a measurement of a live component, being a consequence of someone else's injection.

The path is derived from the **agent's own** identifier: its worktree
(`git rev-parse --show-toplevel`) or its session-scratchpad, which the harness
issues to each agent personally.

### 4. A foreign tree is not mutated. Ever

A redness check requires mutation — so it is done in **your own** checkout:

```bash
git worktree add --detach "$SCRATCH/checkout" <sha of the real PR commit>
```

and not in another agent's working directory (PR #551) and not in a shared checkout.
The hook does not block reading a foreign tree, but it is still a bad idea: the tree of
a live agent changes under you, and you will not see it.

### 5. Processes — only your own, by PID

`pkill -f` / `killall` hit by pattern and extinguish any agent's processes (PR #547).
Your own processes are killed by PID: `lsof -ti tcp:<your port>` → `kill <PID>`.
A deliberate mass sweep is the owner's prerogative, not the task's.

### 6. A foreign worktree is not removed

An agent does not see other agents and **cannot reasonably judge** whether a foreign
worktree is abandoned. On PR #544 an "inactive" worktree turned out to be a reviewer's worktree waiting for the
next round. Your own — remove it, a foreign one — report to the orchestrator.

**Your own — remove it by an explicit path, not a variable.** The hook cannot expand `"$w"` —
for that it would have to execute it — and so cannot say whose
directory it is. Previously it was silent in this case, and 2026-09-02 the loop
`for w in $(git worktree list | ...); do git worktree remove --force "$w"; done`
wiped the checkouts of two working reviewers, though the literal form of the same command
was blocked by a refusal. Now an opaque path gets the refusal
`WORKTREE-OPAQUE`. Cleanup in a batch — expand (`echo "$w"`) and remove one by one:
then the foreign directory will be named by name, not wiped.

### 7. The worktree vanished — stop and report

An agent that discovers its worktree is gone (or that `git rev-parse
--show-toplevel` does not match the issued path) **must stop and
report**, not continue in the directory it was thrown into. On PR #544
the reviewer was saved only by having looked at
`git worktree list` on its own initiative — managing beforehand to detach the HEAD of the shared checkout.

### 8. Reconciliation before the first edit (a mandatory step)

The first command in any write-agent's session:

```bash
git rev-parse --show-toplevel     # must match the issued worktree
```

No match → rule 7 (stop + report). The environment's self-representation cannot be
trusted: 2026-08-17 the harness told the agent a worktree path that **was not on
disk**, while reading at that path returned content. Trust only a fact
obtained by a command.

## How we know it is violated (a mandatory answer for every rule)

A rule without observability is not a rule. For each one above:

| #   | Mechanics                                                                                     | Observability of a violation                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Hook `pre:agent:dispatch-isolation` (matcher `Agent\|Task`) — refusal on dispatch             | The refusal is visible to the dispatcher immediately. Duplicate layer: Master after EACH agent checks `git status --porcelain` of the main checkout              |
| 2   | The hook passes read-only types silently                                                      | A case in the smoke test; a regression is caught by a run                                                                                                        |
| 3   | The same hook: an absolute path of the form `/tmp/rev<PR>` in the prompt → refusal            | A refusal on dispatch + a `Checkout:` line in the reviewer's report (two identical paths from two reviewers = a collision, visible in the aggregate)             |
| 4   | Hook `pre:bash:cross-agent-blast` predicate `FOREIGN-WORKTREE`                                | A refusal at the moment of the command                                                                                                                           |
| 5   | The same hook, predicate `BROADCAST-KILL`                                                     | A refusal at the moment of the command                                                                                                                           |
| 6   | The same hook, predicates `WORKTREE-REMOVE` / `WORKTREE-PRUNE` / `WORKTREE-OPAQUE`            | A refusal at the moment of the command. `OPAQUE` — "the path is not a literal, ownership is not verifiable": it distinguishes "could not verify" from "verified" |
| 7   | There is no mechanic (the agent may not notice the loss) → **a mandatory line in the report** | An agent's report without a `Worktree: <path> (verified)` line = the reconciliation was not done. The absence is visible to Master at acceptance                 |
| 8   | The same report line                                                                          | Same                                                                                                                                                             |

**The report line (mandatory for write-agents and for reviewers that made a checkout):**

```
Worktree: /abs/path (verified: toplevel == dispatched path)
```

No line → Master returns the agent for rework, as for a missing verdict.
This is the only thing that makes rules 7 and 8 observable: the harness gives no hook for
"an agent reads the wrong directory", and a Bash hook cannot know which path was issued to
the agent at dispatch.

## The cost of a false positive

Both hooks decide by the **first token of a command segment**, not by a substring of the whole
string. That is why `grep -rn "pkill" .claude/hooks/` and `echo "do not run pkill"`
pass, while `pgrep -f ... | xargs kill -9` (the owner's documented sweep)
is not touched at all.

This is done deliberately. The adjacent `pre:bash:safety` greps the raw string and therefore
blocks a plain `echo` mentioning `DROP DATABASE crm_db` — reproduced
2026-08-17 while working on these hooks. That is exactly how the reflex to bypass the
gate is bred (backlog 63, `live-db-guard` against a harmless `grep`). A false positive
costs trust in the whole hook infra, not a minute.

**The refusal `WORKTREE-OPAQUE` is the only exception, and it is weighed, not
done "just in case".** It refuses not by a sign of danger but by a
sign of unverifiability — i.e. it knowingly covers harmless commands too.
Justified only where both conditions hold at once: (1) the command has no
harmless majority — `git worktree remove` **always** destroys a working
space, the only question is whose; (2) the bypass costs one command (`echo "$w"` →
substitute the literal). It is not extended to ordinary mutators (`rm "$x"`) precisely
because there both conditions are false: the majority is harmless, and no one will unroll a loop
over two hundred files by hand — and will learn to bypass the gate. The scope is
fixed by "silent" cases in the smoke: extending the rule must be a
deliberate act, not drift.

## Checking the gates

```bash
bash .claude/hooks/tests/cross-agent-hooks-smoke.sh   # both sides: refusals and silence
```

**This smoke, until 2026-09-01, nobody ran except a human by hand.** Not one
workflow referenced it (`grep -rn cross-agent-hooks-smoke .github` — empty):
42 real cases CI never executed once. Now it is called from
`scripts/devops/tests/test-pre-bash-cross-agent-blast.sh`, and that is part of
`run-guard-tests.sh` — a step inside a **required** check. Plus each of the two hooks
got its own set of cases in `scripts/devops/tests/`, because the meta-guard
`check-guard-tests-exist.sh` now takes the list of hooks from `.claude/settings.json`
and requires a negative case from every one that can refuse.

The smoke test first does `bash -n` on both hooks and requires of a blocked
case not only exit code 2 but also the body `{"decision":"block"}`: a syntax error in a
hook also gives exit code 2 and is otherwise indistinguishable from an honest block (the first draft of
`cross-agent-blast` died on parsing and "passed" all eight blocking
cases, doing nothing).

## Related rules

- `.claude/rules/common/zone-of-write.md` — which paths are whose (this file — about **which tree**).
- `.claude/rules/common/review-findings-transfer.md` — transferring review findings (the same family: a channel without a gate).
- `.claude/rules/common/light-track.md` — concurrency ceiling, sweep of zombie dev servers.
- `.claude/skills/code-review-discipline/SKILL.md` §6 — the reviewer's own checkout.
- `.claude/agents/contracts.md` — Master-direct-dispatch contracts (dispatch with isolation).

## Sources

- `docs/architecture/2026-08-17-agent-collision-mechanics.md` — analysis of all seven cases, verification runs, rejected options.
- Incidents: PR #493 (shared reviewer directory), #497 (dispatch without isolation), #544 (wiping a foreign worktree), #545 (shared scratch DB), #547 (`pkill` by mask), #551 (mutating a foreign tree).
