# Rule: An instrument that did not look reports nothing, not a negative

**Status:** Always-on (procedural — deliberately **no gate**; two candidate gates were built to a
predicate and then measured down, see the rationale)
**Applies to:** every agent and the orchestrator — anyone who reads a command's result and acts on it.
This is the one rule that binds the reader of an output, not the writer of a file.

> Rationale, the seven instances of 2026-10-21 as measured facts, and the measurements that killed
> both candidate gates: `docs/architecture/rules-rationale/verification-integrity.md`

---

## The defect, in one sentence

> **An instrument reported a negative or a success when it had not actually looked, and nothing
> distinguished "clean" from "did not run".**

Eight instances in one day, across agents and the orchestrator alike. They are not eight bugs. They
are two shapes, and the shapes need different answers:

| Shape                                     | What it looks like                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| **(A) silence read as a negative answer** | the failure went to a channel nobody read, and the consumer reported the absence as a finding |
| **(B) exit 0 without the artifact**       | the status said success; the thing that was supposed to exist does not                        |

**The one instrument that got it right** is the model for both halves. The mutation gate saw Stryker
exit 0 having written no report and refused, saying so in as many words: _the run did not complete,
so nothing was verified._ It did not infer a pass from a zero. It is the only tool in the repo that
drew that line itself, and everything below is that line, generalised.

---

## (B) Verify the artifact, never the exit status

**An exit code is a claim. An artifact is a fact.** For every operation whose success you are about
to rely on, there is a thing that exists afterwards, and checking it costs one command.

| Operation             | The claim being made            | The artifact that settles it                                                           |
| --------------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| dependency install    | "the dependencies are there"    | `node_modules/.bin` is populated — and the tool you actually need answers `--version`  |
| `git push`            | "it is on origin"               | `git ls-remote origin <branch>` shows the sha you meant to push                        |
| `git commit`          | "the commit exists"             | the branch head moved — the new head is not the one you started from                   |
| a generated file      | "the file is generated"         | the file **contains the declaration** you need, not merely that the path exists        |
| a test / mutation run | "it passed"                     | the report exists and names a number of cases. Exit 0 with no report is not a pass     |
| a CI check            | "the checks pass"               | the checks **exist** first — a count — and only then their conclusions                 |
| **your own commit**   | "it touches only _these_ files" | `git show --stat HEAD` — the commit's **own** file list, never what you meant to stage |

The last row is the one people skip, because a claim about your own diff feels like a memory rather
than a measurement. It is a measurement. **The index is a whole-tree snapshot, not a diff against
HEAD**, so a commit can carry stale copies of files you never staged in this session — and on a
branch ref shared with another worktree, that silently reverts someone else's work. `git add` by
explicit name is necessary and **not sufficient**: the file list of the finished commit is the only
artifact. Fetching first does not help, because a sibling's commit reached through the shared local
ref is already an ancestor.

**The project already owns this device, twice, without naming it:** the `Pushed: <branch> @ <sha>`
line required by `stream-watchdog.md`, and the `Findings: … (N)` control line required by
`review-findings-transfer.md`. Both replace a claim with **an assertion checkable in one command**.
That is the generalisation, and it is the whole of (B):

> **State the artifact, not the outcome.** A sentence a reader can check in one command beats a
> sentence they have to believe.

### The exit status of a compound belongs to its last command

A variable named after one command but assigned `$?` after another is not a mistake in reasoning, it
is a false statement in the transcript — and it reads exactly like success. Capture a status
immediately after the command it belongs to, or skip the status and assert the artifact.

The same applies to a status you never looked at. A command in the middle of an `&&` chain, or
upstream in a pipeline, can fail while the chain's own exit code is 0.

---

## (A) Never discard the channel you would learn from

Three forms. In all three the failure went somewhere nobody read, and the consumer turned that
silence into a positive finding.

1. **`producer 2>/dev/null | counter`.** The producer's error went to the discarded channel; the
   counter counted an empty input and printed `0`. **`0` means both "nothing matched" and "nothing
   was read", and the two are not distinguishable at the consumer.** Read as "the symbol is absent"
   when the truth was "the file was never opened".
