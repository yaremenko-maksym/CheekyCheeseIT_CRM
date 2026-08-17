import { describe, expect, it, vi } from 'vitest'
import { inspect } from 'util'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { Logger } from '@nestjs/common'
import type { DatabaseService } from '../database/database.service'
import {
  CompanyAccountOffCurrencyError,
  computeCompanyAccountBalanceForDisplay,
  computeCompanyAccountBalanceFromLedger,
} from './company-account-balance'

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

/**
 * C-3 (mega-audit wave 2, AC7/AC8) — assertNoOffCurrencyCompanyRows unit
 * coverage. The real-DB behaviour (a genuine off-currency row actually
 * getting rejected end-to-end) is proven by
 * company-account-balance-off-currency.integration.spec.ts; THIS suite is
 * the unit-level, mocked-db coverage the mutation gate needs — Stryker's
 * non-integration run never executes *.integration.spec.ts files, so the
 * throw path, its message, and its 9th-query shape must ALSO be pinned here
 * or every mutant inside `assertNoOffCurrencyCompanyRows` is invisible to it.
 */
describe('C-3: assertNoOffCurrencyCompanyRows (9th query, mocked db)', () => {
  // 8 SUM terms all zero (irrelevant to this guard) + a controllable 9th
  // (the off-currency COUNT(*) check) whose row/total we vary per test.
  function makeDb(ninthRows: Array<{ total: string }>) {
    let callCount = 0
    let ninthProjection: unknown
    let ninthWhere: unknown
    const select = vi.fn((projection: unknown) => {
      const idx = callCount
      if (idx === 8) ninthProjection = projection
      return {
        from: () => ({
          where: (clause: unknown) => {
            if (idx === 8) ninthWhere = clause
            callCount++
            if (idx < 8) return Promise.resolve([{ total: '0' }])
            return Promise.resolve(ninthRows)
          },
        }),
      }
    })
    const db = { select } as unknown as DatabaseService['db']
    return {
      db,
      getNinthProjection: () => ninthProjection,
      getNinthWhere: () => ninthWhere,
    }
  }

  it('throws a message naming the count when off-currency company rows exist (count=2)', async () => {
    const { db } = makeDb([{ total: '2' }])
    let caught: unknown
    try {
      await computeCompanyAccountBalanceFromLedger(db)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    // Each assertion below pins one of the five concatenated string literals
    // that make up the thrown message — killing each independently.
    expect(message).toContain('found 2 PAID company-account')
    expect(message).toContain('row(s) booked in a currency other than USDT. The company account is')
    expect(message).toContain(
      'USDT-only — these rows would silently drop out of the balance instead of',
    )
    expect(message).toContain(
      'being counted or rejected. Fix the offending row(s) (wrong currency label)',
    )
    expect(message).toContain('before trusting this balance.')
  })

  it('does NOT throw when the off-currency check finds zero rows (count=0)', async () => {
    const { db } = makeDb([{ total: '0' }])
    await expect(computeCompanyAccountBalanceFromLedger(db)).resolves.not.toThrow()
  })

  it('treats an empty result set (rows[0] undefined) as zero — no throw, no TypeError', async () => {
    const { db } = makeDb([])
    await expect(computeCompanyAccountBalanceFromLedger(db)).resolves.not.toThrow()
  })

  it('the 9th query selects COUNT(*) and filters status=PAID, currency<>USDT', async () => {
    const { db, getNinthProjection, getNinthWhere } = makeDb([{ total: '0' }])
    await computeCompanyAccountBalanceFromLedger(db)

    const projectionStr = inspect(getNinthProjection(), { depth: 20 })
    expect(projectionStr).toContain('COUNT(*)')

    // NOT a raw inspect()-substring check: `status`/`currency` are Drizzle
    // pgEnum columns, whose AST node carries a static `enumValues` list (EVERY
    // value the Postgres enum can ever hold, e.g. status's PENDING/VALIDATED/
    // PAID/REJECTED) as a plain property alongside the actual bound `Param`.
    // A substring search over the whole inspected tree would "find" 'PAID' /
    // 'USDT' via that metadata regardless of what the query actually binds —
    // empirically confirmed: mutating 'PAID' → '' at the call site left an
    // inspect()-substring assertion GREEN. A generic AST-walker (this file's
    // sibling helper, drizzle-where-introspection.ts's collectParamValues)
    // ALSO breaks here — `nonDeletedTransactions` is a `pgView` whose column
    // references are alias-proxied, which recurses infinitely under a plain
    // `Object.values()` walk. `PgDialect#sqlToQuery` is the REAL Postgres
    // compiler drizzle itself uses (see source-income-drop-link-schema.spec.ts
    // for the same technique) — it returns the actual bound `params` array,
    // sidestepping both traps entirely.
    const compiled = new PgDialect().sqlToQuery(getNinthWhere() as SQL)
    expect(compiled.params).toContain('PAID')
    expect(compiled.params).toContain('USDT')
  })
})

/**
 * SEC-1 (mega-audit wave 2, review round 2) — localization test.
 *
 * The security-reviewer flagged a real gap: nothing proved the off-currency
 * guard's failure mode was actually LOCALIZED — that a money-moving gate
 * still refuses (fail-closed, correct) while a read-only display path
 * degrades instead of 500ing (stays alive, also correct). Before this test,
 * BOTH entry points shared the exact same throw, so an accidental future
 * regression that made the display path start throwing again — or, just as
 * bad, made the "safe" wrapper start swallowing genuine DB errors — would
 * have been invisible to every other test in this file.
 *
 * `computeCompanyAccountBalanceFromLedger` stands in for the four money
 * gates (createExpense/paySalary/settleByCompany/createDividend — all call
 * it directly, unchanged by this PR); `computeCompanyAccountBalanceForDisplay`
 * is the display-safe wrapper the diagnostic screen should call. See its
 * docstring in company-account-balance.ts for the caller-wiring note (out of
 * this task's zone — company-account.service.ts is not touched here).
 */
describe('SEC-1: gate throws / display degrades — localization of the off-currency guard', () => {
  // Routed by CONTENT, not call position: the guard's COUNT(*) query is
  // distinguished from the 8 SUM-term queries by inspecting the projection
  // object each `select()` call receives. Round 3 (SEC-1 wiring) made
  // `computeCompanyAccountBalanceForDisplay` call the 8-term sum TWICE on the
  // degraded path (once inside the failed guarded attempt, once again for
  // the best-effort recompute) — a position-based mock (call #9 = the guard)
  // silently breaks the moment the call COUNT changes; this one does not.
  function makeDb(ninthTotal: string, sumTotal = '0') {
    const select = vi.fn((projection: unknown) => {
      const isCountQuery = inspect(projection, { depth: 10 }).includes('COUNT(*)')
      return {
        from: () => ({
          where: () => Promise.resolve([{ total: isCountQuery ? ninthTotal : sumTotal }]),
        }),
      }
    })
    return { select } as unknown as DatabaseService['db']
  }

  it('the GATE path (computeCompanyAccountBalanceFromLedger) still throws CompanyAccountOffCurrencyError', async () => {
    const db = makeDb('4')
    await expect(computeCompanyAccountBalanceFromLedger(db)).rejects.toBeInstanceOf(
      CompanyAccountOffCurrencyError,
    )
  })

  it('the DISPLAY path (computeCompanyAccountBalanceForDisplay) does NOT throw on the same condition — degrades instead, with a best-effort balance', async () => {
    // sumTotal=100 on every one of the 8 terms → 3 credit terms − 5 debit
    // terms = 300 − 500 = −200. A non-zero, non-default figure — proves the
    // degraded `balance` is a REAL recomputation, not a hardcoded 0/null.
    const db = makeDb('4', '100')
    const reading = await computeCompanyAccountBalanceForDisplay(db)
    expect(reading.reliable).toBe(false)
    expect(reading.offCurrencyCount).toBe(4)
    expect(reading.balance).toBe(-200)
  })

  it('the DISPLAY path stays reliable and returns the real balance on a clean ledger', async () => {
    const db = makeDb('0')
    const reading = await computeCompanyAccountBalanceForDisplay(db)
    expect(reading.reliable).toBe(true)
    expect(reading.offCurrencyCount).toBe(0)
    expect(reading.balance).toBe(0) // all 8 SUM terms mocked to '0' in makeDb
  })

  it('the DISPLAY path does NOT swallow a genuine (non-off-currency) failure — it must stay loud too', async () => {
    // A DB error surfacing from one of the 8 SUM terms (e.g. connection drop)
    // is a DIFFERENT failure mode than "the guard found a bad row" — must
    // propagate, not get silently mapped to a misleading reliable:false.
    //
    // Mutation-gate (`instanceof CompanyAccountOffCurrencyError` → `true`):
    // a mock that rejects EVERY call would still reject the same way under
    // that mutant (the fallback recompute would ALSO fail), so the assertion
    // alone cannot kill it. This mock instead FAILS the first 8-term cycle
    // and SUCCEEDS on any later cycle — correct code never reaches a second
    // cycle (it rethrows immediately); the mutant WOULD reach it (treats the
    // plain Error as the off-currency case, retries via `sumLedgerTerms`,
    // and that retry succeeds) — resolving instead of rejecting, and calling
    // `select` far more than 8 times.
    let firstCycleDone = false
    let callsInFirstCycle = 0
    const select = vi.fn(() => ({
      from: () => ({
        where: () => {
          if (!firstCycleDone) {
            callsInFirstCycle++
            if (callsInFirstCycle === 8) firstCycleDone = true
            return Promise.reject(new Error('connection terminated unexpectedly'))
          }
          return Promise.resolve([{ total: '0' }])
        },
      }),
    }))
    const db = { select } as unknown as DatabaseService['db']
    await expect(computeCompanyAccountBalanceForDisplay(db)).rejects.toThrow(
      /connection terminated unexpectedly/,
    )
    // Exactly the 8-term sum ran once — the off-currency guard's 9th query
    // never fires (the Promise.all already rejected) AND, crucially, the
    // best-effort recompute never fires either (that would add MORE calls).
    expect(select).toHaveBeenCalledTimes(8)
  })

  it('CompanyAccountOffCurrencyError carries a named, distinguishable .name (not the default "Error")', () => {
    const err = new CompanyAccountOffCurrencyError(3)
    expect(err.name).toBe('CompanyAccountOffCurrencyError')
    expect(err.count).toBe(3)
    expect(err).toBeInstanceOf(Error)
  })

  it('the display-degraded log carries the real detail message and the module-scoped logger context', async () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    try {
      const db = makeDb('7')
      await computeCompanyAccountBalanceForDisplay(db)

      expect(errorSpy).toHaveBeenCalledTimes(1)
      const [message] = errorSpy.mock.calls[0]!
      expect(message).toContain('company-account balance display degraded — ')
      expect(message).toContain('found 7 PAID company-account row(s)')

      // The `this` the spy was invoked on IS the module-level Logger instance
      // — its bound context is what actually prefixes the printed log line.
      const boundLogger = errorSpy.mock.instances[0] as unknown as { context?: string }
      expect(boundLogger.context).toBe('company-account-balance')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
