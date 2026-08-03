/**
 * security-review PR #456 round 3, LOW ("подумай над последним"): the
 * `non_deleted_transactions` view's filter predicate is defined in TWO
 * independent places with nothing else tying them together —
 *   1. `schema.ts` — `NON_DELETED_TRANSACTIONS_PREDICATE`, applied via
 *      `drizzle-kit push` in dev/CI.
 *   2. `drizzle/manual/2026-08-03_non_deleted_transactions_view.sql` — hand-
 *      written prod DDL (prod ships no drizzle-kit).
 * If a future change edits one side's predicate (e.g. adds an extra
 * condition) and forgets the other, the two environments would silently
 * diverge — dev/CI would exercise a different filter than prod ever runs.
 * This spec fails loudly on that class of drift by deriving BOTH sides fresh
 * on every run and comparing them, instead of hand-copying one into the test
 * as a hardcoded expectation (which would only catch drift in the OTHER
 * side, not either).
 *
 * Pure unit spec — no live DB needed. `.toSQL()` compiles the query object to
 * `{ sql, params }` without ever opening a connection (the `Pool` below is
 * never `.connect()`-ed or queried), so this runs in the default
 * non-integration job.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import * as schema from './schema'
import { NON_DELETED_TRANSACTIONS_PREDICATE, transactions } from './schema'

const MIGRATION_FILE = join(
  import.meta.dirname,
  '../../drizzle/manual/2026-08-03_non_deleted_transactions_view.sql',
)

/** Normalises whitespace/case so formatting differences don't fail the compare. */
function normalize(sqlFragment: string): string {
  return sqlFragment.replace(/\s+/g, ' ').trim().toLowerCase()
}

describe('non_deleted_transactions — schema.ts predicate matches the prod migration file (round 3 LOW)', () => {
  it('the compiled TypeScript predicate and the migration file WHERE clause express the identical filter', () => {
    // Side 1 — compile schema.ts's ACTUAL predicate object (the same one the
    // view itself uses, per NON_DELETED_TRANSACTIONS_PREDICATE's doc in
    // schema.ts) to SQL. Never connects — `.toSQL()` is a pure compile step.
    const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' })
    const db = drizzle(pool, { schema })
    const compiled = db
      .select()
      .from(transactions)
      .where(NON_DELETED_TRANSACTIONS_PREDICATE)
      .toSQL()
    const whereMatch = /where\s+(.+)$/i.exec(compiled.sql)
    expect(whereMatch, `expected a WHERE clause in compiled SQL: ${compiled.sql}`).not.toBeNull()
    const tsPredicateSql = normalize(whereMatch![1]!)

    // Side 2 — the prod migration file's literal WHERE clause.
    const migrationSql = readFileSync(MIGRATION_FILE, 'utf-8')
    const viewMatch =
      /create\s+or\s+replace\s+view\s+non_deleted_transactions\s+as\s+select\s+\*\s+from\s+transactions\s+where\s+([^;]+);/is.exec(
        migrationSql,
      )
    expect(
      viewMatch,
      'expected to find "CREATE OR REPLACE VIEW non_deleted_transactions AS SELECT * FROM ' +
        'transactions WHERE ...;" in the migration file — if this fails, the file\'s CREATE VIEW ' +
        "statement shape changed and this spec's extraction regex needs updating too.",
    ).not.toBeNull()
    const migrationPredicateSql = normalize(viewMatch![1]!)

    // Both sides, independently derived, must express the SAME predicate.
    // schema.ts's query-builder `.where()` compiles to a table-qualified,
    // quoted reference (`"transactions"."deleted_at" is null`); the
    // migration file's unaliased single-table view writes the bare, unquoted
    // `deleted_at is null`. Strip quoting AND table qualification before
    // comparing so this spec fails only on an ACTUAL predicate change
    // (different column, different operator, an added condition) — not on
    // cosmetic differences between how the query builder renders a WHERE
    // clause vs. how the DDL was hand-written.
    const normalizePredicate = (s: string): string =>
      s
        .replace(/"/g, '')
        .replace(/\b[a-z_][a-z0-9_]*\./gi, '')
        .trim()
    expect(normalizePredicate(migrationPredicateSql)).toBe(normalizePredicate(tsPredicateSql))

    // Pin the expected shape too — if BOTH sides drifted together to
    // something other than "deleted_at is null" (e.g. someone widened the
    // view's filter without updating this spec's own understanding), the
    // equality check above would still pass but silently validate the wrong
    // thing. This catches that class of "drifted together" mistake.
    expect(normalizePredicate(tsPredicateSql)).toBe('deleted_at is null')
  })
})
