# Task sources-03 re-merge — PR #1428 (WWR) after #1433 (Djinni) landed

Parent task: `/Users/maksym/.t3/worktrees/CheekyCheeseIT_CRM/t3-e2d4e8c0-f9e0b534f5d3bb43/.claude/tasks/task-sources-03-wwr.md`.
PR #1428, branch `fix/sources-03-wwr`, head `3e1ec36b3`. Reviews APPROVE / PASS on `69ac72a60`. PR #1433 merged
into main as `623923ad7` (Djinni namespace default + `configVersion: 2` revise for Djinni rows). Merge order agreed:
#1433 first, #1428 adapts (A1, Master).

Start: `git fetch origin && git checkout -B fix-1428-remerge origin/fix/sources-03-wwr && git merge origin/main`.
Fresh worktree: `pnpm install --frozen-lockfile` and `pnpm --filter @crm/web build` before the first push.

## Conflicts (measured with `git merge-tree`)

- `apps/api/drizzle/manual/2026-10-24_job_sources_manifest_delta.sql` — a GENERATED file. Do not hand-merge it: take
  either side, then regenerate it with the repo's generator (find it: the manifest seed-SQL script / the
  `manifest.seed-sql.ts` emitter and the spec that asserts the file is up to date) so it carries BOTH the Djinni rows
  (`config_version 2`, namespace `djinni`) and this PR's WWR rows.
- `apps/api/src/job-sourcing/providers/manifest.golden.spec.ts` — keep #1433's design (skill
  `resolving-merge-conflicts`: resolve each hunk by each side's intent, traced to its commit). Both sides' assertions
  must survive: Djinni's and WWR's.

## Do

1. Merge, resolve, regenerate. Check whether WWR's namespace fix uses the same mechanism as Djinni's on main
   (`DJINNI_NAMESPACE` docblock in `providers/sources/djinni.provider.ts`: `z.preprocess` turning a stored `''` into
   the default, plus a `configVersion` bump so the seed-delta revise step rewrites the stored row). If WWR differs
   in a way that leaves prod WWR rows (stored `namespace ''`) quarantined `INVALID_NAMESPACE`, align it and say so.
2. Unit tests for job-sourcing + the manifest specs; typecheck; eslint; prettier; mutation gate on changed lines
   (`node scripts/devops/mutation-gate.mjs --changed`).
3. Commit (merge commit + any fix commit) with `ac_verified:` of the branch's last non-wip commit. Push
   `DATABASE_URL= git push origin HEAD:fix/sources-03-wwr` in the background; verify with `git ls-remote`.
4. PR body: append a "Re-merge after #1433" section: conflicts, how each was resolved, regenerated delta, test counts.
   Edit with `gh pr view 1428 --json body --jq .body > f`, edit, `gh pr edit 1428 --body-file f`.

## Rules

Zone `apps/**`, `packages/**`. Scratch DB only if an integration spec is needed (`DATABASE_URL` inline,
`crm_qa_wwr_rm`, never `crm_db`). Never --no-verify. Notes server: `notes.search` first, `notes.add` facts with
file:line. No second-opinion. English only. Report: `Worktree:`, `Pushed: <branch> @ <sha>`, conflicts resolved,
`Tests:` with counts, mutation survivors.
