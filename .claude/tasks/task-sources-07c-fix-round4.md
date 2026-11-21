# Task sources-07c fix round 4 — PR #1431 (delta review r4)

Parent task: `.claude/tasks/task-sources-07c-senior-queue-closed.md`. PR #1431, branch
`feat/sources-07c-senior-queue-closed-1`, head `f23cfc524`. Reviews on that head: 5981336053 (code BLOCK, security
APPROVE), 5981337241 (spec FAIL). Read both in full: `gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/1431/reviews/<id> --jq .body`.
Two agents work in parallel on disjoint files and push to the same branch: always
`git pull --rebase origin feat/sources-07c-senior-queue-closed-1` right before your push.
Fresh worktree: `pnpm install --frozen-lockfile` and `pnpm --filter @crm/web build` before the first push.

## Part A — Coder (zone `apps/**`)

- **CR4-M-1 + SPEC-L-1 + SPEC-L-2** `apps/api/src/interviews/interviews.service.ts` `move()`: it writes
  `position: newPosition` without shifting the incumbents, so the moved card ties with the card it was dropped on,
  and the tie-break (`position, createdAt, id`) then places it by `created_at` — the card slides back after the
  refetch. Fix the outcome: after a move, the moved card sits at the index it was dropped on, and the column's
  positions are distinct. Use the existing renormalisation loops (shift incumbents at/after the target, or
  renormalise the column with the moved card placed at its target index), inside the same transaction. Pin the
  OUTCOME with an integration spec on a scratch DB (`DATABASE_URL` inline, e.g. `crm_qa_07c_r4`, never `crm_db`):
  drop onto an occupied index (up and down), assert the listed order. Red-check it on the current head first.
  Keep or adapt the compiled-SQL unit spec (`interviews-board-order.unit.spec.ts`).

## Part B — DevOps (zone `scripts/devops/**`, `.github/workflows/**`)

- **CR4-H-1 + SPEC-L-3** The `.github/workflows/ci.yml` misc-shard comment hunk in `f23cfc524` was written by
  Master (zone violation). Own it: check its facts (shard timing from a recent main run, the removed
  `tests/job-sourcing-mobile.spec.ts`), and rewrite it in your own commit (wording yours; content must be true).
- **SPEC-M-1 + CR4-L-4** `scripts/devops/mutation-gate-vacuum-proof.sh`: the arm selector (`SELECTED_ARMS`) was not
  asked for. Remove it: the script always runs all four arms, as `mutation-nightly.yml` calls it. That removes
  CR4-L-4.
- **CR4-L-1** the script header still claims it proves the "REAL 2026-08-07 defect, not a synthetic one"; the
  subject is now a hand-written vacuous fixture of `PostingMarkdown`'s test. Rewrite the header, and fix the
  set-aside / NEWER_DEFENCE_TESTS description to what the script does.
- **CR4-L-2** `scripts/devops/mutation-gate-runbook.md`: a verbatim live measurement (`Instrumented 2 source
  file(s) with 5 mutant(s)`, "the ONE real survivor") is attributed to a file it was never measured on, and
  `MARKDOWN_COMPONENTS` is not exported. Replace it with a measurement you take on `PostingMarkdown.tsx`, or remove
  the verbatim block and describe it without numbers.
- **CR4-L-3** fixture has 15 tests (9 `it` + 6 `it.each` rows); the script and runbook say 13. Fix both.
- Run the script once in full and report each arm's outcome (arm 4 can fail spuriously under machine load from
  Stryker timeouts: if so, re-run when idle and report both). Exit 0 without its report is not a pass.

## Both parts

- **SPEC-L-4**: in the PR body's "Fix round 4" table, map each finding to the commit that closes it (including
  CR3-L-1/L-2/L-3 -> `f23cfc524`). Append your rows; re-read the body right before you write it
  (`gh pr view 1431 --json body --jq .body > f`, edit, `gh pr edit 1431 --body-file f`).

## Rules

eslint and prettier on changed files, `tsc --noEmit` where relevant, mutation gate on changed lines
(`node scripts/devops/mutation-gate.mjs --changed`). Commit with `ac_verified: 1,2,3,4,5,6` plus the finding ids.
Push `DATABASE_URL= git push origin HEAD:feat/sources-07c-senior-queue-closed-1` in the background, verify with
`git ls-remote`. Never --no-verify. Notes server: `notes.search` first. No second-opinion. English only.
Report: `Worktree:`, `Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M`, `Tests:` with counts,
mutation survivors.
