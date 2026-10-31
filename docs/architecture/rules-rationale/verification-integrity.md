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

**(1) A dependency install believed on its exit status alone.** As originally diagnosed — and
repeated in several briefs — a frozen-lockfile install under a Node older than the repository's
`engines` range printed an unsupported-engine warning, linked **no** binaries, and **exited 0**, with
the next command failing obscurely far from the cause.

**That diagnosis is wrong, and this file is the wrong place to keep repeating it.** Re-run
deliberately in a fresh worktree under the older Node, the install **exited 0, linked its binaries
correctly** (workspace-root and per-package binary directories both populated) and **printed no
unsupported-engine warning at all**. So the Node major version alone does not produce this failure,
and **the real trigger is unidentified.**

What _is_ documented and measured about that Node on this repository is a **different** failure, and
it is the lead worth following rather than guessing: the shared `ensure_node` helper's header records
that on the older Node the compiled i18n catalog is loaded through a `require` of a `.ts` file, which
only works with the newer Node's built-in type stripping — so specs fail with "Cannot use import
statement outside a module", which is nothing like an unlinked binary. The same header records a
second hazard that **is** squarely this class: the task-runner's cache key **does not include the
Node version**, so a suite that passed under the correct Node replays as a cache hit under the wrong
one — measured, identical hash. A green from a cache replay, with nothing verified. — _Shape B._

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

**Two checks catch it, and the earlier one is the better one.** `git diff --cached --name-only`
lists the sibling's file while it is still only staged — before it becomes a commit, and one
`--amend` cheaper than finding it afterwards. `git show --stat HEAD` on your own commit is the
assertion that the claim is true once it is made. Use the first to prevent, the second to assert;
both read a file list rather than the list you intended. This is shape (B) applied
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

## 3. The instruments that drew the line themselves

The mutation gate saw the mutation runner exit 0 having produced no report, and refused rather than
inferring a pass — saying, in substance, _the run did not complete, so nothing was verified._

**It is not the only one, and the earlier claim that it was is withdrawn:** the shared `ensure_node`
helper refuses rather than falling back to the wrong Node, on the explicit grounds that a loud
refusal is an acceptable failure mode while **a green gate on the wrong runtime is not**. Two
instruments, same line.

It is the model for the whole rule, and the reason is worth stating: it did not test for a known
failure mode. It tested for **the presence of the thing that constitutes a result**, and treated its
absence as "unknown", never as "fine". That is a check that cannot be outrun by a new failure mode,
because it does not enumerate failure modes. Compare `mutation-gate-integration-specs.md`, which
already records the related ordering — _not executed at all_ is more serious than _executed and not
caught_.

## 4. The device the project already owned, unnamed

`stream-watchdog.md` requires the report line `Pushed: <branch> @ <sha>` — an agent's claim that its
work is outside its worktree, **checkable by the reader in one command**. That is this rule's device
exactly, and **instance 2 is precisely the defect it exists to make visible**: a push reported as
succeeded whose remote ref had not moved. So the generalisation — _state the artifact, not the
outcome_ — was not invented here; it was extracted from a place that already had it.

**A cousin, not the same device** (narrowed after review): the `Findings: … (N)` control line in
`review-findings-transfer.md` reconciles a **count across a handoff**, not an artifact against an
exit status. Nothing there is claiming success on a status it never read. It belongs in the same
family only in the weaker sense that both make a reader able to **check instead of believe** —
observability by arithmetic rather than by attentiveness — and the earlier claim that it was a second
instance of this rule's device was a stretch.

---

## 5. The gate for (A): rejected, then BUILT when the rejection's measurement did not reproduce

This section is the most important one in the file, because the conclusion **reversed**, and it
reversed for the exact reason the rule exists.

### The predicate

A command that **discards stderr _and_ pipes into a counter**. That is the mechanism of instances 5
and 6, and it is structurally decidable: the shared command analyzer already answers "what is in
command position" and where redirections sit, so this is not a text match. That distinction is the
one that mattered in the six-round history of the launcher-gate narrowing, which converged by
**inverting a denylist into an allowlist** after four false positives in a single day — a markdown
heredoc, a pull-request body, a Python heredoc, and a read-only dependency query.

### The first measurement, and why it was wrong

The gate was first **rejected** on the finding that the conjunction occurred **exactly once** in the
repository, legitimately. Two errors produced that number, and both are this very defect:

