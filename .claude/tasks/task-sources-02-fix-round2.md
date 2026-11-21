# Task sources-02 fix round 2 — PR #1433 (Djinni must store postings on prod)

Parent task: `.claude/tasks/task-sources-02-djinni.md`. PR #1433, branch
`feat/sources-02-djinni-employer-withheld`, head `260ff6853`. Owner requirement: Djinni MUST store postings on prod.
Start: `git fetch origin && git checkout -B fix-1433-r2 origin/feat/sources-02-djinni-employer-withheld`, then
`git merge origin/main` (resolve conflicts by each side's intent; skill `resolving-merge-conflicts`).
Fresh worktree: `pnpm install --frozen-lockfile` and `pnpm --filter @crm/web build` before the first push.

## Corrected root cause (Master, from task sources-09 / PR #1434, 2026-11-19)

Round-2 reviews CR-H-1, CR-H-2, SP-H-1, SP-H-2 rest on a premise that is false: "the persisted `received` is
`counts.raw`". It is not. The persisted run row gets `received: page.observations.length`
(`apps/api/src/job-sourcing/store/source-record.store.ts`, the page write), i.e. only the observations that
were stored. Items quarantined before storage (`INVALID_NAMESPACE` from `normalize/identity-key.ts`) are not
counted anywhere persisted; the honest counts (`toStoredReportCounts` in `providers/reporting-provider.ts`) go into
an in-memory run report that is never written. So a feed whose every item is quarantined stores `received 0,
invalid 0` — prod's exact picture. PR #1434 (`fix/sources-09-rss-received-zero`) makes the counters honest; it does
not make Djinni store postings. The namespace fix in THIS PR is what does.

Prod facts (read-only, 2026-11-19): two `DJINNI_RSS` rows, both `enabled`, `ACTIVE`, readiness `CANDIDATE`,
`consecutive_failures 0`, no cooldown, stored `namespace` = empty string. No quarantine table exists on prod.

## Do

1. **Prove the chain end to end (this is the regression test SP-M-1 asks for).** Through the REAL worker path
   (`runtime/job-run-worker.ts` with the real Djinni binding, transport stubbed only at the HTTP boundary with the
   committed 97-item capture, the real store), on a scratch DB (`DATABASE_URL` inline, `crm_qa_djinni_r2`, never
   `crm_db`), with a prod-shaped source row (empty `namespace`, `config {"primaryKeyword":"Python"}`,
   config_version as prod's). Assert on the PERSISTED rows: `job_collection_runs.received` and the source-record
   count. Red-check it on main's code (expected: 0 stored), green on this branch (expected: > 0 stored). If the
   branch also stores 0, STOP and report — the root cause is elsewhere.
   An integration spec is the right shape (`*.integration.spec.ts`, graceful-skip without `DATABASE_URL`).
2. **Rewrite the durable text** (CR-H-1): the three comments the review cites
   (`providers/sources/djinni.provider.ts` `DJINNI_NAMESPACE` docblock, `providers/manifest.definitions.ts` Djinni
   entry, `providers/sources/djinni.provider.spec.ts`) and the PR body must state the real mechanism: empty stored
   namespace -> every item quarantined `INVALID_NAMESPACE` before storage -> nothing persisted; the run row reads
   `received 0` because it counts stored observations (PR #1434 makes refused items visible). Describe behaviour and
   symbols, no line numbers (`doc-durability.md`).
3. **CR-M-2** `identity/resolver.spec.ts`: rename the case titled "still merge with a disclosed posting only when
   that one agrees on a real company" to what it asserts (DISTINCT on title alone), or add the agreeing-company
   merge assertion. Pick the rename unless the merge case is missing elsewhere.
4. **CR-M-1** (overlap with #1428 in `manifest.golden.spec.ts`): merge order is #1433 first, #1428 after. Keep this
   PR's design; #1428 re-merges main and adapts. Say so in the PR body. Nothing to change here beyond the main merge.
5. PR body: append a "Fix round 2" table (CR-H-1, CR-H-2, CR-M-1, CR-M-2, SP-H-1, SP-H-2, SP-M-1 — outcome and
   evidence; for CR-H-2/SP-H-2 the evidence is item 1's red/green). Edit with
   `gh pr view 1433 --json body --jq .body > f`, edit, `gh pr edit 1433 --body-file f`.

## Rules

Zone `apps/**`, `packages/**`. Typecheck, eslint, prettier, unit tests, the new integration spec on the scratch DB,
mutation gate on changed lines (`node scripts/devops/mutation-gate.mjs --changed`). Commit with the `ac_verified:`
line of the branch's last non-wip commit plus the finding ids. Push
`DATABASE_URL= git push origin HEAD:feat/sources-02-djinni-employer-withheld` in the background, verify with
`git ls-remote`; push early (after the main merge). Never --no-verify. External GETs to djinni.co are not needed
(use the committed capture). Notes server: `notes.search` first, `notes.add` facts with file:line. No
second-opinion. English only. Report: `Worktree:`, `Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M`,
`Tests:` with counts (red on main, green on branch), mutation survivors.
