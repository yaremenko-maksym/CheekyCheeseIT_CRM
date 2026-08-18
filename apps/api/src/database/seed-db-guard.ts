/**
 * Seed DB guard — refuses `db:seed`'s destructive TRUNCATE (and, since
 * task-ci-db-rename-and-dbpush-guard, `db:push` / `db:migrate`'s destructive
 * schema sync too — see the CLI entry point at the bottom of this file)
 * unless the target database is recognizably disposable.
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
 * Second incident this closes (2026-08-12, follow-up tracked at the time and
 * closed by task-ci-db-rename-and-dbpush-guard): `db:push` (`drizzle-kit
 * push`) synchronizes the database to match `schema.ts` — an agent's
 * checkout was 40 commits behind `main`, and running `db:push` against the
 * live database dropped the `senior_resumes` table because that checkout's
 * `schema.ts` did not know about it yet. `db:push` is a direct third-party
 * CLI invocation (`drizzle-kit`), not TS code this repo owns, so there is no
 * import site to hang an in-process check off of the way `db:seed` has one
 * in `seed.ts` — the CLI entry point at the bottom of this file (`require.main
 * === module`) exists specifically to give it an equivalent check anyway, run
 * as its own process in front of `drizzle-kit push` (wired in
 * `apps/api/package.json`).
 *
 * Design (owner decision, 2026-08-18): the check lives IN the seed script
 * itself, not a wrapper script or a git hook — a wrapper can be skipped by
 * calling the underlying command directly, a hook can be bypassed, an
 * inherited env var silently wins over one either way, and an agent's
 * memory of "be careful" does not survive a session boundary. A check that
 * runs unconditionally inside the one function that TRUNCATEs is the only
 * thing that cannot be bypassed by accident — whoever runs this script,
 * however they run it. `db:push` has no such in-process function to hang the
 * check off of (see above) — the closest equivalent is a process that must
 * run, and exit zero, before `drizzle-kit push` is allowed to start; the CLI
 * entry point at the bottom of this file is exactly that, run from the SAME
 * file (not a copy) so the two commands' disposable-name logic and escape
 * hatch can never drift apart from each other.
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
 * uses, not a guess (checked 2026-08-18, re-checked 2026-08-18 after
 * task-ci-db-rename-and-dbpush-guard's CI rename):
 *   - the ONE real name is `crm_db` — docker-compose.yml's `POSTGRES_DB`,
 *     `.env.example`'s `DATABASE_URL`, and deploy.yml's generated
 *     `/opt/crm/.env.production` on the prod VPS all use exactly this name.
 *   - CI's OWN throwaway Postgres service is named `crm_ci` (ci.yml + e2e.yml
 *     `services.postgres.env.POSTGRES_DB` and each job's `DATABASE_URL`) — a
 *     fresh container recreated per run, safe to wipe, and — same as every
 *     other scratch name below — already `crm_`-prefixed and not literally
 *     `crm_db`, so it needs no special-case exception in this file at all.
 *     (Renamed FROM `crm_db` by task-ci-db-rename-and-dbpush-guard
 *     specifically to remove the need for the `GITHUB_ACTIONS` exception
 *     this file used to carry — a full bypass gated on one inherited env
 *     var is a strictly worse shape of protection than "the name this repo's
 *     own CI already uses happens to pass the same check everyone else's
 *     scratch database does.")
 *   - every OTHER database name actually used anywhere in this repo —
 *     `.env.test`'s `crm_qa`, `run-landing-e2e-local.sh`'s own
 *     `crm_db_scratch` example, and every ad-hoc scratch name an agent has
 *     picked for a one-off integration run (`crm_scratch`, `crm_scratch_x`,
 *     `crm_te_scratch`, `crm_acct_create`, `crm_hr_dash`, …) — follows the
 *     SAME `crm_` prefix convention as the real name. So "disposable" here
 *     means: starts with `crm_`, and is not literally `crm_db`.
 */

import { loadEnvQuietly } from './load-env-quietly'

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
  // `.slice(1)` rather than `.replace(/^\//, '')`: URL.pathname is guaranteed
  // to either be empty or start with `/` (WHATWG URL spec), so there is no
  // observable difference — and no regex left for a mutation gate to flag as
  // an untested equivalent.
  const raw = pathname.slice(1)
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
  // No separate `dbName.length > 0` check: it would be dead code.
  // DISPOSABLE_NAME_PREFIX is non-empty, so an empty dbName already fails
  // `.startsWith(DISPOSABLE_NAME_PREFIX)` on its own — there is no string
  // for which the length check changes the result.
  return dbName.startsWith(DISPOSABLE_NAME_PREFIX) && dbName !== LIVE_DB_NAME
}

