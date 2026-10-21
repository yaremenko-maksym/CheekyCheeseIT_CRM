# Rule: An instrument that did not look reports nothing, not a negative

**Status:** Always-on. Half of it is mechanised: the **advisory** hook
`pre:bash:swallowed-failure` (never refuses). The rest is procedural — see "How we know it is
violated".
**Applies to:** every agent and the orchestrator — anyone who reads a command's result and acts on it.
This is the one rule that binds the reader of an output, not the writer of a file.

> Rationale, the eight instances of 2026-10-21 as measured facts, and the measurement that reopened
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

**Two instruments in this repo already draw the line**, and they are the model for both halves. The
mutation gate saw Stryker exit 0 having written no report and refused, saying so in as many words:
_the run did not complete, so nothing was verified._ It did not infer a pass from a zero. And
`ensure-node.sh` refuses outright rather than falling back to the wrong Node, on the stated grounds
that a loud refusal is an acceptable failure mode while **a green gate on the wrong runtime is not**.
Everything below is that line, generalised.

---

## (B) Verify the artifact, never the exit status

**An exit code is a claim. An artifact is a fact.** For every operation whose success you are about
to rely on, there is a thing that exists afterwards, and checking it costs one command.

| Operation           | The claim being made            | The artifact that settles it                                                          |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| dependency install  | "the dependencies are there"    | `node_modules/.bin` is populated — and the tool you actually need answers `--version` |
| `git push`          | "it is on origin"               | `git ls-remote origin <branch>` shows the sha you meant to push                       |
| `git commit`        | "the commit exists"             | the branch head moved — the new head is not the one you started from                  |
| a generated file    | "the file is generated"         | `grep <the exported symbol> <file>` — the declaration you need, not merely the path   |
| a unit / E2E run    | "it passed"                     | the reported case count is **non-zero** — "0 passed" and "nothing ran" print alike    |
| a mutation run      | "it passed"                     | the JSON report exists and names a score. Exit 0 with no report is not a pass         |
| a CI check          | "the checks pass"               | `gh pr checks` **lists** checks at all — a count — and only then their conclusions    |
| **your own commit** | "it touches only _these_ files" | `git diff --cached --name-only` **before** committing, `git show --stat HEAD` after   |

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

**The project already owns this device**, unnamed, in the `Pushed: <branch> @ <sha>` line required by
`stream-watchdog.md`: a claim about a push, replaced by **an assertion checkable in one command**.
(The `Findings: … (N)` line in `review-findings-transfer.md` is a cousin rather than the same thing —
it reconciles a _count_ across a handoff, not an artifact against an exit status — but it is the same
instinct: make the reader able to check instead of believe.) That is the generalisation, and it is
the whole of (B):

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
2. **`grep -c` inside an `&&` chain.** `grep` exits non-zero when it matches nothing — **`-c` does
   not change that**, so `grep -c` prints `0` _and_ fails. Inside an `&&` chain that terminates it:
   everything after silently does not run, and the absence of output reads as "nothing to report".
   The earlier half of the chain had already taken effect, which is what makes this one dangerous
   rather than merely confusing. (`wc -l` is **not** like this — it exits 0 on empty input. The
   hazard there is the `0` itself, form 1, not the status.)
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

## How we know it is violated

One shape is mechanised (`pre:bash:swallowed-failure`, above) and it covers form 1 and the zsh trap
in ad-hoc commands only. **Everything else here is procedural**, and the observability is the
arithmetic the project already uses elsewhere: an assertion is present and checkable, or it is
missing.

| What is reconciled                                                                               | Who                            |
| ------------------------------------------------------------------------------------------------ | ------------------------------ |
| A verification claim in a report has the asserting command beside it, and a reader can re-run it | Master at acceptance           |
| An artifact claim cites the artifact, not an exit code — "exit 0" is never the evidence          | Master at acceptance; reviewer |
| `2>/dev/null` does not appear in a command whose output is being used as evidence                | the author, before sending     |
| A number offered as proof of an absence comes with proof the input was read                      | reviewer                       |
| A wait that ended on an absence proves the thing had started                                     | the author, before reporting   |

A claim without its assertion is indistinguishable from a claim that was never checked — which is
the defect itself, one level up.

## The mechanism: `pre:bash:swallowed-failure` (advisory)

Form 1 and the zsh trap **are** mechanised, because the first attempt to reject a gate here rested on
a measurement that was itself an instance of this class (a regex whose flag-cluster pattern never
matched `grep -qE`, and which enumerated `wc -l` while missing `wc -w`). Corrected, the conjunction
occurs **twice in `scripts/`, `.github/` and `.claude/hooks/`** — and **8 times repository-wide**, of which
**3 are shapes this hook would actually report** (two of them vendored under `skills/ecc/`). One of the two in the
first set was a latent defect of exactly this shape in one of our own guards. Both commands and both
figures are in the rationale, so the numbers can be re-run.

`pre:bash:swallowed-failure` prints one note and **never refuses**:

- **SWALLOWED-COUNT** — a named-object read (`git show` / `cat-file` / `log` / `diff`, `cat`, `head`,
  `tail`, `jq`) whose stderr is discarded, piped into a counter (`grep -c`/`-q`, `wc -l`/`-w`/`-c`).
- **ZSH-REVSPEC** — an unbraced `$VAR:` in such a read, reported with or without a discard.

**It is advisory by decision, not by weakness.** Service probes (`curl`, `nc`, `ssh-keyscan`,
`pg_isready`) are deliberately not readers, because a probe's producer is _expected_ to fail — that
is the one legitimate occurrence of this shape in the repo, and refusing it would trade a cheap,
recoverable miss for the credibility of the whole hook layer. Form 2, form 3, and the shape inside
an authored script are **not** covered; the rationale says why and what would cover them.

## Related rules

- `.claude/rules/common/stream-watchdog.md` — the `Pushed: <branch> @ <sha>` line: this device, applied to durability.
- `.claude/rules/common/review-findings-transfer.md` — the `Findings: … (N)` control line: this device, applied to a channel.
- `.claude/rules/common/mutation-gate-integration-specs.md` — why "no report" is more serious than "not caught".
- `.claude/rules/common/light-track.md` — `pre:bash:unbounded-wait`, and the zsh `kill $VAR` gotcha masked by `2>/dev/null`.
- `.claude/rules/common/doc-durability.md` — a long-lived record states behaviour and a verification condition.
- `.claude/skills/diagnosing-bugs/SKILL.md` — the adjacent gate: no red command, no hypotheses.
