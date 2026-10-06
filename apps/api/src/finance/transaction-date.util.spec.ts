import { describe, expect, it } from 'vitest'
import { parseTransactionBusinessDate, resolveTransactionDate } from './transaction-date.util'

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

  it('fails loudly for a non-existent calendar date instead of silently recording now', () => {
    const now = new Date('2026-10-05T18:12:34.567Z')
    expect(() => resolveTransactionDate('2026-02-31', now)).toThrow(
      'Invalid transaction business date: 2026-02-31',
    )
    expect(() => parseTransactionBusinessDate('2026-02-31')).toThrow(
      'Invalid transaction business date: 2026-02-31',
    )
  })

  it('keeps future-date policy outside the timestamp resolver', () => {
    const now = new Date('2026-10-05T18:12:34.567Z')
    expect(resolveTransactionDate('2026-10-06', now).toISOString()).toBe('2026-10-06T00:00:00.000Z')
  })
})
