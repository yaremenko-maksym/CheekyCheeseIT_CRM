/**
 * Integration DB guard — vitest globalSetup.
 *
 * Runs ONCE in the main vitest process before any test workers are spawned.
 * Loaded only for integration runs (see vitest.config.mts `globalSetup`).
 *
 * Purpose: prevent *.integration.spec.ts from silently writing residue into
 * the developer's working crm_db database — AND (BACKLOG item 113,
 * 2026-08-17) prevent an integration run from reporting "N passed" while
 * every spec silently skipped every assertion because DATABASE_URL was
 * unreachable, or reachable but pointing at the WRONG Postgres instance.
 *
 * The second half is not hypothetical: two agents hit it on the same
 * evening. Each *.integration.spec.ts previously probed its OWN
 * reachability/schema and, on any failure, set a local `dbAvailable = false`
 * flag and had every `it()` early-`return` — vitest reports an early
 * `return` from a test body as **passed**, so a spec that asserted nothing
 * looked identical to one that asserted everything (see
 * `src/finance/salary-paid-amount.integration.spec.ts` — the file that
 * already fixed this for itself and is the pattern this guard generalizes).
 * That per-spec probe also only ever checked "is *some* Postgres reachable
 * at this connection string" — never WHICH Postgres. On a dev machine
 * running Postgres two ways at once (Homebrew service + docker-compose),
 * both listening on port 5432, a specific-address bind (native) wins over a
 * wildcard bind (`docker-proxy`) for `localhost`/`127.0.0.1` traffic — so
 * `DATABASE_URL=…@localhost:5432/crm_qa` connects successfully to a
 * completely different Postgres SERVER than the one docker-compose started,
 * which may happen to have a same-named `crm_qa` database with a stale or
 * unrelated schema. "Connects" is not "connects to the right thing".
 *
 * Guard logic:
 *   - If CI=true  → skip (CI uses a throwaway container DB, crm_db there is safe)
 *   - If DATABASE_URL ends with `/crm_db` → throw an explicit error
 *   - If DATABASE_URL is unset → warn and return (each spec's own
 *     `describe.skipIf(!hasDatabaseUrl())` reports this as SKIPPED, not
 *     passed — see src/test/require-real-db.ts)
 *   - Otherwise → ACTUALLY CONNECT (`SELECT version()`), and throw loudly if:
 *       (a) the connection fails at all (wrong port, wrong credentials, DB
 *           does not exist — anything that used to be silently swallowed
 *           per-spec is now a hard, whole-run failure at a single choke
 *           point instead of 101 separate silent no-ops), or
 *       (b) the server answers but is not the major Postgres version this
 *           repo pins for docker-compose (16 — see
 *           .claude/rules/common/version-pins.md). A version mismatch is
 *           the single most reliable, cheap signal that DATABASE_URL landed
 *           on a stray local instance rather than the docker-compose one:
 *           it is exactly what caught the reproduction of this bug on this
 *           very repo (Homebrew postgresql@15 shadowing docker's
 *           postgres:16-alpine on port 5432, both with a `crm_qa` database).
 *   - Success → log the target DB **and** the confirmed server version, then
 *     proceed.
 *
 * Known limitation (documented, not silently ignored — see AC5 of
 * BACKLOG item 113): this catches a WRONG instance only when its Postgres
 * major version differs from the pin. Two instances that are BOTH
 * postgres:16.x — one docker-compose's, one a stray second docker
 * container or VM also on 16 — with a same-named database are
 * indistinguishable by this guard. There is no cheap, generic way to prove
 * "this is the docker-compose container from THIS repo" over the wire
 * without baking a marker into the schema itself, which no spec here
 * currently expects. Mitigation for that residual case is procedural: when
 * in doubt, compare `pg_postmaster_start_time()` against
 * `docker inspect -f '{{.State.StartedAt}}' <container>` by hand.
 *
 * Default for local runs: vitest loads .env.test before this guard runs,
 * so DATABASE_URL is already set to crm_qa (see .env.test).
 * The guard is a second-line safety net for cases where the developer's
 * shell already exports DATABASE_URL pointing at crm_db.
 */

import path from 'path'
import fs from 'fs'
import { config as loadDotenv } from 'dotenv'
import { Pool } from 'pg'

/** Postgres major version pinned for docker-compose (version-pins.md). */
const EXPECTED_PG_MAJOR = 16

