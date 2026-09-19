import { describe, expect, it } from 'vitest'
import { compareNames, formatDate, formatMoney, formatNumber } from './format'

describe('format', () => {
  it('formats the same date differently per locale', () => {
    const d = new Date(Date.UTC(2026, 8, 19))
    expect(formatDate(d, 'uk')).toBe(
      new Intl.DateTimeFormat('uk-UA', { timeZone: 'UTC' }).format(d),
    )
    expect(formatDate(d, 'en')).toBe(
      new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC' }).format(d),
    )
  })
  it('accepts an ISO string the same way it accepts a Date', () => {
    const iso = '2026-09-19T00:00:00.000Z'
    expect(formatDate(iso, 'uk')).toBe(formatDate(new Date(iso), 'uk'))
    expect(formatDate(iso, 'uk')).toBe(
      new Intl.DateTimeFormat('uk-UA', { timeZone: 'UTC' }).format(new Date(iso)),
    )
  })
  it('the long style spells out the month, unlike the short default', () => {
    const d = new Date(Date.UTC(2026, 8, 19))
    const long = formatDate(d, 'en', 'long')
    expect(long).toBe(
      new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(d),
    )
    expect(long).not.toBe(formatDate(d, 'en'))
  })
  it('is pinned to UTC regardless of the host timezone', () => {
    // A date near a day boundary in UTC, so any non-UTC offset renders a
    // different calendar day. `TZ` is read by Node's Intl per-call (not
    // cached at process start — verified directly), so overriding it here
    // deterministically proves `formatDate` always passes `timeZone: 'UTC'`
    // through, instead of depending on whichever timezone happens to be the
    // host's default (which may itself already differ from UTC, masking a
    // regression that drops the option — as it did while this test was
    // being written: the earlier version of this suite had no case at all
    // that could tell "timeZone: 'UTC' passed" apart from "no timeZone
    // option passed" when the two happened to coincide).
    const originalTz = process.env['TZ']
    process.env['TZ'] = 'Pacific/Kiritimati' // UTC+14
    try {
      const d = new Date(Date.UTC(2026, 8, 19, 22, 30))
      expect(formatDate(d, 'en')).toBe(
        new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC' }).format(d),
      )
      expect(formatDate(d, 'en')).not.toBe(new Intl.DateTimeFormat('en-GB').format(d))
    } finally {
      if (originalTz === undefined) delete process.env['TZ']
      else process.env['TZ'] = originalTz
    }
  })
  it('formats money with the currency code, two decimals', () => {
    // Two literal exceptions per task-i18n-stage2-task1-2.md override #4 — every
    // other assertion in this file compares against `Intl` of the same runtime,
    // not a hand-typed literal (uk-UA's grouping separator is U+00A0, not a
    // plain space, so a literal here would be an encoding trap, not a spec).
    expect(formatMoney('1234.5', 'USDT', 'en')).toBe('1,234.50 USDT')
    const ukBody = new Intl.NumberFormat('uk-UA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(1234.5)
    expect(formatMoney(1234.5, 'UAH', 'uk')).toBe(`${ukBody} UAH`)
  })
  it('compareNames orders Ukrainian letters correctly', () => {
    const sorted = ['Яків', 'Ірина', 'Євген', 'Андрій'].sort(compareNames('uk'))
    expect(sorted).toEqual(['Андрій', 'Євген', 'Ірина', 'Яків'])
  })
  it('compareNames is base-sensitivity — case does not affect ordering', () => {
    // `Intl.Collator` sensitivity: 'base' ranks case variants as equal (0);
    // the locale-aware default sensitivity does not — this is what actually
    // exercises that option rather than just the letter ordering above.
    expect(compareNames('uk')('Андрій', 'андрій')).toBe(0)
  })
  it('formatNumber uses locale separators', () => {
    expect(formatNumber(1000000, 'en')).toBe('1,000,000')
  })
})
