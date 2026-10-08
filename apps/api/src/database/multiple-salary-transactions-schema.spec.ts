import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { salaryMonthInitializations, transactions, users } from './schema'

const LEGACY_AUDIT_DDL = readFileSync(
  join(import.meta.dirname, '../../drizzle/manual/2026-07-04_audit_hardening_constraints.sql'),
  'utf8',
)

function normalize(sql: string): string {
  return sql
    .replace(/"/g, '')
    .replace(/\btransactions\./gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function indexColumnNames(index: { config: { columns: unknown[] } }): string[] {
  return index.config.columns.map((column) => (column as { name?: string }).name ?? String(column))
}

describe('multipart salary — Drizzle schema contract', () => {
  it('preserves the transaction columns and company-deposit index that share this changed schema region', () => {
    const config = getTableConfig(transactions)
    const column = (name: string) => config.columns.find((c) => c.name === name)

    expect(column('funding_source')?.getSQLType()).toBe('varchar(16)')
    expect(column('notes')?.getSQLType()).toBe('varchar(1000)')
    expect(column('salary_month')?.getSQLType()).toBe('varchar(7)')

    const companyDeposit = config.indexes.find(
      (i) => i.config.name === 'uq_transactions_company_deposit_tx_hash',
    )
    expect(companyDeposit).toBeDefined()
    expect(companyDeposit!.config.unique).toBe(true)
    expect(indexColumnNames(companyDeposit!)).toEqual(['tx_hash'])
    expect(
      normalize(new PgDialect().sqlToQuery(companyDeposit!.config.where!, 'indexes').sql),
    ).toBe("type = 'company_deposit' and tx_hash is not null")
  })

  it('declares salary_origin as the nullable varchar(8) discriminator', () => {
    const column = getTableConfig(transactions).columns.find((c) => c.name === 'salary_origin')
    expect(column).toBeDefined()
    expect(column!.getSQLType()).toBe('varchar(8)')
    expect(column!.notNull).toBe(false)
  })

  it('keeps receiver/month lookup non-unique and scoped to salary rows', () => {
    const index = getTableConfig(transactions).indexes.find(
      (i) => i.config.name === 'idx_transactions_salary_receiver_month',
    )
    expect(index).toBeDefined()
    expect(index!.config.unique).toBe(false)
    expect(indexColumnNames(index!)).toEqual(['receiver_id', 'salary_month'])
    expect(normalize(new PgDialect().sqlToQuery(index!.config.where!, 'indexes').sql)).toBe(
      "type = 'salary' and salary_month is not null",
    )
  })

  it('prevents replayed legacy audit DDL from restoring receiver/month uniqueness after multipart salary', () => {
    expect(LEGACY_AUDIT_DDL).toMatch(
      /DO \$\$[\s\S]*?IF to_regclass\('public\.salary_month_initializations'\) IS NULL THEN[\s\S]*?CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_salary_receiver_month[\s\S]*?END IF;[\s\S]*?\$\$;/,
    )
  })

  it('enforces one manual salary intent per idempotency key', () => {
    const config = getTableConfig(transactions)
    const index = config.indexes.find(
      (i) => i.config.name === 'uq_transactions_salary_idempotency_key',
    )
    expect(index).toBeDefined()
    expect(index!.config.unique).toBe(true)
    expect(indexColumnNames(index!)).toEqual(['idempotency_key'])
    expect(normalize(new PgDialect().sqlToQuery(index!.config.where!, 'indexes').sql)).toBe(
      "type = 'salary' and idempotency_key is not null",
    )

    const check = config.checks.find(
      (c) => c.name === 'ck_transactions_manual_salary_idempotency_key',
    )
    expect(check).toBeDefined()
    expect(normalize(new PgDialect().sqlToQuery(check!.value).sql)).toBe(
      "type <> 'salary' or salary_origin is distinct from 'manual' or idempotency_key is not null",
    )
  })

  it('declares the durable cron-initialization table exactly', () => {
    const config = getTableConfig(salaryMonthInitializations)
    expect(config.name).toBe('salary_month_initializations')
    expect(
      config.columns.map((c) => ({
        name: c.name,
        type: c.getSQLType(),
        notNull: c.notNull,
        hasDefault: c.hasDefault,
      })),
    ).toEqual([
      { name: 'id', type: 'uuid', notNull: true, hasDefault: true },
      { name: 'receiver_id', type: 'uuid', notNull: true, hasDefault: false },
      { name: 'salary_month', type: 'varchar(7)', notNull: true, hasDefault: false },
      { name: 'initialized_by', type: 'uuid', notNull: false, hasDefault: false },
      {
        name: 'initialized_at',
        type: 'timestamp with time zone',
        notNull: true,
        hasDefault: true,
      },
    ])

    const receiverFk = config.foreignKeys.find((fk) =>
      fk.reference().columns.some((column) => column.name === 'receiver_id'),
    )
    expect(receiverFk).toBeDefined()
    expect(receiverFk!.reference().foreignTable).toBe(users)
    expect(receiverFk!.reference().foreignColumns.map((c) => c.name)).toEqual(['id'])
    expect(receiverFk!.onDelete).toBe('cascade')

    const initializedByFk = config.foreignKeys.find((fk) =>
      fk.reference().columns.some((column) => column.name === 'initialized_by'),
    )
    expect(initializedByFk).toBeDefined()
    expect(initializedByFk!.reference().foreignTable).toBe(users)
    expect(initializedByFk!.reference().foreignColumns.map((c) => c.name)).toEqual(['id'])
    expect(initializedByFk!.onDelete).toBe('set null')

    expect(config.indexes).toHaveLength(1)
    expect(config.indexes[0]!.config.name).toBe('uq_salary_month_initializations_receiver_month')
    expect(config.indexes[0]!.config.unique).toBe(true)
    expect(indexColumnNames(config.indexes[0]!)).toEqual(['receiver_id', 'salary_month'])
  })
})