1. the consumer pattern required the `grep` flag cluster to **end** in `c` or `q`, so `grep -qE` —
   an extremely common form — never matched;
2. the counter list enumerated `wc -l` and **omitted `wc -w`**.

A miscounting counter, inside the analysis of miscounting counters. The lesson is not "be careful
with regexes": it is that **a population of one should have been treated as a suspiciously small
number and checked, rather than as a licence to conclude.**

### The corrected measurement — re-runnable, which the first one was not

Recorded so anyone can re-run it and see where a disagreement comes from. **The scope is stated
because the first write-up of this said "this repository's scripts" while only three directories had
been measured** — a scope claim wider than the measurement is the same defect as a count wider than
the read.

Measured at `origin/main` = `46085e3713d38a9038cf91d127036327a9f789d4`.

**(a) Strict conjunction, in `scripts/` + `.github/` + `.claude/hooks/` — 2 occurrences:**

```
grep -rnE '2>[[:space:]]*/dev/null[^|]*\|([^|]*\|)*[[:space:]]*(grep[[:space:]][^|]*-[a-zA-Z]*[cq]|wc[[:space:]]+-[lwc])' \
  --include='*.sh' --include='*.mjs' --include='*.yml' --include='*.py' scripts .github .claude/hooks
```

- A readiness probe that scans a port for a host key until a service answers — **legitimate**, and
  the producer is _expected_ to fail while the service boots.
- A parent count in our **own** push gate, from a `git log` whose stderr is discarded and whose
  output is fed to `wc -w` — **a latent defect of exactly this class, in a guard.** Its consequence
  was conservative (a failed read counted as zero parents and fell through to the block, the safe
  direction for a push gate), so it was never a bypass — but conservative _by accident_, and an
  inverted condition later would have turned the same silence into an allow. Fixed in this change by
  consuming the read's exit status instead of inferring it from the count.

**(b) Strict conjunction, repository-wide — 8 raw occurrences**, over every tracked
`*.sh`/`*.mjs`/`*.yml`/`*.py`, which is the honest denominator for a claim about "this repository":

```
git grep -nE '<the same pattern>' 2a3cb489d -- '*.sh' '*.mjs' '*.yml' '*.py'
```

The decomposition matters more than the total, so both readings are given rather than one headline
number:

| Reading                                                                 | Count |
| ----------------------------------------------------------------------- | ----- |
| raw matches of the pattern, repository-wide                             | **8** |
| of those, in the three directories of (a)                               | 2     |
| of those, vendored under `skills/ecc/` **and** matching the reader list | 2     |
| **occurrences this hook would actually report** (producer is a reader)  | **3** |
| occurrences whose producer is `find` — deliberately not a reader        | 4     |

The two vendored ones that match are **not** excusable as out-of-scope: a `jq` over a JSON log piped
to `wc -l`, and a `tail` of a log file piped to `grep -q`. In each, a discarded failure (a missing
file) reads as "no matches". The four `find` producers are not counted, on the same reasoning that
exempts probes: a tree walk that fails partway still returns meaningful output. And the readiness
probe from (a) is not among the 3, because `ssh-keyscan` is not a reader — which is the exemption
working as designed.

**(c) The loose family — 6 occurrences** beyond the strict set: a discarded producer piped into a
_filter_ whose empty output is then read as an answer. **Four of the six are `curl` header checks**,
where a failed request is indistinguishable from a missing header:

```
git grep -nE '2>[[:space:]]*/dev/null[^|]*\|[[:space:]]*grep' 2a3cb489d -- scripts .github .claude/hooks
```

That command returns 7 lines; one is the readiness probe already counted in (a), leaving 6. These are
the same defect with a much larger legitimate population, which is why the hook does not cover them
and why the figures are reported separately rather than merged into one alarming total.

**Why a fixed sha and `git grep` rather than a path-relative `grep`:** the first version of this
section published a command whose output no longer matched its own figure, because the measurement
had been taken before this change added its own test fixtures — and those fixtures contain the shape
on purpose. A number that cannot be re-run is the thing this whole rule is against, so the commands
are pinned to the pre-change tree.

### What this does to the rejection

**Both legs of it are gone.**

- "The population is one, and legitimate" was an artifact of a broken predicate. Corrected, the
  population includes a live instance in our own guard, and the owner's original claim — that this
  pairing is almost never anything but a swallowed failure read as a fact — is **supported** by the
  corpus, not falsified by it.
