/**
 * Integration DB guard — vitest globalSetup.
 *
 * Runs ONCE in the main vitest process before any test workers are spawned.
 * Loaded only for integration runs (see vitest.config.mts `globalSetup`).
 *
 * Purpose: prevent *.integration.spec.ts from silently writing residue into
 * the developer's working crm_db database.
 *
 * Guard logic:
 *   - If CI=true  → skip (CI uses a throwaway container DB, crm_db there is safe)
 *   - If DATABASE_URL ends with `/crm_db` → throw an explicit error
 *   - Otherwise   → log the target DB and proceed
 *
 * Default for local runs: vitest loads .env.test before this guard runs,
 * so DATABASE_URL is already set to crm_qa (see .env.test).
 * The guard is a second-line safety net for cases where the developer's
 * shell already exports DATABASE_URL pointing at crm_db.
 */

import path from 'path'
import fs from 'fs'
import { config as loadDotenv } from 'dotenv'

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
    // `describe.skipIf(!DATABASE_URL)` guards. Let vitest proceed.
    console.warn(
      '[integration-db-guard] DATABASE_URL is not set — integration specs will be skipped',
    )
    return
  }

  console.log(
    `[integration-db-guard] OK — using database: ${dbName} (${dbUrl.replace(/:[^:@]+@/, ':***@')})`,
  )
}
