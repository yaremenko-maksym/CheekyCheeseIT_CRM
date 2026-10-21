# Rationale: verification-integrity

> Rule: `.claude/rules/common/verification-integrity.md`
> Written 2026-10-21, after the owner asked for the class to be closed following the seventh instance (an eighth arrived the same day and is recorded below)
> in one day.

This file exists because the next person to meet one of these will otherwise reinvent the analysis
from one instance and patch that instance. The eight below are **one class with two shapes**, and the
two shapes want different answers. Per `doc-durability.md` they are recorded as **behaviour** — what
the instrument did, and what made it wrong — not as coordinates.

---

## 1. The class

> An instrument reported a negative or a success when it had not actually looked, and nothing
> distinguished "clean" from "did not run".

What makes it a class rather than eight bugs: in every instance the **consumer of the result was
correct given its input**. Nothing malfunctioned. A counter that is handed an empty input correctly
reports zero; a chain that receives exit 0 correctly proceeds. The defect is that the input was
empty, or the status was from elsewhere, **for a reason the consumer could not see** — and no
instrument in the path was obliged to say so.

---

## 2. The eight instances, as measured facts

Numbered as the owner reported them, so the numbering can be cited.

**(1) A dependency install that exits 0 having linked nothing.** Run with a Node older than the
range the repository's `engines` field requires, the package manager printed an unsupported-engine
warning, linked **no** binaries, and **exited 0**. The caller believed the status; the next command
failed obscurely, far from the cause. Caught only by checking that the binary directory had been
populated. — _Shape B._

**(2) A push reported as succeeded that never reached the remote.** An agent reported a zero exit for
a push while the remote ref still pointed at the old commit. The zero came from a different command
in the same compound. **A zero from the wrong command is indistinguishable from success.** — _Shape B._

**(3) A commit that was never created inside an `&&` chain that continued.** A commit reading its
message from standard input, fed by a heredoc inside an `&&` chain: the chain ran on, no commit was
created, and the log still showed the previous head. Caught only by comparing the branch against its
remote. — _Shape B._

**(4) A counter's non-zero exit silently terminating an `&&` chain.** A counter asked for a pattern
that was absent **exits non-zero**. Inside an `&&` chain that ended the chain: the write earlier in
the chain had already landed, the verification step after it never ran, and **the absence of output
read as "nothing to report"**. The dangerous part is the asymmetry — the effect happened, the check
did not. — _Shape A._

**(5) A counter fed an empty input by a producer whose error was discarded.** A read of one named
object at a revision, with stderr sent to `/dev/null`, piped into a counter. The path was wrong; the
error went to the discarded channel; the counter counted an empty input and printed `0`. Read as
**"the symbol is absent"** when the truth was **"the file was never read"**. — _Shape A._

**(6) The same shape, caused by zsh consuming a colon as a modifier.** The revision was passed as a
bare `$VAR` immediately followed by `:` and a path. zsh read what followed the colon as a modifier of
the expansion, mangling the word into a revision/path that does not exist. Error to the discarded
channel, empty stdout, counter printed `0`. **Quoting did not help; `${VAR}` did.** Two consecutive
verifications were wrong this way before the third produced facts. — _Shape A._

**(7) A wait helper that reported success before the work existed.** An agent's own CI-wait helper
reported two checks passing on a pull request **whose checks had not been created yet**, because it
terminated on "nothing pending" — a condition that is also true _before_ anything is scheduled. **A
terminating condition that does not distinguish "not started" from "finished clean" will always fire
at the start.** — _Shape A._

**(8) An agent's claim about its own diff, defeated by a shared branch ref and a whole-tree index.**
Reported after the first seven, the same day. An agent asserted that its five commits "touch only
test files". Two of them also **reverted another agent's work in files it never meant to edit.** The
mechanism is worth recording precisely, because it defeats the obvious guard:

