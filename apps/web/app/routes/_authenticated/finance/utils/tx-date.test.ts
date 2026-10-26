import { describe, expect, it } from 'vitest'
import { formatTxOrCreated } from './tx-date'

// Runs under the host zone, TZ=America/Los_Angeles and TZ=Europe/Kyiv. Every
// expected value is a literal that holds in ALL of them: the business day does
// not depend on the browser zone (backlog 338), so there is no per-zone table
// and nothing is skipped in an unpinned developer zone (item c).
describe('formatTxOrCreated', () => {
  it('renders a date-only txDate as the SAME calendar day in any host zone, ignoring createdAt', () => {
    expect(formatTxOrCreated('2026-07-31T00:00:00.000Z', '2026-08-05T10:00:00.000Z', 'en')).toBe(
      '31/07/26',
    )
    expect(formatTxOrCreated('2026-01-01T00:00:00.000Z', '2026-08-05T10:00:00.000Z', 'uk')).toBe(
      '01.01.26',
    )
  })

  it('renders a null/undefined txDate as the KYIV day of createdAt in every host zone', () => {
    // 23:30Z on 31 Jul is 1 Aug in Kyiv: the day the server floors on.
    expect(formatTxOrCreated(null, '2026-07-31T23:30:00.000Z', 'en')).toBe('01/08/26')
    expect(formatTxOrCreated(undefined, '2026-07-31T23:30:00.000Z', 'en')).toBe('01/08/26')
    // 05:00Z on 20 Oct is 19 Oct in Los Angeles, but 20 Oct is the business day.
    expect(formatTxOrCreated(null, '2026-10-20T05:00:00.000Z', 'uk')).toBe('20.10.26')
  })

  it('item (e): renders a dash for an unparseable value instead of throwing', () => {
    expect(formatTxOrCreated(null, 'not-a-date', 'en')).toBe('—')
    expect(formatTxOrCreated('garbage', '2026-07-31T23:30:00.000Z', 'en')).toBe('—')
  })
})