- "`stream-watchdog.md` prescribes this shape" is **false and withdrawn.** That file prescribes
  `curl --max-time 5` and `gh pr checks`; neither discards stderr nor pipes into a matcher. The
  bridge from "bounded probe" to "discard piped into a quiet matcher" was **my inference presented
  as that file's prescription**, which is precisely the move this rule forbids. The readiness-probe
  concern is real, but it rests on the corpus occurrence above, not on a citation.

### The first build shipped the defect it was closing

Worth recording, because it is the sharpest instance in the whole file and it happened **after** all
eight were written down. The hook was built, tested, and green — writing its note to **stderr**. For
a PreToolUse hook that exits 0, stderr does not reach the model; the model-visible channel is
`hookSpecificOutput.additionalContext` on stdout. So the advisory was **an instrument reporting into
a channel nobody reads**, and its test asserted that the note had been _written_, not that anyone
_received_ it — a green test proving the wrong proposition.

Caught in review, not by the test. The fix is the stdout channel, and the pin is a test that parses
the JSON and fails if the note stops arriving: measured, moving the note back to stderr turns all ten
firing cases red.

### So it was built — and it is advisory

`pre:bash:swallowed-failure`, with the two predicates named in the rule. It **never refuses**, and
that is the part of the original reasoning that _did_ survive the correction:

| Gate family                        | Cost of a miss                                        | Cost of a false positive                    |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| `pre:bash:safety`, `live-db-guard` | the owner's database                                  | one minute                                  |
| `pre:bash:unbounded-wait`          | a task alive for a day                                | one minute                                  |
| this one                           | **one wrong answer, recoverable by the next command** | **the credibility of the whole hook layer** |

Where a miss is catastrophic, fail toward refusing. Here the ordering is reversed, and the legitimate
probe population is measured rather than imagined — so a refusal would trade the cheap failure for
the expensive one. The analyzer's own header names that expensive failure exactly: the documented
workaround sits inside the refusal text, two false hits train "prepend and retry", and that reflex
then fires on a real launch. **An advisory has no workaround to learn, so it cannot teach one.**

Service probes (`curl`, `nc`, `ssh-keyscan`, `pg_isready`, `docker ps`) are deliberately **not**
readers, which is what keeps the legitimate corpus case silent. The reader list is an enumeration,
and that is defensible _here_ although the analyzer's header argues the opposite for the launcher
gates, because the direction of failure is reversed: for a refusal, a command left out costs a false
positive and one wrongly left in costs a miss; for an advisory, one left out costs a missed note —
nothing — and one wrongly left in costs **noise**, which is the only thing that can kill an advisory.
So this list fails toward silence on purpose.

### What the hook does not reach

- **Instance 4** (`grep -c` terminating an `&&` chain) — not covered, and not coverable by refusal:
  a quiet matcher in an `&&` chain is _the_ canonical shell idiom, so almost every hit would be a
  false positive.
- **Instance 7** (a terminating condition true before the work exists) — not a shell shape at all;
  it lives inside a helper, and the command line that invokes it says nothing.
- **Script interiors** — and this is the big one. `bash scripts/foo.sh` is one segment; the shape
  inside is invisible. **Every strict-conjunction occurrence measured above lives in an authored
  script, not in an ad-hoc command.** So the corpus that justifies the predicate is a population the
  hook cannot see, and the population the hook _does_ see — ad-hoc verification commands, which is
  what instances 5 and 6 were — is **not sampled anywhere.** The instrument for the authored-script
  half is a static scanner, not this hook; see section 8.

## 6. The gate for (B): still rejected, and this time the measurement held

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

- **Instance 1's actual trigger** is unidentified — see section 2, and the `ensure_node` lead named
  there.
- **Instance 7's class** — a helper whose terminating condition is satisfied by the "not started"
  state — has no mechanical answer here and is covered only by the rule's "existence before
  absence".
- **The ad-hoc population of the (A) shape is unsampled.** The hook's whole target population is
  commands typed into a tool call, and nothing measures how often the shape there is a swallowed
  failure versus a probe. The advisory form is what makes that acceptable: it costs a line of text
  to be wrong.
