# Task sources-03 fix round 2 — PR #1428 (WWR RSS namespace)

Parent task: `.claude/tasks/task-sources-03-wwr.md`. PR #1428, branch `fix/sources-03-wwr`, head `13367576d`.
Round-2 review: PR review id 5978870763 (`gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/1428/reviews`).
Start: `git fetch origin && git checkout -B fix-wwr-r2 origin/fix/sources-03-wwr`; push with
`DATABASE_URL= git push origin HEAD:fix/sources-03-wwr` (run it in the background, then verify with `git ls-remote`).

## Findings

- **CR2-M-1** The regenerated manifest delta sets the two WWR rows' `namespace` to `wwr`, but on prod it is a
  no-op: the delta writes `namespace` only on claim (rows with no `manifest_id`), on revise
  (`s.config_version < m.config_version`) and on insert. Prod has 2 claimed WWR rows at `config_version = 1`.
  Fix: bump `configVersion` of both WWR entries (`wwr.rss.all-jobs`, `wwr.rss.devops`) by one in
  `apps/api/src/job-sourcing/providers/manifest.definitions.ts` (Master lifts the round-1 "do not touch"
  limit for this file, WWR entries only). Regenerate the delta with the repo's generator (find it via
  `manifest.drift.spec.ts`; never hand-edit the SQL), update `manifest.golden.spec.ts` / `manifest.spec.ts`.
  The revise step then rewrites config (unchanged), namespace and versions and starts a new checkpoint
  scope: that is the intended effect.
- **CR2-L-1** Use the convention of the other single-namespace adapters, but keep the stored `''` working:
  `namespace: z.preprocess((v) => (v === '' ? undefined : v), z.literal(WWR_NAMESPACE).default(WWR_NAMESPACE))`
  (or the equivalent Zod v4 form; check with context7) in `.extend()`, and drop `namespace` from the
  transform. Test: `''` and absent parse to `wwr`; an unrelated value such as `wrr` is rejected.
- **CR2-L-2** `manifest.spec.ts` test title: "empty for the Djinni and EU Remote Jobs feeds", and add
  `expect(entry('djinni.rss.python').namespace).toBe('')`.
- **CR2-L-3** Not fixed (cache key is a pure function of the asserted `config.namespace`; a test needs a new
  seam). Record it as "disagreed" in the PR body table with that reason.

## Rules

Zone: `apps/api/src/job-sourcing/providers/**` and the generated delta SQL only. Red-check new assertions.
Run the WWR provider spec, manifest specs (including drift and golden), `tsc --noEmit` for `@crm/api`,
prettier, eslint, the mutation gate on changed lines (`node scripts/devops/mutation-gate.mjs --changed`).
Commit with `ac_verified: 1,2,3`. Append a "Fix round 2" table to the PR body (`gh pr edit 1428 --body-file`).
Never --no-verify. Notes server: `notes.search` first, `notes.add` facts with file:line. No second-opinion.
English only. Report: `Worktree:`, `Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M (ids)`,
`Tests:` with counts, mutation survivors.
