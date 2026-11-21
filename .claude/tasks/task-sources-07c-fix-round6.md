# Task sources-07c fix round 6 — PR #1431 (delta review r6)

PR #1431, branch `feat/sources-07c-senior-queue-closed-1`, head `4da32dfff`. Reviews on that head: 5997289766
(code APPROVE, security APPROVE, H=0 M=1 L=6), 5997290024 (spec PASS, L=2). Read both in full:
`gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/1431/reviews/5997289766 --jq .body` (and ...5997290024).
The PR CONFLICTS with main (`.github/workflows/deploy.yml`, `docs/runbooks/deployment.md`,
`scripts/devops/deploy-stack-on-vps.sh`), so NO CI ran on `8bcda33af` / `4da32dfff` (CR6-M-1).
Two agents push to one branch on disjoint files. Part B merges main FIRST and pushes it; Part A integrates with
`git fetch origin && git merge origin/feat/sources-07c-senior-queue-closed-1` (merge, not rebase — the branch now
carries a merge commit) right before its push. Fresh worktree: `pnpm install --frozen-lockfile`,
`pnpm --filter @crm/inference build`, `pnpm --filter @crm/web build`.

## Part B — DevOps (zone `scripts/devops/**`, `.github/workflows/**`, `docs/runbooks/**`) — do the merge first

- **CR6-M-1**: `git merge origin/main`, resolve the 3 conflicts (skill `resolving-merge-conflicts`: each hunk by each
  side's intent traced to its commit/PR; main's deploy changes must survive intact, this PR's own hunks re-applied).
  Push the merge right away. Then watch CI on the new head (`gh pr checks 1431`, single bounded probes) — typecheck,
  lint, unit, integration, E2E, Mutation Gate must all run and pass; report counts.
- **CR6-L-4**: `scripts/devops/mutation-gate-runbook.md` mixed-diff paragraph still points at arm 1 (single file, no
  CSS-only file). Point it at what actually demonstrates a mixed diff, or state plainly that the proof does not cover it.
- **CR6-L-5 / SPEC6-L-1**: `ci.yml` misc-shard comment cites run 44623136500, a PR run on another branch, as a main
  run. Measure from a real main run (`gh run list --branch main --workflow CI`) and cite it correctly.
- **CR6-L-6**: the vacuum proof does not count Stryker timeouts. Count `Timeout` in arm 1; assert it is 0 with a
  message "re-run on an idle machine (N timeouts)"; add timeouts into the arm-4 expected total. Loosen nothing.
  Then run the full proof once at low load (check `uptime`; wait for load < 8, bounded) and get 9/9. If it is not
  9/9, report the exact counts and stop. Report each arm and the report file.

## Part A — Coder (zone `apps/**`)

- **CR6-L-1**: `move()` in `apps/api/src/interviews/interviews.service.ts`: `.for('update')` -> `.for('no key update')`
  (precedent: `meeting-recorder.service.ts` uses it). Rewrite the lock comment with the true reason the target column
  alone is not enough (an empty target column has no rows to lock; the moved card is not in it yet).
- **CR6-L-2** (pre-existing): if the moved card is not among the locked rows (deleted before the lock), throw the
  existing `INTERVIEW_NOT_FOUND` error (404), not the `?? interview.stage` fallback. Unit or integration test.
- **CR6-L-3** (pre-existing): `create()` and the queue's `createSubmittedInterviewCard` compute a new card's position
  outside the board lock. Take the same per-senior board lock (same order, same lock strength) inside their
  transaction before computing the position (move `create()`'s count into its transaction). Integration spec on
  scratch DB `crm_qa_07c_r6` (`DATABASE_URL` inline, never `crm_db`): a create racing a move ends with distinct
  positions; red-check it if it can be made deterministic, else say so.
- Typecheck, eslint, prettier, unit + interviews and sourcing-queue integration specs, mutation gate on changed lines
  (`node scripts/devops/mutation-gate.mjs --changed`).

## Both

SPEC6-L-2: `8bcda33af` has no `ac_verified:` / `wip:` — history is not rewritten; every new commit carries
`ac_verified: 1,2,3,4,5,6` plus the finding ids. PR body: append a "Fix round 6" table (CR6-M-1, CR6-L-1..L-6,
SPEC6-L-1, SPEC6-L-2: outcome + commit); re-read the body right before writing (`gh pr view 1431 --json body --jq .body > f`,
edit, `gh pr edit 1431 --body-file f`). Push `DATABASE_URL= git push origin HEAD:feat/sources-07c-senior-queue-closed-1`
in the background, verify with `git ls-remote`; do not end your turn while a push, test or proof you depend on is
running — wait with a bounded loop. Never --no-verify. Notes server: `notes.search` first, `notes.add` facts with
file:line. No second-opinion. English only. Report: `Worktree:`, `Pushed: <branch> @ <sha>`,
`Findings: resolved N / disagreed M`, `Tests:` with counts (Part B: CI counts + per-arm outcomes), mutation survivors.
