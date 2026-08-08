import { describe, expect, it } from 'vitest'
import {
  companyNameTokens,
  companyNamesMatch,
  normalizeCompanyName,
  textMatchesKeyword,
} from './company-name'

/**
 * task-job-sourcing-slice1 AC2: "Фильтр по компании ловит написание в другом
 * регистре, с суффиксом и на другой азбуке — ТЕСТ НА КАЖДЫЙ КЛАСС ОТДЕЛЬНО."
 *
 * Every match class below is its own named `it(...)` on purpose. One lumped
 * "normalizes company names" test would go green while a whole class silently
 * regressed — and a company filter that quietly stops catching one spelling is
 * exactly the failure this feature cannot afford (the senior sees a vacancy at
 * their own client). Named classes also make a failure report say WHICH kind of
 * spelling broke.
 */
describe('companyNamesMatch — match classes (AC2)', () => {
  it('class: identical strings', () => {
    expect(companyNamesMatch('EPAM Systems', 'EPAM Systems')).toBe(true)
  })

  it('class: different letter case', () => {
    expect(companyNamesMatch('epam systems', 'EPAM SYSTEMS')).toBe(true)
    expect(companyNamesMatch('SoftServe', 'softserve')).toBe(true)
  })

  it('class: trailing legal suffix (Inc. / LLC / Ltd)', () => {
    expect(companyNamesMatch('EPAM Systems Inc.', 'EPAM Systems')).toBe(true)
    expect(companyNamesMatch('Wetelo, Inc.', 'Wetelo')).toBe(true)
    expect(companyNamesMatch('LearnFast Ltd', 'LearnFast')).toBe(true)
    expect(companyNamesMatch('Globex LLC', 'Globex')).toBe(true)
  })

  it('class: leading Ukrainian/Russian legal form (ТОВ / ООО / ФОП)', () => {
    expect(companyNamesMatch('ТОВ Ромашка', 'Ромашка')).toBe(true)
    expect(companyNamesMatch('ООО «Ромашка»', 'Ромашка')).toBe(true)
    expect(companyNamesMatch('ФОП Ромашка', 'ТОВ Ромашка')).toBe(true)
  })

  it('class: different alphabet — Cyrillic vs Latin', () => {
    expect(companyNamesMatch('ЕПАМ', 'EPAM')).toBe(true)
    expect(companyNamesMatch('ТОВ «ЕПАМ»', 'Epam Systems Inc.')).toBe(true)
    expect(companyNamesMatch('Ромашка', 'Romashka')).toBe(true)
    expect(companyNamesMatch('ЛУН', 'LUN')).toBe(true)
  })

  it('class: known limitation — Latin «c» is not resolvable to с/к', () => {
    // Documented, deliberately-pinned gap (see the file header): Latin `c`
    // spells BOTH Cyrillic `с` (/s/) and `к` (/k/), so a brand written `Citicor`
    // in Latin and `Сітікор` in Cyrillic cannot be collapsed by any single
    // letter mapping. Such pairs need an explicit second exclusion entry. This
    // test exists so the gap is a known, reviewed decision rather than a
    // surprise discovered by a senior seeing their own employer.
    expect(companyNamesMatch('Сітікор', 'Citicor')).toBe(false)
  })

  it('class: punctuation, quotes and dashes', () => {
    expect(companyNamesMatch('Soft-Serve', 'Soft Serve')).toBe(true)
    expect(companyNamesMatch('«Ромашка»', 'Ромашка')).toBe(true)
    expect(companyNamesMatch('N-iX', 'N iX')).toBe(true)
    expect(companyNamesMatch('Advanced Software Development (ASD Team)', 'ASD Team')).toBe(true)
  })

  it('class: word-splitting differences (SoftServe vs Soft Serve)', () => {
    expect(companyNamesMatch('SoftServe', 'Soft Serve')).toBe(true)
    expect(companyNamesMatch('Soft Serve Ukraine', 'SoftServe')).toBe(true)
  })

  it('class: diacritics folded (Zürich vs Zurich)', () => {
    expect(companyNamesMatch('Zürich Tech', 'Zurich Tech')).toBe(true)
    expect(companyNamesMatch('Škoda Digital', 'Skoda Digital')).toBe(true)
  })

  it('class: short name is a prefix of a longer official name', () => {
    expect(companyNamesMatch('EPAM', 'EPAM Systems Ukraine')).toBe(true)
    // Symmetric — argument order must not change the verdict.
    expect(companyNamesMatch('EPAM Systems Ukraine', 'EPAM')).toBe(true)
  })

  it('class: extra whitespace and mixed spacing', () => {
    expect(companyNamesMatch('  EPAM   Systems  ', 'EPAM Systems')).toBe(true)
  })
})

