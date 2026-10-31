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
redness check lives under the session scratchpad, and removing it came out as "this is NOT your
worktree". Six reviewers in one session hit it; the stale checkouts accumulated there, which is the
opposite of what the rule wants.

Every one of those refusals was correct by the letter of the predicate. That is the diagnostic: a
guard that is right by its letter and wrong in substance is a guard whose **definition of "own" is
incomplete**, not one that needs a looser threshold. So the fix had to add the missing half of the
definition rather than relax anything — and the first attempt at that half got it wrong.

#### The first fix was wrong, and how it was wrong is the lesson

That fix keyed "own" on the **path**: anything under the caller's session scratchpad was treated as
its own, on the stated premise that the harness issues a scratchpad per agent. **It does not.**
Measured under one session id on 2026-10-18: a single flat directory, 190 entries, holding the
checkouts of about ten different agents side by side — `checkout`, `co2`, `co3`, `cr-1017`,
`cr-pr1021-checkout`, `cr1016-own`. A reviewer demonstrated the consequence: the widened hook
returned rc 0 for removing a **security reviewer's** checkout. That is PR #544 reintroduced between
siblings — by the guard written to prevent it.

Two things are worth carrying forward from that mistake:

1. **The premise came from a dispatch brief and was repeated in three places** (hook comment, core
   rule, this file) without being measured once. `ls` of the directory was the whole verification and
   it cost one command. A guard whose justification is inherited rather than observed is a guard
   nobody has checked.
2. **The canonical example in the rule was itself a collision.** `"$SCRATCH/checkout"` is a _shared_
   name in a _shared_ directory: two agents of one session that both follow the example literally
   land on the same path. The rule now asks for a name of the agent's own.

#### What the guard actually checks now

`cwd` is shared between siblings and so is `session_id`. The one field in the hook payload that
differs per agent is **`agent_id`**, which the harness fills from the subagent tool context and
leaves empty on the main thread (`createBaseHookInput` in `utils/hooks.ts` of the Claude Code
source: "Hooks use agent_id presence to distinguish subagent calls from main-thread calls").

So ownership is not read off the path at all — it is **recorded**: when this hook watches an agent run
`git worktree add` with a **literal** target inside the scratchpad, it appends one
`<agent_id>\t<path>` line to a ledger there. At remove time only paths recorded against the calling
`agent_id` are permitted; everything else in the scratchpad gets `WORKTREE-UNRECORDED`. The key comes
from the harness, not from the command, and the line is written by the hook, not by the caller —
which is what makes this a check rather than a claim.

#### What may be recorded, and why each condition is load-bearing

The `add` branch decides ownership, so it is the part worth being strict in. A target is recorded only
when it is **literal**, **absolute**, strictly **below** the scratchpad root by at least one
component, and **does not already exist**. The first draft required only "literal, somewhere under
the scratchpad", and each of the other three conditions comes from a defect found in review:

| Condition      | What it stops                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| absolute       | `git worktree add -b mybranch /p/co` puts a **branch name** in argument position. The draft resolved it against cwd and recorded `<cwd>/mybranch` — a path git never creates, named by whoever wrote the branch name. Absoluteness is a **trait**; enumerating `-b`/`-B`/`--reason` is the kind of list this repo has twice watched break quietly (the pre-push prefix list, the commit-type list). It also fixed the legitimate half: the draft recorded the branch name and stopped, so the real target was never recorded at all. |
| below the root | `is_owned` matches prefixes, so a single line for the scratch **root** makes every sibling checkout "mine" — CR-M-1 re-opened by the fix for CR-M-1.                                                                                                                                                                                                                                                                                                                                                                                 |
| does not exist | **The load-bearing one.** A PreToolUse hook records before git runs, so `git worktree add <a live sibling checkout>` fails in git and still left a line claiming it, and the next `remove` was permitted: PR #544 between siblings in two commands. A tree that already exists is not a tree this command creates.                                                                                                                                                                                                                   |

