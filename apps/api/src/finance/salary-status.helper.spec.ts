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
 * configured — the two states were indistinguishable. Security-review MED-3
 * (round 2) then found a THIRD collapsed state: a role `monthlySalary` IS
 * configured for but the monthly cron never processes at all (SENIOR/DROP)
 * read back identically to "the cron just hasn't run yet" (AWAITING_CREATION)
 * — permanently and falsely implying an imminent automatic accrual. The
 * helper now takes a `{ hasMonthlySalary, isCronEligibleRole }` config object
 * and returns a 4-state discriminated union. This spec is the RED→GREEN
 * proof: every "no row" case below asserts a SPECIFIC state depending on
 * that input — a plain `null` return (the pre-fix shape), or collapsing
 * NOT_CRON_ELIGIBLE into NOT_CONFIGURED/AWAITING_CREATION, fails these.
 *
 * Covers:
 *   1. No row + not configured → NOT_CONFIGURED.
 *   2. No row + configured but role not cron-eligible → NOT_CRON_ELIGIBLE.
 *   3. No row + configured and role IS cron-eligible → AWAITING_CREATION
 *      (exactly the state a missed cron month produces).
 *   4. Unexpected status (defensive) → same 3-way branching as "no row",
 *      driven by the SAME `salaryConfig` input.
 *   5. Valid row → EXISTS {amount, currency, status} for each valid status,
 *      REGARDLESS of `salaryConfig` (the row's existence is what matters
 *      once it exists).
 *   6. currency is taken from the row (no hard-coded USD).
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

const NOT_CONFIGURED = { hasMonthlySalary: false, isCronEligibleRole: false }
// A role with `monthlySalary` set but the cron never processes (SENIOR/DROP).
const NOT_CRON_ELIGIBLE = { hasMonthlySalary: true, isCronEligibleRole: false }
const AWAITING_CREATION = { hasMonthlySalary: true, isCronEligibleRole: true }

describe('getOwnSalaryStatus', () => {
  describe('no row exists — the E-6 3-way split', () => {
    it('returns NOT_CONFIGURED when no row exists and monthlySalary is not set', async () => {
      const db = makeDb(undefined)
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, NOT_CONFIGURED)
      expect(result).toEqual({ state: 'NOT_CONFIGURED' })
    })

    it('returns NOT_CRON_ELIGIBLE when monthlySalary IS set but the role is never cron-processed (security-review MED-3)', async () => {
      const db = makeDb(undefined)
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, NOT_CRON_ELIGIBLE)
      expect(result).toEqual({ state: 'NOT_CRON_ELIGIBLE' })
    })

    it('returns AWAITING_CREATION when no row exists but monthlySalary IS set AND the role is cron-eligible (the E-5 gap state)', async () => {
      const db = makeDb(undefined)
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, AWAITING_CREATION)
      expect(result).toEqual({ state: 'AWAITING_CREATION' })
    })

    it('all three "no row" states are distinguishable by shape, not just a caller-side reinterpretation of null', async () => {
      const db = makeDb(undefined)
      const notConfigured = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, NOT_CONFIGURED)
      const notCronEligible = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, NOT_CRON_ELIGIBLE)
      const awaiting = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, AWAITING_CREATION)
      expect(notConfigured).not.toEqual(notCronEligible)
      expect(notConfigured).not.toEqual(awaiting)
      expect(notCronEligible).not.toEqual(awaiting)
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
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, NOT_CONFIGURED)
      expect(result).toEqual({ state: 'NOT_CONFIGURED' })
    })

    it('degrades to NOT_CRON_ELIGIBLE when configured but not cron-eligible', async () => {
      const db = makeDb(unsupportedRow())
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, NOT_CRON_ELIGIBLE)
      expect(result).toEqual({ state: 'NOT_CRON_ELIGIBLE' })
    })

    it('degrades to AWAITING_CREATION when configured and cron-eligible', async () => {
      const db = makeDb(unsupportedRow())
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, AWAITING_CREATION)
      expect(result).toEqual({ state: 'AWAITING_CREATION' })
    })
  })

  describe('a valid row always wins — EXISTS regardless of salaryConfig', () => {
    it('returns EXISTS for PENDING status even when NOT_CONFIGURED', async () => {
      const db = makeDb({
        type: 'SALARY',
        status: 'PENDING',
        amount: '2500',
        currency: 'UAH',
        receiverId: USER_ID,
        salaryMonth: SALARY_MONTH,
      })
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, NOT_CONFIGURED)
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
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, AWAITING_CREATION)
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
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, AWAITING_CREATION)
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
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, AWAITING_CREATION)
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
      const result = await getOwnSalaryStatus(db, USER_ID, SALARY_MONTH, AWAITING_CREATION)
      expect(result.state).toBe('EXISTS')
      if (result.state !== 'EXISTS') throw new Error('unreachable')
      expect(typeof result.amount).toBe('number')
      expect(result.amount).toBeCloseTo(9999.99, 2)
    })
  })
})
