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
 *   1. The function executes 9 queries: 8 SUM terms (7th SENIOR_INCOME + 8th
 *      PAYOUT_DROP term — task-drop-share-override-and-receiver C7) PLUS a 9th
 *      — the C-3 (mega-audit wave 2) off-currency existence check
 *      (`assertNoOffCurrencyCompanyRows`, company-account-balance.ts) that
 *      runs AFTER the 8-term Promise.all so the original 8 calls/order are
 *      untouched (see company-account-balance.spec.ts for the arithmetic,
 *      unaffected by this addition).
 *   2. Each of the 8 SUM WHERE predicates carries an
 *      eq(transactions.currency, 'USDT') condition. We use util.inspect() to
 *      stringify the Drizzle SQL AST (avoids JSON.stringify circular-reference
 *      error) and check that 'USDT' appears as a SQL parameter/text value.
 */

describe('AC5: computeCompanyAccountBalanceFromLedger — currency=USDT guard on all sumAmount calls', () => {
  it('queries 9 ledger terms (8 SUMs + the C-3 off-currency existence check)', async () => {
    let callCount = 0
    // 9th slot (index 8) feeds the C-3 assertNoOffCurrencyCompanyRows COUNT(*)
    // query — '0' means "no off-currency rows found", so it does not throw.
    const totals = ['1000', '500', '300', '200', '400', '150', '80', '60', '0']

    const select = vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve([{ total: totals[callCount++] ?? '0' }]),
      }),
    }))
    const db = { select } as unknown as DatabaseService['db']

    await computeCompanyAccountBalanceFromLedger(db)

    // 8 SUM terms: deposits, payouts(COMPANY), adminIncome(COMPANY), dividends,
    // salary(COMPANY), expense(COMPANY), seniorPayout(COMPANY), dropPayout(COMPANY)
    // + 1 C-3 off-currency existence check = 9.
    expect(callCount).toBe(9)
  })

  it('each of the 8 SUM WHERE clauses includes the USDT currency predicate', async () => {
    const capturedClauses: unknown[] = []
    let callCount = 0
    const totals = ['1000', '500', '300', '200', '400', '150', '80', '60', '0']

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
    // value inside the AST — inspect renders it as the string "USDT". Only the FIRST
    // 8 clauses are the currency-guarded SUM terms; the 9th (index 8) is the C-3
    // off-currency check, which deliberately does NOT filter on 'USDT' (it is
    // looking FOR non-USDT rows) — excluded from this loop.
    for (let i = 0; i < 8; i++) {
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
