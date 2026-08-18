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

|                | Pre-push hook (`.claude/hooks/pre-bash-mutation-gate.sh`) | PR gate (`ci.yml`, `quality` job)            | Nightly (`mutation-nightly.yml`) |
| -------------- | --------------------------------------------------------- | -------------------------------------------- | -------------------------------- |
| Scope          | same as the PR gate — the LINES this branch changed       | only the LINES this branch changed           | whole packages on `main`         |
| Verdict        | BLOCK on a real finding, visible SKIP on anything else    | one survivor → build red                     | inventory → alert issue          |
| Cost           | budget-capped at 120s locally (see the hook's own header) | proportional to the diff (see numbers below) | up to 5h per package leg         |
| Blocks a merge | no — only slows a `git push` locally                      | yes                                          | no                               |

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

### `N mutant(s) in changed code are not executed by any test` (warning)

Changed lines no test ever reaches. Reported loudly, does **not** fail the build:
a coverage threshold on changed lines is a separate task, and this one refuses to
smuggle it in. Set `MUTATION_NO_COVERAGE_IS_RED=1` when that task lands.

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
- **A suppression's printed count is per (line, mutator), not per author's
  intent.** `// Stryker disable next-line <mutator>` silences EVERY mutant that
  mutator produces on that line — measured three times higher than expected
  (#531: eight vs. two intended; #554: four vs. one). `groupSuppressions()`
  prints the real count from Stryker's own report specifically so nobody has to
  get this right by memory a fourth time.
