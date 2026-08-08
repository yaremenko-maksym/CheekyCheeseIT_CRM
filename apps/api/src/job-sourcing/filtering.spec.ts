import { describe, expect, it } from 'vitest'
import type { JobExclusionDto } from '@crm/shared'
import {
  companyAliases,
  deriveProjectExclusions,
  findMatchingExclusion,
  isPostingExcluded,
} from './filtering'

const SENIOR_ID = '11111111-1111-4111-8111-111111111111'

function manualCompany(value: string): JobExclusionDto {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    scope: 'SENIOR',
    seniorId: SENIOR_ID,
    kind: 'COMPANY',
    value,
    normalizedValue: value.toLowerCase(),
    origin: 'MANUAL',
    sourceLabel: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  }
}

function manualKeyword(value: string): JobExclusionDto {
  return { ...manualCompany(value), kind: 'KEYWORD' }
}

function posting(companyName: string, title = 'Senior Frontend Engineer') {
  return { companyName, title }
}

/**
 * AC2 at the FILTER level. `company-name.spec.ts` pins the normalization
 * primitive; these tests pin that the filter actually USES it — a filter can be
 * wired to a `===` comparison while the (perfectly good) normalizer sits unused
 * one import away, and the senior would still see their own employer.
 */
describe('findMatchingExclusion — COMPANY classes (AC2)', () => {
  const exclusions = [manualCompany('EPAM Systems')]

  it('class: exact company', () => {
    expect(isPostingExcluded(posting('EPAM Systems'), exclusions)).toBe(true)
  })

  it('class: different case', () => {
    expect(isPostingExcluded(posting('epam systems'), exclusions)).toBe(true)
  })

  it('class: legal suffix on the posting side', () => {
    expect(isPostingExcluded(posting('EPAM Systems Inc.'), exclusions)).toBe(true)
    expect(isPostingExcluded(posting('Wetelo, Inc.'), [manualCompany('Wetelo')])).toBe(true)
  })

  it('class: legal form on the exclusion side (ТОВ «Ромашка»)', () => {
    expect(isPostingExcluded(posting('Ромашка'), [manualCompany('ТОВ «Ромашка»')])).toBe(true)
  })

  it('class: different alphabet', () => {
    expect(isPostingExcluded(posting('ЕПАМ'), [manualCompany('EPAM')])).toBe(true)
    expect(isPostingExcluded(posting('EPAM'), [manualCompany('ЕПАМ')])).toBe(true)
  })

  it('class: shortened company name (EPAM vs EPAM Systems)', () => {
    expect(isPostingExcluded(posting('EPAM'), exclusions)).toBe(true)
  })

  it('class: spacing / punctuation (SoftServe vs Soft-Serve)', () => {
    expect(isPostingExcluded(posting('Soft-Serve'), [manualCompany('SoftServe')])).toBe(true)
  })

  it('does NOT exclude an unrelated company', () => {
    expect(isPostingExcluded(posting('Ciklum'), exclusions)).toBe(false)
    expect(isPostingExcluded(posting('Epamos'), exclusions)).toBe(false)
  })

  it('reports WHICH exclusion matched, so a hidden posting is explainable', () => {
    const match = findMatchingExclusion(posting('ЕПАМ'), [
      manualCompany('Ciklum'),
      manualCompany('EPAM'),
    ])
    expect(match?.value).toBe('EPAM')
  })
})

describe('findMatchingExclusion — KEYWORD', () => {
  it('matches a stop-word in the title', () => {
    expect(
      isPostingExcluded(posting('Some Studio', 'Senior Gambling Platform Engineer'), [
        manualKeyword('gambling'),
      ]),
    ).toBe(true)
  })

  it('matches a stop-word in the company name', () => {
    expect(isPostingExcluded(posting('Casino Tech'), [manualKeyword('casino')])).toBe(true)
  })

  it('matches across alphabets', () => {
    expect(
      isPostingExcluded(posting('Studio', 'Розробник для казино'), [manualKeyword('казино')]),
    ).toBe(true)
  })

  it('does not match a substring inside another word', () => {
    expect(isPostingExcluded(posting('Anticasino Analytics'), [manualKeyword('casino')])).toBe(
      false,
    )
  })
})

