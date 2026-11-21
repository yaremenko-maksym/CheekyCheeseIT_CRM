# Task sources-12 fix round 3 — PR #1443 (branch `feat/sources-nextleveljobs`, head 2db0c9526)

CI `Integration Tests (Postgres)` fails one assertion: `apps/api/src/job-sourcing/providers/manifest.seed-delta.integration.spec.ts`
line 162 `expect(newEntries()).toHaveLength(21)` receives 22. The PR adds the Next Level Jobs manifest entry, so the
new-entry count is 22. The line above (`after - before === 16 + newEntries().length`) already passes, so rows and
manifest agree; only the literal is stale.

## Do

1. Change `toHaveLength(21)` to `toHaveLength(22)` on that line. No other change.
2. Run that one spec on a scratch DB: `DATABASE_URL=postgresql://<local scratch>/crm_qa_s12_r3 pnpm --filter @crm/api exec vitest run --config <the integration vitest config the api package uses> src/job-sourcing/providers/manifest.seed-delta.integration.spec.ts`
   (create the scratch DB the way the repo's integration guard expects; never `crm_db`). Report the passed count (non-zero).
3. Prettier on the file.

Work on local branch `fix/sources-12-r3` from `origin/feat/sources-nextleveljobs`; commit
`test(job-sourcing): seed-delta count includes Next Level Jobs` with `ac_verified: CI-int-1`; push fast-forward
`DATABASE_URL= git push origin HEAD:feat/sources-nextleveljobs`. Report `Worktree:`, `Pushed: <branch> @ <sha>` (verify
with `git ls-remote origin feat/sources-nextleveljobs`).

## Rules

Zone `apps/api/**` only. Every Edit/Write path starts with your own `git rev-parse --show-toplevel`. No `--no-verify`,
explicit `git add`, never create `.claude/.allow-direct-edits`. No second-opinion. Pre-push runs the suites (~25 min):
run it in the background and wait for it; do not start a second push.
