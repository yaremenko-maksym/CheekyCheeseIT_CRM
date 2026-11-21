# Task sources-09 fix round 1 — PR #1434 (run counters: which bucket goes where)

Parent task: `.claude/tasks/task-sources-09-rss-received-zero.md` (on the PR branch). PR #1434, branch
`fix/sources-09-rss-received-zero`, head `45be09b40`. Reviews on that head: 5982040217 (code BLOCK, security
APPROVE), 5981837586 (spec PASS, 2 L). Read both in full:
`gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/1434/reviews/<id> --jq .body`.
Start: `git fetch origin && git checkout -B fix-1434-r1 origin/fix/sources-09-rss-received-zero`.
Fresh worktree: `pnpm install --frozen-lockfile` and `pnpm --filter @crm/web build` before the first push.

## Master decision (A1, recorded here; put it in the PR body "Assumptions")

`refused` today is `toStoredReportCounts().invalid` = schema-invalid + quarantined + discarded, and all of it lands
in both `received` and `invalid`. Split it by what each bucket means:

| Bucket | `received` | `invalid` | `persistence_errors` |
| --- | --- | --- | --- |
| schema-invalid (the provider's item failed the schema) | + | + | |
| quarantined (identity seam refused it: `INVALID_NAMESPACE`, `MISSING_COMPANY`, ...) | + | | |
| discarded (our own page write failed, `PERSISTENCE`) | | | + (only the items not already persisted) |

Why: `invalid / received > 10%` drives `SCHEMA_DRIFT` -> `DEGRADED` -> alert (`health/detectors.ts`
`detectFormatDrift`, `health/health-alert-policy.ts`). Quarantine is a steady state for some boards (committed
captures: Lever/Spotify raw 6 / quarantined 6, Ashby/Linear raw 4 / quarantined 4, all `MISSING_COMPANY`), and a
DB failure is not provider drift (CR-M-1, CR-M-2, SO E1). Quarantined items in `received` alone raise no alert:
`detectSilence` needs a history of created items and `EMPTY_RESPONSE` needs a non-empty baseline — verify this
with a test for a never-created, 100%-quarantined source (health stays as on main) and state it in the PR body.

## Findings to resolve

- **CR-M-1 / SO-E1** discarded -> `persistence_errors`, never `invalid`.
- **CR-M-2** quarantined -> `received` only. The PR body's "no-op for the 18 working types" claim: replace with
  what is true per bucket.
- **CR-L-1 / SO-E2** chunked page (`chunkPage` in `runtime/job-run-worker.ts` `savePage`): chunks committed before
  the failing chunk are already in the persisted `received`; do not count them again (neither in `received` nor in
  `persistence_errors`). If the provider cannot tell which chunks landed, count the whole page in
  `persistence_errors` only and leave a `shortcut:` comment. Test the >cap, second-chunk-fails case.
- **SO-E3** `endRun` computes `nonEmpty` from `received` read BEFORE the increment: use the value after it, so a
  run that read only refused items counts as non-empty. Check `last_nonempty_at`'s consumers agree; test it.
- **CR-L-2 + SP-L-1 + SP-L-2** PR body "Alert consequence": state per detector what changes (`detectFormatDrift`
  only on schema-invalid now; `detectSilence` `stillReceiving` and `EMPTY_RESPONSE` with quarantined in
  `received`; `run-provenance.ts`), the prod fact behind the Djinni/WWR case (stored `namespace` '' ->
  `INVALID_NAMESPACE` quarantine), and a verification condition (what a prod SELECT shows after deploy). Note that
  `invalid` was 0 for every source type before, so the drift ratio never fired for any source.
- **CR-L-3** `summaryCounts` computed twice in `job-run-worker.ts`: compute once.
- **CR-L-4** the review says nothing writes `job_collection_runs.coverage`; prod rows carry `PARTIAL`. Find the
  writer (`deriveCoverage` and its caller) and answer in the PR body; no code change unless it is really missing.
- **CR-L-5** merge order is **#1433 (Djinni namespace), then #1428 (WWR), then this PR**. Fix the PR body and this
  branch's task file text that says the opposite.
- Keep the regression test red on main / green after for both feed shapes: with this split, a Djinni-shaped
  all-quarantined feed stores `received > 0, invalid 0`.

Append a "Fix round 1" table (all ids above: outcome + evidence). Edit with
`gh pr view 1434 --json body --jq .body > f`, edit, `gh pr edit 1434 --body-file f`.

## Rules

Zone `apps/**`, `packages/**` (plus the branch's own task file for CR-L-5). Typecheck, eslint, prettier, unit
tests, the integration specs on a scratch DB (`DATABASE_URL` inline, e.g. `crm_qa_s09_r1`, never `crm_db`),
mutation gate on changed lines (`node scripts/devops/mutation-gate.mjs --changed`). Commit with `ac_verified: 1,2,3`
plus the finding ids. Push `DATABASE_URL= git push origin HEAD:fix/sources-09-rss-received-zero` in the
background, verify with `git ls-remote`. Never --no-verify. Notes server: `notes.search` first, `notes.add` facts
with file:line. No second-opinion. English only. Report: `Worktree:`, `Pushed: <branch> @ <sha>`,
`Findings: resolved N / disagreed M`, `Tests:` with counts (red/green), mutation survivors.
