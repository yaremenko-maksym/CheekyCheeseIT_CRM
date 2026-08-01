/**
 * task-vacancy-salary-range (owner decision 2026-07-31) — `formatSalaryRange`
 * unit coverage. `domainLabel`/`employmentTypeLabel` already have coverage in
 * `i18n.spec.ts` (dictionary key-parity) — this file is scoped to the new
 * salary-range formatting helper only.
 */
import { describe, expect, it } from 'vitest'
import { formatSalaryRange } from '@/lib/vacancy-domain'
import { getDictionary } from '@/i18n/dictionaries'

const dict = getDictionary('en')

const FILLED = {
  salaryMin: '3000.00',
  salaryMax: '5000.00',
  salaryCurrency: 'USDT' as const,
  salaryPeriod: 'MONTH' as const,
}

describe('formatSalaryRange', () => {
  it('returns null when the vacancy has no salary range at all (AC3 — legacy vacancy)', () => {
    expect(
      formatSalaryRange(
        { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null },
        dict.vacancy,
      ),
    ).toBeNull()
  })

  it('returns null when only SOME of the 4 fields are set (never a fabricated/partial range)', () => {
    expect(
      formatSalaryRange(
        { salaryMin: '3000', salaryMax: '5000', salaryCurrency: null, salaryPeriod: null },
        dict.vacancy,
      ),
    ).toBeNull()
  })

  it('formats a filled range as "min–max CURRENCY · period"', () => {
    expect(formatSalaryRange(FILLED, dict.vacancy)).toBe('3000–5000 USDT · per month')
  })

  it('drops a bare .00 but keeps real cents', () => {
    expect(
      formatSalaryRange({ ...FILLED, salaryMin: '3250.50', salaryMax: '5000.00' }, dict.vacancy),
    ).toBe('3250.5–5000 USDT · per month')
  })

  it('numbers/currency are NOT locale-formatted — no thousands grouping regardless of amount size', () => {
    expect(
      formatSalaryRange({ ...FILLED, salaryMin: '80000', salaryMax: '120000' }, dict.vacancy),
    ).toBe('80000–120000 USDT · per month')
  })

  it.each(['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'] as const)(
    'localizes the %s period suffix per the dictionary',
    (period) => {
      const result = formatSalaryRange({ ...FILLED, salaryPeriod: period }, dict.vacancy)
      expect(result).toContain(dict.vacancy.salaryPeriodLabels[period])
    },
  )

  it.each(['USDT', 'USD', 'EUR', 'UAH'] as const)(
    'shows the currency code verbatim (not translated) for %s',
    (currency) => {
      const result = formatSalaryRange({ ...FILLED, salaryCurrency: currency }, dict.vacancy)
      expect(result).toContain(currency)
    },
  )
})
