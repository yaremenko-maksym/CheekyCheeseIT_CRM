/**
 * Integration-run detection — shared between `vitest.config.mts` and its own
 * unit test (`integration-run-mode.spec.ts`) so the config and the tested
 * logic can never drift apart.
 *
 * CI (and any developer reproducing the integration suite) invokes it as a
 * PATH SUBSTRING filter passed to `vitest run`:
 *
 *   pnpm --filter @crm/api exec vitest run integration.spec
 *
 * `integration.spec` is present in every `*.integration.spec.ts` /
 * `*.realdb.integration.spec.ts` path and absent from every unit spec path
 * (all DB-backed specs share this suffix — see INTEGRATION_SPEC_EXCLUDE_GLOB).
 *
 * Any OTHER invocation — including a plain, unfiltered `pnpm --filter @crm/api
 * test` (exactly what `.husky/pre-push` runs) — is a "non-integration run".
 * On a non-integration run `vitest.config.mts` excludes every integration
 * spec file from test discovery entirely (see INTEGRATION_SPEC_EXCLUDE_GLOB),
 * so those files are never parsed/loaded — regardless of what DATABASE_URL
 * happens to be ambient in the shell. This is what keeps a stray ambient
 * `DATABASE_URL=…/crm_db` (developer's `.env`, inherited by the vitest worker
 * pool) from ever reaching a real Postgres connection on a non-integration
 * run, and also eliminates the cross-file parallel-race class of bugs for
 * that run (the integration specs simply don't execute at all).
 */
export function isIntegrationRun(argv: readonly string[]): boolean {
  return argv.some((arg) => arg.includes('integration.spec'))
}

/**
 * Glob pattern matching every DB-backed integration spec file. Added to
 * vitest's `test.exclude` on non-integration runs (see `isIntegrationRun`
 * above and vitest.config.mts). `**\/*.integration.spec.ts` matches BOTH
 * `*.integration.spec.ts` and `*.realdb.integration.spec.ts` — both filename
 * conventions end in `integration.spec.ts` (verified against every file
 * under `src/**` at the time this was written; no non-`*.integration.spec.ts`
 * spec opens a DB connection).
 */
export const INTEGRATION_SPEC_EXCLUDE_GLOB = '**/*.integration.spec.ts'
