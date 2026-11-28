import { describe, it, expect } from 'vitest'
import type { JobQueueSalary } from '@crm/shared'
import { i18n } from '@/lib/i18n'
import { loadCatalog } from '@/test/i18n'
import { formatSalary } from '../salary-format'

const s = (over: Partial<JobQueueSalary>): JobQueueSalary => ({
  min: 4000,
  max: 5500,
  currency: 'EUR',
  period: 'MONTH',
  ...over,
})
// uk currency spelling depends on the ICU build, so the uk amounts come from the same Intl call
const uk = (n: number, currency = 'EUR') =>
  new Intl.NumberFormat('uk', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)

describe('formatSalary', () => {
  it('en: a range, one bound, equal bounds, and each period', async () => {
    await loadCatalog('en')
    expect(formatSalary(s({}), 'en', i18n)).toBe('€4,000 – €5,500 / month')
    expect(formatSalary(s({ max: null }), 'en', i18n)).toBe('from €4,000 / month')
    expect(formatSalary(s({ min: null }), 'en', i18n)).toBe('up to €5,500 / month')
    expect(formatSalary(s({ min: 5500 }), 'en', i18n)).toBe('€5,500 / month')
    expect(formatSalary(s({ period: 'HOUR', min: 30, max: 40 }), 'en', i18n)).toBe(
      '€30 – €40 / hour',
    )
    expect(formatSalary(s({ period: 'YEAR', max: null, currency: 'USD' }), 'en', i18n)).toBe(
      'from $4,000 / year',
    )
    // whole units only
    expect(formatSalary(s({ min: 4000.6, max: null }), 'en', i18n)).toBe('from €4,001 / month')
  })

  it('uk: the same shapes with the uk words', async () => {
    await loadCatalog('uk')
    expect(formatSalary(s({ max: null }), 'uk', i18n)).toBe(`від ${uk(4000)} / міс`)
    expect(formatSalary(s({ min: null }), 'uk', i18n)).toBe(`до ${uk(5500)} / міс`)
    expect(formatSalary(s({ min: 5500 }), 'uk', i18n)).toBe(`${uk(5500)} / міс`)
    expect(formatSalary(s({ period: 'HOUR' }), 'uk', i18n)).toMatch(/ \/ год$/)
    expect(formatSalary(s({ period: 'YEAR' }), 'uk', i18n)).toMatch(/ \/ рік$/)
    expect(formatSalary(s({}), 'uk', i18n)).toBe(
      `${new Intl.NumberFormat('uk', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).formatRange(4000, 5500)} / міс`,
    )
  })
})