/** AC3 — auto-filled exclusions from the senior's own projects. */
describe('deriveProjectExclusions (AC3)', () => {
  it('derives one COMPANY exclusion per distinct client', () => {
    const derived = deriveProjectExclusions(SENIOR_ID, [
      { name: 'AI Platform v2', companyName: 'TechCorp AI', archivedAt: null },
      { name: 'EdTech Portal', companyName: 'LearnFast Ltd', archivedAt: null },
    ])
    expect(derived).toHaveLength(2)
    expect(derived[0]).toMatchObject({
      id: null,
      kind: 'COMPANY',
      origin: 'PROJECT',
      value: 'TechCorp AI',
      normalizedValue: 'techcorp ai',
      sourceLabel: 'AI Platform v2',
      seniorId: SENIOR_ID,
    })
  })

  it('hides a posting from the senior’s own client — including a different spelling', () => {
    const derived = deriveProjectExclusions(SENIOR_ID, [
      { name: 'AI Platform v2', companyName: 'EPAM Systems Inc.', archivedAt: null },
    ])
    expect(isPostingExcluded(posting('ЕПАМ'), derived)).toBe(true)
    expect(isPostingExcluded(posting('epam systems'), derived)).toBe(true)
    expect(isPostingExcluded(posting('Ciklum'), derived)).toBe(false)
  })

  it('keeps excluding a client whose project was archived', () => {
    const derived = deriveProjectExclusions(SENIOR_ID, [
      { name: 'Old deal', companyName: 'Globex', archivedAt: new Date('2026-01-01') },
    ])
    expect(isPostingExcluded(posting('Globex LLC'), derived)).toBe(true)
  })

  it('de-duplicates two projects at the same client', () => {
    const derived = deriveProjectExclusions(SENIOR_ID, [
      { name: 'Project A', companyName: 'EPAM', archivedAt: null },
      { name: 'Project B', companyName: 'ЕПАМ', archivedAt: null },
    ])
    expect(derived).toHaveLength(1)
  })

  it('skips a project whose client name is blank', () => {
    expect(
      deriveProjectExclusions(SENIOR_ID, [
        { name: 'Internal', companyName: '  ', archivedAt: null },
      ]),
    ).toEqual([])
  })
})

/**
 * Security-review round 2, MED-3.
 *
 * `companyFromDouUrl` existed but never took part in matching. The URL slug is
 * assigned by the job board, not typed by the advertiser, so it is the harder
 * of the two to spoof — and on a PUBLIC board (anyone can post a vacancy) the
 * title is exactly what an advertiser controls.
 */
describe('companyAliases — URL-derived company (MED-3)', () => {
  const excl = [manualCompany('EPAM')]

  it('catches a posting whose TITLE hides the company but whose URL does not', () => {
    expect(
      isPostingExcluded(
        {
          companyName: 'Ромашка Digital',
          title: 'Senior Engineer',
          sourceType: 'DOU_RSS',
          url: 'https://jobs.dou.ua/companies/epam-systems/vacancies/777',
        },
        excl,
      ),
    ).toBe(true)
  })

  it('returns the alias only when it adds something', () => {
    // Same company in both places → no redundant alias.
    expect(
      companyAliases({
        companyName: 'EPAM',
        title: 't',
        sourceType: 'DOU_RSS',
        url: 'https://jobs.dou.ua/companies/epam/vacancies/1',
      }),
    ).toEqual([])
    expect(
      companyAliases({
        companyName: 'Ромашка',
        title: 't',
        sourceType: 'DOU_RSS',
        url: 'https://jobs.dou.ua/companies/epam-systems/vacancies/1',
      }),
    ).toEqual(['epam systems'])
  })

  it('does not invent an alias when the URL carries no company segment', () => {
    expect(
      companyAliases({
        companyName: 'Ромашка',
        title: 't',
        sourceType: 'DOU_RSS',
        url: 'https://jobs.dou.ua/vacancies/1',
      }),
    ).toEqual([])
    expect(companyAliases({ companyName: 'Ромашка', title: 't' })).toEqual([])
  })

  it('does not widen matching for an unrelated company in the URL', () => {
    expect(
      isPostingExcluded(
        {
          companyName: 'Ciklum',
          title: 'Dev',
          sourceType: 'DOU_RSS',
          url: 'https://jobs.dou.ua/companies/ciklum/vacancies/5',
        },
        excl,
      ),
    ).toBe(false)
  })

  it('ignores the URL for a source that is not DOU', () => {
    expect(
      companyAliases({
        companyName: 'Ромашка',
        title: 't',
        sourceType: 'FUTURE_SOURCE',
        url: 'https://example.com/companies/epam/vacancies/1',
      }),
    ).toEqual([])
  })
})

describe('exclusion sets combine', () => {
  it('applies global, personal and derived entries together', () => {
    const globalEntry: JobExclusionDto = {
      ...manualCompany('Ciklum'),
      scope: 'GLOBAL',
      seniorId: null,
    }
    const personal = manualCompany('Mobilunity')
    const derived = deriveProjectExclusions(SENIOR_ID, [
      { name: 'AI Platform', companyName: 'TechCorp AI', archivedAt: null },
    ])
    const all = [globalEntry, personal, ...derived]

    expect(findMatchingExclusion(posting('Ciklum'), all)?.scope).toBe('GLOBAL')
    expect(findMatchingExclusion(posting('Mobilunity'), all)?.origin).toBe('MANUAL')
    expect(findMatchingExclusion(posting('TechCorp AI'), all)?.origin).toBe('PROJECT')
    expect(findMatchingExclusion(posting('Devart'), all)).toBeNull()
  })

  it('an empty exclusion set hides nothing', () => {
    expect(isPostingExcluded(posting('EPAM'), [])).toBe(false)
  })
})