export async function setup(): Promise<void> {
  // globalSetup runs in the main process — `test.env` / `test.envFile` are
  // only injected into test workers, NOT here. We must load .env.test
  // ourselves so that the default crm_qa URL is available when the developer
  // has not exported DATABASE_URL in their shell.
  const envTestPath = path.resolve(__dirname, '../../.env.test')
  if (fs.existsSync(envTestPath)) {
    // `override: false` — shell-exported DATABASE_URL takes precedence.
    // This means: if the developer explicitly set DATABASE_URL in their shell,
    // we respect it (and the guard below will still catch crm_db).
    // `quiet: true` — suppress dotenv's upstream "tip" banner (see
    // vitest.config.mts for the full rationale).
    loadDotenv({ path: envTestPath, override: false, quiet: true })
  }

  // CI uses a throwaway Postgres container — crm_db there is safe to write.
  if (process.env['CI'] === 'true') {
    console.log('[integration-db-guard] CI=true — guard skipped (throwaway container DB)')
    return
  }

  const dbUrl = process.env['DATABASE_URL'] ?? ''

  // Extract the database name from the connection string (last path segment).
  // Handles: postgresql://user:pass@host:port/dbname
  //          postgresql://user:pass@host/dbname
  //          postgres://user:pass@host:port/dbname
  let dbName: string
  try {
    const parsed = new URL(dbUrl)
    dbName = parsed.pathname.replace(/^\//, '')
  } catch {
    // Malformed URL — no database name to check; let the test fail naturally.
    dbName = ''
  }

  if (dbName === 'crm_db') {
    throw new Error(
      `[integration-db-guard] BLOCKED: integration tests must not run against crm_db locally.\n` +
        `  DATABASE_URL currently points to: ${dbUrl}\n` +
        `\n` +
        `  Fix: set DATABASE_URL to crm_qa before running integration tests.\n` +
        `\n` +
        `  Quick setup (first time):\n` +
        `    createdb crm_qa\n` +
        `    DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \\\n` +
        `      pnpm --filter @crm/api db:push\n` +
        `\n` +
        `  Then run: pnpm --filter @crm/api test integration\n` +
        `  (vitest auto-loads .env.test which defaults DATABASE_URL to crm_qa)\n`,
    )
  }

  if (!dbUrl) {
    // No DATABASE_URL — integration specs will skip themselves via their own
    // `describe.skipIf(!hasDatabaseUrl())` guards (src/test/require-real-db.ts).
    // Let vitest proceed.
    console.warn(
      '[integration-db-guard] DATABASE_URL is not set — integration specs will be skipped',
    )
    return
  }

  // ── Real connectivity + instance-identity check ───────────────────────────
  // Everything above this point was string-parsing of DATABASE_URL — it never
  // actually opened a socket. A DATABASE_URL that LOOKS fine (right db name,
  // non-empty) but is unreachable, mis-authenticated, or points at a totally
  // different Postgres SERVER used to sail through this guard and then get
  // silently swallowed by every individual spec's own try/catch (the bug this
  // guard now closes at a single choke point — see file doc above).
  const redactedUrl = dbUrl.replace(/:[^:@]+@/, ':***@')
  const probe = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 5000 })
  let serverVersion: string
  try {
    const result = await probe.query<{ version: string }>('SELECT version()')
    serverVersion = result.rows[0]?.version ?? '(unknown)'
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `[integration-db-guard] BLOCKED: could not connect to DATABASE_URL.\n` +
        `  DATABASE_URL: ${redactedUrl}\n` +
        `  Underlying error: ${reason}\n` +
        `\n` +
        `  This used to be swallowed per-spec (every *.integration.spec.ts caught this\n` +
        `  and quietly reported "N passed" while asserting nothing). It is now a hard\n` +
        `  failure of the whole integration run instead — fix DATABASE_URL and re-run.\n`,
    )
  } finally {
    await probe.end()
  }

  const majorMatch = /PostgreSQL (\d+)\./.exec(serverVersion)
  const actualMajor = majorMatch ? Number(majorMatch[1]) : null
  if (actualMajor !== EXPECTED_PG_MAJOR) {
    throw new Error(
      `[integration-db-guard] BLOCKED: DATABASE_URL connects, but to the WRONG Postgres.\n` +
        `  DATABASE_URL: ${redactedUrl}\n` +
        `  Connected server reports: ${serverVersion}\n` +
        `  Expected major version:   ${EXPECTED_PG_MAJOR} (docker-compose pin, see\n` +
        `  .claude/rules/common/version-pins.md)\n` +
        `\n` +
        `  This is the classic two-Postgres-on-one-port trap: a native/Homebrew\n` +
        `  Postgres and the docker-compose one can both listen on 5432, and a\n` +
        `  specific-address bind (native) wins over docker-proxy's wildcard bind for\n` +
        `  localhost/127.0.0.1 traffic — so you connect to the WRONG server even\n` +
        `  though the URL, user, and database name all look correct, and that server\n` +
        `  may happen to have a same-named database with a stale/unrelated schema.\n` +
        `\n` +
        `  Fix: stop the stray local Postgres (or move it off 5432), or point\n` +
        `  DATABASE_URL at a port you have verified belongs to the docker-compose\n` +
        `  container (\`docker ps\`, \`docker exec <container> psql -U crm_user -d \n` +
        `  crm_qa -c 'select version()'\` to compare).\n`,
    )
  }

  console.log(
    `[integration-db-guard] OK — using database: ${dbName} (${redactedUrl})\n` +
      `[integration-db-guard]      connected server: ${serverVersion}`,
  )
}
