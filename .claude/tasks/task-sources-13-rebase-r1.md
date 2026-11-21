# Task sources-13 rebase round 1 — PR #1444 (branch `feat/sources-sitemap-trio-3`, head 776e18b5c)

Original task: `task-sources-13-sitemap-trio.md` (same directory). PR #1444 was stacked on #1443
(`feat/sources-nextleveljobs`). #1443 is now squash-merged to main as e7e4bfb02, and #1444's base is now `main`.
#1444 was rebased only onto #1443's round-1 head 688c4e37b. It lacks #1443's rounds 2 and 3
(`task-sources-12-fix-round2.md`, `task-sources-12-fix-round3.md`).

## Do

1. **Rebase.** Rebase the PR's own commits onto `origin/main` (`git rebase --onto origin/main <old base> <branch>`).
   Find the old base with `git merge-base`, or use 688c4e37b.
   - Resolve each conflict by each side's intent (skill `resolving-merge-conflicts`).
   - Keep the shared core `sitemap-jsonld.ts` structure.
2. **Port #1443 round 2 into the core, so all four sites get it.** Read the round-2 diff with `git diff 688c4e37b 2db0c9526`.
   - D-1: the older-id offset is drawn once per run from `deps.random()`. Not the hourly clock.
   - D-2: the `shortcut:` comment on 410 / lasting 5xx.
   - D-3: an invalid sample `apply-button: none` when a matched page has no apply button. Apply it only to sites that have an apply-button notion, and state the choice per site.
   - D-4: identity URL compare with the id normalised, the same way as the id. The fetch keeps the sitemap URL. For lastmod-dated sites (JustJoin.it, Landing.jobs), apply the same normalisation to their own id format, or state why it is not needed.
   - Future-dated ids (or a future lastmod) do not count toward drift.
3. **Tests.** The NLJ spec from main must pass unchanged. Add or port tests so the trio sites get the same coverage of D-1, D-3 (where applicable), D-4 and future-age.
4. **seed-delta pin.** `manifest.seed-delta.integration.spec.ts` new-entry count = main's 22 + this PR's new entries. Run it on a scratch DB `crm_qa_s13_rb` (`DATABASE_URL` inline, never crm_db).
5. **Run everything.**
   - `pnpm --filter @crm/api test`, typecheck, eslint on changed files, prettier.
   - Mutation gate `node scripts/devops/mutation-gate.mjs --changed`. Run it alone, not during a push (shared build lock). If the full run cannot fit the budget locally, say so and give the narrowed result.
6. **Push.** Force-push with lease to the PR branch: `DATABASE_URL= git push --force-with-lease origin HEAD:feat/sources-sitemap-trio-3`.
   - Pre-push runs the suites, about 25 min. Run it in the background and wait for it. Do not start a second push.
   - The final commit carries `ac_verified:` with the original AC numbers + `rebase-r1`.

Report:
- `Worktree:`
- `Pushed: <branch> @ <sha>` (verify with `git ls-remote origin feat/sources-sitemap-trio-3`)
- test counts (non-zero)
- the mutation result
- the conflict list with how each was resolved
- `Findings resolved (5)`

## Rules

- Zone `apps/api/**` only.
- Every Edit/Write path starts with your own `git rev-parse --show-toplevel`.
- Git:
  - No `--no-verify`.
  - Use explicit `git add`.
  - Never create `.claude/.allow-direct-edits`.
- No second-opinion.
- No external GETs.
- Notes server: `notes.search` before reading code; `notes.add` facts with file:line.
- Do not touch PR #1445 (`feat/sources-dice-nofluff`). It will rebase on this one later and reuse this PR's `ACCEPT_PROHIBITED_RISK` mechanism.