- ~~The mechanism of instance 6 was not reproduced.~~ **Withdrawn — it reproduces.** From a plain
  Bash call, `$REV:apps/x.ts` expanded to `<cwd>/HEADpps/x.ts`: zsh consumed `:a` as the
  absolute-path modifier and glued the remainder onto a path that names nothing. Double-quoting the
  whole word changed nothing; `${REV}` fixed it. The enabling fact was measured too — **the
  harness's Bash tool runs zsh here** (`$0` is `/bin/zsh`, `BASH_VERSION` unset) — so zsh's word
  rules govern every command any agent sends. This stopped being anyone's recollection and became a
  reproducible measurement.

## 8. When to reconsider

The decisions here are contingent on measurements, so they should be revisited if any of these
change.

1. **A static scanner over authored scripts.** This is the instrument the corrected measurement
   actually justifies and the one gap that is both real and unaddressed: every measured occurrence
   lives in a committed script, where no hook can see it. A scanner has a measurable population, no
   interactive false-positive cost, and a natural negative control (red on the parent-count shape,
   green once it consumes the read's status). It is not in this change because the zone places such
   a check and its test on either side of a boundary — see item 4 — not because it was judged
   unnecessary.
2. **Measure the ad-hoc population after the fact.** Counting the shape from transcripts — the way
   stream silence is measured after the fact rather than prevented — would replace the one guess
   left in this design with a number, and a measurement carries none of a gate's false-positive
   cost.
3. **Instance 8 wants a gate, and the argument for it is already made.** A commit about to be made
   on a branch whose ref has moved beneath this worktree is decidable **before** the command, needs
   no not-yet-existing artifact, and is the one cost in this class that is **not cheaply
   recoverable** — another agent's work reverted. So the asymmetry in section 5 may genuinely come
   out the other way here, and a refusal may be right where it is wrong elsewhere.

   Two things must be fixed before building it, and the previous edition of this item got both
   wrong. **It should not wait for a recurrence** — "wait and see" contradicts the
   not-cheaply-recoverable cost that is the whole reason to consider refusing, and is the same
   mistake as treating a population of one as a conclusion. And **the baseline must be named**: "the
   ref moved" is only decidable against something, and the usable pair is **this worktree's own HEAD
   reflog versus the branch reflog** — the branch ref records the sibling's move while the
   per-worktree HEAD does not, which is exactly the asymmetry that made the incident silent.
   The claim that its false-positive population is small is **unmeasured**, and must be measured
   before the gate blocks rather than advises.

4. **The zone boundary around a hook's test.** A `post:bash:*` artifact check, and the scanner in
   item 1, need a test at a path derived from the thing's own name, which falls outside the
   Architect zone as written (`test-pre-*`). That is a process question, not a technical one, and it
   is recorded rather than routed around.

## 9. Sources

- **Instances 1-7:** the owner's report of 2026-10-21, following the seventh in one day.
  **Instance 8:** the owner's report later the same day. Each instance's "what it actually did" is a
  measurement, not a reconstruction — except instance 1, whose original diagnosis is corrected in
  section 2 by a re-run.
- **The (A) measurement:** the command, the file globs and the `origin/main` sha are written out in
  section 5 so the number can be re-run and disagreements located. The first, wrong measurement is
  recorded there too, with the two errors that produced it.
- **The (B) falsification:** a frozen-lockfile install executed in a fresh worktree under the older
  Node, with the binary directories inspected afterwards.
- **The zsh reproduction and the shell fact:** a plain Bash call in this session; the observed
  mangling is quoted in section 7.
- **The false-positive budget and the denylist→allowlist lesson:** the shared command analyzer's
  header and the six-round history of the pull request that narrowed the launcher gates.
- **The devices being generalised:** the mutation gate's refusal on a report-less exit 0; the
  `ensure_node` helper's refusal to fall back to the wrong runtime; the `Pushed:` line in
  `stream-watchdog.md`.
- **The review that reopened the gate decision:** code review of this change, findings CR-H-1
  (the measurement did not reproduce), CR-H-2 (the withdrawn prescription claim) and CR-H-3 (the
  instance-1 contradiction).

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

Eight instances in one day, across agents and the orchestrator alike. They are not eight bugs. They
are two shapes, and the shapes need different answers:


---

**Two instruments in this repo already draw the line**, and they are the model for both halves. The
mutation gate saw Stryker exit 0 having written no report and refused, saying so in as many words:
_the run did not complete, so nothing was verified._ It did not infer a pass from a zero. And
`ensure-node.sh` refuses outright rather than falling back to the wrong Node, on the stated grounds
that a loud refusal is an acceptable failure mode while **a green gate on the wrong runtime is not**.
Everything below is that line, generalised.


---

The last row is the one people skip, because a claim about your own diff feels like a memory rather
than a measurement. It is a measurement. **The index is a whole-tree snapshot, not a diff against
HEAD**, so a commit can carry stale copies of files you never staged in this session — and on a
branch ref shared with another worktree, that silently reverts someone else's work. `git add` by
explicit name is necessary and **not sufficient**.

**Check the staged set before you commit, not only the commit afterwards.**
`git diff --cached --name-only` already lists the sibling's file while it is still only staged, which
is one step earlier and one `--amend` cheaper than discovering it in `git show --stat HEAD`. Use the
first to prevent and the second to assert. Fetching first does not help either: a sibling's commit
reached through the shared local ref is already an ancestor, so nothing is behind-upstream.


---

**The project already owns this device**, unnamed, in the `Pushed: <branch> @ <sha>` line required by
`stream-watchdog.md`: a claim about a push, replaced by **an assertion checkable in one command**.
(The `Findings: … (N)` line in `review-findings-transfer.md` is a cousin rather than the same thing —
it reconciles a _count_ across a handoff, not an artifact against an exit status — but it is the same
instinct: make the reader able to check instead of believe.) That is the generalisation, and it is
the whole of (B):

> **State the artifact, not the outcome.** A sentence a reader can check in one command beats a
> sentence they have to believe.


---

**Measured:** the Bash tool's shell in this environment is **zsh** (`$0` is `/bin/zsh`, and
`BASH_VERSION` is unset). So zsh's word rules apply to every command any agent sends, whatever the
command text looks like.

