# Task sources-07c fix round 3 — PR #1431 (second-opinion findings)

Parent task: `.claude/tasks/task-sources-07c-senior-queue-closed.md`. PR #1431, branch
`feat/sources-07c-senior-queue-closed-1`, head `faa36be47`. Two agents work in parallel on disjoint files and
push to the same branch: always `git pull --rebase origin feat/sources-07c-senior-queue-closed-1` right before
your push.

## Part A — Coder (zone `apps/**`)

- **SO-L-1** `apps/api/src/job-sourcing/job-sourcing.service.ts`, the docblock of `openOpportunity`: it still says
  "a SENIOR only when it is a LEAD or TRIAGE for them". Since this PR the method calls `assertNotSenior` first, so a
  SENIOR is refused (403). Rewrite the docblock to the current contract (ADMIN and HR only; SENIOR refused before
  any read). Comment only.
- **SO-L-2** `apps/api/src/interviews/interviews.service.ts`, `move()`: both renormalisation loops read the
  column with `orderBy: [asc(interviews.position)]` only. Positions can tie (CR2-L-1: two concurrent submits get
  the same `max+1`), so the renormalised order of tied cards is arbitrary. Use the same tie-break as the list
  query: `asc(interviews.position), asc(interviews.createdAt), asc(interviews.id)`. Add or extend a unit/
  integration test that pins it (red-check it). Integration specs only on a scratch DB, `DATABASE_URL` inline.

## Part B — DevOps (zone `scripts/devops/**`, `.github/workflows/**`)

- **SO-M-1** `scripts/devops/mutation-gate-vacuum-proof.sh` (run by `.github/workflows/mutation-nightly.yml`)
  hardcodes `TEST_FILE=apps/web/app/components/job-sourcing/__tests__/JobSuggestionDialog.test.tsx`, which this
  PR deletes together with `JobSuggestionDialog.tsx`. The existence check exits 2, so the nightly mutation run
  fails after merge. The defence the proof covers now lives in `PostingMarkdown.tsx`, and the fixture
  `apps/web/app/test/fixtures/2026-08-07-JobSuggestionDialog.vacuum.tsx.txt` imports the deleted dialog.
  Fix: retarget the proof so it still proves what it proved (a vacuous test suite does not pass the gate on
  the defence component), using `PostingMarkdown.tsx` and its real test; rebuild the vacuum fixture as a vacuous
  copy of that test if needed (a fixture under `apps/web/app/test/fixtures/` is allowed for this task). Run the
  script locally and report each arm's outcome; a run that exits 0 without its report is not a pass. Update the
  references in `scripts/devops/mutation-gate.mjs` comments and `scripts/devops/mutation-gate-runbook.md` that
  name the deleted files.

## Rules (both parts)

eslint and prettier on changed files, `tsc --noEmit` where relevant, mutation gate on changed lines
(`node scripts/devops/mutation-gate.mjs --changed`). Commit with the `ac_verified:` line of the branch's last
non-wip commit plus the finding ids. Push `DATABASE_URL= git push origin HEAD:feat/sources-07c-senior-queue-closed-1`
in the background, verify with `git ls-remote`. Append your rows to a "Fix round 3" table in the PR body
(`gh pr view 1431 --json body --jq .body > f`, edit, `gh pr edit 1431 --body-file f`; re-read the body right before
you write it, the other agent may have edited it). Never --no-verify. Notes server: `notes.search` first. No
second-opinion. English only. Report: `Worktree:`, `Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M`,
`Tests:` with counts, mutation survivors.