/**
 * Per-command copy for the refusal message {@link assertTargetIsDisposable}
 * throws — the disposable-name check and escape hatch are shared between
 * `db:seed` and `db:push`/`db:migrate` (same function, same env var; see
 * {@link SEED_LIVE_DB_CONFIRM_ENV}), but the two commands are destructive in
 * different ways, so the wording naming the danger and the command to
 * re-invoke has to differ.
 */
interface RefusalCopy {
  /** e.g. "db:seed will not TRUNCATE" — the clause right after "REFUSED: ". */
  headline: string
  /**
   * One short paragraph (its own continuation lines pre-indented with two
   * spaces) explaining what the command would have done and introducing the
   * override instructions that follow it.
   */
  dangerParagraph: string
  /** The exact command line to show in the override instructions. */
  commandLine: string
}

const SEED_REFUSAL_COPY: RefusalCopy = {
  headline: 'db:seed will not TRUNCATE',
  dangerParagraph:
    "seed.ts's main() truncates every table before reseeding — if this is genuinely\n" +
    '  your own database and you want to wipe it on purpose, set:',
  commandLine: 'pnpm --filter @crm/api db:seed',
}

const DB_PUSH_REFUSAL_COPY: RefusalCopy = {
  headline: 'db:push (drizzle-kit push) will not run against',
  dangerParagraph:
    'drizzle-kit push syncs the database schema to match schema.ts, which can\n' +
    '  drop or alter existing tables and columns without asking — this is exactly\n' +
    '  what destroyed the live senior_resumes table on 2026-08-12. If this is\n' +
    '  genuinely your own database and you want to push schema to it, set:',
  commandLine: 'pnpm --filter @crm/api db:push',
}

/**
 * Shared refusal logic for both `db:seed` and `db:push`/`db:migrate` —
 * {@link assertSeedTargetIsDisposable} and {@link assertDbPushTargetIsDisposable}
 * are both thin wrappers around this, differing only in the message copy
 * they pass. Deliberately ONE implementation of the disposable-name check
 * and the escape hatch: two separate copies (or two separate escape-hatch
 * env vars) would inevitably drift from each other over time
 * (task-ci-db-rename-and-dbpush-guard, AC6).
 */
function assertTargetIsDisposable(
  databaseUrl: string,
  copy: RefusalCopy,
  confirmSourceEnv: NodeJS.ProcessEnv,
): void {
  const dbName = extractDbName(databaseUrl)
  if (looksDisposable(dbName)) {
    return
  }

  if (dbName.length > 0 && confirmSourceEnv[SEED_LIVE_DB_CONFIRM_ENV] === dbName) {
    console.warn(
      `[seed-db-guard] ${SEED_LIVE_DB_CONFIRM_ENV} confirms wiping '${dbName}' — proceeding.`,
    )
    return
  }

  const shownName = dbName.length > 0 ? dbName : '(unknown — could not parse DATABASE_URL)'
  throw new Error(
    `[seed-db-guard] REFUSED: ${copy.headline} database '${shownName}'.\n` +
      `  This database name does not look disposable — expected a '${DISPOSABLE_NAME_PREFIX}'-\n` +
      `  prefixed scratch/QA name, not exactly '${LIVE_DB_NAME}'.\n` +
      `\n` +
      `  ${copy.dangerParagraph}\n` +
      `    ${SEED_LIVE_DB_CONFIRM_ENV}=${dbName || '<exact db name>'} ${copy.commandLine}\n` +
      `  (the value must equal the exact database name above, typed for THIS run on the\n` +
      `  command line — putting it in apps/api/.env will not work, and an inherited or\n` +
      `  stale env var from an earlier session will not accidentally match).\n`,
  )
}