The residual, stated because it cannot be closed from PreToolUse: if the add fails for an unrelated
reason (a bad sha), the line survives for a path that was never created, so a sibling that later picks
the **same literal path** could have it removed by this agent. It needs both agents to choose one
name, which is why rule 4 now asks for a name of your own instead of `checkout`. Closing it properly
needs a PostToolUse companion that records only after git reports success.

Four further limits, each deliberate and each pinned by a case:

- a **non-literal** add (`"$SCRATCH/co"`) records nothing, so its own maker cannot remove it later.
  The remedy is the one `WORKTREE-OPAQUE` already asks for, applied one step earlier: expand once,
  then use the literal for both the add and the remove;
- a **re-dispatched** agent is a new `agent_id` and cannot remove its previous instance's checkout —
  rule 6 working as intended, since it cannot know that tree is abandoned;
- **no `agent_id`** (main thread, or a runtime that omits the field) records nothing and permits
  nothing, i.e. the behaviour from before the widening;
- the ledger write is wrapped and its failure ignored: a hook that died over bookkeeping would refuse
  the command it was only observing.

The prefix comparison keeps its trailing slash, so a record of `…/co-A` does not cover
`…/co-A-notes`; dropping the slash turns that case red (demonstrated with a mutated copy of the hook
via `CROSS_AGENT_BLAST_HOOK`).

#### A ledger-backed guard fails in the direction no assertion was watching

The first version of these tests was green on macOS and red in CI, and the way it was red is the part
worth keeping. Two fixtures were written with macOS-only assumptions — `mktemp -t <prefix>` (a BSD
shorthand; GNU coreutils exits 1 with "too few X's in template") and a path under `/private/tmp`
(which does not exist on Linux and which a non-root user cannot create). Both failures were silent, so
in CI **no ledger line was ever written**.

The consequence is the lesson: a dead ledger does not make this guard permissive, it makes it
**maximally refusing**. So the suite did not fail — it **inverted**. Every "expect allow" case went
red, and every "expect block" case still passed, _including_ the three cases whose entire purpose is
to prove the recording rule discriminates. They were passing because nothing recorded, not because the
rule held.

That is a general property of any guard whose permission comes from state it maintains itself:
**breaking the state looks exactly like being strict.** A refusal case can therefore never be the only
evidence that such a rule works. The fix was accordingly in two parts, not one:

1. the fixtures use the portable idiom `lib/harness.sh` already used (`mktemp "${TMPDIR:-/tmp}/…-XXXXXX"`),
   and the disk-backed roots are spelled `/tmp` — the hook accepts either spelling, so the `/private`
   case that remains is on a path needing no disk;
2. the fixture is **asserted, not assumed** (an unwritable ledger or a missing fixture directory is a
   loud `FATAL`, not an inversion), and every recording rule now has a **positive assertion on the
   ledger** beside its refusal case — `expected recorded, got absent` names the cause where
   `expected allow, got block` only shows a symptom.

Verified both ways: with recording deliberately disabled in a copy of the hook, five cases go red
including two ledger assertions; with the previous `add` branch restored, eight go red instead of the
four the refusal-only suite could see.

One incidental trap, recorded because it cost a cycle: `/tmp` is a symlink to `/private/tmp` on macOS,
so the harness reports a cwd under one spelling while an agent types the other. Both the ledger lines
and the comparison normalise the prefix textually rather than through `realpath`, because the target
of a `git worktree remove` may already be gone and a filesystem lookup would answer a different
question than the one asked.

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

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

## What the harness already does itself (do not duplicate)

| Command                                  | Result                |
| ---------------------------------------- | --------------------- |
| `git -C <foreign path> status`           | the harness refuses   |
| `cd <foreign path> && git rev-parse ...` | the harness refuses   |
| `cd <foreign worktree> && ls`            | **executes** — a hole |
| `git worktree remove <foreign worktree>` | **executes** — a hole |
| `pkill -f <pattern>`                     | **executes** — a hole |

The built-in protection is **only git-specific and only for isolated agents**. A non-isolated agent
is protected by nothing, and file and process operations are not covered at all. These three holes
are closed by `pre:bash:cross-agent-blast`.

---

