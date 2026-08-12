/**
 * task-admin-income-drop-backfill, security-review round 3 (PR #517,
 * mutation gate). Three mutants in `schema.ts` survived the CI mutation gate
 * with zero test coverage:
 *   1. `uq_transactions_source_income_drop_link`'s partial-index WHERE
 *      clause mutated to an empty `sql``` — no test noticed the index would
 *      then apply to EVERY row instead of only DROP_PENDING_PAYOUT/
 *      PAYOUT_DROP rows.
 *   2. The index's NAME string mutated to `""` — no test noticed.
 *   3. `sourceIncomeTransactionId`'s FK `{ onDelete: 'set null' }` mutated to
 *      `{ onDelete: '' }` — no test noticed a hard-delete of a source income
 *      would then behave differently (Postgres treats an invalid/empty
 *      action as an error at DDL-apply time, but nothing in-process asserted
 *      the TypeScript SIDE ever said the right thing).
 *
 * All three exist because MED-F (the DB-level race guard) was proven against
 * the REAL running index in crm_qa (admin-income-drop-backfill.integration
 * .spec.ts's MED-F test — a raw duplicate INSERT gets rejected), never
 * against the schema.ts TypeScript SOURCE that defines it. That integration
 * spec doesn't even import `schema.ts` (it drives the equivalent DDL via the
 * manual SQL files directly), so Stryker's TypeScript-level mutants were
 * invisible to it.
 *
 * This spec closes that gap the same way
 * `non-deleted-transactions-view-consistency.spec.ts` already does for the
 * `non_deleted_transactions` view: compile schema.ts's ACTUAL Drizzle object
 * (never a hand-typed restatement of what it SHOULD say) and compare it
 * against the prod migration file's literal DDL. Pure unit spec — no live DB
 * needed; `PgDialect#sqlToQuery` / `getTableConfig` are pure compile-time
 * introspection, the `Pool` below is never `.connect()`-ed.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { PgDialect } from 'drizzle-orm/pg-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import * as schema from './schema'
import { transactions } from './schema'

const COLUMN_MIGRATION_FILE = join(
  import.meta.dirname,
  '../../drizzle/manual/2026-08-12_admin_income_drop_backfill_column.sql',
)

/** Normalises whitespace/case/quoting/table-qualification so formatting
 * differences (quoted vs bare identifiers, `"transactions".` prefixes the
 * query compiler adds but hand-written DDL never carries) don't fail the
 * compare — mirrors non-deleted-transactions-view-consistency.spec.ts's
 * `normalize`/`normalizePredicate`. */
function normalize(sqlFragment: string): string {
  return sqlFragment
    .replace(/"/g, '')
    .replace(/\btransactions\./gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

describe('uq_transactions_source_income_drop_link — schema.ts matches the prod migration file (mutation-gate closure)', () => {
  it('the index NAME is the real string, not empty (kills the StringLiteral→"" mutant)', () => {
    const { indexes } = getTableConfig(transactions)
    const idx = indexes.find((i) => i.config.name === 'uq_transactions_source_income_drop_link')
    expect(
      idx,
      `expected an index literally named 'uq_transactions_source_income_drop_link' — ` +
        `got names: ${indexes.map((i) => i.config.name).join(', ')}`,
    ).not.toBeUndefined()
    expect(idx!.config.unique).toBe(true)
  })

  it("the index WHERE clause (compiled from the REAL schema.ts object) matches the prod migration file's literal WHERE clause, and is not empty", () => {
    const { indexes } = getTableConfig(transactions)
    const idx = indexes.find((i) => i.config.name === 'uq_transactions_source_income_drop_link')!
    expect(idx.config.where, 'the partial index must carry a WHERE condition').toBeDefined()

    // Side 1 — compile schema.ts's ACTUAL where-clause SQL object. `'indexes'`
    // is drizzle-orm's own invoke-source flag for compiling an index
    // condition (bare column names, no table-qualified/aliased form — a
    // separate code path from `db.select().where()`, which is why this spec
    // cannot reuse `.toSQL()` the way the view-consistency spec does).
    const compiled = new PgDialect().sqlToQuery(idx.config.where!, 'indexes')
    const tsWhereSql = normalize(compiled.sql)
    expect(tsWhereSql.length).toBeGreaterThan(0)

    // Side 2 — the prod migration file's literal WHERE clause.
    const migrationSql = readFileSync(COLUMN_MIGRATION_FILE, 'utf-8')
    const ddlMatch =
      /create\s+unique\s+index\s+if\s+not\s+exists\s+uq_transactions_source_income_drop_link\s+on\s+transactions\s*\([^)]*\)\s*where\s+([^;]+);/is.exec(
        migrationSql,
      )
    expect(
      ddlMatch,
      'expected to find "CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_source_income_drop_link ' +
        'ON transactions (...) WHERE ...;" in the migration file — if this fails, the file\'s DDL shape ' +
        "changed and this spec's extraction regex needs updating too.",
    ).not.toBeNull()
    const migrationWhereSql = normalize(ddlMatch![1]!)

    // Both sides, independently derived, must express the SAME predicate —
    // kills the empty-WHERE mutant (an empty `tsWhereSql` can never equal
    // the non-empty migration text) without hand-retyping either side.
    expect(tsWhereSql).toBe(migrationWhereSql)
    // Pin the expected shape too, same reasoning as the view-consistency
    // spec: catches BOTH sides drifting together to something else.
    expect(tsWhereSql).toBe(
      "type in ('drop_pending_payout', 'payout_drop') and source_income_transaction_id is not null",
    )
  })

  it("sourceIncomeTransactionId's FK really is ON DELETE SET NULL (kills the onDelete:'' mutant)", () => {
    const { foreignKeys } = getTableConfig(transactions)
    const fk = foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === 'source_income_transaction_id'),
    )
    expect(
      fk,
      'expected a foreign key on transactions.source_income_transaction_id',
    ).not.toBeUndefined()
    expect(fk!.onDelete).toBe('set null')
  })

  it('sanity: the compiled table + Pool never actually connect (pure introspection, no live DB required)', () => {
    // Mirrors the view-consistency spec's own sanity note: constructing the
    // Pool/db objects above is enough to drive `getTableConfig` — nothing in
    // this file calls `.connect()` or issues a query, so it belongs in the
    // default (non-integration) unit run, same as the mutation gate expects.
    const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' })
    const db = drizzle(pool, { schema })
    expect(db).toBeDefined()
  })
})
