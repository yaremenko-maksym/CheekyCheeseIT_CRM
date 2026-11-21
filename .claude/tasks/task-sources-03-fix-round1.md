# Task sources-03 fix round 1 — PR #1428 (WWR RSS namespace fallback)

Parent task: `.claude/tasks/task-sources-03-wwr.md`. Branch of PR #1428, head `695d772c0`.
Code review (issue comment on the PR, first line `Verdict: BLOCK`):
`gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/issues/1428/comments`. Resolve all three.

## Findings

- **CR-H-1** `apps/api/src/job-sourcing/providers/sources/wwr.provider.ts` `mapEntry`: the fallback
  `config.namespace || WWR_NAMESPACE` leaves `config.namespace === ''` in the runtime config, so
  `rss.provider.ts` `cacheKeyOf` and `scopeOf` still use `''` (`batch.scope.namespace === ''`, while
  `observation.identity.namespace === 'wwr'`). Move the fallback into the adapter's `configSchema`:
  a `.transform` (or preprocess) that maps an empty or absent namespace to `WWR_NAMESPACE`. A plain
  `.default()` is NOT enough: the production rows store an explicit `''`. Remove the `mapEntry`
  fallback once the schema supplies the value. Do not change `DJINNI_RSS` or `EUREMOTEJOBS_RSS` here
  (Djinni is task 02; its owner is told separately).
- **CR-M-1** `wwr.provider.ts` comment on `WWR_MAX_FEED_BYTES`: the 2.3 MB peak was seen on
  2026-11-17 (PR #1379), not 2026-11-19. Fix the date.
- **CR-L-1** `wwr.provider.spec.ts` regression test: also assert `batch.scope.namespace === 'wwr'`
  and that the parsed config's namespace is `'wwr'` for an input of `''`.

## Rules

Work only in your own worktree, in `apps/api/src/job-sourcing/providers/sources/wwr.provider*.ts`.
Red-check the new assertions (revert the fix, see them fail, restore). Run the WWR and rss provider
specs, `tsc --noEmit` for `@crm/api`, prettier, eslint. Run the mutation gate on the changed file
(`node scripts/devops/mutation-gate.mjs --changed`, see `docs/runbooks/mutation-gate-runbook.md`) and
report the survivor count. Commit with `ac_verified:` copied from the parent task, push with
`DATABASE_URL= git push` (background if long), verify with `git ls-remote`. Add a "Fix round 1"
table to the PR body via `gh pr edit 1428 --body-file`. Never --no-verify. Notes server:
`notes.search` before reading code, `notes.add` for facts with file:line. Do not run second-opinion.
English only.

Report: `Worktree:`, `Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M (ids)`,
`Tests:` with counts, mutation survivors.
