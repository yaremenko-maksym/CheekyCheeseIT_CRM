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

## The two halves

|                | PR gate (`ci.yml`, `quality` job)            | Nightly (`mutation-nightly.yml`) |
| -------------- | -------------------------------------------- | -------------------------------- |
| Scope          | only the LINES this branch changed           | whole packages on `main`         |
| Verdict        | one survivor → build red                     | inventory → alert issue          |
| Cost           | proportional to the diff (see numbers below) | up to 5h per package leg         |
| Blocks a merge | yes                                          | no                               |

The PR gate is affordable because it is line-scoped. It is also blind to
everything written before it existed — that is the nightly's job.

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

Startup dominates a small diff (~3s of the 3.5s); after that the cost tracks the
mutant count, which tracks changed lines.

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
