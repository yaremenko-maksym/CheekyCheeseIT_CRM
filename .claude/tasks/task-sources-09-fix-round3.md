# Task sources-09 fix round 3 — PR #1434 (CR2-H-1: semantic conflict with #1428)

PR #1434, branch `fix/sources-09-rss-received-zero`, head `7cfcbee0e`. Delta review r2 (5997281554) BLOCK on CR2-H-1:
CI `Integration Tests (Postgres)` fails on the PR merge ref. #1428 (merged into main as `739f71abb`) made the WWR
config schema `namespace: z.literal('wwr')` (empty string preprocessed to the default). The schema-invalid case in
`apps/api/src/job-sourcing/runtime/job-run-worker.counts.integration.spec.ts` seeds a WWR_RSS source with
`config: { configVersion: 1, namespace: 'wwr-schema-invalid' }`, which now ends the run `CONFIG_INVALID` / FAILED.

Start: `git fetch origin && git checkout -B fix-1434-r3 origin/fix/sources-09-rss-received-zero && git merge origin/main`.
Fresh worktree: `pnpm install --frozen-lockfile`, `pnpm --filter @crm/inference build`, `pnpm --filter @crm/web build`.

## Do

1. First reproduce red: run the counts integration spec after the merge on scratch DB `crm_qa_s09_r3` (`DATABASE_URL`
   inline, never `crm_db`); confirm the failure is CONFIG_INVALID on that case (quote the failing assertion).
2. Fix the test, not the provider: give the case a config valid under main's WWR schema. If the distinct namespace
   was there to keep the source row unique or isolated from the other WWR case, find what makes source rows unique
   (schema / unique index) and isolate it another way (e.g. a distinct `manifest_id` / source id, or per-test cleanup),
   keeping the case's intent: a schema-invalid item via the mapper fault records received 3 / invalid 1.
   Check the other cases in the file (`namespace: 'djinni'`, `'wwr'`) and any other job-sourcing spec that seeds a
   WWR/Djinni source with a non-default namespace: `git grep -n "namespace: '" apps/api/src/job-sourcing`.
3. Unit + the job-sourcing integration specs on the scratch DB, typecheck, eslint, prettier, mutation gate
   (`node scripts/devops/mutation-gate.mjs --changed`).
4. PR body: append a "Fix round 3" table (CR2-H-1: outcome + evidence). Edit with
   `gh pr view 1434 --json body --jq .body > f`, edit, `gh pr edit 1434 --body-file f` (re-read right before writing).

## Rules

Zone `apps/**`. Commit (merge commit + fix) with `ac_verified: 1,2,3` plus `CR2-H-1`. Push
`DATABASE_URL= git push origin HEAD:fix/sources-09-rss-received-zero` in the background, verify with `git ls-remote`;
do not end your turn while a command you depend on runs — wait with a bounded loop. Never --no-verify. Notes server:
`notes.search` first, `notes.add` facts with file:line. No second-opinion. English only. Report: `Worktree:`,
`Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M`, `Tests:` with counts (red/green), mutation survivors.
