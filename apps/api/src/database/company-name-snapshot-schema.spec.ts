/**
 * task-drop-sees-own-obligations, security-review round 2 (PR #523,
 * mutation gate). Two mutants on the `companyNameSnapshot` column
 * DECLARATION in `schema.ts:869` survived the CI mutation gate with zero
 * test coverage:
 *   1. The column NAME string `'company_name_snapshot'` mutated to `''` —
 *      no test noticed (the real Postgres column would then be named
 *      something Drizzle never intended).
 *   2. The `{ length: 255 }` option mutated to a different number — no test
 *      noticed a shorter/longer varchar bound than the prod DDL declares.
 *
 * Both exist for the same structural reason as
 * `source-income-drop-link-schema.spec.ts` (PR #517, security-review round
 * 3): a column DECLARATION is Drizzle metadata, observable only by Postgres
 * itself or by compile-time introspection — no unit test exercising
 * `getDropSelfIncomes`/`bookCompanyObligations` through the mocked-row
 * stubs used elsewhere in this task ever reads `company_name_snapshot`'s
 * OWN name/length off the column object; it only reads/writes VALUES
 * through it, which a stub happily accepts regardless of what the DDL
 * would actually allow. This spec closes that gap the same way: compile
 * schema.ts's ACTUAL Drizzle object (never a hand-typed restatement) and
 * compare it against the prod migration file's literal DDL. Pure unit
 * spec — no live DB needed; `getTableConfig` is pure compile-time
 * introspection.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import * as schema from './schema'
import { transactions } from './schema'

const COLUMN_MIGRATION_FILE = join(
  import.meta.dirname,
  '../../drizzle/manual/2026-08-12_drop_obligation_company_name_snapshot.sql',
)

describe('transactions.companyNameSnapshot — schema.ts matches the prod migration file (mutation-gate closure)', () => {
  it("the column NAME is the real string 'company_name_snapshot', not empty (kills the StringLiteral→'' mutant)", () => {
    const { columns } = getTableConfig(transactions)
    const col = columns.find((c) => c.name === 'company_name_snapshot')
    expect(
      col,
      `expected a column literally named 'company_name_snapshot' — got names: ` +
        `${columns.map((c) => c.name).join(', ')}`,
    ).not.toBeUndefined()
    expect(col!.columnType).toBe('PgVarchar')
  })

  it('the column length is 255 (kills the NumberLiteral mutant on { length: 255 })', () => {
    const { columns } = getTableConfig(transactions)
    const col = columns.find((c) => c.name === 'company_name_snapshot')!
    expect(col.length).toBe(255)
  })

  it("the column is NULLABLE — no NOT NULL / default (matches the doc's 'nullable, no backfill' contract)", () => {
    const { columns } = getTableConfig(transactions)
    const col = columns.find((c) => c.name === 'company_name_snapshot')!
    expect(col.notNull).toBe(false)
    expect(col.hasDefault).toBe(false)
  })

  it("schema.ts's compiled name/length agree with the prod migration file's literal DDL", () => {
    const { columns } = getTableConfig(transactions)
    const col = columns.find((c) => c.name === 'company_name_snapshot')!

    const migrationSql = readFileSync(COLUMN_MIGRATION_FILE, 'utf-8')
    const ddlMatch =
      /alter\s+table\s+transactions\s+add\s+column\s+if\s+not\s+exists\s+company_name_snapshot\s+varchar\((\d+)\)\s*;/is.exec(
        migrationSql,
      )
    expect(
      ddlMatch,
      'expected to find "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ' +
        'company_name_snapshot varchar(<N>);" in the migration file — if this fails, the ' +
        "file's DDL shape changed and this spec's extraction regex needs updating too.",
    ).not.toBeNull()

    const migrationLength = Number(ddlMatch![1])
    // Both sides, independently derived, must express the SAME length — kills
    // a NumberLiteral mutant on EITHER side (schema.ts drifting from the DDL,
    // or vice versa) without hand-retyping either into a shared constant.
    expect(col.length).toBe(migrationLength)
    expect(col.length).toBe(255)
  })

  it('sanity: the compiled table + Pool never actually connect (pure introspection, no live DB required)', () => {
    const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' })
    const db = drizzle(pool, { schema })
    expect(db).toBeDefined()
  })
})
