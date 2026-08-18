/**
 * Seed DB guard — refuses `db:seed`'s destructive TRUNCATE unless the
 * target database is recognizably disposable.
 *
 * Incident this closes (2026-08-18): an agent preparing an isolated
 * environment wrote its own `.env` pointing at a scratch database, then ran
 * `pnpm --filter @crm/api db:seed`. The command hit the live `crm_db`
 * instead — the agent's shell already had `DATABASE_URL` exported to the
 * live database from an earlier step, and dotenv's `config()`
 * (`loadEnvQuietly`, called at the top of seed.ts) never overrides an
 * already-set `process.env` var, so the `.env` file lost silently. `main()`
 * in seed.ts TRUNCATEs 24 tables (`RESTART IDENTITY CASCADE`) as its very
 * first step, unconditionally. There was no dump and archiving was off —
 * nothing was recoverable.
 *
 * Design (owner decision, 2026-08-18): the check lives IN the seed script
 * itself, not a wrapper script or a git hook — a wrapper can be skipped by
 * calling the underlying command directly, a hook can be bypassed, an
 * inherited env var silently wins over one either way, and an agent's
 * memory of "be careful" does not survive a session boundary. A check that
 * runs unconditionally inside the one function that TRUNCATEs is the only
 * thing that cannot be bypassed by accident — whoever runs this script,
 * however they run it.
 *
 * Allowlist, not denylist: this refuses any database name that does not
 * *look* disposable, rather than merely blocking the one name known today
 * to be dangerous. Deliberately a SEPARATE check from
 * `../test/integration-db-guard.ts` (which protects `*.integration.spec.ts`
 * runs via vitest's `globalSetup`) rather than shared code: that file is
 * only ever loaded by vitest, and importing it here would pull a `pg` Pool
 * connection module into a file that has to stay side-effect-free at import
 * time for its own unit tests — this file makes no network call at all, it
 * is pure string logic, checked before anything opens a socket.
 *
 * "Disposable-looking" is defined by what this repo's own tooling actually
 * uses, not a guess (checked 2026-08-18):
 *   - the ONE real name is `crm_db` — docker-compose.yml's `POSTGRES_DB`,
 *     `.env.example`'s `DATABASE_URL`, and deploy.yml's generated
 *     `/opt/crm/.env.production` on the prod VPS all use exactly this name.
 *   - CI's OWN throwaway Postgres service is ALSO named `crm_db`
 *     (ci.yml + e2e.yml `services.postgres.env.POSTGRES_DB` and each job's
 *     `DATABASE_URL`) — a fresh container recreated per run, safe to wipe.
 *     GitHub Actions sets `CI=true` in every job's environment
 *     automatically (no workflow-file wiring needed), so that is the signal
 *     used to tell "CI's crm_db" apart from "a developer's crm_db" below.
 *   - every OTHER database name actually used anywhere in this repo —
 *     `.env.test`'s `crm_qa`, `run-landing-e2e-local.sh`'s own
 *     `crm_db_scratch` example, and every ad-hoc scratch name an agent has
 *     picked for a one-off integration run (`crm_scratch`, `crm_scratch_x`,
 *     `crm_te_scratch`, `crm_acct_create`, `crm_hr_dash`, …) — follows the
 *     SAME `crm_` prefix convention as the real name. So "disposable" here
 *     means: starts with `crm_`, and is not literally `crm_db`.
 */

export const LIVE_DB_NAME = 'crm_db'
export const DISPOSABLE_NAME_PREFIX = 'crm_'

/** Escape hatch env var — see {@link assertSeedTargetIsDisposable}. */
export const SEED_LIVE_DB_CONFIRM_ENV = 'SEED_CONFIRM_LIVE_DB_NAME'

/**
 * Extracts and normalizes the database name (last path segment) from a
 * Postgres connection string. Percent-decodes (`crm%5Fdb` is the same
 * database as `crm_db` to libpq) and trims surrounding whitespace — the
 * same two bypass classes closed in `run-landing-e2e-local.sh`'s
 * `db_name_from_url()` (review round 3, 2026-08-17) for the same reason.
 *
 * Returns `''` for a malformed URL or a URL with no path segment (an
 * absent dbname defaults to the connecting user's name over the wire, not
 * `crm_db` — not a name that reaches the live database this guard exists
 * to protect, so it is simply "not disposable-looking" rather than
 * specifically dangerous; the empty string already refuses via
 * {@link looksDisposable}).
 */
export function extractDbName(databaseUrl: string): string {
  let pathname: string
  try {
    pathname = new URL(databaseUrl).pathname
  } catch {
    return ''
  }
  const raw = pathname.replace(/^\//, '')
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }
  return decoded.trim()
}

/**
 * Case-sensitive on purpose: Postgres identifiers are case-sensitive unless
 * double-quoted, so `CRM_DB` is a genuinely different database object from
 * `crm_db` — folding case here would only produce false refusals on an
 * unrelated database that happens to share letters.
 */
export function looksDisposable(dbName: string): boolean {
  return dbName.length > 0 && dbName.startsWith(DISPOSABLE_NAME_PREFIX) && dbName !== LIVE_DB_NAME
}

/**
 * Throws BEFORE any TRUNCATE (and before opening any DB connection at all)
 * unless the resolved database name looks disposable, per
 * {@link looksDisposable}, or one of two deliberate exceptions applies:
 *
 *   1. `CI=true` — GitHub Actions' own throwaway container. Checked first,
 *      unconditionally, so a CI run never even has to reach the name check.
 *   2. `SEED_CONFIRM_LIVE_DB_NAME=<exact db name>` — the owner's own
 *      escape hatch to deliberately reseed a database that doesn't look
 *      disposable (their live `crm_db` included). The confirmation value
 *      must equal the EXACT database name being targeted, typed at
 *      invocation time — not a plain on/off flag. A flag like
 *      `SEED_ALLOW_LIVE_DB=1` is exactly the shape of thing that silently
 *      survives in an inherited shell environment (the incident this guard
 *      exists for was caused by precisely that pattern, with
 *      `DATABASE_URL`); a value that must match the specific name of THIS
 *      run's target cannot be satisfied by accidentally-inherited state
 *      from an unrelated earlier session.
 */
export function assertSeedTargetIsDisposable(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env['CI'] === 'true') {
    return
  }

  const dbName = extractDbName(databaseUrl)
  if (looksDisposable(dbName)) {
    return
  }

  if (dbName.length > 0 && env[SEED_LIVE_DB_CONFIRM_ENV] === dbName) {
    console.warn(
      `[seed-db-guard] ${SEED_LIVE_DB_CONFIRM_ENV} confirms wiping '${dbName}' — proceeding.`,
    )
    return
  }

  const shownName = dbName.length > 0 ? dbName : '(unknown — could not parse DATABASE_URL)'
  throw new Error(
    `[seed-db-guard] REFUSED: db:seed will not TRUNCATE database '${shownName}'.\n` +
      `  This database name does not look disposable — expected a '${DISPOSABLE_NAME_PREFIX}'-\n` +
      `  prefixed scratch/QA name, not exactly '${LIVE_DB_NAME}'.\n` +
      `\n` +
      `  seed.ts's main() truncates every table before reseeding — if this is genuinely\n` +
      `  your own database and you want to wipe it on purpose, set:\n` +
      `    ${SEED_LIVE_DB_CONFIRM_ENV}=${dbName || '<exact db name>'} pnpm --filter @crm/api db:seed\n` +
      `  (the value must equal the exact database name above, typed for this run — an\n` +
      `  inherited or stale env var from an earlier session will not accidentally match).\n`,
  )
}