- **A branch ref is shared across worktrees.** A sibling agent committing on the same branch moves
  the ref beneath you, while **your own HEAD reflog stays silent** — nothing in your worktree's own
  history records the move, so there is no local signal to notice.
- **The git index is a whole-tree snapshot, not a diff against HEAD.** So an index populated earlier
  still holds the _old_ copies of files the sibling has since changed. Committing writes those old
  blobs — reverting the sibling — **even though every `git add` named only the intended files.**
  Staging by explicit name is necessary and not sufficient: it controls what you _add_, not what the
  index already carries.
- **Fetching before the push cannot reveal it**, which is the part that makes this one nasty. The
  sibling's commit is already an **ancestor** through the shared local ref, so there is nothing
  behind-upstream to report and no non-fast-forward to refuse. Every remote-side check reads clean.

The check that catches it is **`git show --stat HEAD` on your own commit, before asserting anything
about it** — the commit's own file list, rather than the list you intended. This is shape (B) applied
to a claim about one's own diff: `git add` succeeding is the exit status, and the commit's file list
is the artifact. — _Shape B._

> Recorded as instance 8 because it is the same class, not a git curiosity: the instrument (one's own
> memory of what was staged) reported a negative — "no other files" — having never looked. It also
> sharpens the rule's `git commit` row, which until this instance asked only whether the branch head
> had _moved_. A head that moved is not evidence of _what_ moved with it.

### What the shapes are, and why they split

| Shape                                                                       | Instances  | The mechanism                                                                                           |
| --------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| **(A)** failure on an unread channel, silence consumed as a negative answer | 4, 5, 6, 7 | `producer 2>/dev/null \| counter`; a counter inside `&&`; a terminating condition true before the start |
| **(B)** exit 0 without the artifact                                         | 1, 2, 3, 8 | the status is from the wrong command, or from a command that did not do its job                         |

They split because the **answer** differs. (B) is closed by naming the artifact for each operation —
a positive obligation, decidable only after the fact, and already implemented twice in this
repository (below). (A) is a _shell-shaped_ defect and is the half where a gate is tempting.

---

## 3. The one instrument that drew the line itself

The mutation gate saw the mutation runner exit 0 having produced no report, and refused rather than
inferring a pass — saying, in substance, _the run did not complete, so nothing was verified._

It is the model for the whole rule, and the reason is worth stating: it did not test for a known
failure mode. It tested for **the presence of the thing that constitutes a result**, and treated its
absence as "unknown", never as "fine". That is a check that cannot be outrun by a new failure mode,
because it does not enumerate failure modes. Compare `mutation-gate-integration-specs.md`, which
already records the related ordering — _not executed at all_ is more serious than _executed and not
caught_.

## 4. The device the project already owned, unnamed

Two always-on rules had independently invented the same answer to (B) before this rule named it:

- `stream-watchdog.md` requires the report line `Pushed: <branch> @ <sha>` — an agent's claim that
  its work is outside its worktree, **checkable by the reader in one command**.
- `review-findings-transfer.md` requires the control line `Findings: … (N)` — making a lost finding
  visible by arithmetic instead of attentiveness.

Both replace a claim with an assertion a reader can re-run. Instance 2 is precisely the defect that
the `Pushed:` line exists to make visible. The generalisation — _state the artifact, not the outcome_
— was therefore not invented here; it was extracted from two places that already had it, which is
why it is stated once in the rule and pointed at from both.

---

## 5. The gate designed for (A), and the measurement that rejected it

### The predicate

The narrow conjunction worth considering was: **a command that discards stderr _and_ pipes into a
counter** (a counting or quiet-matching consumer). That pairing is the mechanism of instances 5 and
6, and it is structurally decidable — the shared command analyzer used by the `pre:bash:*` hooks
already answers "what is in command position" and where redirections sit, so this would **not** have
been a text match. That distinction is the one that mattered in the six-round history of the analyzer
change that converged by **inverting a denylist into an allowlist**, after a gate that inspected text
rather than command position produced four false positives on the owner in a single day — a markdown
heredoc, a pull-request body, a Python heredoc, and a read-only dependency query.

