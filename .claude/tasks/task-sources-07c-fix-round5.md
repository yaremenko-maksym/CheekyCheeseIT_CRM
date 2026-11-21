# Task sources-07c fix round 5 — PR #1431 (delta review r5, all L)

PR #1431, branch `feat/sources-07c-senior-queue-closed-1`, head `0e3b90cbe`. Reviews on that head: 5996489686
(code APPROVE, security APPROVE, H=0 M=0 L=6), 5996490747 (spec PASS). Read the code review in full:
`gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/1431/reviews/5996489686 --jq .body`.
Two agents push to the same branch on disjoint files: `git pull --rebase origin feat/sources-07c-senior-queue-closed-1`
right before your push. Fresh worktree: `pnpm install --frozen-lockfile` and `pnpm --filter @crm/web build` before
the first push. R5-L-6 (PR body table split) is already fixed by Master.

## Part A — Coder (zone `apps/**`)

- **R5-L-4** `apps/api/src/interviews/interviews.service.ts` `move()`: drop the now-dead `position: newPosition`
  write and the `{ id } as Row` cast (splice a value whose type needs no cast, e.g. ids only).
- **R5-L-5** (pre-existing, fix it now): two concurrent moves into the same column can both read the column and
  write duplicate positions. Serialise the renormalisation inside the existing transaction — lock the target
  column's rows (`SELECT ... FOR UPDATE` over the column, or a transaction-scoped advisory lock keyed by
  `(seniorId, stage)`; pick the one the codebase already uses: grep `pg_advisory_xact_lock` / `for('update')`).
  Pin it with an integration spec on a scratch DB (`DATABASE_URL` inline, `crm_qa_07c_r5`, never `crm_db`): two
  concurrent `move()` calls into one column end with distinct positions. Red-check on the current head if the race
  reproduces deterministically; if it cannot be made deterministic, say so and keep the spec as an outcome check.
- Typecheck, eslint, prettier, unit + the interviews integration specs, mutation gate on changed lines
  (`node scripts/devops/mutation-gate.mjs --changed`).

## Part B — DevOps (zone `scripts/devops/**`, `.github/workflows/**`)

- **R5-L-1** `scripts/devops/mutation-gate-vacuum-proof.sh` NEWER_DEFENCE_TESTS description says "suites written
  after the retarget"; `JobQueueCard.test.tsx` predates it (#1302, 2026-11-09). State the real criterion (the
  suites, other than the vacuous fixture's subject test, that also kill the defence mutants).
- **R5-L-2** `scripts/devops/mutation-gate-runbook.md`: "the worked example quoted here" refers to a quote this PR
  deleted. Rewrite the paragraph so it points only at what exists.
- **R5-L-3** `.github/workflows/ci.yml` misc-shard comment: `~4:28` is the test step, not the job. Measure from a
  recent main run (`gh run view <id> --json jobs`) and state step and job times correctly against
  `timeout-minutes`.
- **Re-run the vacuum proof in full** (`scripts/devops/mutation-gate-vacuum-proof.sh`, all four arms) now: load is
  low (~7). Report each arm's outcome and the report file it produced. Exit 0 without a report is not a pass. If arm 4
  fails on Stryker timeouts again, report the counts and stop; do not loosen the script.

## Both parts

PR body: append a "Fix round 5" table (R5-L-1..L-6: outcome + commit). Re-read the body right before you write it
(`gh pr view 1431 --json body --jq .body > f`, edit, `gh pr edit 1431 --body-file f`). Commit with
`ac_verified: 1,2,3,4,5,6` plus the finding ids. Push `DATABASE_URL= git push origin HEAD:feat/sources-07c-senior-queue-closed-1`
in the background, verify with `git ls-remote`. Never --no-verify. Notes server: `notes.search` first, `notes.add`
facts with file:line. No second-opinion. English only. Report: `Worktree:`, `Pushed: <branch> @ <sha>`,
`Findings: resolved N / disagreed M`, `Tests:` with counts, mutation survivors (Part B: per-arm outcomes).