2. **A counter inside an `&&` chain.** A counter that finds nothing **exits non-zero** — so it
   terminates the chain, everything after it silently does not run, and the absence of output reads
   as "nothing to report". The earlier half of the chain had already taken effect, which is what
   makes this one dangerous rather than merely confusing.
3. **A terminating condition that is also true before the thing starts.** "Nothing is pending" is
   true of a job whose steps have not been created yet. A wait that ends on an absence will end
   immediately, and report the empty state as a result.

**The correct forms, each one cheap:**

- During a verification, **do not discard stderr at all.** It is the channel that would have told
  you. If the noise is genuinely unwanted, read the producer's output into a variable, confirm it is
  non-empty, and count afterwards.
- Put a counter **last**, or use its _output_ rather than its _status_ (`n=$(… | grep -c X || true)`).
  A counter is a measurement, never a link in a chain of preconditions.
- For "has it finished", **assert that it started** before you accept that it is not running.
  Existence before absence, always.

### The zsh gotcha that produces a confident `0`

**Measured:** the Bash tool's shell in this environment is **zsh** (`$0` is `/bin/zsh`, and
`BASH_VERSION` is unset). So zsh's word rules apply to every command any agent sends, whatever the
command text looks like.

> **Write `${VAR}:path`, never `$VAR:path`.** After a bare `$VAR`, zsh reads what follows the colon
> as a modifier of the expansion and mangles the word into something that does not name what you
> meant. **Quoting does not help; braces do.**

With form 1 that is the complete failure: the mangled argument names a nonexistent object, the error
goes to the discarded channel, the counter prints `0`, and the `0` is reported as a fact about the
code. A sibling already lives in `light-track.md` — `kill $VAR` does not word-split in zsh, and the
resulting failure is itself masked by `2>/dev/null`. Same family, same cure: brace the expansion, and
do not throw away the error.

---

## How we know it is violated

No gate (see below). The observability is the same arithmetic the project already uses elsewhere: an
assertion is present and checkable, or it is missing.

| What is reconciled                                                                               | Who                            |
| ------------------------------------------------------------------------------------------------ | ------------------------------ |
| A verification claim in a report has the asserting command beside it, and a reader can re-run it | Master at acceptance           |
| An artifact claim cites the artifact, not an exit code — "exit 0" is never the evidence          | Master at acceptance; reviewer |
| `2>/dev/null` does not appear in a command whose output is being used as evidence                | the author, before sending     |
| A number offered as proof of an absence comes with proof the input was read                      | reviewer                       |
| A wait that ended on an absence proves the thing had started                                     | the author, before reporting   |

A claim without its assertion is indistinguishable from a claim that was never checked — which is
the defect itself, one level up.

## Why there is no gate

A gate for each half was taken as far as a concrete predicate and **rejected on measurement**: the
(A) conjunction occurs once in all of this repository's scripts and that one occurrence is
legitimate — and `stream-watchdog.md` _prescribes_ the same shape for bounded probes; the (B)
candidate was falsified by running it. Unlike the safety hooks, a miss here costs one recoverable
wrong answer while a false positive costs the credibility of the whole hook layer, so the asymmetry
that justifies `pre:bash:safety` is **inverted**. Numbers, the full argument and the four conditions
under which to reconsider are in the rationale file.

## Related rules

- `.claude/rules/common/stream-watchdog.md` — the `Pushed: <branch> @ <sha>` line: this device, applied to durability.
- `.claude/rules/common/review-findings-transfer.md` — the `Findings: … (N)` control line: this device, applied to a channel.
- `.claude/rules/common/mutation-gate-integration-specs.md` — why "no report" is more serious than "not caught".
- `.claude/rules/common/light-track.md` — `pre:bash:unbounded-wait`, and the zsh `kill $VAR` gotcha masked by `2>/dev/null`.
- `.claude/rules/common/doc-durability.md` — a long-lived record states behaviour and a verification condition.
- `.claude/skills/diagnosing-bugs/SKILL.md` — the adjacent gate: no red command, no hypotheses.