describe('companyNamesMatch — must NOT match (over-filtering guards)', () => {
  it('does not match an unrelated company', () => {
    expect(companyNamesMatch('EPAM', 'SoftServe')).toBe(false)
  })

  it('does not match on a mid-word substring (Epam vs Epamos)', () => {
    // The whole reason matching is token-window based rather than
    // `String.includes`: `epamos`.includes(`epam`) would be a false positive.
    expect(companyNamesMatch('EPAM', 'Epamos')).toBe(false)
    expect(companyNamesMatch('Serve', 'SoftServe')).toBe(false)
  })

  it('does not let a 2-letter name match by containment', () => {
    expect(companyNamesMatch('IT', 'IT Solutions')).toBe(false)
    // …but an exact 2-letter name still matches itself.
    expect(companyNamesMatch('IT', 'it')).toBe(true)
  })

  it('does not match when either side is empty', () => {
    expect(companyNamesMatch('', 'EPAM')).toBe(false)
    expect(companyNamesMatch('EPAM', null)).toBe(false)
    expect(companyNamesMatch(undefined, undefined)).toBe(false)
    expect(companyNamesMatch('   ', 'EPAM')).toBe(false)
    // A name that is ONLY punctuation normalizes to empty → never matches.
    expect(companyNamesMatch('«»', 'EPAM')).toBe(false)
  })

  it('does not treat two different companies with the same legal form as equal', () => {
    expect(companyNamesMatch('ТОВ Ромашка', 'ТОВ Волошка')).toBe(false)
    expect(companyNamesMatch('Alpha LLC', 'Beta LLC')).toBe(false)
  })
})

describe('normalizeCompanyName / companyNameTokens', () => {
  it('produces a stable canonical string', () => {
    expect(normalizeCompanyName('  Epam Systems, Inc. ')).toBe('epam systems')
    expect(normalizeCompanyName('ТОВ «ЕПАМ»')).toBe('epam')
    expect(normalizeCompanyName('N-iX')).toBe('n ix')
  })

  it('returns an empty string for blank input', () => {
    expect(normalizeCompanyName(null)).toBe('')
    expect(normalizeCompanyName(undefined)).toBe('')
    expect(normalizeCompanyName('   ')).toBe('')
  })

  it('keeps legal-form tokens when they are the ENTIRE name', () => {
    // Stripping them would leave an empty key that matches every company.
    expect(companyNameTokens('ТОВ')).toEqual(['tov'])
    expect(normalizeCompanyName('LLC')).toBe('llc')
    expect(companyNamesMatch('ТОВ', 'Ромашка')).toBe(false)
  })

  it('keeps non-transliterated alphabets intact instead of dropping them', () => {
    expect(normalizeCompanyName('株式会社')).toBe('株式会社')
    expect(companyNamesMatch('株式会社', '株式会社')).toBe(true)
  })
})

describe('textMatchesKeyword — stop-words', () => {
  it('matches case-insensitively on a word-start boundary', () => {
    expect(textMatchesKeyword('Senior Gambling Platform Engineer', 'gambling')).toBe(true)
    expect(textMatchesKeyword('Senior GAMBLINGS Engineer', 'gambling')).toBe(true)
  })

  it('matches across alphabets (казино → kazino)', () => {
    expect(textMatchesKeyword('Розробник для казино', 'казино')).toBe(true)
    expect(textMatchesKeyword('Kazino backend developer', 'казино')).toBe(true)
  })

  it('matches a multi-word phrase', () => {
    expect(textMatchesKeyword('Online Casino backend developer', 'online casino')).toBe(true)
    expect(textMatchesKeyword('Casino online developer', 'online casino')).toBe(false)
  })

  it('does not match mid-word (Anticasino is not casino)', () => {
    expect(textMatchesKeyword('Anticasino Fraud Analyst', 'casino')).toBe(false)
  })

  it('does not match on empty input', () => {
    expect(textMatchesKeyword('', 'casino')).toBe(false)
    expect(textMatchesKeyword('Casino dev', '')).toBe(false)
    expect(textMatchesKeyword(null, null)).toBe(false)
  })
})
