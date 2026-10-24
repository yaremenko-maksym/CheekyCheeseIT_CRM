import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import type { DatabaseService } from '../database/database.service'
import { getOwnSalaryStates, getOwnSalaryStatus } from './salary-status.helper'

type TransactionRow = {
  status: string
  amount: string
  currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
}

// SR-795-L-3: the legacy single-part projection takes the FIRST row of this
// query, so the query must impose an order. The harness therefore refuses to
// answer an unordered read — `where` is no longer terminal — which is what
// makes "no ORDER BY" a test failure rather than a silent dependence on
// Postgres's physical row order.
function makeDb(rows: TransactionRow[], capture?: { orderBy?: unknown[] }): DatabaseService['db'] {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async (...clauses: unknown[]) => {
            if (capture) capture.orderBy = clauses
            return rows
          },
        }),
      }),
    }),
  } as unknown as DatabaseService['db']
}

const USER_ID = 'aaaaaaaa-0000-4000-0000-000000000001'
const SALARY_MONTH = '2026-06'

const NOT_CONFIGURED = { hasMonthlySalary: false, isCronEligibleRole: false }
const NOT_CRON_ELIGIBLE = { hasMonthlySalary: true, isCronEligibleRole: false }
const AWAITING_CREATION = { hasMonthlySalary: true, isCronEligibleRole: true }

function row(
  amount: string,
  status: string,
  currency: TransactionRow['currency'] = 'USD',
): TransactionRow {
  return { amount, status, currency }
}

describe('getOwnSalaryStatus', () => {
  describe('no valid salary part exists', () => {
    it('returns NOT_CONFIGURED when monthly salary is not configured', async () => {
      expect(await getOwnSalaryStatus(makeDb([]), USER_ID, SALARY_MONTH, NOT_CONFIGURED)).toEqual({
        state: 'NOT_CONFIGURED',
      })
    })

    it('returns NOT_CRON_ELIGIBLE when configured role is not processed by cron', async () => {
      expect(
        await getOwnSalaryStatus(makeDb([]), USER_ID, SALARY_MONTH, NOT_CRON_ELIGIBLE),
      ).toEqual({ state: 'NOT_CRON_ELIGIBLE' })
    })

    it('returns AWAITING_CREATION for a configured cron-eligible role', async () => {
      expect(
        await getOwnSalaryStatus(makeDb([]), USER_ID, SALARY_MONTH, AWAITING_CREATION),
      ).toEqual({ state: 'AWAITING_CREATION' })
    })

    it('ignores unsupported statuses before applying the same state split', async () => {
      const db = makeDb([row('1000', 'CANCELLED')])
      expect(await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, NOT_CONFIGURED)).toEqual({
        state: 'NOT_CONFIGURED',
      })
      expect(await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, NOT_CRON_ELIGIBLE)).toEqual({
        state: 'NOT_CRON_ELIGIBLE',
      })
      expect(await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, AWAITING_CREATION)).toEqual({
        state: 'AWAITING_CREATION',
      })
    })
  })

  describe('multipart aggregation', () => {
    it('keeps single-part values while exposing aggregate metadata', async () => {
      const { aggregate: result, legacy } = await getOwnSalaryStates(
        makeDb([row('2500', 'PENDING', 'UAH')]),
        USER_ID,
        SALARY_MONTH,
        NOT_CONFIGURED,
      )

      expect(result).toEqual({
        state: 'EXISTS',
        amount: 2500,
        currency: 'UAH',
        status: 'PENDING',
        transactionCount: 1,
        totals: [
          {
            currency: 'UAH',
            amount: 2500,
            paidAmount: 0,
            pendingAmount: 2500,
            lockedAmount: 0,
          },
        ],
      })
      expect(legacy).toEqual({
        state: 'EXISTS',
        amount: 2500,
        currency: 'UAH',
        status: 'PENDING',
      })
    })

    it('aggregates paid and pending parts in one currency as PARTIALLY_PAID', async () => {
      const { aggregate: result, legacy } = await getOwnSalaryStates(
        makeDb([row('500', 'PAID'), row('500', 'PENDING')]),
        USER_ID,
        SALARY_MONTH,
        AWAITING_CREATION,
      )

      expect(result).toEqual({
        state: 'EXISTS',
        amount: 1000,
        currency: 'USD',
        status: 'PARTIALLY_PAID',
        transactionCount: 2,
        totals: [
          {
            currency: 'USD',
            amount: 1000,
            paidAmount: 500,
            pendingAmount: 500,
            lockedAmount: 0,
          },
        ],
      })
      expect(legacy).toEqual({
        state: 'EXISTS',
        amount: 500,
        currency: 'USD',
        status: 'PAID',
      })
    })

    it('reports PAID only when every valid part is paid', async () => {
      const { aggregate: result } = await getOwnSalaryStates(
        makeDb([row('400', 'PAID'), row('600', 'PAID')]),
        USER_ID,
        SALARY_MONTH,
        AWAITING_CREATION,
      )

      expect(result).toMatchObject({
        state: 'EXISTS',
        amount: 1000,
        currency: 'USD',
        status: 'PAID',
        transactionCount: 2,
      })
      if (result.state !== 'EXISTS') throw new Error('unreachable')
      expect(result.totals[0]?.paidAmount).toBe(1000)
    })

    it('reports LOCKED when every valid part is locked', async () => {
      const { aggregate: result } = await getOwnSalaryStates(
        makeDb([row('300', 'LOCKED'), row('200', 'LOCKED')]),
        USER_ID,
        SALARY_MONTH,
        AWAITING_CREATION,
      )

      expect(result).toMatchObject({
        state: 'EXISTS',
        amount: 500,
        currency: 'USD',
        status: 'LOCKED',
        transactionCount: 2,
      })
      if (result.state !== 'EXISTS') throw new Error('unreachable')
      expect(result.totals[0]?.lockedAmount).toBe(500)
    })

    it('does not report LOCKED when only some valid parts are locked', async () => {
      const { aggregate: result } = await getOwnSalaryStates(
        makeDb([row('300', 'LOCKED'), row('200', 'PENDING')]),
        USER_ID,
        SALARY_MONTH,
        AWAITING_CREATION,
      )

      expect(result).toMatchObject({
        state: 'EXISTS',
        amount: 500,
        currency: 'USD',
        status: 'PENDING',
        transactionCount: 2,
      })
    })

    it('does not collapse mixed currencies into a misleading amount', async () => {
      const { aggregate: result, legacy } = await getOwnSalaryStates(
        makeDb([row('500', 'PAID', 'USD'), row('450', 'PENDING', 'EUR')]),
        USER_ID,
        SALARY_MONTH,
        AWAITING_CREATION,
      )

      expect(result).toEqual({
        state: 'EXISTS',
        amount: null,
        currency: null,
        status: 'PARTIALLY_PAID',
        transactionCount: 2,
        totals: [
          {
            currency: 'EUR',
            amount: 450,
            paidAmount: 0,
            pendingAmount: 450,
            lockedAmount: 0,
          },
          {
            currency: 'USD',
            amount: 500,
            paidAmount: 500,
            pendingAmount: 0,
            lockedAmount: 0,
          },
        ],
      })
      expect(legacy).toEqual({
        state: 'EXISTS',
        amount: 500,
        currency: 'USD',
        status: 'PAID',
      })
    })

    it('counts only valid salary parts', async () => {
      const { aggregate: result } = await getOwnSalaryStates(
        makeDb([row('100', 'CANCELLED'), row('9999.99', 'PENDING')]),
        USER_ID,
        SALARY_MONTH,
        AWAITING_CREATION,
      )

      expect(result).toMatchObject({
        state: 'EXISTS',
        amount: 9999.99,
        transactionCount: 1,
      })
    })
  })

  describe('multipart totals are exact (numeric(18,6) strings, not IEEE floats)', () => {
    it('sums 0.1 + 0.2 style parts to exactly 0.3', async () => {
      const { aggregate } = await getOwnSalaryStates(
        makeDb([row('0.1', 'PENDING', 'USD'), row('0.2', 'PENDING', 'USD')]),
        USER_ID,
        SALARY_MONTH,
        AWAITING_CREATION,
      )
      if (aggregate.state !== 'EXISTS') throw new Error('expected EXISTS')
      expect(aggregate.amount).toBe(0.3)
      expect(aggregate.totals[0]).toMatchObject({
        amount: 0.3,
        pendingAmount: 0.3,
        paidAmount: 0,
        lockedAmount: 0,
      })
    })

    it('does not ship 3000.3000000000004 for 1000.1 + 2000.2, per status bucket', async () => {
      const { aggregate } = await getOwnSalaryStates(
        makeDb([
          row('1000.100000', 'PAID', 'USDT'),
          row('2000.200000', 'PAID', 'USDT'),
          row('0.1', 'LOCKED', 'USDT'),
          row('0.2', 'LOCKED', 'USDT'),
        ]),
        USER_ID,
        SALARY_MONTH,
        AWAITING_CREATION,
      )
      if (aggregate.state !== 'EXISTS') throw new Error('expected EXISTS')
      expect(aggregate.totals[0]).toMatchObject({
        amount: 3000.6,
        paidAmount: 3000.3,
        lockedAmount: 0.3,
      })
    })
  })
})

