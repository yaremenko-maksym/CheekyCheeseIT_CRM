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
  it('formatNumber uses locale separators', () => {
    expect(formatNumber(1000000, 'en')).toBe('1,000,000')
  })
})
