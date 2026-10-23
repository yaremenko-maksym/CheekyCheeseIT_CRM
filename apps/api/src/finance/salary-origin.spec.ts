/**
 * CR-795-M-7 — the two salary-origin SQL fragments, compiled and read back.
 *
 * The expected SQL and parameter lists below are written out by hand from the
 * business meaning of each predicate. They are deliberately NOT derived from
 * `salaryOriginSchema` the way the fragments are: a test that recomputed the
 * value list the same way the code does could not disagree with the code, and
 * the whole point of this module is that the list is stated once and everything
 * else agrees with it.
 *
 * Pure compile-time introspection — `PgDialect#sqlToQuery` never opens a
 * connection.
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import {
  accountsForSalaryMonthSql,
  AUTOMATIC_ORIGIN_VALUES,
  isAutomaticSalaryComponent,
  MONTH_ACCOUNTING_ORIGIN_VALUES,
} from './salary-origin'

const dialect = new PgDialect()

describe('salary-origin SQL fragments (CR-795-M-7)', () => {
  it('isAutomaticSalaryComponent — legacy NULL or CRON, nothing else', () => {
    const { sql, params } = dialect.sqlToQuery(isAutomaticSalaryComponent())

    expect(sql).toBe(
      '("transactions"."salary_origin" is null or "transactions"."salary_origin" in ($1))',
    )
    expect(params).toEqual(['CRON'])
  })

  it('accountsForSalaryMonthSql — legacy NULL, CRON or MANUAL; never ADJUSTED', () => {
    const { sql, params } = dialect.sqlToQuery(accountsForSalaryMonthSql())

    expect(sql).toBe(
      '("transactions"."salary_origin" is null or "transactions"."salary_origin" in ($1, $2))',
    )
    expect(params).toEqual(['MANUAL', 'CRON'])
    expect(params).not.toContain('ADJUSTED')
  })

  it('the exported value lists are the ones the fragments bind', () => {
    expect(AUTOMATIC_ORIGIN_VALUES).toEqual(['CRON'])
    expect(MONTH_ACCOUNTING_ORIGIN_VALUES).toEqual(['MANUAL', 'CRON'])
  })
})
