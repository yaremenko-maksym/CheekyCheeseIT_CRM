/**
 * Unit tests for getOwnSalaryStatus (salary-status.helper.ts).
 *
 * The helper is a pure function over a Drizzle db handle — no NestJS DI.
 * We pass a minimal mock that satisfies the `db.query.transactions.findFirst`
 * interface so the suite is fast and dependency-free.
 *
 * Covers:
 *   1. Returns null when no SALARY row exists for the month.
 *   2. Returns null when the row has an unexpected status (defensive path).
 *   3. Returns {amount, currency, status} for each valid status.
 *   4. currency is taken from the row (no hard-coded USD).
 */

import { describe, expect, it } from 'vitest'
import { getOwnSalaryStatus } from './salary-status.helper'
import type { DatabaseService } from '../database/database.service'

// Minimal type matching what Drizzle's `query.transactions.findFirst` returns.
type TransactionRow = {
  type: string
  status: string
  amount: string
  currency: string
  receiverId: string
  salaryMonth: string | null
}

/**
 * Build a minimal DatabaseService['db'] mock. `findFirst` returns the
 * provided row (or undefined to simulate "no row found").
 */
function makeDb(row: TransactionRow | undefined): DatabaseService['db'] {
  return {
    query: {
      transactions: {
        findFirst: async () => row,
      },
    },
  } as unknown as DatabaseService['db']
}

const USER_ID = 'aaaaaaaa-0000-4000-0000-000000000001'
const SALARY_MONTH = '2026-06'

describe('getOwnSalaryStatus', () => {
  it('returns null when no salary row exists for the month', async () => {
    const db = makeDb(undefined)
    const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH)
    expect(result).toBeNull()
  })

  it('returns null when the row has an unsupported status (defensive)', async () => {
    const db = makeDb({
      type: 'SALARY',
      status: 'CANCELLED', // not in validStatuses
      amount: '1000',
      currency: 'USD',
      receiverId: USER_ID,
      salaryMonth: SALARY_MONTH,
    })
    const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH)
    expect(result).toBeNull()
  })

  it('returns correct shape for PENDING status', async () => {
    const db = makeDb({
      type: 'SALARY',
      status: 'PENDING',
      amount: '2500',
      currency: 'UAH',
      receiverId: USER_ID,
      salaryMonth: SALARY_MONTH,
    })
    const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH)
    expect(result).toEqual({ amount: 2500, currency: 'UAH', status: 'PENDING' })
  })

  it('returns correct shape for PAID status', async () => {
    const db = makeDb({
      type: 'SALARY',
      status: 'PAID',
      amount: '1200',
      currency: 'USD',
      receiverId: USER_ID,
      salaryMonth: SALARY_MONTH,
    })
    const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH)
    expect(result).toEqual({ amount: 1200, currency: 'USD', status: 'PAID' })
  })

  it('returns correct shape for LOCKED status', async () => {
    const db = makeDb({
      type: 'SALARY',
      status: 'LOCKED',
      amount: '3000',
      currency: 'USDT',
      receiverId: USER_ID,
      salaryMonth: SALARY_MONTH,
    })
    const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH)
    expect(result).toEqual({ amount: 3000, currency: 'USDT', status: 'LOCKED' })
  })

  it('currency is taken from the row — no hard-coded USD (UAH example)', async () => {
    // The salary-currency bug fix: a UAH salary must NOT surface as USD.
    const db = makeDb({
      type: 'SALARY',
      status: 'PENDING',
      amount: '50000',
      currency: 'UAH',
      receiverId: USER_ID,
      salaryMonth: SALARY_MONTH,
    })
    const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH)
    expect(result).not.toBeNull()
    expect(result!.currency).toBe('UAH')
    expect(result!.currency).not.toBe('USD')
  })

  it('converts string amount to number', async () => {
    const db = makeDb({
      type: 'SALARY',
      status: 'PENDING',
      amount: '9999.99',
      currency: 'USD',
      receiverId: USER_ID,
      salaryMonth: SALARY_MONTH,
    })
    const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH)
    expect(result).not.toBeNull()
    expect(typeof result!.amount).toBe('number')
    expect(result!.amount).toBeCloseTo(9999.99, 2)
  })
})
