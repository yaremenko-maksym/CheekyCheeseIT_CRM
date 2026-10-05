# task-integration-spec-cleanup

## Agent: coder

## Model: sonnet

## Branch: test/integration-spec-cleanup (off origin/main)

## Design tier: — (not UI; the diff does not touch apps/web / apps/landing)

## Context

The backend coder on PR #367 (2026-07-13) documented with isolated proof a **pre-existing** problem:
`apps/api/src/finance/income-compliance.integration.spec.ts` and
`apps/api/src/admin/admin-summary.integration.spec.ts` fail ONLY on a full sequential
run of the integration suite against the shared `crm_qa` (16/16 identical failures on clean base code with
the changes stashed), while in isolation on a fresh re-seed they pass 30/30.

**Cause** — cross-spec pollution of the shared DB: some integration specs do not clean up after themselves (rows
in `transactions` / `pending_obligations` / `projects` / `users` / `project_members` /
`payout_requests` etc.), while these two specs compute company-wide aggregates (sums over the WHOLE database)
that drift because of other specs' leftovers.

Technical context:

- Integration runs are already sequential: `apps/api/vitest.config.mts` sets
  `fileParallelism: false` for integration runs (see `isIntegrationRun` in the config).
- DB target: `.env.test` → `crm_qa` (vitest picks it up automatically);
  `apps/api/src/test/integration-db-guard.ts` blocks running against `crm_db` — do NOT change its semantics.
- The real dev DB is native postgres `localhost:5432` (NOT a docker container).
- The reference "cleans up after itself" pattern is the new spec of PR #367:
  `apps/api/src/finance/usdt-income-obligations.integration.spec.ts` on branch
  `feature/drop-share-override-and-receiver` (read via
  `git fetch origin feature/drop-share-override-and-receiver` +
  `git show origin/feature/drop-share-override-and-receiver:apps/api/src/finance/usdt-income-obligations.integration.spec.ts`).
  Do NOT touch or merge the #367 branch — only read it as a model.

## Scope / zone

- ONLY `apps/api/**`: `*.integration.spec.ts` + if needed a shared test helper in
  `apps/api/src/test/` (for example, a scoped-fixtures/cleanup utility).
- Do NOT change production code (non-spec files in `apps/api/src`). If you conclude that the pollution
  is caused by a production-code bug (an endpoint leaves orphans) — do NOT fix it yourself, document it in
  `.claude/tasks/task-integration-spec-cleanup.blocked.md` + note it in the PR.

## Concrete changes

1. **Audit of cleanup discipline** of all `*.integration.spec.ts` in `apps/api` (~71 files).
   Classify each one: (a) creates rows and fully cleans them up in afterAll/afterEach;
   (b) creates and does NOT clean up (offender); (c) read-only. Primary method — reading
   beforeAll/afterAll; when in doubt — empirics (row-count snapshots before/after the file against crm_qa).
2. **Pattern A — offenders:** project-scoped/prefixed fixtures (a unique spec prefix in
   email/names) + an `afterAll` cleanup that deletes EVERYTHING created (children → parents by FK).
   The model is the spec from PR #367 above.
3. **Pattern B — company-wide aggregate specs** (`income-compliance`, `admin-summary`; check
   for the same fragility `senior-summary`, `accountant-summary`, `hr-summary`, `total-earned`,
   `transactions.summary.rbac` and other summary specs): rewrite the asserts to a **delta**
   (snapshot the aggregate before inserting scoped fixtures → assert `after == before + expected delta`)
   OR an isolated calculation over the scoped fixtures. Remove absolute company-wide sums.
   A dedicated run order / a separate DB — only as a fallback with justification in the PR.
4. **Forbidden:** deleting/skipping failing tests, weakening asserts "to make it pass"
   (widening tolerances without scoped logic), changing `integration-db-guard.ts`, touching `apps/e2e/**`.

## AC

1. [ ] In the PR body — an audit table: `spec → which tables it pollutes → applied fix (A/B/read-only)`
       for all ~71 integration specs.
2. [ ] All offender specs received prefixed fixtures + afterAll cleanup (pattern A).
3. [ ] Company-wide aggregate specs assert deltas / a scoped calculation, not absolutes (pattern B).
4. [ ] Verification: re-seed crm_qa once (baseline) → a full sequential integration run
       **×2 in a row WITHOUT re-seed between runs** — both green. The final summary lines of both
       runs — in the PR body. (The second green run proves the cleanup discipline.)
5. [ ] `pnpm --filter @crm/api test` (unit, without DATABASE_URL) green; `pnpm typecheck` green;
       `mcp__eslint__lint-files` on all changed files clean.
6. [ ] `pnpm --filter @crm/e2e test` green locally before the final push (the diff contains code).
7. [ ] The diff contains no files outside `apps/api/**` (spec + test helpers) — check
       `git diff --name-only origin/main..HEAD`.

## Verification / git

- Push: `DATABASE_URL= git push` (empty — git-policy; integration specs graceful-skip in pre-push).
- Commit: `test(api): ...` + `ac_verified: ...`.
- PR: normal pipeline, base main. Do NOT touch the merge-approved labels.
- Fresh worktree: `pnpm install --frozen-lockfile` before work (husky/worktree gotcha).
