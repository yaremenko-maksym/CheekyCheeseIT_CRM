# Rationale: agent-isolation

Rationale layer for `.claude/rules/common/agent-isolation.md`. Not auto-loaded — read on demand.

**Source:** seven agent-collision incidents 2026-08-07…2026-08-17 (PR #493, #497, #544, #545, #547,
#551) — full analysis in `docs/architecture/2026-08-17-agent-collision-mechanics.md`.

---

## Seven cases, one mechanism

The seven incidents looked like seven different errors. The mechanism was one: an agent worked in a
directory that did not belong to it, because the working directory was not issued to it — it
inherited it.

| PR   | What happened                                               | Rule it produced |
| ---- | ----------------------------------------------------------- | ---------------- |
| #493 | Two reviewers shared one working directory (`/tmp/rev<PR>`) | 3                |
| #497 | A write-agent dispatched without isolation                  | 1                |
| #544 | A foreign worktree wiped as "inactive"                      | 6, 7             |
| #545 | A shared scratch database                                   | 3 (same family)  |
| #547 | `pkill` by mask extinguished another agent's processes      | 5                |
| #551 | A reviewer mutated another agent's tree                     | 4                |

Because the mechanism was one, the cure is one — derive the session directory from the agent's own
identifier — rather than seven pointed patches.

### Why #493 mattered more than it looked

On PR #493 two reviewers ended up in one directory, and someone else's edit got into the measurements
**as a property of the code**: "858 px" went into the report as a measurement of a live component,
being a consequence of someone else's injection. A shared directory does not produce a visible
collision — it produces a confidently wrong finding.

### Why #544 produced two rules

The "inactive" worktree turned out to be a reviewer's worktree waiting for the next round. The
reviewer was saved only by having looked at `git worktree list` on its own initiative — managing
beforehand to detach the HEAD of the shared checkout. Hence both rule 6 (do not remove a foreign
worktree) and rule 7 (if yours vanished, stop).

A later repeat, 2026-09-02, came through a loop:

```bash
for w in $(git worktree list | ...); do git worktree remove --force "$w"; done
```

It wiped the checkouts of two working reviewers, though the **literal** form of the same command was
already blocked. The hook cannot expand `"$w"` — for that it would have to execute it — so it could
not say whose directory it was, and was silent. That is what the `WORKTREE-OPAQUE` refusal was added
for.

## The cwd reset — verified, not assumed

The harness states it in plain text in the subagent's system prompt ("Agent threads always have their
cwd reset between bash calls"), and it was verified by a run 2026-08-17: `cd <another directory> &&
pwd` shows the other directory, the next `pwd` call — its own again.

The harness-holes table in the core rule is likewise from that run, from an isolated agent, command
by command — not from documentation.

(The matcher for `pre:agent:dispatch-isolation` is written `Agent|Task` in the core rule. It appeared
as `Agent\|Task` while that row lived inside a markdown table, where the pipe had to be escaped; the
regex itself never contained a backslash.)

One finding from the same run is worth keeping in mind whenever an agent reasons about its own
environment: **the harness told the agent a worktree path that was not on disk**, while reading at
that path returned content. That is the whole justification for rule 8 being a command and not a
belief.

## The cost of a false positive

Both hooks decide by the **first token of a command segment**, not by a substring of the whole string.
That is why `grep -rn "pkill" .claude/hooks/` and `echo "do not run pkill"` pass, while `pgrep -f ...
| xargs kill -9` (the owner's documented sweep) is not touched at all.

This is deliberate. The adjacent `pre:bash:safety` greps the raw string and therefore blocks a plain
`echo` mentioning `DROP DATABASE crm_db` — reproduced 2026-08-17 while working on these hooks. That is
exactly how the reflex to bypass the gate is bred (backlog 63, `live-db-guard` against a harmless
`grep`). **A false positive costs trust in the whole hook infra, not a minute.**

### Why `WORKTREE-OPAQUE` is allowed to be an exception

It refuses not by a sign of danger but by a sign of **unverifiability** — i.e. it knowingly covers
harmless commands too. That is justified only where both conditions hold at once:

1. **The command has no harmless majority.** `git worktree remove` **always** destroys a working
   space; the only question is whose.
2. **The bypass costs one command.** `echo "$w"` → substitute the literal.

It is deliberately **not** extended to ordinary mutators (`rm "$x"`), because there both conditions
are false: the majority is harmless, and no one will unroll a loop over two hundred files by hand —
they will learn to bypass the gate instead. The scope is fixed by "silent" cases in the smoke test, so
that extending the rule must be a deliberate act rather than drift.

### The reviewers who could not clean up after themselves (2026-10-17)

The same false-positive budget cut the other way, and it took a session to notice. `WORKTREE-REMOVE`
recognised only the caller's primary worktree as "own" — but a read-only agent is deliberately given
no worktree (rule 2), so `own_wt` is empty for **every** reviewer. The checkout a reviewer makes for a
redness check lives under the session scratchpad the harness issues it personally, and removing it
came out as "this is NOT your worktree". Six reviewers in one session hit it; the stale checkouts
accumulated under the scratchpad, which is the opposite of what the rule wants.

Every one of those refusals was correct by the letter of the predicate. That is the diagnostic: a
guard that is right by its letter and wrong in substance is a guard whose **definition of "own" is
incomplete**, not one that needs a looser threshold. So the fix added the second half of the
definition rather than relaxing anything — "own" is my worktree **or** my own session scratchpad, and
both are derived from my own cwd.

What keeps the widening narrow is the **session id**: `/tmp/claude-<uid>/<slug>/<session>/...` is
issued per agent, so another session's scratchpad is as foreign as another agent's worktree, and the
claim "this is mine" stays checkable rather than asserted. Three things the predicate already
protected are pinned by refusal cases from a scratchpad cwd: another session's scratchpad, another
agent's worktree, and an opaque target. A scratch path named from a **worktree** cwd is still refused
— the scratchpad is not derivable from a worktree path, so ownership is unverifiable, and the remedy
is the same single command that `WORKTREE-OPAQUE` asks for.

One incidental trap, recorded because it cost a cycle: `/tmp` is a symlink to `/private/tmp` on macOS,
so the harness reports a cwd under one spelling while an agent types the other. The comparison
normalises the prefix textually rather than through `realpath`, because the target of a `git worktree
remove` may already be gone and a filesystem lookup would answer a different question than the one
asked.

## The smoke test was dead for a month

Until 2026-09-01 nobody ran `.claude/hooks/tests/cross-agent-hooks-smoke.sh` except a human by hand.
Not one workflow referenced it (`grep -rn cross-agent-hooks-smoke .github` — empty): **42 real cases
CI never executed once.** It is now called from `scripts/devops/tests/test-pre-bash-cross-agent-blast.sh`,
inside `run-guard-tests.sh`, inside a required check. See
`docs/architecture/rules-rationale/zone-of-write.md` for why those tests live in the DevOps directory.

The `bash -n` + `{"decision":"block"}` assertion in the smoke exists because the first draft of
`cross-agent-blast` **died on parsing and "passed" all eight blocking cases, doing nothing** — a
syntax error also exits 2.

## Sources

- `docs/architecture/2026-08-17-agent-collision-mechanics.md` — analysis of all seven cases, verification runs, rejected options.
- Incidents: PR #493 (shared reviewer directory), #497 (dispatch without isolation), #544 (wiping a foreign worktree), #545 (shared scratch DB), #547 (`pkill` by mask), #551 (mutating a foreign tree).
- 2026-09-02 — the opaque-variable worktree loop; origin of `WORKTREE-OPAQUE`.