> **Write `${VAR}:path`, never `$VAR:path`.** After a bare `$VAR`, zsh reads what follows the colon
> as a modifier of the expansion and mangles the word into something that does not name what you
> meant. **Quoting does not help; braces do.**

**Reproduced**, from a plain Bash call: `$REV:apps/x.ts` expanded to
`<cwd>/HEADpps/x.ts` — the `:a` was consumed as the "absolute path" modifier and the surviving text
was glued to a path that exists nowhere. Double-quoting the whole word changed nothing; `${REV}`
fixed it.

With form 1 that is the complete failure: the mangled argument names a nonexistent object, the error
goes to the discarded channel, the counter prints `0`, and the `0` is reported as a fact about the
code. A sibling already lives in `light-track.md` — `kill $VAR` does not word-split in zsh, and the
resulting failure is itself masked by `2>/dev/null`. Same family, same cure: brace the expansion, and
do not throw away the error.

---


---

Form 1 and the zsh trap **are** mechanised, because the first attempt to reject a gate here rested on
a measurement that was itself an instance of this class (a regex whose flag-cluster pattern never
matched `grep -qE`, and which enumerated `wc -l` while missing `wc -w`). Corrected, the conjunction
occurs **twice in `scripts/`, `.github/` and `.claude/hooks/`** — and **8 times repository-wide**, of which
**3 are shapes this hook would actually report** (two of them vendored under `skills/ecc/`). One of the two in the
first set was a latent defect of exactly this shape in one of our own guards. Both commands and both
figures are in the rationale, so the numbers can be re-run.


---

**It is advisory by decision, not by weakness.** Service probes (`curl`, `nc`, `ssh-keyscan`,
`pg_isready`) are deliberately not readers, because a probe's producer is _expected_ to fail — that
is the one legitimate occurrence of this shape in the repo, and refusing it would trade a cheap,
recoverable miss for the credibility of the whole hook layer. Form 2, form 3, and the shape inside
an authored script are **not** covered; the rationale says why and what would cover them.

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

   The earlier half of the chain had already taken effect, which is what makes this one dangerous
   rather than merely confusing. (`wc -l` is **not** like this — it exits 0 on empty input. The
   hazard there is the `0` itself, form 1, not the status.)

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

- `.claude/rules/common/stream-watchdog.md` — the `Pushed: <branch> @ <sha>` line: this device, applied to durability.
- `.claude/rules/common/review-findings-transfer.md` — the `Findings: … (N)` control line: this device, applied to a channel.
