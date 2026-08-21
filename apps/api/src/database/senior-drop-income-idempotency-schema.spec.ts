/**
 * task-senior-drop-income-idempotency (backlog 73/A-3, security, mutation-gate
 * closure). Same shape as `source-income-drop-link-schema.spec.ts` (PR #517,
 * security-review round 3) — a partial unique index's NAME and WHERE clause in
 * `schema.ts` are pure TypeScript string literals with no in-process assertion
 * on them; the DB-level proof
 * (`senior-drop-income-idempotency.integration.spec.ts`, which drives the
 * REAL running index against crm_qa) never imports `schema.ts` either — it
 * hits the equivalent DDL via the manual SQL migration file directly. Without
 * THIS spec, Stryker's TypeScript-level `StringLiteral` mutants on
 * `uq_transactions_senior_income_idempotency_key` /
 * `uq_transactions_drop_income_idempotency_key` (index name → `""`, WHERE
 * clause → empty `sql``) are invisible to the unit-scoped mutation gate.
 *
 * Compiles schema.ts's ACTUAL Drizzle object (never a hand-typed restatement
 * of what it SHOULD say) and compares it against the prod migration file's
 * literal DDL. Pure unit spec — no live DB needed; `PgDialect#sqlToQuery` /
 * `getTableConfig` are pure compile-time introspection, the `Pool` below is
 * never `.connect()`-ed.
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

const MIGRATION_FILE = join(
  import.meta.dirname,
  '../../drizzle/manual/2026-08-19_senior_drop_income_idempotency_index.sql',
)

/** Same normalisation as source-income-drop-link-schema.spec.ts — formatting
 * differences (quoted vs bare identifiers, table-qualification the query
 * compiler adds but hand-written DDL never carries) don't fail the compare. */
function normalize(sqlFragment: string): string {
  return sqlFragment
    .replace(/"/g, '')
    .replace(/\btransactions\./gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function whereClauseFromMigration(indexName: string): string {
  const migrationSql = readFileSync(MIGRATION_FILE, 'utf-8')
  const ddlMatch = new RegExp(
    `create\\s+unique\\s+index\\s+if\\s+not\\s+exists\\s+${indexName}\\s+on\\s+transactions\\s*\\([^)]*\\)\\s*where\\s+([^;]+);`,
    'is',
  ).exec(migrationSql)
  expect(
    ddlMatch,
    `expected to find "CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON transactions (...) ` +
      `WHERE ...;" in the migration file — if this fails, the file's DDL shape changed and this ` +
      "spec's extraction regex needs updating too.",
  ).not.toBeNull()
  return normalize(ddlMatch![1]!)
}

describe.each([
  {
    indexName: 'uq_transactions_senior_income_idempotency_key',
    expectedWhere: "type = 'senior_income' and idempotency_key is not null",
  },
  {
    indexName: 'uq_transactions_drop_income_idempotency_key',
    expectedWhere: "type = 'drop_income' and idempotency_key is not null",
  },
])('$indexName — schema.ts matches the prod migration file (mutation-gate closure)', (tc) => {
  it('the index NAME is the real string, not empty (kills the StringLiteral→"" mutant)', () => {
    const { indexes } = getTableConfig(transactions)
    const idx = indexes.find((i) => i.config.name === tc.indexName)
    expect(
      idx,
      `expected an index literally named '${tc.indexName}' — got names: ` +
        `${indexes.map((i) => i.config.name).join(', ')}`,
    ).not.toBeUndefined()
    expect(idx!.config.unique).toBe(true)
  })

  it("the index WHERE clause (compiled from the REAL schema.ts object) matches the prod migration file's literal WHERE clause, and is not empty", () => {
    const { indexes } = getTableConfig(transactions)
    const idx = indexes.find((i) => i.config.name === tc.indexName)!
    expect(idx.config.where, 'the partial index must carry a WHERE condition').toBeDefined()

    // Side 1 — compile schema.ts's ACTUAL where-clause SQL object.
    const compiled = new PgDialect().sqlToQuery(idx.config.where!, 'indexes')
    const tsWhereSql = normalize(compiled.sql)
    expect(tsWhereSql.length).toBeGreaterThan(0)

    // Side 2 — the prod migration file's literal WHERE clause.
    const migrationWhereSql = whereClauseFromMigration(tc.indexName)

    // Both sides, independently derived, must express the SAME predicate —
    // kills the empty-WHERE mutant (an empty `tsWhereSql` can never equal the
    // non-empty migration text) without hand-retyping either side.
    expect(tsWhereSql).toBe(migrationWhereSql)
    // Pin the expected shape too — catches BOTH sides drifting together to
    // something else.
    expect(tsWhereSql).toBe(tc.expectedWhere)
  })
})

it('sanity: the compiled table + Pool never actually connect (pure introspection, no live DB required)', () => {
  const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' })
  const db = drizzle(pool, { schema })
  expect(db).toBeDefined()
})
