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

/**
 * task-cascade-apply (task 3) — the NINTH term, addendum §1.3.
 *
 * A cascade revert flips a settled derivative back
 * `PAID → PENDING_PAYMENT`, which drops it out of term 7/8 and therefore
 * REMOVES a debit for money that physically left the account. The ninth term
 * puts that debit back, keyed on the MONOTONIC `settled_amount` accumulator
 * (the figure that actually left) rather than `amount` (which the cascade has
 * just rewritten to the NEW share).
 *
 * Risk 4 of the ADR's list: an error in the "+" direction here inflates the
 * balance and is caught by NO automatic gate — the money gates read this very
 * number (`if (amount > balance) throw`), so an inflated balance lets the
 * system spend what it does not have. Every figure below is a hand-computed
 * literal, never re-derived the way the production code derives it.
 *
 * Test-AC 4b: this is the UNIT half. The real-Postgres half lives in
 * `cascade-apply.integration.spec.ts` (balance before/after a revert) — the
 * mutation gate cannot execute that file at all
 * (`mutation-gate-integration-specs.md`), which is why the arithmetic is
 * pinned here with fixed numbers as well.
 */
describe('computeCompanyAccountBalanceFromLedger — 9th term (reverted-to-PENDING settled amounts)', () => {
  it('sums all NINE terms with correct signs', async () => {
    // 1000 + 500 + 300 − 200 − 400 − 150 − 80 − 60 − 25 = 885 (computed by hand)
    const db = makeDb(['1000', '500', '300', '200', '400', '150', '80', '60', '25'])
    expect(await computeCompanyAccountBalanceFromLedger(db)).toBe(885)
  })

  it('the 9th term DEBITS (−): a reverted row alone drives the balance negative', async () => {
    const db = makeDb(['0', '0', '0', '0', '0', '0', '0', '0', '700'])
    expect(await computeCompanyAccountBalanceFromLedger(db)).toBe(-700)
  })

  it('a revert is balance-NEUTRAL: the debit term 7 loses is exactly what term 9 returns', async () => {
    // BEFORE the revert the row sits in term 7 (SENIOR_INCOME, PAID) for 260;
    // AFTER it sits in term 9 (SENIOR_PENDING_PAYOUT, PENDING_PAYMENT) for the
    // same 260 that was actually paid. Deposits 1000 in both readings.
    const before = makeDb(['1000', '0', '0', '0', '0', '0', '260', '0', '0'])
    const after = makeDb(['1000', '0', '0', '0', '0', '0', '0', '0', '260'])
    expect(await computeCompanyAccountBalanceFromLedger(before)).toBe(740)
    expect(await computeCompanyAccountBalanceFromLedger(after)).toBe(740)
  })

  it('WITHOUT the 9th term the same revert would inflate the balance by the amount already paid', async () => {
    // The regression this term exists to prevent, stated as an inequality
    // rather than a repetition of the formula: a reading that ignores the
    // reverted row (term 9 = 0) is 260 HIGHER than the pre-revert truth.
    const preRevert = makeDb(['1000', '0', '0', '0', '0', '0', '260', '0', '0'])
    const revertedButUncompensated = makeDb(['1000', '0', '0', '0', '0', '0', '0', '0', '0'])
    const truth = await computeCompanyAccountBalanceFromLedger(preRevert)
    const inflated = await computeCompanyAccountBalanceFromLedger(revertedButUncompensated)
    expect(inflated - truth).toBe(260)
  })

  it('NaN / NULL in the 9th slot coerces to 0 like every other term', async () => {
    const db = makeDb(['500', '0', '0', '0', '0', '0', '0', '0', 'not-a-number'])
    expect(await computeCompanyAccountBalanceFromLedger(db)).toBe(500)
  })

  it('an EMPTY result set on the 9th term reads as 0 rather than blowing up', async () => {
    // `sumSettledAmount` reads `rows[0]?.total ?? '0'`. Postgres always returns
    // one row for a bare aggregate, so this is defence-in-depth — but without
    // the optional chain the whole balance read would throw a TypeError, i.e.
    // a 500 on four money gates, instead of a zero contribution.
    let call = 0
    const select = vi.fn(() => ({
      from: () => ({
        // index 8 = the 9th SUM term; index 9 = the off-currency guard COUNT.
        where: () => Promise.resolve(call++ === 8 ? [] : [{ total: '0' }]),
      }),
    }))
    const db = { select } as unknown as DatabaseService['db']
    await expect(computeCompanyAccountBalanceFromLedger(db)).resolves.toBe(0)
  })
})
