# Mutation gate — runbook

`task-mutation-gate`, 2026-08-11. Read this when the gate went red, when the
nightly opened an issue, or before changing anything about either.

## Why it exists

Between 2026-08-07 and 2026-08-08 the same defect was found eight times, each
time in a place that was considered covered: **a check that cannot go red.**
Three of its shapes are invisible to a linter because the syntax is perfect —
an assertion compared against the very constant it should pin, an expected value
derived from the actual one through a ternary, a value compared with itself via a
default substitution. Two more had genuine assertions but read the wrong DOM tree
(a dialog renders through a portal; the test queried `container`).

None of them is visible by reading. All of them were found by breaking the code
and watching whether anything went red. That is what mutation testing automates:
it applies a small change to your source, re-runs the tests, and reports whether
they noticed.

## The three halves

|                | Pre-push hook (`.claude/hooks/pre-bash-mutation-gate.sh`) | PR gate (`ci.yml`, `mutation` job — split out of `quality` 2026-09-03, task-infra-split-mutation-gate, so it runs in parallel instead of adding to `quality`'s wall time; further split into a 3-package matrix the same day, task-infra-mutation-gate-matrix, so the three packages also run in parallel with EACH OTHER instead of sequentially inside one job — `mutation_summary` rolls the three legs back into the single `Mutation Gate` required-check context, same shape as `e2e`/`e2e_summary`) | Nightly (`mutation-nightly.yml`) |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Scope          | same as the PR gate — the LINES this branch changed       | only the LINES this branch changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | whole packages on `main`         |
| Verdict        | BLOCK on a real finding, visible SKIP on anything else    | one survivor → build red                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | inventory → alert issue          |
| Cost           | budget-capped at 120s locally (see the hook's own header) | proportional to the diff (see numbers below)                                                                                                                                                                                                                                                                                                                                                                                                                                                               | up to 5h per package leg         |
| Blocks a merge | no — only slows a `git push` locally                      | yes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | no                               |

The PR gate is affordable because it is line-scoped. It is also blind to
everything written before it existed — that is the nightly's job.

The pre-push hook exists because, before it did, the gate ran by memory: the
same session that built it still went red on it in CI twice, because nothing
ran it before push (`task-mutation-gate-mechanical`, 2026-08-18). It runs the
SAME `--changed` command the PR gate does, but only ever BLOCKS on a real
finding — Stryker missing, `packages/shared` not built, or the gate hitting its
own error path are all a visible `SKIP`, never a silent pass and never a hard
block, because CI remains the actual, unskippable check. See the hook's own
header comment for the full BLOCK/SKIP/PASS decision tree and why each branch
lands where it does.

## Reading a red gate

### `mutant SURVIVED (...)`

Someone can make that change to your code and every test still passes. The
annotation names the file, the line and the replacement.

Fix it by adding an assertion that fails on that replacement. Do NOT "fix" it by
asserting the mutant's shape — assert the behaviour the mutant destroys.

If the mutant genuinely cannot be observed by any test (an _equivalent_ mutant —
this repo has a real one: `img: () => null` mutated to `img: () => undefined`
renders identically in React), suppress that one mutant with a written reason:

```ts
// Stryker disable next-line ArrowFunction: React renders nothing for both null and undefined, so no assertion can distinguish the two
img: () => null,
```

The reason is mandatory and is checked twice — by
`scripts/devops/check-mutation-suppressions.mjs` across the whole repo, and by
the gate itself out of Stryker's report. A file-scoped `// Stryker disable`
(without `next-line`) is always rejected: it silences code nobody has written
yet.

### `mutant NOT VERIFIED (...)` — tool failure, not a surviving mutant (warning)

**What it means:** the test runner executed **zero tests** for this specific
mutant. Stryker's own report says so directly — `testsCompleted: 0` — and that
field is written for every `Survived` mutant regardless of whether the runner
ran the whole suite or nothing at all
(`@stryker-mutator/core`'s `mutation-test-report-helper.js`:
`testsCompleted: result.nrOfTests`). "Completed, no failure" is the ONLY rule
`@stryker-mutator/api`'s own `toMutantRunResult()` applies to decide
`Survived` — it does not ask how many tests ran first. Before this gate read
`testsCompleted`, a mutant nobody actually tested and a mutant real tests
looked at and missed were the same bucket: `Survived`, blocking either way.

**How this is different from a surviving mutant:** a survivor means a test
DID run the mutated line and still passed — real verification happened and
missed something. A tool failure means NO verification happened at all. The
gate now tells them apart per mutant (not per file, not per package — two
mutants on the very same line can land in different buckets, see the "mixed
report" test case in `scripts/devops/tests/test-mutation-gate-reporting.sh`)
and treats them differently: a real survivor still blocks the build exactly as
before; a tool failure is reported loudly — its own report section, `::warning::`
annotations, counted in the per-package table's `tool` column — but **never**
counted toward the exit code.

**Why it does NOT block:** the defect, whatever it is, is in the test
runner's ability to associate a mutant with the tests that cover it — not in
the code that was changed. Blocking a PR over a fact about the CI machine's
tooling, on code that may well be perfectly tested, would train exactly the
kind of learned mistrust ("the gate is just flaky, re-run it") that a mutation
gate exists to prevent for everything else.

**Live reproduction (2026-08-25, this repo, before this fix existed):** a
`@crm/web` diff (task 5/6, cascade edit-preview — `cascade-preview.ts` +
`AdminEditTransactionDialog.tsx`, both with real, passing unit specs) produced
33 mutants, ALL status `Survived`, ALL with `testsCompleted: 0`. Stryker's own
clear-text reporter said as much in plain English — `Ran 0.00 tests per mutant
on average` — and the gate still went red, on code the runner had not
executed a single assertion against. After the fix, the identical run: `killed
0, survived 0, tool-failure 33` — `mutation-gate: PASS`, with the same 33
mutants still listed, now correctly labeled and non-blocking.

**Suspected mechanism, named but deliberately NOT fixed here:** the
`@stryker-mutator/vitest-runner` plugin resolves, per mutant, which test files
to run via Vitest's own `related` (dependency-graph) file selection, pointed
at the SANDBOXED copy of the mutated file
(`vitest-test-runner.js`'s `mutantRun()`: `relatedFiles: [options.sandboxFileName]`).
If that resolution comes back empty for a mutant Stryker's coverage analysis
otherwise believed was covered, `mutantRun()` runs zero tests, `Complete` with
no failure, `Survived`, `testsCompleted: 0` — silently, because the one
warning this runner does emit for that situation
(`"Vitest failed to find test files related to mutated files"`) is logged only
during the DRY run, never during an individual mutant run. **Fixing the
runner's related-file resolution is separate, harder work and explicitly out
of scope for this fix** — this fix is about the gate's HONESTY given whatever
the runner reports, not the runner's behavior. If you find yourself tempted to
"fix" this by touching `vitest.related` config, stop: that is the follow-up
task, not this one.

**Where this can still hide a real gap:** a tool failure is not proof the code
IS tested elsewhere — it is proof the gate could not verify one way or the
other on this run. Treat the file it names the same way you would treat a
`NoCoverage` entry with no integration-spec hint (see below): worth a look,
not an emergency.

### `N mutant(s) TIMED OUT` — counted as killed, shown separately (non-blocking)

**What it means:** Stryker's own convention counts a `Timeout` mutant as
`Killed` for the exit code — a mutant that made the suite hang, or simply ran
long enough to trip `timeoutMS`/`timeoutFactor`, is not told apart from one an
assertion actually caught (see "VERDICT RULES" in `mutation-gate.mjs`'s module
header). That verdict is **not** changed by this section. What changed is
visibility: before `readReport()` collected `Timeout` mutants into their own
list and `formatKilled()` existed, the timeout count was invisible inside
"killed" at **both** places that print it — the per-package table and the
console summary — so a run where a large share of "killed" was actually
timeouts read as an ordinary, undifferentiated pass.

**What it looks like now:** `killed N (M timeout)` in the table and the
summary line when `M > 0`, plain `killed N` when it is zero — and, if `M > 0`,
its own report section listing every timed-out mutant, the same shape as the
tool-failure list above (`where`, `mutator`, `replacement`), printed with
`::notice::` rather than `::warning::` or `::error::`, since nothing here is
wrong by itself.

**Why it does NOT block:** raising this to a real, exit-code-affecting
distinction would be a decision about `timeoutMS`/`timeoutFactor` themselves —
whether the budget is too generous — and that is deliberately a SEPARATE,
harder decision with its own cost (see "Tuning" below on why `timeoutMS` is
generous on purpose: a too-tight timeout turns real survivors into a false
green, which is a strictly worse failure mode than an over-generous one hiding
a slow mutant inside "killed"). This section only makes the number visible; it
does not touch either constant.

#### Zero survivors with timeouts

Zero survivors alongside a notable timeout count is not, by itself, a clean
pass — it is a reason to re-run on an idle machine before trusting the green,
not proof the code is fine. Observed directly on this repo (historical, dated
so it is not read as a live coordinate): the identical commit produced seven
surviving mutants on a loaded host and zero survivors on an idle one, nothing
about the code having changed between the two runs. A pile of timeouts is one
of the ways a loaded host produces that same false confidence — a mutant that
would have been caught given enough wall-clock time instead trips the timeout
and gets counted as killed. Treat a clean exit code that carries a lot of `⏱`
entries the same way you would treat any other suspiciously convenient
result: worth a second run before it goes into a decision, not an emergency,
but not automatically trusted either.

### `N mutant(s) in changed code are not executed by any test` (warning)

Changed lines no test ever reaches. Reported loudly, does **not** fail the build:
a coverage threshold on changed lines is a separate task, and this one refuses to
smuggle it in. Set `MUTATION_NO_COVERAGE_IS_RED=1` when that task lands.

### `nothing to mutate: N changed line(s) contain no mutable code` (green, not a warning)

**What it means:** the changed lines exist and Stryker instrumented them, but
found zero mutants there — a diff that only touches class names, comments, or
other non-mutable text. Printed as its own report section
(`#### Nothing to mutate`), by package name, and it never affects the exit
code: a package that lands here already contributed nothing to the totals.

**Why this needed a fix, not just a message:** Stryker itself never writes a
JSON report for a run that generates zero mutants —
`MutationTestExecutor.execute()` short-circuits before `reportAll()` runs
whenever its own initial dry run finds no tests to execute AND `allowEmpty` is
set (this gate always sets it), and with zero mutants there is, correctly,
nothing for that dry run to relate tests to. Before this fix, `mutation-gate.mjs`
read "no report" as one thing only — a tool failure — and failed the build
(exit 2) with "Stryker produced no report ... nothing was verified", on a diff
that had no logic in it to verify in the first place.

**Reproduced live, 2026-09-01, PR #620** (a two-line Tailwind-class-only diff to
`apps/web/app/components/layout/notifications-bell.tsx`):

```
INFO Instrumenter Instrumented 1 source file(s) with 0 mutant(s)
INFO DryRunExecutor No tests were found
INFO MutationTestExecutor Done in 4 seconds.

::error::mutation-gate: Stryker produced no report for @crm/web (exit 0).
The run did not complete, so nothing was verified. Full output above.
```

— gate exit 2, on a diff whose only content was `overflow-x-hidden` and
`wrap-anywhere` class names. After the fix, the identical diff:

```
mutation-gate: @crm/web — nothing to mutate: Stryker instrumented the
changed line(s) and generated 0 mutants. [...] This is NOT a tool failure.
mutation-gate: PASS
```

**The trap this had to avoid:** the exact same "no report" shape is also what
the already-documented tool failure above (`mutant NOT VERIFIED`) produces on
code that DOES have real mutants — Stryker's dry run can fail to find related
tests regardless of whether there was anything to mutate. "No report + clean
exit" is therefore not, by itself, proof of a legitimate zero. The fix reads
one more fact, logged by the instrumenter UNCONDITIONALLY and BEFORE the dry
run ever runs: its own count of mutants generated
(`Instrumented %d source file(s) with %d mutant(s)`, `@stryker-mutator/
instrumenter`). Only an EXACT zero there, together with Stryker's own clean
exit code, is read as "legitimately nothing to mutate" — a nonzero count, a
missing line, or a nonzero exit all still fail exactly as before this fix
(`parseInstrumentedMutantCount()` in `mutation-gate.mjs`).

**Mixed diffs (one file with mutants, one without, same package):** this path
is never even reached — Stryker's instrumented-count line covers the WHOLE
package run, not one file at a time, so a diff touching both a CSS-only file
and a file with real logic reports a nonzero total, a report gets written
normally, and the CSS-only file simply contributes no entries to it (nothing
to report for lines with no mutable AST). Verified live, same session: the
`notifications-bell.tsx` CSS-only change (0 mutants) plus `JobSuggestionDialog
.tsx`'s defence block (the same 5-mutant scope arm 1 of the vacuum proof
above uses) in one `MUTATION_ONLY_FILES`-scoped run —
`Instrumented 2 source file(s) with 5 mutant(s)` (nonzero total), a report was
written, and it named exactly the ONE real survivor in
`JobSuggestionDialog.tsx` (`img: () => null` → `() => undefined`, the same
documented equivalent-mutant case as the module header's `Ignored` example) —
`notifications-bell.tsx` appears nowhere in the report at all, not even as a
zero row. The zero-mutant bypass above did not fire, because it does not need
to: a nonzero total already takes the ordinary path.

**How this is different from `no mutable source lines changed vs the base`**
(printed earlier, before Stryker even runs): that one means the diff touched
NO file the gate would mutate at all — nothing to hand Stryker in the first
place. This one means a file WAS handed to Stryker, and Stryker itself found
nothing mutable inside the lines it was given. Different fact, deliberately
different wording.

### `the test suite itself is red BEFORE any mutation is applied`

Not a survivor. Stryker refuses to start when the unmutated suite fails, so a
flaky test stops the gate here. Note that mutation testing re-runs the suite
hundreds of times: a timing-sensitive test that passes in `pnpm test` and fails
once in a hundred runs WILL show up here. De-flake it; there is no way to make
mutation testing tolerate a test that is not deterministic.

### `time budget of Ns exhausted`

The gate was killed and **nothing was verified for the remaining packages**. It
is red on purpose — a gate that quietly passes under load is exactly the failure
being treated. Either split the PR, or raise `MUTATION_BUDGET_SECONDS` in
`ci.yml` with a reason in the diff.

## Measured cost (2026-08-11, 4 workers, local)

| Diff                                                           | Mutants |       Wall clock |
| -------------------------------------------------------------- | ------: | ---------------: |
| 2 changed lines (`packages/shared/src/utils/filename.ts`)      |       5 |             3.5s |
| 175 changed lines, 2 files (PR #506 shape)                     |      41 |             7.6s |
| 223 changed lines, 3 files                                     |      55 |            10.2s |
| 4565 changed lines, 16 files (PR #504 — the largest recent PR) |    2220 | budget territory |
| whole `packages/shared` (nightly leg, 36 files)                |    2291 |           139.6s |
| whole `apps/web` (nightly leg, 263 files)                      |   27947 |     not measured |

Startup dominates a small diff (~3s of the 3.5s); after that the cost tracks the
mutant count, which tracks changed lines.

**This table has NO `apps/api` row, and that gap was itself the bug** — the
2026-08-18 pre-push hook (`.claude/hooks/pre-bash-mutation-gate.sh`) shipped
quoting this table's `packages/shared` number (3.5s-10s) as "the" typical cost,
without ever having measured `apps/api` specifically. Filling that gap, and
reporting it as a RANGE rather than a point (review round 3 — three
measurements of the SAME 2-line/4-mutant `apps/api` diff, on different
occasions, came back 39s, 40s, and 53s: a ~1.5x spread from the SAME diff
shape, which makes any single number here a coincidence, not a promise):

| Diff                                                                  | Package       | Mutants |       Wall clock | Load average during measurement           |
| --------------------------------------------------------------------- | ------------- | ------: | ---------------: | ----------------------------------------- |
| 1 changed line (`packages/shared/src/utils/filename.ts`, idempotent)  | `@crm/shared` |       3 |             8.0s | ~20-22 (8-core, shared machine)           |
| 1 changed line (`apps/api/src/users/users.controller.ts`)             | `@crm/api`    |       3 |            24.7s | ~20-22 (same session, same load as above) |
| 2 changed lines (`apps/api`, measured 3 times on different occasions) | `@crm/api`    |       4 | **39-53s range** | 15-23 each time, not identical run to run |

The `@crm/shared` / `@crm/api` (1-line) pair above is from the SAME session,
same load, same-shaped diff — a controlled comparison, not a general
prediction. The 39-53s range is the general prediction: it is what three
INDEPENDENT measurements of one fixed diff shape actually produced, and the
spread between them is the honest answer to "how long will apps/api take" —
not a single number, because **the dominant variable is not the diff, it is
how many other agents are running heavy work on this shared machine at push
time** (this repo's dev environment routinely runs multiple concurrent Coder/
Reviewer/DevOps sessions; `uptime` load averages of 15-23 on 8 cores are the
ordinary case here, not an outlier — see `.claude/rules/common/light-track.md`
"Параллельный диспатч" for the wider pattern). Two effects compound into that
range: the ~3x structural gap over `@crm/shared`/`apps/web` (Stryker boots the
full NestJS DI graph once per worker before it can run a single mutant,
roughly 16-20s of the `@crm/api` total, present regardless of mutant count and
regardless of load — neither `@crm/shared` nor `apps/web` has this bootstrap),
and THEN a load multiplier on top of that fixed tax that varies run to run on
this specific machine. An unloaded, dedicated machine would show smaller
absolute numbers across the board, but the same ~3x relative gap between
`@crm/api` and the other two packages.

**Practical consequence for the pre-push hook's 120s budget:** even the low
end of the observed range (~39s) already spends the fixed `apps/api` tax
(~16-20s) plus real per-mutant time before a single extra mutant beyond the
measured 4 is counted; the high end (~53s) is already 44% of the budget on a
2-line diff. Real but not huge margin for the common case, tighter on a
genuinely large `apps/api` diff, and load-dependent rather than fixed — a push
that would comfortably fit the budget on a quiet machine can run noticeably
closer to it when several other agents are active. See "Judgment: is ~25-53s
per `apps/api` push acceptable?" below for the call on whether that is worth
narrowing further.

**The `apps/web` nightly leg is the long pole and its wall clock is NOT known.**
What was measured: 263 files instrument to 27947 mutants, and its unmutated dry
run (1346 tests) takes 63s. Extrapolating from the per-mutant rate seen on
smaller runs puts it in the low hours locally, and a GitHub runner has fewer
cores than the machine those numbers came from — so it may well hit the 5h
budget on the first night. That is a deliberate choice over guessing: exceeding
the budget produces a loud, specific red naming the package and the elapsed
time, which is a real measurement, whereas a number invented here would be a
comfortable fiction. **Read the first nightly run and set
`MUTATION_BUDGET_SECONDS` per leg from what it actually reports.** If `apps/web`
cannot finish in one night, split that leg by directory in the matrix rather
than raising the budget past the 6h job ceiling.

## Judgment: is ~25-53s per `apps/api` push acceptable? (review round 2/3, 2026-08-18)

Asked explicitly by a PR reviewer once the real `apps/api` cost was measured,
rather than left implicit. The answer here is **yes, as shipped, with one
caveat spelled out rather than fixed silently** — this section is that
judgment call, on the record.

**Why yes:** `apps/api` is not an arbitrary expensive package — it is the
EXACT area task-mutation-gate-mechanical's own motivating facts came from
(three independent "test checks the mock, not the code" defects found there
in one session). A push that costs more because it is checking the highest-
risk surface more thoroughly is a real tradeoff paid for real protection, not
waste. 25-53s is noticeable but not disruptive to a normal push cadence
(compare: `pnpm test` for the whole monorepo already runs on every pre-push
via the existing husky hook and costs minutes, not seconds — this hook adds a
fraction of that, and only for pushes that actually touch mutation-relevant
`apps/api` lines). The MUTATION_PREPUSH_BUDGET_SECONDS=120 default leaves real
margin above the measured cost for a typical small diff (a handful of changed
lines), and the budget-exceeded path is verified to fail loud rather than
silent (see "Measured cost" above and the hook's own header).

**The caveat:** margin shrinks fast as a diff grows, because the ~16-20s
NestJS-boot tax is fixed per push, not amortized across a session — every
apps/api push pays it again, whether the diff is 1 line or 50. A genuinely
large apps/api diff (the shape of PR #504, 4565 lines / 2220 mutants) would
hit the 120s local budget WELL before the mutant count alone would explain it,
purely from that one push's own boot cost stacking against whatever margin the
mutant count already used. That push still gets a correct, loud SKIP (verified
above against a REAL overflow, not a stub) — it just means "not verified
locally" happens exactly on the largest, highest-risk apps/api changes, which
is the opposite of where a local first line of defense is most valuable.

**A narrowing option, described but NOT implemented here** (task instruction:
describe rather than silently redo when the fix is non-trivial design work,
not a one-line change) — reuse a warm NestJS `TestingModule` across the dry
run and every mutant within one Stryker worker, instead of paying the DI-graph
boot cost once per worker regardless of mutant count. This is real, scoped
engineering: it means writing or wiring a Stryker-aware test bootstrap for
`apps/api` specifically (Stryker's `vitest-runner` plugin does not do this on
its own — it re-imports the test file per mutant, which is what re-triggers
Nest's bootstrap each time), verifying no state leaks between mutants sharing
one module instance, and confirming the speedup is real under this repo's
actual DI graph size before trusting it. That is `apps/api` source/test-infra
work — outside this task's zone (`.claude/hooks/**`, `scripts/devops/**`) and
a plausible size for its own task if the owner wants it pursued.

A cheaper, in-zone alternative that WOULD fit this task's surface: raise
`MUTATION_PREPUSH_BUDGET_SECONDS`'s default specifically higher when the diff
touches `apps/api` (the fixed boot tax alone already claims a sixth of the
current 120s default), or size-gate very large local `apps/api` diffs into an
immediate, visible SKIP ("this diff is large enough that local verification
would cost minutes — CI will check it for real") rather than spending the
whole budget attempting it. Neither is implemented here: both are judgment
calls about UX (how many false-margin seconds is worth adding, what "large"
means) that belong to the owner's call, not something to guess and ship
silently.

## Running it yourself

```bash
pnpm install --frozen-lockfile
pnpm --filter @crm/shared build          # web/api vitest resolve @crm/shared through dist

pnpm mutation:changed                    # what this branch changed vs origin/main
pnpm mutation:full                       # everything (long)

# narrow while iterating — MUTATION_ONLY_FILES can only SHRINK the scope
MUTATION_ONLY_FILES=apps/api/src/auth/jwt.guard.ts pnpm mutation:changed
```

**A point run is for debugging ONE mutant, never proof before a push.**
PR #623 ran the gate scoped to each round's own files/lines
(`MUTATION_ONLY_FILES`, or a diff base narrowed to that round) seven separate
rounds, and every round reported `survived 0`. CI, running `--changed`
against the FULL branch diff vs `origin/main` with no `MUTATION_ONLY_FILES`,
found **34 surviving mutants** on the same branch. Broken down: **20** were
in files that round's changes never touched at all, and the other **14**
were in files a round DID touch, but on different lines than that round's
own edit. Seven point runs saw zero of the thirty-four between them — not
because the gate missed them, but because a scoped run's "changed" is
whatever you told it to look at, not what the branch actually changed.
Before a push: `pnpm mutation:changed` with NOTHING narrowing it — the
`MUTATION_ONLY_FILES` line above is for iterating on one finding after the
full run already told you where it is, never a substitute for running it.

`reports/mutation/*.report.json` holds the full machine-readable result
(gitignored; uploaded as a CI artifact).

## Proving the gate still has teeth

```bash
bash scripts/devops/mutation-gate-vacuum-proof.sh
```

Four arms against the render-side XSS defence of `JobSuggestionDialog`:

1. the real test → 4 killed, 1 survivor → **red**
2. real test + suppression **with** a reason → **green**
3. real test + suppression **without** a reason → **red**
4. the actual pre-fix vacuum test from 2026-08-07
   (`apps/web/app/test/fixtures/2026-08-07-JobSuggestionDialog.vacuum.tsx.txt`,
   11 passing tests) → **0 killed, 5 survivors** → **red**

Arm 4 is the one that matters, and its assertion is deliberately harsh: the
vacuum test must kill **zero**. One of those five mutants deletes the entire
`MARKDOWN_COMPONENTS` object — the whole render-side defence — and that suite
stays green through it. If a future change makes the vacuum test kill even one
mutant, the script fails: either the fixture stopped reproducing the original
state or the gate's configuration drifted.

The proof restores every file it touches, including on Ctrl-C, and runs nightly
in the `@crm/web` sweep leg so it cannot rot.

## The nightly alert

`mutation-nightly.yml` sweeps all three packages, tallies the reports with
`check-mutation-tally.mjs`, and routes the verdict through the existing
`post-merge-alert.sh` (`KIND=mutation`, label `mutants-surviving`) — one open
issue at a time, one comment per night while red, auto-closed when nothing
survives.

**It is expected to be red from the first night.** On the day it shipped, one
386-line component's own (good) test file left 57 mutants alive and the whole of
`packages/shared` left 1061. That backlog is the point; the task that introduced
this deliberately did not fix it. A nightly rigged to be green on day one would
be one more check that cannot fail.

A tally of "all legs green, zero reports produced" is **red**, not green — see
the header of `check-mutation-tally.mjs`.

**The alert text depends on WHETHER the sweep ran, not only on WHAT it found**
(task-mutation-gate nightly-alert-fidelity, 2026-09-03). Before this, every
`KIND=mutation` failure — a leg crashing before Stryker even started, a
corrupt report, zero reports produced, OR real survivors — produced the SAME
issue body ("выжившие мутанты — вот что делать"). The nightly was red on
every single scheduled run from its first trigger (2026-08-12) through at
least 2026-09-03, and for most of that window the cause was a leg failing
before any mutant ran — yet the open issue read, every night, as ordinary
accumulated mutant debt to work through later. `check-mutation-tally.mjs` now
also prints `reason=incomplete|survivors|cancelled|clean` and
`missing_packages=<comma list>`; `post-merge-alert.sh` uses `reason` to pick
between two genuinely different bodies (see its own header comment on
`MUTATION_REASON` for the exact split) — the `incomplete` one names which
package(s) produced no report, says explicitly that static mutants were not
checked that night, and points at fixing the RUN, not at closing mutants.
Verify both bodies with `DRY_RUN=1 ... MUTATION_REASON=incomplete|survivors
./scripts/devops/post-merge-alert.sh` — pattern and worked example in
`scripts/devops/post-merge-ci-runbook.md` §4.1 (that file, not this one; this
runbook has no numbered sections of its own).

## PR gate vs nightly (`ignoreStatic` — considered and rejected)

**Read `mutation-gate.mjs`'s own header section "PR GATE vs NIGHTLY" first;
this is the runbook-side pointer, not a duplicate.** `ignoreStatic`
(Stryker's flag to skip load-time-only mutants — a module-level constant, a
Zod schema default) was proposed for `--changed` only, prototyped, and
**rejected by the owner, 2026-09-03**, after the self-check itself
demonstrated the cost: it hides module-level constants — the exact class of
the 2026-08-07 incident. It is OFF, unconditionally, in both `--changed` and
`--full`.

**The case for it was real — 61 static mutants on PR #623 were 11% of the
mutant count and 84% of the wall time — and that cost is unresolved, not
eliminated by rejecting it.** Until the `api` leg is file-sharded
(`.claude/tasks/BACKLOG-followups.md` #135, promoted to priority the same
day — the only remaining lever after this rejection), a heavy diff on
`--changed` runs 36-47 minutes. Knowingly accepted: the measured price of
keeping the gate honest instead of fast.

**What the prototype broke, verified by running `mutation-gate-vacuum-proof.sh`
itself, not by reasoning about it:** with `ignoreStatic` active, 4 of the
self-check's 5 XSS-defence mutants (`MARKDOWN_URL_TRANSFORM` and
`MARKDOWN_COMPONENTS` in `JobSuggestionDialog.tsx`, both module-level
`export const`s) came back `Ignored` (static) and were never exercised.
`arm 1`'s "the real test kills the defence mutants (>= 4)" assertion — true
since this file was written — dropped to 1, and the gate reported PASS for a
diff that deletes the render-side XSS defence. The self-check's assertions
were never weakened to accommodate this; the failure stood, and it was the
finding that ended the prototype.

**Current status of each leg, verified live after the revert:**

- `@crm/shared` — green every night since 2026-08-12; its statics have been
  verified throughout.
- `@crm/web` — the self-check's `arm 4` crash (frozen vacuum fixture
  predating `matchScore`/`matchedKeywords` and `SourceBudgetPanel`/
  `useJobSources` from PR #515) is fixed, AND with `ignoreStatic` reverted,
  the whole self-check passes end to end again: `mutation-gate-vacuum-proof.sh`
  run fresh — 9/9 assertions, all 4 arms, 5/5 reference mutants in arm 4
  actually exercised (0 skipped as static). The `Gate self-check` step no
  longer blocks `Full mutation sweep` for this leg.
- `@crm/api` — still blocked, for a third, unrelated reason: Stryker's
  initial dry run is red on `resume-text-extraction.service.spec.ts`'s 250ms
  stall-ceiling assertion (observed ~1.6s on a shared runner). `*.spec.ts` is
  AutoTest's zone; being fixed in a separate PR as of this writing, not this
  one.

So after this revert, a green full nightly needs exactly one thing it did
not need before: AutoTest's `api`-leg fix landing. `@crm/shared` and
`@crm/web` are no longer blockers.

`.claude/tasks/BACKLOG-followups.md` #137 covers a related, separate finding:
even the (previously miscategorized) nightly alert issue went three-plus
weeks and 22 comments without anyone reading it, which is why none of this
was noticed sooner.

**What got a full, non-scoped local verification, and what that does and
does not prove:** the complete local `.husky/pre-push` sequence —
`pnpm typecheck` + `pnpm --filter @crm/shared|@crm/api|@crm/web|@crm/landing
test`, unscoped, not the point-scoped runs §"Running it yourself" warns
against above. That is evidence this repo's OWN test suites are sound on
this branch; it is not, and does not claim to be, evidence about the nightly
`--full` sweep's own survivor count, which is a different question (see "The
alert text depends on WHETHER the sweep ran, not only on WHAT it found"
above).

## Tuning

Everything lives in `scripts/devops/mutation-gate.mjs`:

- **`PACKAGES`** — which packages are swept, and the `exclude` list per package.
  `apps/e2e` is absent on purpose (a browser run per mutant). Exclusions mirror
  each package's existing vitest coverage `exclude` plus generated files: they
  are things a UNIT suite structurally cannot kill mutants in (DI wiring, the
  Drizzle schema, generated route trees), not things that do not matter.
- **`timeoutMS` / `timeoutFactor`** — generous on purpose. Stryker counts a
  timeout as _killed_, so a tight timeout converts survivors into false greens.
  Err long.
- Env knobs (`MUTATION_BUDGET_SECONDS`, `MUTATION_CONCURRENCY`,
  `MUTATION_PACKAGES`, `MUTATION_SURVIVOR_BUDGET`, …) are documented in the
  script's header.

## Known limits (stated, not hidden)

- **Line scoping is containment-based.** Stryker only generates a mutant when the
  mutated AST node lies entirely inside a changed line range
  (`@stryker-mutator/instrumenter`, `locationIncluded`). Change one line inside a
  30-line JSX block and you mutate the expressions on that line, not the block.
  The enclosing block is the nightly's business.
- **The gate cannot judge whether an assertion is meaningful**, only whether it
  can fail. A test that kills the mutant for the wrong reason still counts.
- **Suppression reasons are not verified for truthfulness.** Writing a plausible
  lie defeats it — but it is a lie in the diff, where a reviewer reads it. Same
  stopping point as `check-guard-tests-exist.sh`.
- **`apps/landing` is not swept** — no unit specs of its own worth mutating yet.
  Add it to `PACKAGES` the day that changes.
- **`*.integration.spec.ts` is invisible to this gate, structurally.** A
  `NoCoverage` finding in a file exercised only by an integration spec is
  expected, not a hole — see
  `.claude/rules/common/mutation-gate-integration-specs.md` for the mechanism
  and what to do about it (a unit-level double, not an integration spec — the
  gate cannot see either one, but only the double is a tool requirement rather
  than duplication). The gate labels this heuristically
  (`looksIntegrationOnly()` — a filename match, not proof); always look before
  trusting the label either way.
- **A per-package `vitest.config` that computes its own repo root by a FIXED
  `path.resolve(__dirname, '../..')` walk-up breaks the moment Stryker's
  sandbox reloads it from two levels deeper** (`apps/<pkg>/.stryker-tmp/
sandbox-<id>/`, not `apps/<pkg>/`) — the fixed walk-up lands ON the package
  root instead of the real repo root, and any `@crm/shared` alias built from
  it points at a directory that does not exist. Reproduced live 2026-08-25
  (PR #613): `apps/api/vitest.config.mts` carried exactly this bug, invisibly,
  until `env-git-commit-boot.spec.ts` (added the same day) did a real Node
  `import()` that actually needed the alias to resolve — `mutation-gate: @crm/
api: the test suite itself is red BEFORE any mutation is applied`, with
  Node's own `Cannot find package '@crm/shared'` underneath. `apps/web/
vitest.config.ts` carried the IDENTICAL bug and was NOT observably broken —
  verified live with the same diff's web-side changes (`cascade-preview.ts`,
  a real runtime `@crm/shared` import): Vite's alias resolver falls back to a
  real `node_modules` lookup when the aliased absolute path is missing, where
  plain Node ESM resolution (what `apps/api`'s tests go through) does not.
  That fallback is a resolver ACCIDENT, not a contract to rely on — both
  configs now compute their root the same way `apps/api/vitest.config.mts`
  already had an (until-then-unused) helper for: walk up from `__dirname`
  looking for an actual `.git` entry, which exists only at the true checkout
  root regardless of how deep a tool nests its own working copy beneath it.
  Fail loud (`throw`) if that walk-up finds nothing, rather than falling back
  to a guess — the whole point is that a wrong root here does not error
  immediately, it errors LATER, at an unrelated import site, which is how
  this one went unnoticed as long as it did.
- **A suppression's printed count is per (line, mutator), not per author's
  intent.** `// Stryker disable next-line <mutator>` silences EVERY mutant that
  mutator produces on that line — measured three times higher than expected
  (#531: eight vs. two intended; #554: four vs. one). `groupSuppressions()`
  prints the real count from Stryker's own report specifically so nobody has to
  get this right by memory a fourth time.
- **The tool-failure vs survivor split (above) lives ONLY in `mutation-gate.mjs`
  — `check-mutation-tally.mjs`, which drives the NIGHTLY alert issue, does not
  share it.** That script reads `Survived` straight off the raw Stryker report
  (`counts.Survived`, no `testsCompleted` check) as its own, independent
  codepath — it does not call `readReport()`. A nightly full sweep can hit the
  same runner behavior described above (it mutates whole packages, `apps/web`
  alone is 27947 mutants — see "Measured cost" — so the exposure is larger, not
  smaller) and would still count a tool failure as a real survivor, potentially
  opening or keeping open a `mutants-surviving` issue for mutants nobody's
  tests were ever run against. Noted here rather than fixed silently — carrying
  the same reclassification into the nightly tally is its own scoped follow-up,
  not a one-line change (`check-mutation-tally.mjs` aggregates ACROSS reports
  from multiple sweep-leg jobs, each a separate CI job with its own uploaded
  artifact, which is a different shape of problem than one process reading one
  report path it just wrote).
