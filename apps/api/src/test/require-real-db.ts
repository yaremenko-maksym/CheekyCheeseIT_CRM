/**
 * Shared convention for every `*.integration.spec.ts` that hits a real
 * Postgres — see BACKLOG item 113 (2026-08-17): two independent agents got a
 * false-green "N passed" from a spec that silently skipped every assertion
 * because DATABASE_URL pointed at nothing / an unmigrated schema / the
 * WRONG Postgres instance shadowing the intended one on the same port.
 *
 * `src/test/integration-db-guard.ts` (vitest `globalSetup`) is the PRIMARY
 * defense: it now actually connects and checks the server's Postgres major
 * version before any spec file even loads, so an unreachable or wrong-instance
 * DATABASE_URL aborts the whole run loudly at one choke point instead of
 * getting swallowed per-file 89 times over. This module is the secondary,
 * per-spec layer for the ONE thing the global guard cannot know about: a
 * spec-specific column/table that a migration hasn't applied yet on an
 * otherwise-correct, reachable database.
 *
 * Exactly two outcomes are legitimate for a spec using these helpers:
 *
 *   1. DATABASE_URL is not set at all — the ONE case allowed to be invisible
 *      to a human running the suite. This is the `DATABASE_URL= git push`
 *      convention (git-policy.md) and the unit-only CI job. Gate the whole
 *      `describe` block with `describe.skipIf(!hasDatabaseUrl())` so vitest
 *      reports the suite as **skipped** — never silently "N passed".
 *
 *   2. DATABASE_URL IS set. From here on nothing may swallow a failure into
 *      a quiet early-return: an unmigrated schema must surface as a THROWN
 *      error in `beforeAll` (vitest then reports the suite as FAILED — never
 *      "passed", never silently "skipped"). Use `assertRealDbSchema()` for
 *      this; a plain connectivity failure is already handled by the global
 *      guard and doesn't need a local catch at all.
 */

import { Pool } from 'pg'

/** True iff DATABASE_URL is a non-empty string. Gate `describe.skipIf` on this. */
export function hasDatabaseUrl(): boolean {
  return !!process.env['DATABASE_URL']
}

/**
 * Throws if any `table.column` in `checks` is missing from the database at
 * DATABASE_URL — the signal that this specific spec's migration hasn't been
 * applied yet, even though the instance itself is reachable and correct
 * (that broader check is `integration-db-guard.ts`'s job, not this one).
 * Deliberately does NOT catch connection errors — a `Pool#query` failure
 * (wrong host, wrong credentials, database does not exist) propagates as-is
 * and fails `beforeAll` loudly on its own, with Postgres's own error text.
 */
export async function assertRealDbSchema(
  checks: ReadonlyArray<{ table: string; column: string }>,
): Promise<void> {
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
  try {
    for (const { table, column } of checks) {
      const result = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
        [table, column],
      )
      if (result.rowCount === 0) {
        throw new Error(
          `[require-real-db] ${table}.${column} not found at this DATABASE_URL — the schema is ` +
            `unmigrated (run \`pnpm --filter @crm/api db:push\` against it) or DATABASE_URL points ` +
            `at an unrelated database entirely.`,
        )
      }
    }
  } finally {
    await pool.end()
  }
}
