# Rule: Mutation gate cannot see integration specs — unit doubles are required, not duplication

**Status:** Always-on
**Applies to:** Coder (writes tests behind the mutation gate), DevOps (owns `scripts/devops/mutation-gate.mjs`), code-reviewer (reads a `NoCoverage` finding on a PR)
**Source:** `task-mutation-gate-mechanical` (2026-08-18), AC4 — fact 3: PR #564 spent a full turn re-deriving this by hand because it was nowhere written down.

---

## The rule

**The mutation gate runs the UNIT suite only, and cannot execute a single
`*.integration.spec.ts`.** If a piece of behavior is exercised ONLY by an
integration spec, the gate reports `NoCoverage` on it — and that is the CORRECT,
EXPECTED report, not a bug in the gate and not, by itself, a real coverage gap.

If you want the mutation gate to actually verify that behavior, you have to add a
**unit-level test double** (mocked repository / mocked HTTP client / mocked
Drizzle query) that exercises the same code path. **This is a requirement of the
tool, not duplication of the integration spec.** The integration spec keeps
verifying the real thing against real Postgres; the unit double is what makes
this specific gate able to see the line at all. Neither replaces the other.

## Why the gate cannot see integration specs (mechanism, not policy)

`scripts/devops/mutation-gate.mjs` drives Stryker with the `vitest` test runner
against `apps/api`, `apps/web`, `packages/shared`. `apps/api/vitest.config.mts`
has a **structural, non-optional** exclude: on any run that is not explicitly
filtered to `integration.spec` (see `isIntegrationRun` in that file), every
`*.integration.spec.ts` is dropped from Vitest's own file discovery — Vitest
never even loads them, so Stryker's `coverageAnalysis: 'perTest'` has no record
that they exist. This is not a mutation-gate limitation to fix; it is the same
non-integration-run guard that protects `pnpm test` and CI's unit job from
touching a live database by accident (see the "Non-integration-run structural
skip" comment in `vitest.config.mts` — a real prior incident). Running the
integration suite under Stryker would additionally require a real Postgres and
re-running it per-mutant, which `mutation-gate.mjs`'s own header explicitly rules
out for `apps/e2e` on the same cost basis ("every mutant there would cost a full
browser run, which is not a gate, it is a night").

## How the gate's own output helps (but does not decide for you)

`mutation-gate.mjs` labels each `NoCoverage` entry with a heuristic
(`looksIntegrationOnly()`): if the uncovered file's basename also appears,
whole-word, somewhere in the text of the repo's `*.integration.spec.ts` files, the
entry is printed under "likely covered only by an integration spec" instead of
the plain uncovered list. **This is a heuristic, not proof** — a filename match,
not a parsed import, and useless for stoplisted generic names (`index`, `types`,
`utils`, …, kept in `INTEGRATION_HINT_STOPLIST`). Treat a "likely" label as "check
before you panic", and treat an entry with NO hint as "look at this one first" —
but always actually look. The heuristic can raise confidence, never lower it: a
"no hint" entry is not proof of a gap either, it might just be a filename the
heuristic cannot match.

## `NoCoverage` vs `Survived` — different diagnoses, different severity

- **`Survived`** — a test DID execute the mutated line, and still passed. The
  suite ran the code and noticed nothing.
- **`NoCoverage`** — no test executed the line AT ALL. By itself this is the
  **more serious** of the two: zero verification happened, versus verification
  that happened to miss something.

The integration-spec carve-out above only explains why `NoCoverage` is not
automatically red in this repo — it does not make `NoCoverage` a lesser finding
than `Survived` in general. A `NoCoverage` entry with NO integration-spec hint is
worth exactly as much attention as a `Survived` entry; treat the gate's
`#### No coverage` section split (`likely` / `real`) as a triage aid for WHICH
`NoCoverage` entries to look at first, not as permission to skip the rest.

## What this means in practice, writing a test

1. Business logic that is reachable from a unit test (service methods, guards,
   pure functions, request/response mapping) — write the unit test that reaches
   it. This is the common case and the gate sees it directly.
2. Business logic that is ONLY reachable through a real DB round-trip (RLS,
   constraint behavior, actual Drizzle query shape) — the integration spec is
   still the right and only place to verify the real thing. If the mutation gate
   flags `NoCoverage` there with no integration hint, either:
   - add a thin unit double around the same branch (mock the repository call,
     assert the service still behaves correctly on both branches), which gives
     the gate something to execute even though the DB-facing part stays
     integration-only; or
   - if genuinely nothing short of a live Postgres can distinguish the mutant
     (e.g. it changes a raw SQL fragment), that is a case for a suppression with
     a written reason (`// Stryker disable next-line <mutator>: <why>`), not for
     silence — see `scripts/devops/mutation-gate-runbook.md`.
3. Never read a `NoCoverage` finding as "add an integration spec" by default —
   the gate cannot see it, so that would not change the gate's report at all,
   even though it is real, legitimate coverage. It only helps when a UNIT double
   is added alongside it.

## Related rules

- `.claude/rules/common/git-policy.md` — `DATABASE_URL=` pushes: integration
  specs graceful-skip on a feature-branch push for a different reason (data
  safety), which is a separate mechanism from this one (the gate cannot run them
  regardless of `DATABASE_URL`).

## Sources

- `scripts/devops/mutation-gate.mjs` — `PACKAGES`, `splitUncoveredByIntegrationHint()`, `looksIntegrationOnly()`.
- `scripts/devops/mutation-gate-runbook.md` — "Known limits" section.
- `apps/api/vitest.config.mts` — "Non-integration-run structural skip" comment block.
- `task-mutation-gate-mechanical` (2026-08-18), fact 3 / AC4 — PR #564.
