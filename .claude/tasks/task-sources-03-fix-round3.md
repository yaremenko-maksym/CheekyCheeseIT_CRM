# Task sources-03 fix round 3 — PR #1428 (two LOW test findings)

Parent task: `.claude/tasks/task-sources-03-wwr.md`. PR #1428, branch `fix/sources-03-wwr`, head `9c324ea96`.
Round-3 review: PR review id 5979429240 (APPROVE / Spec PASS). Start:
`git fetch origin && git checkout -B fix-wwr-r3 origin/fix/sources-03-wwr`.

## Findings (test files only)

- **CR3-L-1** `apps/api/src/job-sourcing/providers/manifest.golden.spec.ts`: the expected config version is derived
  with `e.id.startsWith('wwr.rss.')` instead of being pinned per row. Fix: add `configVersion` as a column of the
  pinned `rows` table (2 for the two WWR rows, 1 elsewhere, matching `manifest.definitions.ts`), assert against it,
  drop the prefix derivation.
- **CR3-L-2** `apps/api/src/job-sourcing/providers/sources/wwr.provider.spec.ts`: the `'wrr'` rejection is asserted
  twice (refused table + a standalone `it`). Drop the standalone `it`; keep the table row.

## Rules

Zone: those two spec files only. Do not touch production code or the delta SQL. Red-check CR3-L-1 (change one
pinned version, see the test fail, restore). Run both specs plus `manifest.drift.spec.ts` and `manifest.spec.ts`,
`tsc --noEmit` for `@crm/api`, prettier, eslint. Commit with `ac_verified: 1,2,3`; push
`DATABASE_URL= git push origin HEAD:fix/sources-03-wwr` in the background, verify with `git ls-remote`. Append a
"Fix round 3" table to the PR body (`gh pr view 1428 --json body --jq .body > f`, edit, `gh pr edit 1428 --body-file f`).
Never --no-verify. Notes server: `notes.search` first. No second-opinion. English only.
Report: `Worktree:`, `Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M`, `Tests:` with counts.
