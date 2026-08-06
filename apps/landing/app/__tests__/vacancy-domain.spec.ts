/**
 * task-vacancy-salary-range (owner decision 2026-07-31) — `formatSalaryRange`
 * unit coverage. `domainLabel`/`employmentTypeLabel` already have coverage in
 * `i18n.spec.ts` (dictionary key-parity) — this file is scoped to the new
 * salary-range formatting helper only.
 */
import { describe, expect, it } from 'vitest'
import { VACANCY_DOMAINS } from '@crm/shared'
import { domainLabel, domainTagVariant, formatSalaryRange } from '@/lib/vacancy-domain'
import { getDictionary } from '@/i18n/dictionaries'
import { LOCALES } from '@/i18n/locale'

const dict = getDictionary('en')

/**
 * task-domains-expansion — a vacancy in any of the 17 domains is public copy:
 * it renders on `/careers` in five languages. The type system guarantees a key
 * EXISTS for each domain in each locale; these assert the two things it cannot
 * — that the value is real copy rather than the raw enum value, and that a
 * domain with no brand hue degrades to the neutral tag instead of `undefined`.
 */
describe('vacancy domain labels and tags', () => {
  it.each(LOCALES)('labels every domain in %s (never the raw enum value)', (locale) => {
    const vacancy = getDictionary(locale).vacancy
    for (const domain of VACANCY_DOMAINS) {
      const label = domainLabel(domain, vacancy)
      expect(label, `${locale}: missing label for ${domain}`).toBeTruthy()
      expect(label, `${locale}: ${domain} renders its raw enum value`).not.toBe(domain)
    }
  })

  it('keeps industry jargon identical across locales (skill copywriting §5)', () => {
    // Deliberately NOT translated: these are how the ru/uk/es/pt markets write
    // them. `LOGISTICS`/`TRAVEL`/`MEDIA`/`CYBERSEC`/`OTHER` are the opposite
    // case (ordinary words) and are asserted to differ below.
    for (const domain of ['FINTECH', 'IGAMING', 'SAAS', 'ADTECH', 'WEB3'] as const) {
      const rendered = new Set(LOCALES.map((l) => domainLabel(domain, getDictionary(l).vacancy)))
      expect([...rendered], `${domain} should read the same everywhere`).toHaveLength(1)
    }
  })

  it('localizes the ordinary words that have a native equivalent', () => {
    for (const domain of ['LOGISTICS', 'TRAVEL', 'CYBERSEC', 'OTHER'] as const) {
      const en = domainLabel(domain, getDictionary('en').vacancy)
      const ru = domainLabel(domain, getDictionary('ru').vacancy)
      expect(ru, `${domain} was left in English on ru`).not.toBe(en)
    }
  })

  it('uses a brand tag only for the three domains that have one, neutral for the rest', () => {
    expect(domainTagVariant('AI')).toBe('ai')
    expect(domainTagVariant('EDTECH')).toBe('edtech')
    expect(domainTagVariant('ECOMMERCE')).toBe('ecommerce')
    const rest = VACANCY_DOMAINS.filter((d) => !['AI', 'EDTECH', 'ECOMMERCE'].includes(d))
    expect(rest.length).toBeGreaterThan(0)
    for (const domain of rest) expect(domainTagVariant(domain)).toBe('neutral')
  })
})

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