So the gate would have been well-formed. It was rejected on frequency and on population.

### The measurement

Searching every shell, Node and workflow script in the repository for the conjunction:

- **exactly one occurrence**, and
- **that occurrence is legitimate**: a readiness probe that scans a port for a host key, discarding
  stderr because the producer is _expected_ to fail while the service comes up, retried inside a
  bounded loop.

A false-positive rate of one out of one on the existing corpus is already decisive, but the stronger
finding is the second one:

> **`stream-watchdog.md` prescribes exactly this shape.** It instructs agents to check long-running
> work with _single bounded probes_ rather than polling loops. A bounded probe is, in practice, a
> producer that may legitimately fail piped into a quiet matcher, with the noise discarded.

A gate for (A) would therefore have refused, quite possibly on its first firing, the form another
always-on rule tells every agent to write. The analyzer's own header states the cost of that
precisely: the documented workaround sits inside the refusal text, so two false hits are enough to
train "prepend the prefix and retry" — **and that reflex then fires on a real launch too. A guard
that cries wolf is a guard that gets routed around.**

### Why the cost asymmetry is inverted here

This is the load-bearing judgment, and it is the reason the conclusion differs from the hooks that
justify all this machinery.

| Gate family                        | Cost of a miss                                        | Cost of a false positive                          |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| `pre:bash:safety`, `live-db-guard` | the owner's database                                  | one minute                                        |
| `pre:bash:unbounded-wait`          | a task alive for a day                                | one minute                                        |
| a verification-integrity gate      | **one wrong answer, recoverable by the next command** | **erosion of the whole hook layer's credibility** |

Where a miss is catastrophic and a false positive is a minute, fail toward refusing — that is the
documented trade for the safety hooks, correctly. Here the ordering is reversed: nothing
irreversible is being prevented, and the expensive failure is the false positive. **A gate whose
misses are cheap and whose false positives are expensive should not be a gate.**

Instance 4 reinforces this independently and would have escaped the conjunction anyway: it discarded
nothing. Its shape is a counter in a non-terminal position of an `&&` chain — and a quiet matcher in
an `&&` chain is _the_ canonical shell idiom (`grep -q X f && echo found`). Any gate over that shape
would be almost entirely false positives. Instance 7 is not a shell shape at all: a helper's
terminating condition cannot be judged from the command line that invokes it.

So of the four (A) instances, a well-formed gate reaches two, at the price of refusing a prescribed
idiom.

## 6. The gate designed for (B), and the measurement that falsified it

(B) resists a `PreToolUse` gate by construction: **the artifact does not exist yet** at the moment
the command is inspected, and the artifact differs per operation. A `PostToolUse` check could see it,
but each operation needs its own artifact, and the meta-guard requires a test at a path derived from
the hook's own name — placing a `post-*` hook's test outside the Architect's zone, which is a
process signal worth noting rather than routing around.

One candidate was locally decidable and promising: **refuse a dependency install when the running
Node cannot satisfy the repository's declared engine range**, which is instance 1's cause. The
environment supported the case strongly — the default `node` on the owner's machine does **not**
satisfy the repository's range, while a satisfying version is installed alongside it, so every fresh
worktree starts one bare install away from instance 1.

**It was falsified by running it.** A frozen-lockfile install in a fresh worktree under the older
Node:

- **exited 0**, as expected, and
- **linked its binaries correctly** — the workspace-root binary directory was populated with the
  expected tools, and the per-package directories likewise — and
- **printed no unsupported-engine warning at all.**

The install simply worked. So the gate would have refused a demonstrably working command, on the very
evidence assembled to justify it. The predicate "an install under a non-conforming Node produces no
artifact" is **false in this environment**, and instance 1 was therefore caused by something narrower
than the Node major version alone — not reproduced here, and not guessed at.