// SR-795-L-3 (task-retro-salary-ledger-integrity). `mySalaryState` is the
// byte-compatible single-part field a stale browser bundle still parses. PR #795
// removed the `.limit(1)` that used to make the read deterministic and replaced
// it with `validRows[0]`, so WHICH of an employee's salary parts their own page
// showed came down to whatever order Postgres happened to return — it can change
// after a VACUUM or an UPDATE with no data change at all. The oldest part is the
// representative one, matching the order the prepare migration's DISTINCT ON
// backfill uses to pick a month's authoritative row.
describe('getOwnSalaryStates — deterministic legacy projection (SR-795-L-3)', () => {
  it('orders the read by created_at then id, ascending', async () => {
    const capture: { orderBy?: unknown[] } = {}
    await getOwnSalaryStates(
      makeDb([row('100', 'PENDING')], capture),
      USER_ID,
      SALARY_MONTH,
      AWAITING_CREATION,
    )

    const dialect = new PgDialect()
    expect(capture.orderBy).toHaveLength(2)
    expect(capture.orderBy!.map((clause) => dialect.sqlToQuery(clause as SQL).sql)).toEqual([
      '"non_deleted_transactions"."created_at" asc',
      '"non_deleted_transactions"."id" asc',
    ])
  })

  it('reports the first ordered row as the legacy single part', async () => {
    const { legacy } = await getOwnSalaryStates(
      makeDb([row('100', 'PENDING', 'EUR'), row('900', 'PAID', 'USD')]),
      USER_ID,
      SALARY_MONTH,
      AWAITING_CREATION,
    )

    expect(legacy).toEqual({ state: 'EXISTS', amount: 100, currency: 'EUR', status: 'PENDING' })
  })
})
