/**
 * task-settled-amount-snapshot (Task 1 of the paid-transaction-edit-cascade
 * decomposition — docs/architecture/2026-08-22-paid-transaction-edit-cascade.md,
 * AC3, AC8 mutation gate). A column DECLARATION is Drizzle metadata, observable
 * only by Postgres itself or by compile-time introspection — no unit test
 * exercising `settleByCompany` through the mocked-row stubs used elsewhere in
 * this task ever reads a new column's OWN name/precision/scale/enum-values off
 * the column object; it only reads/writes VALUES through it, which a stub
 * happily accepts regardless of what the DDL would actually allow. This spec
 * closes that gap the same way `company-name-snapshot-schema.spec.ts` (PR #523)
 * and `source-income-drop-link-schema.spec.ts` (PR #517) already do: compile
 * schema.ts's ACTUAL Drizzle object (never a hand-typed restatement) and
 * compare it against the prod migration file's literal DDL. Pure unit spec —
 * no live DB needed; `getTableConfig` is pure compile-time introspection.
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
  '../../drizzle/manual/2026-08-22_settled_amount_snapshot.sql',
)

describe('transactions.settledAmount/settledCurrency/settledSharePercent — schema.ts matches the prod migration file (mutation-gate closure)', () => {
  it('settled_amount: real column name, PgNumeric, precision 18 / scale 6, nullable, no default (kills StringLiteral/NumberLiteral mutants)', () => {
    const { columns } = getTableConfig(transactions)
    const col = columns.find((c) => c.name === 'settled_amount')
    expect(
      col,
      `expected a column literally named 'settled_amount' — got names: ${columns
        .map((c) => c.name)
        .join(', ')}`,
    ).not.toBeUndefined()
    expect(col!.columnType).toBe('PgNumeric')
    expect(col!.precision).toBe(18)
    expect(col!.scale).toBe(6)
    expect(col!.notNull).toBe(false)
    expect(col!.hasDefault).toBe(false)
  })

  it('settled_currency: real column name, PgEnumColumn over the SAME currency enum values as transactions.currency, nullable, no default', () => {
    const { columns } = getTableConfig(transactions)
    const col = columns.find((c) => c.name === 'settled_currency')
    expect(
      col,
      `expected a column literally named 'settled_currency' — got names: ${columns
        .map((c) => c.name)
        .join(', ')}`,
    ).not.toBeUndefined()
    expect(col!.columnType).toBe('PgEnumColumn')
    // Must be the SAME enum `transactions.currency` already uses — not a
    // hand-restated list that could silently drift from it.
    const currencyCol = columns.find((c) => c.name === 'currency')!
    expect(col!.enumValues).toEqual(currencyCol.enumValues)
    expect(col!.enumValues).toEqual(['USDT', 'USD', 'EUR', 'UAH'])
    expect(col!.notNull).toBe(false)
    expect(col!.hasDefault).toBe(false)
  })

  it('settled_share_percent: real column name, PgInteger, nullable, no default', () => {
    const { columns } = getTableConfig(transactions)
    const col = columns.find((c) => c.name === 'settled_share_percent')
    expect(
      col,
      `expected a column literally named 'settled_share_percent' — got names: ${columns
        .map((c) => c.name)
        .join(', ')}`,
    ).not.toBeUndefined()
    expect(col!.columnType).toBe('PgInteger')
    expect(col!.notNull).toBe(false)
    expect(col!.hasDefault).toBe(false)
  })

  it("schema.ts's compiled precision/scale agree with the prod migration file's literal DDL", () => {
    const { columns } = getTableConfig(transactions)
    const amountCol = columns.find((c) => c.name === 'settled_amount')!

    const migrationSql = readFileSync(COLUMN_MIGRATION_FILE, 'utf-8')
    const ddlMatch =
      /alter\s+table\s+transactions\s*\n?\s*add\s+column\s+if\s+not\s+exists\s+settled_amount\s+numeric\((\d+)\s*,\s*(\d+)\)\s*;/is.exec(
        migrationSql,
      )
    expect(
      ddlMatch,
      'expected to find "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ' +
        'settled_amount numeric(<P>, <S>);" in the migration file — if this fails, the ' +
        "file's DDL shape changed and this spec's extraction regex needs updating too.",
    ).not.toBeNull()

    const migrationPrecision = Number(ddlMatch![1])
    const migrationScale = Number(ddlMatch![2])
    // Both sides, independently derived, must express the SAME precision/scale
    // — kills a NumberLiteral mutant on EITHER side (schema.ts drifting from
    // the DDL, or vice versa) without hand-retyping either into a shared
    // constant.
    expect(amountCol.precision).toBe(migrationPrecision)
    expect(amountCol.scale).toBe(migrationScale)
    expect(amountCol.precision).toBe(18)
    expect(amountCol.scale).toBe(6)
  })

  it('the migration file also adds settled_currency (currency) and settled_share_percent (integer)', () => {
    const migrationSql = readFileSync(COLUMN_MIGRATION_FILE, 'utf-8')
    expect(
      /alter\s+table\s+transactions\s*\n?\s*add\s+column\s+if\s+not\s+exists\s+settled_currency\s+currency\s*;/is.test(
        migrationSql,
      ),
    ).toBe(true)
    expect(
      /alter\s+table\s+transactions\s*\n?\s*add\s+column\s+if\s+not\s+exists\s+settled_share_percent\s+integer\s*;/is.test(
        migrationSql,
      ),
    ).toBe(true)
  })

  it('sanity: the compiled table + Pool never actually connect (pure introspection, no live DB required)', () => {
    const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' })
    const db = drizzle(pool, { schema })
    expect(db).toBeDefined()
  })
})
