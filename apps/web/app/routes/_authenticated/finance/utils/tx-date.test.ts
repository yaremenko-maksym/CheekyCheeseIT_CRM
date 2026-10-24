import { describe, expect, it } from 'vitest'
import { formatTxOrCreated } from './tx-date'

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
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const expected: Record<string, string> = {
      'Europe/Kyiv': '01/08/26',
      'America/Los_Angeles': '31/07/26',
    }
    const want = expected[tz]
    if (want === undefined) return
    expect(formatTxOrCreated(null, createdAt, 'en')).toBe(want)
    expect(formatTxOrCreated(undefined, createdAt, 'en')).toBe(want)
  })
})