A **literal** path, and a name of your own (`co-pr1024`, not `checkout`): the scratchpad is shared,
so `checkout` is a name your siblings use too, and only a literal path can be recorded as yours
(rule 6). Not in another agent's working directory and not in a shared checkout. The hook does not block
reading a foreign tree, but it is still a bad idea: the tree of a live agent changes under you, and
you will not see it.

---

**The session scratchpad is SHARED with the other agents of your session** — one flat directory
holding every sibling's checkout. So a scratch path proves nothing about whose it is, and the hook
answers "mine" from a record instead: it writes `<agent_id> <path>` when it sees you create a
worktree at a path that is **literal, absolute, below the scratchpad root, and not already there**,
and permits removing only what is recorded against you (`WORKTREE-UNRECORDED` otherwise). The last
condition is why an `add` aimed at a tree that already exists records nothing: a hook runs before
git, so a path git is about to refuse is not a path you created. Practical consequence — expand the
variable once and use the literal for both steps:

```bash
echo "$SCRATCH"                                          # once, to get the literal
git worktree add --detach /abs/scratch/co-pr1024 <sha>   # recorded as yours
git worktree remove --force /abs/scratch/co-pr1024       # permitted
```

A sibling's checkout, a path created through an unexpanded variable, and a re-dispatched instance of
yourself all stay refused — none of them is a tree you can know is free.

**Your own — remove it by an explicit path, not a variable.** The hook cannot expand `"$w"` and so
cannot say whose directory it is; an opaque path gets the refusal `WORKTREE-OPAQUE`. Cleanup in a
batch — expand (`echo "$w"`) and remove one by one: then the foreign directory will be named by name,
not wiped.

---

The smoke test first does `bash -n` on both hooks and requires of a blocked case not only exit code 2
but also the body `{"decision":"block"}`: a syntax error in a hook also gives exit code 2 and is
otherwise indistinguishable from an honest block.

---

## The cost of a false positive

Both hooks decide by the **first token of a command segment**, not by a substring of the whole string.
So `grep -rn "pkill" .claude/hooks/` and `echo "do not run pkill"` pass, while `pgrep -f ... | xargs
kill -9` (the owner's documented sweep) is not touched at all. `WORKTREE-OPAQUE` is the one exception
that refuses by unverifiability rather than danger — its justification and scope limits are in the
rationale file. **Do not extend that pattern to ordinary mutators.**

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

- 1 — Hook `pre:agent:dispatch-isolation` (matcher `Agent|Task`) — refusal on dispatch — The refusal is visible to the dispatcher immediately. Duplicate layer: Master after EACH agent checks `git status --porcelain` of the main checkout
- 2 — The hook passes read-only types silently — A case in the smoke test; a regression is caught by a run
- 3 — The same hook: an absolute path of the form `/tmp/rev<PR>` in the prompt → refusal — A refusal on dispatch + a `Checkout:` line in the reviewer's report (two identical paths from two reviewers = a collision, visible in the aggregate)
- 4 — Hook `pre:bash:cross-agent-blast` predicate `FOREIGN-WORKTREE` — A refusal at the moment of the command
- 5 — The same hook, predicate `BROADCAST-KILL` — A refusal at the moment of the command
- 6 — The same hook, predicates `WORKTREE-REMOVE` / `WORKTREE-PRUNE` / `WORKTREE-OPAQUE` / `WORKTREE-UNRECORDED` — A refusal at the moment of the command. `OPAQUE` — "the path is not a literal, ownership is not verifiable"; `UNRECORDED` — "the path is in the shared scratchpad and no record ties it to you": both distinguish "could not verify" from "verified"
- 7 — There is no mechanic (the agent may not notice the loss) → **a mandatory line in the report** — An agent's report without a `Worktree: <path> (verified)` line = the reconciliation was not done. The absence is visible to Master at acceptance
- 8 — The same report line — Same

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

Why that is the cure: **an agent's working directory is reset to its session's directory between Bash
calls** (a property of the harness, not a bug). So a `cd` at the start of work is **not retained**,
and an agent that was not issued its own directory returns to the shared one on every next call. The
reset is harmless by itself — it is harmful exactly when the session directory is shared.
