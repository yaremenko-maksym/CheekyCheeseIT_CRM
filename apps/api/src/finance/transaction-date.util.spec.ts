import { HttpException, HttpStatus } from '@nestjs/common'
import { MAX_TRANSACTION_BUSINESS_YEAR, MIN_TRANSACTION_BUSINESS_YEAR } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import {
  formatTransactionBusinessDate,
  parseTransactionBusinessDate,
  resolveTransactionDate,
} from './transaction-date.util'

/**
 * Returns what `act` threw, or `undefined` when it returned normally — so the
 * assertions stay unconditional (`vitest/no-conditional-expect`) while still
 * inspecting the thrown value's status and code.
 */
function captureThrown(act: () => unknown): unknown {
  try {
    act()
    return undefined
  } catch (err) {
    return err
  }
}

describe('formatTransactionBusinessDate', () => {
  it('uses the UTC calendar date consistently', () => {
    expect(formatTransactionBusinessDate(new Date('2026-07-14T23:30:00.000Z'))).toBe('2026-07-14')
  })
})

describe('resolveTransactionDate', () => {
  it('keeps the exact current instant when no custom date is supplied', () => {
    const now = new Date('2026-10-05T18:12:34.567Z')
    expect(resolveTransactionDate(undefined, now)).toBe(now)
    expect(resolveTransactionDate(null, now)).toBe(now)
  })

  it('keeps the exact current instant when the selected date is the current UTC day', () => {
    const now = new Date('2026-10-05T18:12:34.567Z')
    expect(resolveTransactionDate('2026-10-05', now)).toBe(now)
  })

  it('preserves a selected calendar day when Kyiv has already crossed midnight but UTC has not', () => {
    // A date-only value is an accounting calendar key, encoded at UTC midnight.
    // Returning `now` here would silently turn the selected 15th back into a
    // timestamp whose UTC date is the 14th.
    const now = new Date('2026-07-14T21:30:00.000Z')
    expect(resolveTransactionDate('2026-07-15', now).toISOString()).toBe('2026-07-15T00:00:00.000Z')
  })

  it('stores a historical calendar date at UTC midnight', () => {
    const now = new Date('2026-10-05T18:12:34.567Z')
    const resolved = resolveTransactionDate('2026-10-04', now)
    expect(resolved.toISOString()).toBe('2026-10-04T00:00:00.000Z')
  })

  it('parses an explicitly selected business day at UTC midnight even when it is today', () => {
    expect(parseTransactionBusinessDate('2026-10-05').toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    )
  })

  // SR-809-L-2: this used to throw a bare `RangeError`, which Nest renders as a
  // 500. A malformed date is the caller's mistake, so it must surface as a 400
  // with a translatable code like every other finance rejection. The throw is
  // defense-in-depth — the Zod boundary normally rejects first — so the code is
  // only observable to a caller that bypassed validation.
  it('rejects a non-existent calendar date as a 400, not a 500, instead of silently recording now', () => {
    const now = new Date('2026-10-05T18:12:34.567Z')
    const thrown = [
      () => resolveTransactionDate('2026-02-31', now),
      () => parseTransactionBusinessDate('2026-02-31'),
    ].map(captureThrown)

    expect(thrown.map((err) => err instanceof HttpException)).toEqual([true, true])
    expect(thrown.map((err) => (err as HttpException).getStatus())).toEqual([
      HttpStatus.BAD_REQUEST,
      HttpStatus.BAD_REQUEST,
    ])
    expect(
      thrown.map((err) => ((err as HttpException).getResponse() as { code: string }).code),
    ).toEqual(['FINANCE_TX_DATE_INVALID', 'FINANCE_TX_DATE_INVALID'])
  })

  it('rejects a year outside the storable window as a 400', () => {
    expect(() => parseTransactionBusinessDate('0000-01-01')).toThrow(HttpException)
    expect(() => parseTransactionBusinessDate('9999-12-31')).toThrow(HttpException)
  })

  // Both window edges are INCLUSIVE, and both are asserted here rather than only
  // on the shared Zod schema: this is the API's own second enforcement point, and
  // a `>=`/`<=` slip at either edge would silently reject a legal business day.
  it('accepts both inclusive edges of the storable year window', () => {
    expect(
      parseTransactionBusinessDate(`${MIN_TRANSACTION_BUSINESS_YEAR}-01-01`).toISOString(),
    ).toBe(`${MIN_TRANSACTION_BUSINESS_YEAR}-01-01T00:00:00.000Z`)
    expect(
      parseTransactionBusinessDate(`${MAX_TRANSACTION_BUSINESS_YEAR}-12-31`).toISOString(),
    ).toBe(`${MAX_TRANSACTION_BUSINESS_YEAR}-12-31T00:00:00.000Z`)
  })

  it('rejects the first year beyond each edge', () => {
    expect(() =>
      parseTransactionBusinessDate(`${MIN_TRANSACTION_BUSINESS_YEAR - 1}-12-31`),
    ).toThrow(HttpException)
    expect(() =>
      parseTransactionBusinessDate(`${MAX_TRANSACTION_BUSINESS_YEAR + 1}-01-01`),
    ).toThrow(HttpException)
  })

  it('keeps future-date policy outside the timestamp resolver', () => {
    const now = new Date('2026-10-05T18:12:34.567Z')
    expect(resolveTransactionDate('2026-10-06', now).toISOString()).toBe('2026-10-06T00:00:00.000Z')
  })
})
