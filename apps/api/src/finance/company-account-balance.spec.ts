import { describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'

/**
 * task-salary-company-account — unit test for the SINGLE SOURCE OF TRUTH
 * company-account balance helper. The helper runs `db.select().from().where()`
 * SIX times IN ORDER:
 *   [deposits, payouts(COMPANY), adminIncome(COMPANY), dividends,
 *    salary(COMPANY), expense(COMPANY)]
 * balance = deposits + payouts + adminIncome − dividends − salary − expense.
 *
 * We stub the chained select so each call returns the next total in `totals`,
 * then assert the arithmetic for every term (AC6).
 */

// Stub db.select().from().where() returning totals[call] per invocation.
function makeDb(totals: string[]): DatabaseService['db'] {
  let call = 0
  const select = vi.fn(() => ({
    from: () => ({
      where: () => Promise.resolve([{ total: totals[call++] ?? '0' }]),
    }),
  }))
  return { select } as unknown as DatabaseService['db']
}

describe('computeCompanyAccountBalanceFromLedger — 6-term ledger', () => {
  it('sums all six terms with correct signs', async () => {
    // deposits=1000, payouts=500, adminIncome=300, dividends=200, salary=400, expense=150
    // → 1000 + 500 + 300 − 200 − 400 − 150 = 1050
    const db = makeDb(['1000', '500', '300', '200', '400', '150'])
    expect(await computeCompanyAccountBalanceFromLedger(db)).toBe(1050)
  })

  it('deposit-only → positive balance', async () => {
    const db = makeDb(['750', '0', '0', '0', '0', '0'])
    expect(await computeCompanyAccountBalanceFromLedger(db)).toBe(750)
  })

  it('PAYOUT(COMPANY) credits (+)', async () => {
    const db = makeDb(['0', '640', '0', '0', '0', '0'])
    expect(await computeCompanyAccountBalanceFromLedger(db)).toBe(640)
  })

  it('ADMIN_INCOME(COMPANY) credits (+) — NEW term', async () => {
    const db = makeDb(['0', '0', '900', '0', '0', '0'])
    expect(await computeCompanyAccountBalanceFromLedger(db)).toBe(900)
  })

  it('DIVIDEND debits (−)', async () => {
    const db = makeDb(['1000', '0', '0', '250', '0', '0'])
    expect(await computeCompanyAccountBalanceFromLedger(db)).toBe(750)
  })

  it('SALARY(COMPANY) debits (−)', async () => {
    const db = makeDb(['1000', '0', '0', '0', '350', '0'])
    expect(await computeCompanyAccountBalanceFromLedger(db)).toBe(650)
  })

  it('EXPENSE(COMPANY) debits (−) — NEW term', async () => {
    const db = makeDb(['1000', '0', '0', '0', '0', '420'])
    expect(await computeCompanyAccountBalanceFromLedger(db)).toBe(580)
  })

  it('NaN / NULL totals coerce to 0', async () => {
    const db = makeDb(['not-a-number', '0', '0', '0', '0', '0'])
    expect(await computeCompanyAccountBalanceFromLedger(db)).toBe(0)
  })
})
