/**
 * Unit tests for getOwnSalaryStatus (salary-status.helper.ts).
 *
 * The helper is a pure function over a Drizzle db handle — no NestJS DI.
 * We pass a minimal mock that satisfies the `db.select().from(nonDeleted
 * Transactions).where(...).limit(1)` chain the helper now uses (security-
 * review PR #456 round 2 — sources from the `nonDeletedTransactions` VIEW
 * instead of the raw table + a hand-written `isNull(deletedAt)` filter) so
 * the suite is fast and dependency-free.
 *
 * task-salary-month-gap-and-status (E-6): before this task, "no row exists"
 * always returned a bare `null` regardless of whether `monthlySalary` was
 * configured — the two states were indistinguishable. The helper now takes a
 * 4th `hasSalaryConfigured` argument and returns a 3-state discriminated
 * union. This spec is the RED→GREEN proof: every "no row" case below asserts
 * `{ state: 'NOT_CONFIGURED' | 'AWAITING_CREATION' }` depending on that
 * argument — a plain `null` return (the pre-fix shape) fails ALL of them.
 *
 * Covers:
 *   1. No row + not configured → NOT_CONFIGURED.
 *   2. No row + configured → AWAITING_CREATION (the E-5/E-6 link: this is
 *      exactly the state a missed cron month produces).
 *   3. Unexpected status (defensive) → same NOT_CONFIGURED/AWAITING_CREATION
 *      branching as "no row", driven by the SAME hasSalaryConfigured input.
 *   4. Valid row → EXISTS {amount, currency, status} for each valid status,
 *      REGARDLESS of hasSalaryConfigured (the row's existence is what
 *      matters once it exists).
 *   5. currency is taken from the row (no hard-coded USD).
 */

import { describe, expect, it } from 'vitest'
import { getOwnSalaryStatus } from './salary-status.helper'
import type { DatabaseService } from '../database/database.service'

// Minimal type matching what the view-backed select returns.
type TransactionRow = {
  type: string
  status: string
  amount: string
  currency: string
  receiverId: string
  salaryMonth: string | null
}

/**
 * Build a minimal DatabaseService['db'] mock. The `.limit(1)` step resolves
 * to `[row]` (or `[]` to simulate "no row found").
 */
function makeDb(row: TransactionRow | undefined): DatabaseService['db'] {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    }),
  } as unknown as DatabaseService['db']
}

const USER_ID = 'aaaaaaaa-0000-4000-0000-000000000001'
const SALARY_MONTH = '2026-06'

describe('getOwnSalaryStatus', () => {
  describe('no row exists — the E-6 configured/not-configured split', () => {
    it('returns NOT_CONFIGURED when no row exists and monthlySalary is not set', async () => {
      const db = makeDb(undefined)
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, false)
      expect(result).toEqual({ state: 'NOT_CONFIGURED' })
    })

    it('returns AWAITING_CREATION when no row exists but monthlySalary IS set (the E-5 gap state)', async () => {
      const db = makeDb(undefined)
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, true)
      expect(result).toEqual({ state: 'AWAITING_CREATION' })
    })

    it('the two states are distinguishable by shape, not just by a caller-side reinterpretation of null', async () => {
      const db = makeDb(undefined)
      const notConfigured = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, false)
      const awaiting = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, true)
      expect(notConfigured).not.toEqual(awaiting)
      expect(notConfigured).not.toBeNull()
      expect(awaiting).not.toBeNull()
    })
  })

  describe('row has an unsupported status (defensive)', () => {
    function unsupportedRow(): TransactionRow {
      return {
        type: 'SALARY',
        status: 'CANCELLED', // not in validStatuses
        amount: '1000',
        currency: 'USD',
        receiverId: USER_ID,
        salaryMonth: SALARY_MONTH,
      }
    }

    it('degrades to NOT_CONFIGURED when not configured', async () => {
      const db = makeDb(unsupportedRow())
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, false)
      expect(result).toEqual({ state: 'NOT_CONFIGURED' })
    })

    it('degrades to AWAITING_CREATION when configured', async () => {
      const db = makeDb(unsupportedRow())
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, true)
      expect(result).toEqual({ state: 'AWAITING_CREATION' })
    })
  })

  describe('a valid row always wins — EXISTS regardless of hasSalaryConfigured', () => {
    it('returns EXISTS for PENDING status even when hasSalaryConfigured is false', async () => {
      const db = makeDb({
        type: 'SALARY',
        status: 'PENDING',
        amount: '2500',
        currency: 'UAH',
        receiverId: USER_ID,
        salaryMonth: SALARY_MONTH,
      })
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, false)
      expect(result).toEqual({ state: 'EXISTS', amount: 2500, currency: 'UAH', status: 'PENDING' })
    })

    it('returns EXISTS for PAID status', async () => {
      const db = makeDb({
        type: 'SALARY',
        status: 'PAID',
        amount: '1200',
        currency: 'USD',
        receiverId: USER_ID,
        salaryMonth: SALARY_MONTH,
      })
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, true)
      expect(result).toEqual({ state: 'EXISTS', amount: 1200, currency: 'USD', status: 'PAID' })
    })

    it('returns EXISTS for LOCKED status', async () => {
      const db = makeDb({
        type: 'SALARY',
        status: 'LOCKED',
        amount: '3000',
        currency: 'USDT',
        receiverId: USER_ID,
        salaryMonth: SALARY_MONTH,
      })
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, true)
      expect(result).toEqual({ state: 'EXISTS', amount: 3000, currency: 'USDT', status: 'LOCKED' })
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
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, true)
      expect(result.state).toBe('EXISTS')
      expect(result).toMatchObject({ currency: 'UAH' })
      expect(result).not.toMatchObject({ currency: 'USD' })
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
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, true)
      expect(result.state).toBe('EXISTS')
      if (result.state !== 'EXISTS') throw new Error('unreachable')
      expect(typeof result.amount).toBe('number')
      expect(result.amount).toBeCloseTo(9999.99, 2)
    })
  })
})
