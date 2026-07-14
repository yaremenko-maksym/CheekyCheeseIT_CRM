import { describe, expect, it, vi } from 'vitest'
import { inspect } from 'util'
import type { DatabaseService } from '../database/database.service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'

/**
 * AC5 — company-account-balance currency-guard.
 *
 * All sumAmount calls for the company USDT ledger must filter on
 * `currency = 'USDT'` so that a non-USDT row does NOT distort the
 * USDT balance. This is defence-in-depth.
 *
 * We verify:
 *   1. The function executes 8 queries (7th SENIOR_INCOME + 8th PAYOUT_DROP term —
 *      task-drop-share-override-and-receiver C7).
 *   2. Each WHERE predicate carries an eq(transactions.currency, 'USDT') condition.
 *      We use util.inspect() to stringify the Drizzle SQL AST (avoids JSON.stringify
 *      circular-reference error) and check that 'USDT' appears as a SQL parameter value.
 */

describe('AC5: computeCompanyAccountBalanceFromLedger — currency=USDT guard on all sumAmount calls', () => {
  it('queries 8 ledger terms (SENIOR_INCOME + PAYOUT_DROP — company-funded settlements)', async () => {
    let callCount = 0
    const totals = ['1000', '500', '300', '200', '400', '150', '80', '60']

    const select = vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve([{ total: totals[callCount++] ?? '0' }]),
      }),
    }))
    const db = { select } as unknown as DatabaseService['db']

    await computeCompanyAccountBalanceFromLedger(db)

    // 8 terms: deposits, payouts(COMPANY), adminIncome(COMPANY), dividends,
    // salary(COMPANY), expense(COMPANY), seniorPayout(COMPANY), dropPayout(COMPANY)
    expect(callCount).toBe(8)
  })

  it('each WHERE clause includes the USDT currency predicate', async () => {
    const capturedClauses: unknown[] = []
    let callCount = 0
    const totals = ['1000', '500', '300', '200', '400', '150', '80', '60']

    const select = vi.fn(() => ({
      from: () => ({
        where: (clause: unknown) => {
          capturedClauses.push(clause)
          return Promise.resolve([{ total: totals[callCount++] ?? '0' }])
        },
      }),
    }))
    const db = { select } as unknown as DatabaseService['db']

    await computeCompanyAccountBalanceFromLedger(db)

    // util.inspect() deep-serialises Drizzle SQL AST without hitting JSON circular refs.
    // Each SQL eq(transactions.currency, 'USDT') call stores 'USDT' as a SQL parameter
    // value inside the AST — inspect renders it as the string "USDT".
    for (let i = 0; i < capturedClauses.length; i++) {
      const clauseStr = inspect(capturedClauses[i], { depth: 20 })
      expect(clauseStr, `WHERE clause #${i} must include currency='USDT' predicate`).toContain(
        "'USDT'",
      )
    }
  })

  it('arithmetic is correct with 8-term formula', async () => {
    let call = 0
    // deposits=1000, payouts=500, adminIncome=300, dividends=200, salary=400,
    // expense=150, seniorPayout=80, dropPayout=60
    // balance = 1000 + 500 + 300 − 200 − 400 − 150 − 80 − 60 = 910
    const totals = ['1000', '500', '300', '200', '400', '150', '80', '60']

    const select = vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve([{ total: totals[call++] ?? '0' }]),
      }),
    }))
    const db = { select } as unknown as DatabaseService['db']

    const balance = await computeCompanyAccountBalanceFromLedger(db)
    expect(balance).toBeCloseTo(910, 2)
  })
})
