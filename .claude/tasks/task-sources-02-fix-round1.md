# Task sources-02 fix round 1 — PR #1433 (Djinni must store postings on prod)

Parent task: `.claude/tasks/task-sources-02-djinni.md`. PR #1433, branch
`feat/sources-02-djinni-employer-withheld`, head `4d640ef92`. Owner requirement: Djinni MUST work on prod.

## Master facts (measured 2026-11-19, read-only)

- Prod latest run `djinni.rss.python` (main code, adapter `djinni-1`): `outcome SUCCEEDED`, `coverage PARTIAL`,
  `last_http_status 200`, `bytes_read 420727`, `request_count 1`, `received 0`, `invalid 0`, `created 0`,
  `newest_item_published_at` NULL, checkpoint validators `etag null`, `lastModified` set.
  Same for `djinni.rss.rust`. Every Djinni run since rollout looks like this.
- The same URL fetched from the VPS and locally: HTTP 200, 420727 bytes, 97 `<item>` elements.
- `received` is `counts.raw` (`providers/reporting-provider.ts`). So on prod the RSS path turns a full
  97-item body into 0 raw items without an error. Your local capture gave `raw: 96` on the PR branch, so
  something differs between prod and your run (code on main vs branch, parser path, a byte/item limit, a
  RECENT-feed filter against the checkpoint, the conditional-GET / validators branch, coverage PARTIAL …).
- Prod `job_sources.namespace` is `''` for both enabled DJINNI_RSS rows, and `djinni.provider.ts` passes
  `namespace: config.namespace`. PR #1428 (WWR) found that `normalizeNamespace('')` returns null, so every
  observation quarantines as `INVALID_NAMESPACE`. With the employer quarantine lifted, Djinni will hit this
  next.

## Do

1. **Root-cause `received 0`** with a red command first (skill `diagnosing-bugs`): reproduce with the
   exact prod inputs (config `{"primaryKeyword":"Python"}`, config_version 1, a checkpoint like the one
   above, and the live body — external GETs to djinni.co are owner-approved for diagnosis; a 403/429/
   challenge ends it, no UA change / proxy / headless). Fix the cause in this PR, with a regression test
   that fails on main's behaviour.
2. **Namespace.** Do what PR #1428 does for WWR: in the Djinni `configSchema`, `namespace` is
   `z.preprocess((v) => (v === '' ? undefined : v), z.literal(DJINNI_NAMESPACE).default(DJINNI_NAMESPACE))`
   with `DJINNI_NAMESPACE = 'djinni'` (check the Zod v4 form with context7). Bump `configVersion` of both
   Djinni manifest entries in `manifest.definitions.ts` so the delta's revise step rewrites the stored
   namespace; regenerate the delta with the repo generator (never hand-edit), update the manifest specs.
   Test: `''` and absent parse to `djinni`, the batch scope and identity use `djinni`, nothing quarantines.
   Leave EU Remote Jobs alone (out of scope).
3. A test that runs the full path (body → batch counts) with prod-shaped config and checkpoint and asserts
   `raw > 0`, `normalized > 0`, `quarantined == 0`.

## Rules

Zone `apps/**`, `packages/**`. Red-check every new assertion. Typecheck, eslint, prettier, mutation gate on
changed lines. Integration specs only on a scratch DB, `DATABASE_URL` inline. Commit with `ac_verified:`;
push `DATABASE_URL= git push` (background), verify `git ls-remote`. Add a "Fix round 1" section to the PR
body naming the root cause. Notes server as before. No second-opinion. English only.
Report: `Worktree:`, `Pushed:`, root cause in one sentence with file:line, `Tests:` with counts, survivors.
