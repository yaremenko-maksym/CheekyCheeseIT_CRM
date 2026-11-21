# Task sources-10 fix round 1 — PR #1438 (Arbeitnow 24 MiB cap + near-cap alert)

PR #1438, branch `feat/sources-10-arbeitnow-headroom`, head `8b1d94638`. Review 5999110439 (Verdict BLOCK, Spec FAIL,
Security APPROVE, H=1 M=4 L=3). Read it in full:
`gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/1438/reviews/5999110439 --jq .body`.
Original task: `.claude/tasks/task-sources-10-arbeitnow-headroom.md` (same directory as this file).
Start: `git fetch origin && git checkout -B fix-1438-r1 origin/feat/sources-10-arbeitnow-headroom`.
Fresh worktree: `pnpm install --frozen-lockfile` and `pnpm --filter @crm/web build` before the first push.

## Master decisions (A1, recorded; put them in the PR body "Assumptions")

- **No DDL in this PR.** The near-cap signal is per PAGE, never the run-total `bytes_read`.
- **H1 + M3:** implement `observePageBytes` in the production `CollectionContext` (`runtime/collection-context.ts`)
  and track the largest decoded page of the run. Persist it only if an existing column/jsonb of
  `job_collection_runs` can carry it without DDL (check the Drizzle schema and the stored run report first). If
  none can, the health detector uses `bytes_read / request_count` (average page) — no false positives, may miss a
  single large page; mark it `// shortcut: average page, upgrade with a max_page_bytes column (backlog)` and add
  that column to the PR body "Follow-ups". The per-page `logger.warn` at the fetch moment stays (exact signal).
  Tests: multi-page run whose total is > 80% of the cap but every page < 80% -> no signal (red against
  `8b1d94638`); a run with a near-cap page -> signal.
- **M2:** the owner asked for "24 MiB + alert". Add `PAYLOAD_GROWTH` to `alertStateOf` (`health-alert-policy.ts`)
  so it reaches the same channel `SCHEMA_DRIFT` does, with the same dedup/cooldown. Fix the docblocks to match.
- **M1:** drop `.claude/tasks/BACKLOG-followups.md` from the PR entirely (restore it to `origin/main`). Master
  closes backlog 467 after merge.
- **M4:** remove the `Stryker disable all` on `declaredCapBytes` and kill its mutants with a real test.
- **L1:** choose the 24 MiB ceiling by the fetched URL's host, not by "host list contains".
- **L2:** one exported constant for the allowlist (used by transport and `api-json.provider.ts`), one for the
  0.8 ratio; drop the always-true `requestMaxBytes !== undefined` guard; document that the warning also fires at
  80% of a source's default cap.
- **L3:** state the memory estimate (~0.7 GB peak while parsing a 24 MiB page; fits the 7.5 GiB host) in Assumptions.

## Verify

Typecheck, eslint, prettier, unit, the job-sourcing health integration specs on a scratch DB (`DATABASE_URL`
inline, `crm_qa_s10_r1`, never `crm_db`), mutation gate on changed lines (`node scripts/devops/mutation-gate.mjs --changed`).

## Rules

Zone `apps/**`, `packages/**` only. Commit with `ac_verified: 1,2,3,4,5` plus the finding ids. PR body: append a
"Fix round 1" table (H1, M1-M4, L1-L3: outcome + evidence); re-read the body right before writing
(`gh pr view 1438 --json body --jq .body > f`, edit, `gh pr edit 1438 --body-file f`). Push
`DATABASE_URL= git push origin HEAD:feat/sources-10-arbeitnow-headroom` in the background, verify with
`git ls-remote`; do not end your turn while a command you depend on runs. Never --no-verify. Notes server:
`notes.search` first, `notes.add` facts with file:line. No second-opinion. English only. Report: `Worktree:`,
`Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M`, `Tests:` with counts (red/green), mutation survivors.
