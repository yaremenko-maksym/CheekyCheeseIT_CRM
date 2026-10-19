import { extractDbName, LIVE_DB_NAME } from '../database/seed-db-guard'

/**
 * The second lock behind `integration-db-guard.ts`, for specs that create roles, databases or
 * grants and so refuse the live database themselves.
 *
 * WHY THIS IS NOT A ONE-LINER IN EACH SPEC
 * ----------------------------------------
 * Three specs used to do `new URL(url).pathname.replace(/^\//, '') === 'crm_db'`. `pg` decodes the
 * database name before it connects, so `…/crm%5Fdb` is the live database while that comparison saw
 * `crm%5Fdb` and let it through — the bypass PR #579 closed in `integration-db-guard.ts` and
 * `seed-db-guard.ts`, reappearing by hand-rolling the parse again. `extractDbName` is the one
 * place that decodes and trims; this calls it and does not parse the URL itself.
 *
 * It also has to fail CLOSED. The old `new URL(…)` threw on a URL it could not parse;
 * `extractDbName` swallows that and returns '', which a bare `=== LIVE_DB_NAME` would wave
 * through. An unknown target is not a disposable one.
 *
 * A TEST HELPER: nothing at runtime may import it.
 */
export function assertNotLiveDb(databaseUrl: string, label: string): void {
  const name = extractDbName(databaseUrl)
  if (name === '') {
    throw new Error(
      `[${label}] cannot determine the database name from DATABASE_URL — refusing to run`,
    )
  }
  if (name === LIVE_DB_NAME) {
    throw new Error(`[${label}] refusing to run against the live ${LIVE_DB_NAME}`)
  }
}