/**
 * Throws BEFORE any TRUNCATE (and before opening any DB connection at all)
 * unless the resolved database name looks disposable, per
 * {@link looksDisposable}, or the one deliberate exception applies:
 *
 * `SEED_CONFIRM_LIVE_DB_NAME=<exact db name>` — the owner's own escape
 * hatch to deliberately reseed a database that doesn't look disposable
 * (their live `crm_db` included). The confirmation value must equal the
 * EXACT database name being targeted, typed at invocation time — not a
 * plain on/off flag. A flag like `SEED_ALLOW_LIVE_DB=1` is exactly the
 * shape of thing that silently survives in an inherited shell environment
 * (the incident this guard exists for was caused by precisely that
 * pattern, with `DATABASE_URL`); a value that must match the specific name
 * of THIS run's target cannot be satisfied by accidentally-inherited state
 * from an unrelated earlier session.
 *
 * This value is deliberately read from `confirmSourceEnv`, NOT from `env`
 * (security review on PR #576, 2026-08-18, LOW-2): `env` is normally
 * `process.env` AFTER seed.ts's `loadEnvQuietly()` has run, i.e. it also
 * reflects whatever `apps/api/.env` set. If the confirmation were read from
 * there, setting it once in `.env` to unblock a single deliberate reseed
 * would make that "one-time" confirmation permanent — silently
 * re-confirming on every future run, defeating the entire point of
 * requiring it typed per invocation. `confirmSourceEnv` must be a snapshot
 * of `process.env` taken BEFORE dotenv ran (seed.ts does this at its very
 * first line); dotenv's own default behaviour — never overriding an
 * already-set variable — means a value present in that pre-dotenv snapshot
 * can only have come from the real shell invocation, never from a file.
 *
 * There used to be a second exception here — `GITHUB_ACTIONS=true` — for
 * CI's own throwaway Postgres, which used to be named `crm_db` (the same
 * name as the live one). task-ci-db-rename-and-dbpush-guard renamed that
 * throwaway database to `crm_ci` instead (see the file doc above): a
 * `crm_`-prefixed name that is not `crm_db` already passes
 * {@link looksDisposable} on its own, exactly like every other scratch name
 * in this repo, so the exception is no longer needed and has been removed —
 * a bypass keyed on a single inherited env var (`GITHUB_ACTIONS`) is a full,
 * silent off-switch, and removing the reason it existed is strictly safer
 * than narrowing it further.
 *
 * `env` is kept as a parameter (used only as {@link confirmSourceEnv}'s
 * default) rather than removed outright, so every existing call site —
 * `seed.ts`'s `assertSeedTargetIsDisposable(databaseUrl, process.env,
 * preDotenvEnv)` included — keeps working unchanged.
 */
export function assertSeedTargetIsDisposable(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  confirmSourceEnv: NodeJS.ProcessEnv = env,
): void {
  assertTargetIsDisposable(databaseUrl, SEED_REFUSAL_COPY, confirmSourceEnv)
}

/**
 * Same check as {@link assertSeedTargetIsDisposable}, worded for `db:push` /
 * `db:migrate` (both alias `drizzle-kit push` — see apps/api/package.json)
 * instead of `db:seed`. Same disposable-name logic, same
 * `SEED_CONFIRM_LIVE_DB_NAME` escape hatch — deliberately NOT a second
 * mechanism (task-ci-db-rename-and-dbpush-guard, AC6): a
 * `db:push`-specific env var name would only ever drift from this one over
 * time, and the owner only has to remember one name either way.
 *
 * Called from this file's own CLI entry point below, not imported by
 * anything else — `drizzle-kit push` is a separate third-party process with
 * no import site of its own, so the check has to run as ITS OWN process,
 * in front of it, rather than in-process the way `db:seed` calls this
 * file's sibling function directly from `seed.ts`.
 */
export function assertDbPushTargetIsDisposable(
  databaseUrl: string,
  confirmSourceEnv: NodeJS.ProcessEnv = process.env,
): void {
  assertTargetIsDisposable(databaseUrl, DB_PUSH_REFUSAL_COPY, confirmSourceEnv)
}

/**
 * CLI entry point — closes the one path PR #576's security review flagged
 * as still open (see the file doc above): `db:push` / `db:migrate`
 * (`drizzle-kit push`) can alter or drop columns/tables on whatever
 * `DATABASE_URL` points at, via the exact same inherited-env-var failure
 * mode `db:seed` already guards against, but `drizzle-kit` is a separate
 * third-party CLI process — there is no import site inside it to hang an
 * in-process check off of the way `seed.ts` does.
 *
 * Wired in `apps/api/package.json` as a prefix in front of the real
 * command: `tsx src/database/seed-db-guard.ts && drizzle-kit push`. Bash's
 * `&&` means `drizzle-kit push` never starts unless this process exits 0.
 *
 * `require.main === module` is Node's standard "am I the entry point"
 * check — true only when this file is invoked directly (`tsx
 * src/database/seed-db-guard.ts`), false when it is `import`ed by
 * `seed.ts` or by this file's own `.spec.ts` (in both of those cases some
 * OTHER file is `require.main`). Verified by execution
 * (task-ci-db-rename-and-dbpush-guard): running this file directly via tsx
 * logs `true`; the existing unit tests, which import this file's exports
 * without ever executing it as the entry point, do not trigger this block
 * (confirmed by them continuing to pass unmodified).
 */
if (require.main === module) {
  // Mirrors seed.ts's own pre-dotenv snapshot (see the doc above): captured
  // BEFORE loadEnvQuietly() below runs, so the escape hatch cannot be
  // satisfied by anything sitting in apps/api/.env.
  const preDotenvEnv: NodeJS.ProcessEnv = { ...process.env }
  loadEnvQuietly()

  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) {
    console.error(
      '[seed-db-guard] REFUSED: DATABASE_URL is not set — refusing to run db:push/db:migrate blind.',
    )
    process.exit(1)
  }

  try {
    assertDbPushTargetIsDisposable(databaseUrl, preDotenvEnv)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
