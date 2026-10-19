import { Client } from 'pg'

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
 * THE GUARD AGREES WITH THE CONSUMER BY ASKING IT
 * -----------------------------------------------
 * `extractDbName` reads the URL's PATH. `pg` does not always: for a `socket:` URL it takes the
 * database from `?db=` and ignores the path, so `socket:/var/run/postgresql?db=crm_db` is the live
 * database to `pg` while the path says `var/run/postgresql` (measured, `pg` 8.x). Rather than add
 * that rule to ours — a second copy of someone else's parser, which is how this class of bypass
 * kept coming back — the guard also asks `pg` itself: `new Client({ connectionString }).database`
 * parses the URL exactly as a real connection would and opens nothing. A URL is refused if EITHER
 * says it is the live database.
 *
 * TWO CONSUMERS, TWO RULES — do not "fix" one to match the other. `?dbname=` is deliberately NOT
 * handled here: for node-pg the path overwrites the database, so `…/other?dbname=crm_db` resolves
 * to `other`. It is libpq (`psql`, a dev server's native client) that honours it, which is why the
 * shell-side `pre-bash-live-db-guard.sh` covers it. A test pins the node-pg behaviour, so a `pg`
 * upgrade that changes it fails loudly instead of silently narrowing this guard.
 *
 * A TEST HELPER: nothing at runtime may import it.
 */

/** What the refusal messages tell a developer to do instead; the shape that is accepted. */
const ACCEPTED_SHAPE = 'postgresql://crm_user:password@localhost:5432/crm_qa'

/** The database `pg` itself would connect to for this URL, or undefined if it cannot parse it. */
function databaseNodePgResolves(databaseUrl: string): string | undefined {
  try {
    return new Client({ connectionString: databaseUrl }).database?.trim()
  } catch {
    return undefined
  }
}

export function assertNotLiveDb(databaseUrl: string, label: string): void {
  if (
    extractDbName(databaseUrl) === LIVE_DB_NAME ||
    databaseNodePgResolves(databaseUrl) === LIVE_DB_NAME
  ) {
    throw new Error(
      `[${label}] refusing to run against the live ${LIVE_DB_NAME} — point DATABASE_URL at a ` +
        `scratch database, e.g. ${ACCEPTED_SHAPE}`,
    )
  }
  if (extractDbName(databaseUrl) === '') {
    throw new Error(
      `[${label}] cannot determine the database name from DATABASE_URL — refusing to run. Put the ` +
        `database in the path of a URL with a host, e.g. ${ACCEPTED_SHAPE}`,
    )
  }
}
