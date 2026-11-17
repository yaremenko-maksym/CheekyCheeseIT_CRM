/**
 * Deterministic resume fields (verified-base-resume spec §3).
 *
 * Facts are the input; the derived content is what Typst renders. Everything
 * here is pure and clock-free (`now` is a parameter), so the same facts always
 * produce the same period strings and the same years of experience.
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_RESUME_CONTENT,
  EMPTY_RESUME_FACTS,
  resumeContentSchema,
  resumeFactsSchema,
  type ResumeContent,
  type ResumeFacts,
} from '@crm/shared'
import {
  contentToFacts,
  deriveFrozenContent,
  formatPeriod,
  formatYears,
  parseFreePeriod,
  yearsOfExperience,
} from './derive-content'

type FactsExperience = ResumeFacts['experience'][number]

function experience(overrides: Partial<FactsExperience> = {}): FactsExperience {
  return {
    company: 'Acme',
    role: 'Engineer',
    location: null,
    start: '2021-03',
    end: null,
    current: true,
    technologies: [],
    notes: [],
    ...overrides,
  }
}

describe('formatPeriod', () => {
  it('formats an ongoing job as Present', () => {
    expect(formatPeriod('2021-03', null, true)).toBe('Mar 2021 – Present')
  })

  it('formats a closed period', () => {
    expect(formatPeriod('2021-03', '2023-05', false)).toBe('Mar 2021 – May 2023')
  })

  it('formats a start with no end and not current', () => {
    expect(formatPeriod('2021-03', null, false)).toBe('Mar 2021')
  })

  it('prefers Present over an end date when current is true', () => {
    expect(formatPeriod('2021-03', '2023-05', true)).toBe('Mar 2021 – Present')
  })

  it('uses the English three-letter month for every month', () => {
    const labels = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]
    labels.forEach((label, index) => {
      const month = String(index + 1).padStart(2, '0')
      expect(formatPeriod(`2021-${month}`, null, false)).toBe(`${label} 2021`)
    })
  })

  it('returns an empty string for an invalid month', () => {
    expect(formatPeriod('2021-13', null, false)).toBe('')
    expect(formatPeriod('2021-00', null, false)).toBe('')
    expect(formatPeriod('', null, false)).toBe('')
    expect(formatPeriod('', null, true)).toBe('')
    expect(formatPeriod('-03', null, false)).toBe('')
  })
})

describe('formatYears', () => {
  it('formats a range', () => {
    expect(formatYears(2015, 2019)).toBe('2015 – 2019')
  })

  it('formats only a start year', () => {
    expect(formatYears(2015, null)).toBe('2015')
  })

  it('formats only an end year', () => {
    expect(formatYears(null, 2019)).toBe('2019')
  })

  it('returns an empty string when nothing is known', () => {
    expect(formatYears(null, null)).toBe('')
  })
})

describe('yearsOfExperience', () => {
  const now = new Date('2021-01-15T00:00:00.000Z')

  it('counts overlapping jobs once', () => {
    const items = [
      experience({ start: '2015-01', end: '2018-12', current: false }),
      experience({ start: '2017-01', end: '2020-12', current: false }),
    ]
    expect(yearsOfExperience(items, now)).toBe(6)
  })

  it('adds non-overlapping jobs together', () => {
    const items = [
      experience({ start: '2015-01', end: '2016-12', current: false }),
      experience({ start: '2018-01', end: '2019-12', current: false }),
    ]
    expect(yearsOfExperience(items, now)).toBe(4)
  })

  it('counts a current job up to now', () => {
    expect(yearsOfExperience([experience({ start: '2020-01' })], now)).toBe(1)
  })

  it('counts the current month of now, not only January', () => {
    const june = new Date('2021-06-15T00:00:00.000Z')
    expect(yearsOfExperience([experience({ start: '2020-01' })], june)).toBe(1)
  })

  it('counts overlapping jobs once regardless of input order', () => {
    const items = [
      experience({ start: '2017-01', end: '2020-12', current: false }),
      experience({ start: '2015-01', end: '2018-12', current: false }),
    ]
    expect(yearsOfExperience(items, now)).toBe(6)
  })

  it('does not shrink the union when a nested job comes last', () => {
    const items = [
      experience({ start: '2015-01', end: '2020-12', current: false }),
      experience({ start: '2017-01', end: '2018-12', current: false }),
    ]
    expect(yearsOfExperience(items, now)).toBe(6)
  })

  it('does not count a one-month gap between jobs', () => {
    const items = [
      experience({ start: '2020-01', end: '2020-06', current: false }),
      experience({ start: '2020-08', end: '2020-12', current: false }),
    ]
    expect(yearsOfExperience(items, now)).toBe(0)
  })

  it.each(['garbage', '2010-00', '2010-13', '2010-1', '2010-01-15', 'x2010-01', '2010-01x'])(
    'ignores an invalid start month %j',
    (start) => {
      expect(yearsOfExperience([experience({ start, current: true })], now)).toBe(0)
    },
  )

  it('reads now in UTC, not in the local time zone', () => {
    // 2021-01-01T00:30 UTC is still December 2020 west of UTC; a local read loses January.
    const utcJanuary = new Date('2021-01-01T00:30:00.000Z')
    const tz = process.env['TZ']
    process.env['TZ'] = 'America/New_York'
    try {
      expect(yearsOfExperience([experience({ start: '2020-02', current: true })], utcJanuary)).toBe(
        1,
      )
    } finally {
      if (tz === undefined) delete process.env['TZ']
      else process.env['TZ'] = tz
    }
  })

  it('skips a current job that has not started yet', () => {
    const items = [
      experience({ start: '2021-06', current: true }),
      experience({ start: '2020-02', end: '2020-12', current: false }),
    ]
    expect(yearsOfExperience(items, now)).toBe(0)
  })

  it('counts a current job that started this month', () => {
    const items = [
      experience({ start: '2021-01', current: true }),
      experience({ start: '2020-02', end: '2020-12', current: false }),
    ]
    expect(yearsOfExperience(items, now)).toBe(1)
  })

  it('skips an invalid start next to a valid eleven-month job', () => {
    const items = [
      experience({ start: 'garbage', current: false }),
      experience({ start: '2020-02', end: '2020-12', current: false }),
    ]
    expect(yearsOfExperience(items, now)).toBe(0)
  })

  it('counts a month shared by two jobs once', () => {
    const items = [
      experience({ start: '2020-01', end: '2020-11', current: false }),
      experience({ start: '2020-11', end: '2021-11', current: false }),
    ]
    expect(yearsOfExperience(items, now)).toBe(1)
  })

  it('ignores an invalid end month', () => {
    expect(
      yearsOfExperience([experience({ start: '2010-01', end: 'garbage', current: false })], now),
    ).toBe(0)
  })

  it('floors a partial year', () => {
    expect(
      yearsOfExperience([experience({ start: '2020-03', end: '2021-01', current: false })], now),
    ).toBe(0)
  })

  it('counts exactly twelve inclusive months as one year', () => {
    expect(
      yearsOfExperience([experience({ start: '2020-01', end: '2020-12', current: false })], now),
    ).toBe(1)
  })

  it('returns zero for no experience', () => {
    expect(yearsOfExperience([], now)).toBe(0)
  })

  it('skips an item without a start month', () => {
    expect(yearsOfExperience([experience({ start: null })], now)).toBe(0)
  })

  it('clamps an end before the start to the start month', () => {
    expect(
      yearsOfExperience([experience({ start: '2020-01', end: '2019-01', current: false })], now),
    ).toBe(0)
  })
})

describe('parseFreePeriod', () => {
  it.each([
    ['Mar 2021 – Present', { start: '2021-03', end: null, current: true }],
    ['March 2021 - May 2023', { start: '2021-03', end: '2023-05', current: false }],
    ['2021-03 – 2023-05', { start: '2021-03', end: '2023-05', current: false }],
    ['03/2021 - 05/2023', { start: '2021-03', end: '2023-05', current: false }],
    ['Mar 2021', { start: '2021-03', end: null, current: false }],
    ['2019 — наст. время', { start: null, end: null, current: true }],
    ['2019', { start: null, end: null, current: false }],
    ['2015 - 2019', { start: null, end: null, current: false }],
    ['2019 – Mar 2021', { start: null, end: '2021-03', current: false }],
    ['Present', { start: null, end: null, current: true }],
    ['Current', { start: null, end: null, current: true }],
    ['Now', { start: null, end: null, current: true }],
    ['тепер', { start: null, end: null, current: true }],
    ['по н.в.', { start: null, end: null, current: true }],
    ['по н в', { start: null, end: null, current: true }],
    ['по  н.в.', { start: null, end: null, current: true }],
    ['по н. в.', { start: null, end: null, current: true }],
    ['по н.в', { start: null, end: null, current: true }],
    ['garbage', { start: null, end: null, current: false }],
    ['', { start: null, end: null, current: false }],
    ['2021-00', { start: null, end: null, current: false }],
    ['2021-13', { start: null, end: null, current: false }],
    ['00/2021', { start: null, end: null, current: false }],
    ['13/2021', { start: null, end: null, current: false }],
    ['xMar 2021', { start: null, end: null, current: false }],
    ['Mar 2021x', { start: null, end: null, current: false }],
    ['x2021-03', { start: null, end: null, current: false }],
    ['2021-03x', { start: null, end: null, current: false }],
    ['x03/2021', { start: null, end: null, current: false }],
    ['03/2021x', { start: null, end: null, current: false }],
    ['x2021', { start: null, end: null, current: false }],
  ])('parses %j', (text, expected) => {
    expect(parseFreePeriod(text)).toEqual(expected)
  })

  it('parses every English month name', () => {
    const months = [
      ['Jan', '01'],
      ['February', '02'],
      ['Mar', '03'],
      ['April', '04'],
      ['May', '05'],
      ['June', '06'],
      ['Jul', '07'],
      ['August', '08'],
      ['Sept', '09'],
      ['Oct', '10'],
      ['Nov', '11'],
      ['Dec', '12'],
    ]
    for (const [name, month] of months) {
      expect(parseFreePeriod(`${name} 2021`)).toEqual({
        start: `2021-${month}`,
        end: null,
        current: false,
      })
    }
  })

  it('does not read a month out of a word that only starts like one', () => {
    expect(parseFreePeriod('Marketing 2023 – Decoration 2024')).toEqual({
      start: null,
      end: null,
      current: false,
    })
    expect(parseFreePeriod('Junior 2019, Mayor 2020')).toEqual({
      start: null,
      end: null,
      current: false,
    })
    expect(parseFreePeriod('January 2021 – Sept. 2022')).toEqual({
      start: '2021-01',
      end: '2022-09',
      current: false,
    })
  })

  it('never throws, whatever the string', () => {
    const inputs = ['—', '😀', ' – ', 'Mar', '2021-', '99/9999', 'наст', 'Present day', '\u0000']
    for (const input of inputs) {
      expect(() => parseFreePeriod(input)).not.toThrow()
    }
  })
})

describe('deriveFrozenContent', () => {
  const facts: ResumeFacts = {
    headline: 'Senior Backend Engineer',
    location: { city: 'Kyiv', country: 'Ukraine' },
    workFormat: 'remote',
    skills: ['JS', 'postgres'],
    experience: [
      experience({
        technologies: ['nodejs', 'Docker'],
        notes: ['Shipped things'],
      }),
      experience({
        company: 'Old Co',
        role: 'Junior',
        start: '2018-01',
        end: '2020-12',
        current: false,
      }),
    ],
    education: [{ institution: 'KNU', degree: 'BSc', startYear: 2015, endYear: 2019 }],
    languages: [
      { name: 'English', level: 'C1' },
      { name: 'Ukrainian', level: 'native' },
    ],
    links: [{ label: 'GitHub', url: 'https://github.com/example' }],
  }

  it('fills the deterministic fields and leaves the written ones empty', () => {
    const content = deriveFrozenContent(facts)
    expect(content).toEqual({
      summary: '',
      skills: ['JavaScript', 'PostgreSQL', 'Node.js', 'Docker'],
      experience: [
        { company: 'Acme', role: 'Engineer', period: 'Mar 2021 – Present', bullets: [] },
        { company: 'Old Co', role: 'Junior', period: 'Jan 2018 – Dec 2020', bullets: [] },
      ],
      education: [{ institution: 'KNU', degree: 'BSc', period: '2015 – 2019' }],
      languages: [
        { name: 'English', level: 'C1' },
        { name: 'Ukrainian', level: 'native' },
      ],
      links: [{ label: 'GitHub', url: 'https://github.com/example' }],
    })
  })

  it('produces schema-valid content', () => {
    expect(resumeContentSchema.safeParse(deriveFrozenContent(facts)).success).toBe(true)
  })

  it('leaves the period empty when the start is unknown', () => {
    const content = deriveFrozenContent({
      ...EMPTY_RESUME_FACTS,
      experience: [experience({ start: null, current: false })],
    })
    expect(content.experience[0]?.period).toBe('')
  })

  it('leaves the education period empty when no year is known', () => {
    const content = deriveFrozenContent({
      ...EMPTY_RESUME_FACTS,
      education: [{ institution: 'KNU', degree: 'BSc', startYear: null, endYear: null }],
    })
    expect(content.education[0]?.period).toBe('')
  })

  it('derives empty content from empty facts', () => {
    expect(deriveFrozenContent(EMPTY_RESUME_FACTS)).toEqual(EMPTY_RESUME_CONTENT)
  })
})

describe('contentToFacts — legacy mapping', () => {
  const legacy: ResumeContent = {
    summary: 'Legacy summary',
    skills: ['nodejs', 'postgres'],
    experience: [
      {
        company: 'Acme',
        role: 'Engineer',
        period: 'Mar 2021 – May 2023',
        bullets: ['Did X', 'Did Y'],
      },
      { company: 'Old Co', role: 'Junior', period: '2019 — наст. время', bullets: [] },
      { company: 'Ancient', role: 'Intern', period: 'garbage', bullets: [] },
    ],
    education: [{ institution: 'KNU', degree: 'BSc', period: '2015 - 2019' }],
    languages: [
      { name: 'English', level: 'Fluent' },
      { name: 'Ukrainian', level: 'native' },
    ],
    links: [{ label: 'GitHub', url: 'https://github.com/example' }],
  }

  it('maps an empty legacy content to empty facts', () => {
    expect(contentToFacts(EMPTY_RESUME_CONTENT)).toEqual(EMPTY_RESUME_FACTS)
  })

  it('maps a legacy content into facts', () => {
    expect(contentToFacts(legacy)).toEqual({
      headline: '',
      location: { city: '', country: '' },
      workFormat: null,
      skills: ['Node.js', 'PostgreSQL'],
      experience: [
        {
          company: 'Acme',
          role: 'Engineer',
          location: null,
          start: '2021-03',
          end: '2023-05',
          current: false,
          technologies: [],
          notes: ['Did X', 'Did Y'],
        },
        {
          company: 'Old Co',
          role: 'Junior',
          location: null,
          start: null,
          end: null,
          current: true,
          technologies: [],
          notes: [],
        },
        {
          company: 'Ancient',
          role: 'Intern',
          location: null,
          start: null,
          end: null,
          current: false,
          technologies: [],
          notes: [],
        },
      ],
      education: [{ institution: 'KNU', degree: 'BSc', startYear: 2015, endYear: 2019 }],
      languages: [
        { name: 'English', level: 'C1' },
        { name: 'Ukrainian', level: 'native' },
      ],
      links: [{ label: 'GitHub', url: 'https://github.com/example' }],
    })
  })

  it('produces facts that satisfy the facts schema', () => {
    expect(resumeFactsSchema.safeParse(contentToFacts(legacy)).success).toBe(true)
  })

  it('round-trips a parseable legacy period back to the same string', () => {
    const content = deriveFrozenContent(contentToFacts(legacy))
    expect(content.experience[0]?.period).toBe('Mar 2021 – May 2023')
  })

  it('maps a single education year', () => {
    const facts = contentToFacts({
      ...EMPTY_RESUME_CONTENT,
      education: [{ institution: 'KNU', degree: 'BSc', period: '2019' }],
    })
    expect(facts.education[0]).toEqual({
      institution: 'KNU',
      degree: 'BSc',
      startYear: 2019,
      endYear: null,
    })
  })

  it('drops an education year outside the schema range', () => {
    const facts = contentToFacts({
      ...EMPTY_RESUME_CONTENT,
      education: [{ institution: 'KNU', degree: 'BSc', period: '1949 - 2019' }],
    })
    expect(facts.education[0]?.startYear).toBeNull()
    expect(facts.education[0]?.endYear).toBe(2019)
  })

  it('keeps the schema year boundaries', () => {
    const facts = contentToFacts({
      ...EMPTY_RESUME_CONTENT,
      education: [{ institution: 'KNU', degree: 'BSc', period: '1950 - 2100' }],
    })
    expect(facts.education[0]).toEqual({
      institution: 'KNU',
      degree: 'BSc',
      startYear: 1950,
      endYear: 2100,
    })
  })

  it('drops years beyond both schema boundaries', () => {
    const facts = contentToFacts({
      ...EMPTY_RESUME_CONTENT,
      education: [{ institution: 'KNU', degree: 'BSc', period: '1949 - 2101' }],
    })
    expect(facts.education[0]?.startYear).toBeNull()
    expect(facts.education[0]?.endYear).toBeNull()
  })

  it.each([
    ['B2', 'B2'],
    ['b2', 'B2'],
    ['C1', 'C1'],
    ['native', 'native'],
    ['родной', 'native'],
    ['  Fluent  ', 'C1'],
    ['Fluent', 'C1'],
    ['Advanced', 'C1'],
    ['Upper-Intermediate', 'B2'],
    ['Intermediate', 'B1'],
    ['Pre-Intermediate', 'A2'],
    ['Elementary', 'A1'],
    ['Beginner', 'A1'],
    ['Unrecognised', 'B2'],
  ] as const)('maps the legacy language level %j to %j', (raw, expected) => {
    const facts = contentToFacts({
      ...EMPTY_RESUME_CONTENT,
      languages: [{ name: 'English', level: raw }],
    })
    expect(facts.languages[0]?.level).toBe(expected)
  })
})
