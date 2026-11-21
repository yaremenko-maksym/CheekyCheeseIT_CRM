# Task sources-07c fix round 7 — PR #1431 (second-opinion r6, two confirmed findings)

PR #1431, branch `feat/sources-07c-senior-queue-closed-1`, head `63102ce07` (reviews APPROVE / PASS on it).
Start: `git fetch origin && git checkout -B fix-1431-r7 origin/feat/sources-07c-senior-queue-closed-1 && git merge origin/main`.
Fresh worktree: `pnpm install --frozen-lockfile`, `pnpm --filter @crm/inference build`, `pnpm --filter @crm/web build`.

## Do (zone `apps/**`)

1. **SO6-1** `apps/api/src/interviews/interviews.service.ts` `move()`: `lockedCards.find((card) => card.id === id)`
   compares the route id as typed. Postgres `uuid` matched an uppercase id in the earlier read, so an uppercase id
   gives a false 404 `INTERVIEW_NOT_FOUND`. Compare against the id of the row already read (`interview.id`).
   Unit test: uppercase route id moves the card (red on `63102ce07`, green after).
2. **SO6-2** (pre-existing) `create()` sets the new HR_SCREEN position to `count()` of the column. `remove()`
   deletes without renumbering, so after a delete the count equals an existing position (0,1,2 -> delete 0 ->
   1,2 -> new card at 2: duplicate). Use `coalesce(max(position), -1) + 1` for the column (or renumber in
   `remove()` under `lockSeniorBoard` — pick the smaller change and say why). Integration spec on a scratch DB
   (`DATABASE_URL` inline, `crm_qa_07c_r7`, never `crm_db`): delete a middle/first card, create, positions distinct.
   Red-check on `63102ce07`. The existing CR6-L-3 race spec must stay green.
3. Typecheck, eslint, prettier, unit + interviews integration specs, mutation gate on changed lines
   (`node scripts/devops/mutation-gate.mjs --changed`).
4. PR body: append a "Fix round 7" table (SO6-1, SO6-2: outcome + commit). Re-read the body right before you
   write it (`gh pr view 1431 --json body --jq .body > f`, edit, `gh pr edit 1431 --body-file f`).

## Rules

Commit with `ac_verified: 1,2,3` plus `SO6-1 SO6-2`. Push
`DATABASE_URL= git push origin HEAD:feat/sources-07c-senior-queue-closed-1` in the background, verify with
`git ls-remote`; do not end your turn while a command you depend on runs. Never --no-verify. Notes server:
`notes.search` first, `notes.add` facts with file:line. No second-opinion. English only. Report: `Worktree:`,
`Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M`, `Tests:` with counts (red/green), mutation survivors.
