# Rationale: stream-watchdog

Rationale layer for `.claude/rules/common/stream-watchdog.md`. Not auto-loaded — read on demand.

**Sources:** the multi-agent session of 2026-10-17, in which seven agents were cut off and the cure
was typed out by hand seven times; and 2026-10-20, in which **five agents were cut in one day on one
feature** with that cure already written down as an always-on rule.

---

## Seven cuts, one shape (2026-10-17)

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

That session produced the first edition of the rule: the mechanism, and four moves against it.

## Five cuts, with the rule already in force (2026-10-20)

One day, one feature — host-key pinning in the deploy workflow (PRs
yaremenko-maksym/CheekyCheeseIT_CRM#1056 and #1058, plus the branch `devops/host-key-pin-canary`).

| #   | Shape                                                                                          | What it cost                                                    |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | test suites in the foreground, one after another, nothing written between them                 | the stretch                                                     |
| 2   | the same agent again, **after** the orchestrator had quoted the rule verbatim into the resume  | the stretch                                                     |
| 3   | a long think, then a large workflow file composed in **one** tool call; nothing written at all | **everything** — the harness removed the unchanged worktree     |
| 4   | the long command correctly backgrounded; the silence came from the **writing that followed**   | the stretch                                                     |
| 5   | told explicitly to commit each piece, and did commit — but never pushed                        | a commit on a ref inside a removable worktree nobody could name |

Cut 3 is the expensive one and the most instructive. The lost file was rebuilt afterwards in seven
`wip:` pushes (`c2549ab24` skeleton → pairs 1-3 → verify → assertion → `f16d8143a`), 231 lines in
total, first durable commit 42 lines. Same file, same agent role, opposite outcome — the only
difference is the cadence, which is why the threshold of the new hook is derived from those two
numbers rather than chosen.

## What the second day proved about the first day's fix

### Delivery was never the defect

The first edition's `Applies to` line says the rule exists "so this stops being retyped into each
brief", and the 2026-10-17 analysis below argues the knowledge belongs in inherited context. It
already **is** in inherited context: `stream-watchdog.md` carries no `paths:` frontmatter, and
`.claude/RULES.md` §0 records what that means — such a file is injected into **every request of
every session and every subagent**. Every one of the five agents had the full text in front of it.
Two of them had it twice, the second time retyped verbatim by the orchestrator.

So the conclusion that the delivery channel needs strengthening — a dispatch hook that injects the
cadence, a copy in each `.claude/agents/*.md` — is **wrong, and was tested by the incident**. A
fourth copy of advice that two copies did not carry is not a fix; it is contextual load plus a
second source of truth to drift. `writing-for-agents` calls that out directly ("one meaning, one
place"), and this is the case where the cost of ignoring it is measurable.

### The rule covered waiting, not producing

The four moves address provisioning, a server boot, a suite, a whole-file read — all things the
agent **waits for**. Cuts 3 and 4 came from the agent **producing**: thinking at length, then
emitting a large file in one call. The first edition had nothing to say about that shape, so an
agent following it to the letter still walked into it. Fixed in the text: silence now has two named
sources, and "produce in pieces that each end in a push" is a move of its own.

### "Commit as you go" was false safety

Cut 5 followed the instruction exactly and still lost its work to archaeology. A commit inside an
agent worktree is reachable only through a ref in a tree the harness may remove and the next agent
cannot name; the rescue (a temporary branch, `git log --all`) has been done by hand before
(2026-09-05, weekly-limit recovery). The unit of safety is therefore stated as a **pushed** commit,
with the three states and their costs tabulated, so "I committed it" stops reading as a durability
claim.

## Why a hook, and why this hook

`post:edit-write:undurable-work` is the only mechanical thing available in that spot, and it works
by giving up on the thing that cannot be mechanised:

- **It does not predict silence.** Nothing a hook can see does. The watchdog's clock runs on the
  stream, and a hook only ever runs because the stream has just spoken — by construction it is
  never present during the dangerous stretch.
- **It measures the blast radius instead**, which is decidable from git alone: substantial
  uncommitted work in a worktree with no commit of its own is exactly the state in which a cut costs
  everything rather than a re-read. That is cut 3, and it is the only one of the five whose cost was
  unbounded.
- **PostToolUse, not PreToolUse.** A refusal on a large write would discard content the agent had
  just spent the silent stretch producing — it would charge for the thing it protects. Exit 2 from a
  PostToolUse hook feeds the demand to the model after the write has landed, so the remedy is
  `git commit && git push` and not a re-emission.
- **It fires at most once per agent.** The first commit silences it for the session. The demand it
  makes is the cheapest possible one, and after it the cadence is the rule's business again.

### Rejected: a `pre:agent:dispatch` injection of the cadence

Considered because the brief for this change suggested it. Rejected on the evidence above: the
cadence already reaches every agent through the always-on layer, twice over in two of the five
cases. A dispatch-time hook would be a third copy of text that two copies did not carry, and
`pre:agent:dispatch-isolation` is the counter-example that shows when dispatch-time **is** right —
there the mistake is the **dispatcher's** (an agent cannot give itself a worktree), whereas here the
action is the agent's and the information was already in its hands.

### Rejected: blocking a large single-call write on size

The first design gated `Write` when `content` exceeded a byte threshold, on the theory that content
size is a proxy for generation time. It is a weak one: 10 KB of output is tens of seconds, not ten
minutes. In cut 3 the silence was dominated by the **think**, which no hook can see at all, and the
file was merely where the loss landed. Gating on size would have blocked legitimate writes while
still missing the mechanism.

## Observability: why a ledger and not the existing log

The first edition's "how we know it is violated" asked for "a transcript that ends mid-stretch …
and no `wip:` commit" — a reading, by hand, that leans on the very discipline whose absence is the
failure. In practice nobody read it: five cuts happened in one day and the repository recorded none
of them.

`post:edit-write:coder-progress` could not help. It has logged durable activity since Phase 2.5 but
only for `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, which makes it blind to every silent shape —
suites, boots, reads, thinking. For 2026-10-20 it holds **two lines for the whole day**.

`post:any:heartbeat` + `scripts/devops/check-stream-silence.sh` close that. A gap between two
consecutive heartbeats of one workspace is silence the agent **survived**, measured exactly; at 480 s
of a 600 s budget it is one slow retry from a cut, which makes it a leading indicator rather than a
post-mortem. A ledger that stops is the post-mortem: the distance from its last line to the agent's
death is the stretch that killed it.

### Why the checker is not a CI gate

The ledger is machine-local and per-run — it describes this laptop's agents, not the repository's
content, so a workflow has nothing to check out and reconcile against. It is run by Master at
acceptance. This is the same deliberate choice as `review-findings-transfer.md`: the cheap
mechanical part (a number anybody can be shown, a test that proves the red) carries most of the
effect, and a CI parser would be checking the shape of a local file rather than the thing that
matters. Reconsider if the ledger ever becomes something agents ship with their reports.

## What stays procedural, and why

Three of the four moves in "Break the silence" cannot be gated and are not pretended to be:

- **Announcing a long step before taking it** — a hook cannot tell an announcement from any other
  output, and the only honest test of it is a transcript.
- **Backgrounding a long command** — `pre:bash:unbounded-wait` already refuses the _polling_ half,
  but "is this foreground call going to take four minutes" is a judgment about an unrun command.
  Cut 4 is the proof that getting this right is not even sufficient.
- **Windowed reads** — a whole-file read is legitimate often enough that gating it would train
  people to route around the gate (the false-positive budget argued in
  `pre-agent-dispatch-isolation.sh`).

What is now mechanical is the one thing whose failure is unbounded (losing the stretch outright) and
the one thing that was invisible (how long the silence actually was). The rest is procedure with a
number attached to it, which is more than it had.

## Sources

- The 2026-10-17 session: seven cuts, four distinct silent stretches, cure applied by hand in each
  subsequent dispatch brief.
- The 2026-10-20 session: five cuts, one feature; PRs #1056 / #1058, branch
  `devops/host-key-pin-canary` (seven `wip:` pushes rebuilding a 231-line file lost as one compose).
- `.claude/RULES.md` §0 — a `paths:`-less rule file is injected into every request of every session
  and every subagent. This is the fact that rules the delivery explanation out.
- `.claude/skills/dev-flow-resilience/SKILL.md` §C1 — the watchdog-asymmetry analysis and the origin
  of the chunking cadence (`docs/architecture/2026-05-23-dev-flow-rca.md`).
- `.claude/skills/writing-for-agents/SKILL.md` — the pointer-vs-inline test and "one meaning, one
  place", both applied above.

## Why there is also a report line

`Pushed: <branch> @ <sha>` is the suspenders to the hook's belt, and it is there for cut 5
specifically. The hook stops firing the moment one commit exists, which is correct for its own
predicate (the worktree is no longer auto-removable) and insufficient for the rule's claim (the work
is not yet outside the worktree). Nothing mechanical closes that last step: a hook cannot usefully
demand a push, because the moment to push is a judgment about what comes next, and gating `git
commit` on a subsequent `git push` would block the honest intermediate state.

So it is handled the way `agent-isolation.md` handles the same class of problem — rule 7 there has
no mechanic either, and is made observable by a mandatory report line. An assertion Master checks in
one command (`git ls-remote origin <branch>`) beats an inference, and a missing line is treated as a
missing verdict rather than as a silence to interpret.
