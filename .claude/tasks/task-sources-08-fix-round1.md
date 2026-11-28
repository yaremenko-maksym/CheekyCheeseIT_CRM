# Task sources-08 fix round 1 — PR #1426 (availability reconcile ON)

PR #1426, branch `infra/availability-reconcile-on`, head `6bc0e1731`. Reviews: 5980087990 (code + security
APPROVE), 5980088980 (spec PASS). Start: `git fetch origin && git checkout -B fix-1426-r1 origin/infra/availability-reconcile-on`.
Master names both files below for this task (zone authorised for this task only).

## Findings to fix

- **CR-M-1** `.github/workflows/deploy.yml`, the comment above `JOB_AVAILABILITY_RECONCILE_ENABLED=true`: it says the
  flag makes a taken-down posting "marked closed in the HR queue". On today's data no closure fires: the
  inventory-miss path reads only `FULL_INVENTORY` runs and the window-expiry path needs a latest `WINDOW` run; prod
  runs are all `PARTIAL`. Rewrite the comment: the flag turns on the drain of the `AVAILABILITY:*` partition;
  closures happen only for sources whose runs report `FULL_INVENTORY` or `WINDOW` coverage. Comment only.
- **CR-M-2** `apps/api/src/job-sourcing/job-availability-reconciliation.cron.ts`: capacity 10 batches x 200 x 4
  ticks/day = 8,000 rows/day is below the measured inflow (8.4k-13.4k rows/day) and a 35k backlog. Fix: run the
  cron hourly (`'37 * * * *'`, 48,000 rows/day). Before choosing :37, check that no other `@Cron` in
  `apps/api/src` uses minute 37 hourly (grep the cron constants); pick a free minute if it is taken. Update the
  doc comment ("Every hour at :NN …") and the pinning assertion in `job-availability-reconciliation.cron.spec.ts`
  (red-check it). Do not change `AVAILABILITY_MAX_DRAIN_BATCHES` or the batch size.
- **CR-L-1** PR body, Preconditions bullet SR-M-4: replace "inventory-enabled `job_sources` rows" with the real
  predicate: rows whose `type` is one of the ATS types
  (`GREENHOUSE_ATS, LEVER_ATS, ASHBY_ATS, WORKABLE_ATS, SMARTRECRUITERS_ATS, RECRUITEE_ATS, PERSONIO_ATS`).
- **SPEC-M-1** PR body: add a "Known gap" paragraph. The flag delivers the owner's literal instruction, not yet its
  purpose: closures need `FULL_INVENTORY`/`WINDOW` coverage, and `deriveCoverage` forces `PARTIAL` on any
  quarantined or invalid item. Master tracks the follow-up in the backlog (docs PR).
- **CR-L-2 / SPEC-L-1**: the cited task-file section lands in Master's docs PR. Say so in the PR body.

Append a "Fix round 1" table (all 6 ids, outcome) to the PR body:
`gh pr view 1426 --json body --jq .body > f`, edit, `gh pr edit 1426 --body-file f`.

## Rules

Run the cron spec, `tsc --noEmit` for `@crm/api`, eslint and prettier on the changed files, the mutation gate on
changed lines (`node scripts/devops/mutation-gate.mjs --changed`). Commit with `ac_verified: 1` (the parent task's
single AC: flag on via deploy config) plus the finding ids in the body. Push
`DATABASE_URL= git push origin HEAD:infra/availability-reconcile-on` in the background and verify with
`git ls-remote`. Never --no-verify. Notes server: `notes.search` first. No second-opinion. English only.
Report: `Worktree:`, `Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M`, `Tests:` with counts,
mutation survivors.
