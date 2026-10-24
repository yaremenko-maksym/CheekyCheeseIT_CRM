import { describe, expect, it } from 'vitest'
import { formatTxOrCreated, txDisplayDay } from './tx-date'

describe('txDisplayDay', () => {
  it('a set txDate names its UTC day in any zone, ignoring createdAt', () => {
    expect(txDisplayDay('2026-07-31T00:00:00.000Z', '2026-08-05T10:00:00.000Z')).toBe('2026-07-31')
    expect(txDisplayDay(new Date('2026-01-01T00:00:00.000Z'), '2026-08-05T10:00:00.000Z')).toBe(
      '2026-01-01',
    )
  })

  it('a null/undefined txDate names the createdAt day in the host zone, zero-padded', () => {
    // 23:30Z on 31 Jul: 31 Jul in Los Angeles, 1 Aug in Kyiv, 31 Jul in UTC.
    // 05:00Z on 5 Jan: 4 Jan in Los Angeles (single-digit month AND day, so the padding shows).
    const offset = new Date('2026-07-31T23:30:00.000Z').getTimezoneOffset()
    const want = {
      '-180': ['2026-08-01', '2026-01-05'],
      '420': ['2026-07-31', '2026-01-04'],
      '0': ['2026-07-31', '2026-01-05'],
    }[String(offset)]
    if (want === undefined) return // an unpinned developer zone; the tz:* projects always hit a row
    expect(txDisplayDay(null, '2026-07-31T23:30:00.000Z')).toBe(want[0])
    expect(txDisplayDay(undefined, '2026-01-05T05:00:00.000Z')).toBe(want[1])
  })
})

// Run under TZ=America/Los_Angeles and TZ=Europe/Kyiv.
describe('formatTxOrCreated', () => {
  it('renders a date-only txDate as the SAME calendar day in any host zone, ignoring createdAt', () => {
    expect(formatTxOrCreated('2026-07-31T00:00:00.000Z', '2026-08-05T10:00:00.000Z', 'en')).toBe(
      '31/07/26',
    )
    expect(formatTxOrCreated('2026-01-01T00:00:00.000Z', '2026-08-05T10:00:00.000Z', 'uk')).toBe(
      '01.01.26',
    )
  })

  it('renders a null/undefined txDate via the createdAt INSTANT in the host-zone day', () => {
    // 23:30Z on 31 Jul: 31 Jul in Los Angeles, 1 Aug in Kyiv. A `shortYYUtc`
    // rendering would show 31/07/26 in BOTH, i.e. wrong in Kyiv.
    const createdAt = '2026-07-31T23:30:00.000Z'
    // Keyed on the UTC offset, not the zone NAME: this Node/ICU reports the
    // legacy alias `Europe/Kiev` for TZ=Europe/Kyiv, so a name-keyed table
    // matched nothing and the assertions below were silently skipped.
    const offsetMin = new Date(createdAt).getTimezoneOffset()
    const expected: Record<string, string> = {
      '-180': '01/08/26',
      '420': '31/07/26',
      '0': '31/07/26',
    }
    const want = expected[String(offsetMin)]
    if (want === undefined) return // an unpinned developer zone; the tz:* projects always hit a row
    expect(formatTxOrCreated(null, createdAt, 'en')).toBe(want)
    expect(formatTxOrCreated(undefined, createdAt, 'en')).toBe(want)
  })
})
