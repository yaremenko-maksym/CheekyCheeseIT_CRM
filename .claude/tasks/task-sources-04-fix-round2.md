# Task sources-04 fix round 2 — PR #1429 (two LOW findings, comment + PR body)

Parent task: `.claude/tasks/task-sources-04-wn-muse-smartrecruiters.md`. PR #1429, branch
`feat/sources-04-wn-muse-smartrecruiters`, head `0dccf754a`. Round-2 reviews: 5979653439 (code+security APPROVE),
5979654523 (spec PASS). Start: `git fetch origin && git checkout -B fix-04-r2 origin/feat/sources-04-wn-muse-smartrecruiters`.

## Findings

- **CR-L-10** `apps/api/src/job-sourcing/providers/manifest.drift.spec.ts`, the comment in the test
  "blocks the types that are not ready…": it says the Working Nomads **and Muse** rows still have
  `manifest_id IS NULL`, so step 1 adopts both. True of Working Nomads only. The Muse row already carries
  `muse.api.software-engineering-senior` (claimed by earlier deploys), so step 1 does not touch it and step 5
  (match on `s.manifest_id = m.manifest_id`) moves its readiness. Rewrite the comment to say that. Comment only,
  no code or assertion change.
- **CR-L-9** PR body: the out-of-zone list (claimed to be derived from `git diff --name-only`) omits
  `apps/api/src/job-sourcing/http/source-errors.ts`. Add it with its reason: a comment-only edit (2 lines removed,
  3 added) made inside the merge commit with main, because the merge removed `SourceNotPermittedError`.
  Also append a "Fix round 2" table (CR-L-9, CR-L-10 resolved). Edit with
  `gh pr view 1429 --json body --jq .body > f`, edit, `gh pr edit 1429 --body-file f`.

## Rules

Zone: that one spec file plus the PR body. Run `manifest.drift.spec.ts`, prettier, eslint on the file. Commit
with the `ac_verified:` line of the parent task (copy it from the branch's last non-wip commit); push
`DATABASE_URL= git push origin HEAD:feat/sources-04-wn-muse-smartrecruiters` in the background, verify with
`git ls-remote`. Never --no-verify. Notes server: `notes.search` first. No second-opinion. English only.
Report: `Worktree:`, `Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M`, `Tests:` with counts.
