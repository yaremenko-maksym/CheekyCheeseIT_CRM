# Task sources-14 rebase r1 — PR #1445 (branch `feat/sources-dice-nofluff`, head 43e1e1aa7) onto `main`

Earlier: `task-sources-14-dice-nofluff.md` (same directory). The branch was stacked on the pre-squash Next Level
Jobs commits (`b5d6cc076`..`eef745541`, maybe also `3175d5ead`). Since then `main` gained:

- #1443 (Next Level Jobs, squashed) — the NLJ commits on this branch are already on main in their reviewed form.
- #1444 (The Hub / JustJoin.it / Landing.jobs, merge `4c1d2bc1f`): a shared sitemap + JSON-LD core
  (`providers/sources/sitemap-jsonld.ts`, NLJ re-expressed as a site config on it) and a new owner-decision kind
  `ACCEPT_PROHIBITED_RISK` that lifts a ToS `PROHIBITED` entry (technical blocks stay a hard stop: NO_EVASION).
  `manifest.owner-decisions.spec.ts` pins the exact set of types carrying it; the seed-delta pin is 25.

## Do

1. Rebase only this PR's own commits (Dice / No Fluff Jobs: `4749f3aa5`..`43e1e1aa7`, and `3175d5ead` only if
   main does not already contain its change) onto `origin/main`, e.g. `git rebase --onto origin/main <last NLJ commit>`.
   Use the `resolving-merge-conflicts` skill. Main's side wins for everything NLJ / sitemap-core / #1444.
2. **One mechanism for a lifted prohibition.** This branch added `OVERRIDE_PROHIBITED` + `liftsProhibited`; main has
   `ACCEPT_PROHIBITED_RISK`. Drop this branch's kind and helper; express `DICE_OWNER_DECISION` with main's kind
   and main's lift path, keeping its scope / reference text (English only; quote the owner as
   "I accept the risk for every site" marked `(owner's words, translated)`, the same rendering main uses).
   No Fluff Jobs stays whatever its permission requires (`ACCEPT_RISK` for UNCLEAR, `ACCEPT_PROHIBITED_RISK` if its
   ledger entry is PROHIBITED) — check the entry, do not guess.
3. Extend main's pinned set in `manifest.owner-decisions.spec.ts` with the type(s) that now carry
   `ACCEPT_PROHIBITED_RISK` (Dice; NFJ only if PROHIBITED). Keep any security test that proves the kind cannot lift a
   technical block, a NO_EVASION entry, DOU / WTTJ / The Muse; add one for Dice if main's suite does not cover it.
4. Seed-delta: recompute the pin (main 25 + this PR's entries), regenerate `job-sources:manifest:generate`, and run
   the seed-delta integration spec on scratch DB `crm_qa_s14_rb` (create it; `DATABASE_URL` inline, never crm_db).
5. If Dice / NFJ duplicate a helper main now has (metered fetch, sitemap child reading, ATS dedup, JSON-LD select),
   use main's. Do not change NLJ or trio behaviour: their specs pass unchanged.
6. Run: `src/job-sourcing` specs, `pnpm --filter @crm/api typecheck` (build `@crm/inference` and run
   `i18n` compile first in a fresh worktree if needed), eslint on changed files, prettier, mutation gate
   `node scripts/devops/mutation-gate.mjs --changed` (alone, not during a push).
7. Push with lease: `DATABASE_URL= git push --force-with-lease origin HEAD:feat/sources-dice-nofluff` (pre-push ~25
   min: background, wait, one push). Last commit `ac_verified: R1,R2,R3,R4,R5`.
8. Rewrite the PR body for the new head (body to a file, `gh pr edit 1445 --body-file <file>`): base `main`, the
   decision kinds used, seed-delta pin, verification numbers. Read `.claude/rules/common/doc-durability.md` first.

Report: `Worktree:`, `Pushed: <branch> @ <sha>` (verify `git ls-remote origin feat/sources-dice-nofluff`),
`git log --oneline origin/main..HEAD` count, test counts (non-zero), mutation result, seed-delta number, NFJ ledger
permission found, conflicts and how each was resolved (one line each).

## Rules

Zone `apps/api/**` (+ the PR body). Every Edit/Write path starts with your own `git rev-parse --show-toplevel`. No
`--no-verify`, explicit `git add`, never create `.claude/.allow-direct-edits`. No second-opinion. No external GETs.
No secrets or personal data. Notes server: `notes.search` before reading code, `notes.add` facts with file:line.