This is recorded at length deliberately: the candidate was mine, the measurement killed it, and a
rule file that presented the surviving design without the rejected one would be making exactly the
kind of unfalsifiable claim this class is about.

---

## 7. What was not established, and stays open

- **The mechanism of instance 6 was not reproduced.** The agent-isolation hook refuses any `zsh`
  invocation to a worktree-isolated agent (it cannot prove the shell text will not run git), so the
  expansion could not be exercised directly from this session. What **was** measured is the fact that
  makes the gotcha apply at all: **the Bash tool's shell in this environment is zsh**, not bash — its
  `$0` is `/bin/zsh` and `BASH_VERSION` is unset. The cure in the rule (`${VAR}:path`) is correct
  regardless of which zsh word rule produced the mangling, and is stated as the owner's measurement
  rather than as a mechanism proven here. An earlier edition of the shared analyzer's header once
  claimed a property that a large fuzz run disproved; describing an unverified mechanism as a proof is
  the very defect this class is about, so the gap is named instead of smoothed over.
- **Instance 1's actual trigger** is unexplained, per section 6.
- **Instance 7's class** — a helper whose terminating condition is satisfied by the "not started"
  state — has no mechanical answer here and is covered only by the rule's "existence before absence".

## 8. When to reconsider a gate

The decision above is contingent on measurements, so it should be revisited if any of these change:

1. **The (A) conjunction starts appearing in transcripts as a wrong verification more than a couple of
   times a month.** The corpus measured here is the repository's committed scripts; the population
   that actually matters is what agents type ad hoc, and it is not sampled anywhere today. A cheap
   first step is counting it after the fact from transcripts, the way
   `scripts/devops/check-stream-silence.sh` measures silence after the fact rather than preventing it
   — a measurement is not a gate and carries none of a gate's false-positive cost.
2. **`stream-watchdog.md` stops prescribing bounded probes in the discard-and-match form**, which
   would remove the main legitimate population.
3. **Instance 1 is reproduced** with an identified trigger that is decidable before the command runs.
   Then a gate for that specific trigger is justified, and this time with the artifact measured on
   both sides first.
4. **Instance 8 recurs.** Unlike the two candidates measured down, this one has a predicate that is
   decidable _before_ the command and needs no artifact that does not exist yet: when a commit is
   about to be made on a branch whose ref has moved since this worktree last observed it, say so.
   The shared-ref condition is a fact a hook can read, the false-positive population looks small
   (a deliberate commit onto a sibling's advanced ref is rare and the message would be advisory, not
   a refusal), and the cost of the miss here is **another agent's work reverted** — which is the one
   cost in this whole class that is not cheaply recoverable, and therefore the one place where the
   asymmetry argument in section 5 might come out the other way. Not built here: it arrived after the
   design was measured, and a gate deserves its own measurement rather than a rider on this one.
5. **A `post:bash:*` artifact check becomes cheap to own** — which first requires settling whether a
   `post-*` hook's test may live where the test runner already sweeps, given the Architect zone is
   written in terms of `test-pre-*`.

## 9. Sources

- Instances 1-7: the owner's report of 2026-10-21, following the seventh in one day. Instance 8: the
  owner's report later the same day. Each one's
  "what it actually did" is the owner's measurement, not a reconstruction.
- The one-occurrence measurement of the (A) conjunction: a search of every `.sh`, `.mjs` and `.yml`
  under the repository's script, workflow and hook directories, run on `origin/main` at the time of
  writing.
- The falsification of the (B) install gate: a frozen-lockfile install executed in this worktree under
  the older Node, with the binary directories inspected afterwards.
- The shell fact: `$0` and `BASH_VERSION` read from a Bash tool call in this session.
- The false-positive budget and the denylist→allowlist lesson: the shared command analyzer's header
  and the six-round history of the pull request that narrowed the launcher gates.
- The device being generalised: the mutation gate's refusal on a report-less exit 0; the `Pushed:` line
  in `stream-watchdog.md`; the `Findings: … (N)` line in `review-findings-transfer.md`.
