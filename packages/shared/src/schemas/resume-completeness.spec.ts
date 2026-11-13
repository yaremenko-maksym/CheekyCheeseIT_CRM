import { describe, expect, it } from 'vitest'
import type { ResumeFacts, ResumeFactsExperience } from './resume-facts'
import {
  RESUME_EMAIL_PATTERN,
  RESUME_PHONE_PATTERN,
  checkResumeCompleteness,
  findPhoneSpans,
  isLatinScript,
} from './resume-completeness'

const NOW = new Date('2026-11-10T00:00:00Z')
const CTX = { displayName: 'José Müller', now: NOW }

const BASE_EXPERIENCE: ResumeFactsExperience = {
  company: 'Acme',
  role: 'Engineer',
  location: 'Kyiv',
  start: '2020-01',
  end: '2023-06',
  current: false,
  technologies: ['React'],
  notes: ['Built the design system'],
}

const BASE_FACTS: ResumeFacts = {
  headline: 'Senior Frontend Engineer',
  location: { city: 'Kyiv', country: 'Ukraine' },
  workFormat: 'remote',
  skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL'],
  experience: [BASE_EXPERIENCE],
  education: [{ institution: 'KPI', degree: 'BSc', startYear: 2015, endYear: 2019 }],
  languages: [{ name: 'English', level: 'C1' }],
  links: [],
}

function makeFacts(overrides: Partial<ResumeFacts> = {}): ResumeFacts {
  return { ...BASE_FACTS, ...overrides }
}

function makeExperience(overrides: Partial<ResumeFactsExperience> = {}): ResumeFactsExperience {
  return { ...BASE_EXPERIENCE, ...overrides }
}

describe('checkResumeCompleteness', () => {
  it('returns no issues for a fully filled fixture', () => {
    expect(checkResumeCompleteness(BASE_FACTS, CTX)).toEqual([])
  })

  it('accepts a José Müller display name', () => {
    expect(checkResumeCompleteness(BASE_FACTS, { ...CTX, displayName: 'José Müller' })).toEqual([])
  })

  it('HEADLINE_MISSING: blank headline after trim', () => {
    expect(checkResumeCompleteness(makeFacts({ headline: '   ' }), CTX)).toEqual([
      { path: 'headline', code: 'HEADLINE_MISSING' },
    ])
  })

  it('NO_EXPERIENCE: no experience items', () => {
    expect(checkResumeCompleteness(makeFacts({ experience: [] }), CTX)).toEqual([
      { path: 'experience', code: 'NO_EXPERIENCE' },
    ])
  })

  it('COMPANY_MISSING: blank company', () => {
    const facts = makeFacts({ experience: [makeExperience({ company: ' ' })] })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'experience.0.company', code: 'COMPANY_MISSING' },
    ])
  })

  it('ROLE_MISSING: blank role', () => {
    const facts = makeFacts({ experience: [makeExperience({ role: '' })] })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'experience.0.role', code: 'ROLE_MISSING' },
    ])
  })

  it('START_MISSING: null start', () => {
    const facts = makeFacts({ experience: [makeExperience({ start: null })] })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'experience.0.start', code: 'START_MISSING' },
    ])
  })

  it('END_MISSING: a past item without an end month', () => {
    const facts = makeFacts({ experience: [makeExperience({ end: null, current: false })] })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'experience.0.end', code: 'END_MISSING' },
    ])
  })

  it('END_MISSING: a current item may leave the end month null', () => {
    const facts = makeFacts({ experience: [makeExperience({ end: null, current: true })] })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([])
  })

  it('END_BEFORE_START: end month earlier than start month', () => {
    const facts = makeFacts({
      experience: [makeExperience({ start: '2024-01', end: '2023-01' })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'experience.0.end', code: 'END_BEFORE_START' },
    ])
  })

  it('END_BEFORE_START: equal months are allowed', () => {
    const facts = makeFacts({
      experience: [makeExperience({ start: '2024-01', end: '2024-01' })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([])
  })

  it('START_IN_FUTURE: start after now’s month', () => {
    const facts = makeFacts({
      experience: [makeExperience({ start: '2026-12', end: null, current: true })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'experience.0.start', code: 'START_IN_FUTURE' },
    ])
  })

  it('START_IN_FUTURE: the current month is not in the future', () => {
    const facts = makeFacts({
      experience: [makeExperience({ start: '2026-11', end: null, current: true })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([])
  })

  it('START_IN_FUTURE: compares zero-padded months correctly in a single-digit month', () => {
    const facts = makeFacts({
      experience: [makeExperience({ start: '2026-03', end: null, current: true })],
    })
    const ctx = { ...CTX, now: new Date('2026-02-10T00:00:00Z') }
    expect(checkResumeCompleteness(facts, ctx)).toEqual([
      { path: 'experience.0.start', code: 'START_IN_FUTURE' },
    ])
  })

  it('END_IN_FUTURE: a past item whose end month is after now’s month', () => {
    const facts = makeFacts({
      experience: [makeExperience({ start: '2021-01', end: '2099-01', current: false })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'experience.0.end', code: 'END_IN_FUTURE' },
    ])
  })

  it('END_IN_FUTURE: an end in the current month is allowed', () => {
    const facts = makeFacts({
      experience: [makeExperience({ start: '2021-01', end: '2026-11', current: false })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([])
  })

  it('END_IN_FUTURE: a current item ignores its end month', () => {
    const facts = makeFacts({
      experience: [makeExperience({ start: '2021-01', end: '2099-01', current: true })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([])
  })

  it('END_IN_FUTURE: raised without a start, after START_MISSING', () => {
    const facts = makeFacts({
      experience: [makeExperience({ start: null, end: '2027-01', current: false })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'experience.0.start', code: 'START_MISSING' },
      { path: 'experience.0.end', code: 'END_IN_FUTURE' },
    ])
  })

  it('END_BEFORE_START: education end year earlier than start year', () => {
    const facts = makeFacts({
      education: [{ institution: 'KPI', degree: 'BSc', startYear: 2005, endYear: 1999 }],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'education.0.endYear', code: 'END_BEFORE_START' },
    ])
  })

  it('END_BEFORE_START: education equal years, or one year missing, are allowed', () => {
    const years: Array<[number | null, number | null]> = [
      [2019, 2019],
      [null, 1999],
      [2005, null],
    ]
    for (const [startYear, endYear] of years) {
      const facts = makeFacts({
        education: [{ institution: 'KPI', degree: 'BSc', startYear, endYear }],
      })
      expect(checkResumeCompleteness(facts, CTX)).toEqual([])
    }
  })

  it('NO_NOTES: no notes at all', () => {
    const facts = makeFacts({ experience: [makeExperience({ notes: [] })] })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'experience.0.notes', code: 'NO_NOTES' },
    ])
  })

  it('NO_NOTES: only blank notes', () => {
    const facts = makeFacts({ experience: [makeExperience({ notes: ['   ', ''] })] })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'experience.0.notes', code: 'NO_NOTES' },
    ])
  })

  it('TOO_FEW_SKILLS: fewer than five after the merge', () => {
    const facts = makeFacts({
      skills: ['React'],
      experience: [makeExperience({ technologies: [] })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'skills', code: 'TOO_FEW_SKILLS' },
    ])
  })

  it('TOO_FEW_SKILLS: experience technologies count towards the merge', () => {
    const facts = makeFacts({
      skills: ['React'],
      experience: [
        makeExperience({ technologies: ['Vue.js', 'Node.js', 'TypeScript', 'PostgreSQL'] }),
      ],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([])
  })

  it('ENGLISH_MISSING: no English language', () => {
    const facts = makeFacts({ languages: [{ name: 'Ukrainian', level: 'native' }] })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'languages', code: 'ENGLISH_MISSING' },
    ])
  })

  it('ENGLISH_MISSING: English anywhere in a list of several languages is enough', () => {
    const facts = makeFacts({
      languages: [
        { name: 'Ukrainian', level: 'native' },
        { name: 'English', level: 'B2' },
      ],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([])
  })

  it('ENGLISH_MISSING: name match is trimmed and case-insensitive', () => {
    const facts = makeFacts({ languages: [{ name: '  english ', level: 'B2' }] })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([])
  })

  it('NAME_NON_LATIN: a non-Latin display name', () => {
    expect(checkResumeCompleteness(BASE_FACTS, { ...CTX, displayName: 'Іван' })).toEqual([
      { path: 'displayName', code: 'NAME_NON_LATIN' },
    ])
  })

  it('CONTACT_IN_TEXT: a phone in a note', () => {
    const facts = makeFacts({
      experience: [makeExperience({ notes: ['call me +380 67 123 45 67'] })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'experience.0.notes.0', code: 'CONTACT_IN_TEXT' },
    ])
  })

  it('CONTACT_IN_TEXT: an email in the headline', () => {
    const facts = makeFacts({ headline: 'Reach me at jane.doe@example.com' })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'headline', code: 'CONTACT_IN_TEXT' },
    ])
  })

  it('CONTACT_IN_TEXT: a phone in a skill', () => {
    const facts = makeFacts({
      skills: ['+380 67 123 45 67', 'JavaScript', 'TypeScript', 'React', 'Node.js'],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'skills.0', code: 'CONTACT_IN_TEXT' },
    ])
  })

  it('CONTACT_IN_TEXT: an email in a technology, after its NON_LATIN check', () => {
    const facts = makeFacts({
      experience: [makeExperience({ technologies: ['React', 'Котлин a@b.io'] })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([
      { path: 'experience.0.technologies.1', code: 'NON_LATIN' },
      { path: 'experience.0.technologies.1', code: 'CONTACT_IN_TEXT' },
    ])
  })

  describe('CONTACT_IN_TEXT: the senior’s full name', () => {
    const NAMED = { ...CTX, displayName: 'Oleksiy Kovalenko' }
    const noteIssues = (note: string, ctx = NAMED) =>
      checkResumeCompleteness(makeFacts({ experience: [makeExperience({ notes: [note] })] }), ctx)
    const flagged = [{ path: 'experience.0.notes.0', code: 'CONTACT_IN_TEXT' }]

    it('flags the full name in a note', () => {
      expect(noteIssues('Oleksiy Kovalenko led billing')).toEqual(flagged)
    })

    it('flags the reversed order', () => {
      expect(noteIssues('Led billing with Kovalenko Oleksiy')).toEqual(flagged)
    })

    it('flags a different case and extra whitespace', () => {
      expect(noteIssues('built by oleksiy   KOVALENKO')).toEqual(flagged)
    })

    it('does not flag the surname or the first name alone', () => {
      expect(noteIssues('Kovalenko led billing')).toEqual([])
      expect(noteIssues('Oleksiy led billing')).toEqual([])
    })

    it('does not flag the name inside a longer word', () => {
      expect(noteIssues('Oleksiy Kovalenkovich led billing')).toEqual([])
      expect(noteIssues('XOleksiy Kovalenko led billing')).toEqual([])
    })

    it('a one-token display name adds no name check', () => {
      expect(noteIssues('Oleksiy led billing', { ...CTX, displayName: 'Oleksiy' })).toEqual([])
    })

    it('flags the name in the headline, a skill and a technology too', () => {
      const facts = makeFacts({
        headline: 'Oleksiy Kovalenko, Backend Engineer',
        skills: ['kovalenko oleksiy', 'JavaScript', 'TypeScript', 'React', 'Node.js'],
        experience: [makeExperience({ technologies: ['Oleksiy Kovalenko'] })],
      })
      expect(checkResumeCompleteness(facts, NAMED)).toEqual([
        { path: 'headline', code: 'CONTACT_IN_TEXT' },
        { path: 'skills.0', code: 'CONTACT_IN_TEXT' },
        { path: 'experience.0.technologies.0', code: 'CONTACT_IN_TEXT' },
      ])
    })
  })

  const nonLatinCases: Array<{ name: string; facts: ResumeFacts; path: string }> = [
    {
      name: 'headline',
      facts: makeFacts({ headline: 'Інженер' }),
      path: 'headline',
    },
    {
      name: 'location city',
      facts: makeFacts({ location: { city: 'Київ', country: 'Ukraine' } }),
      path: 'location.city',
    },
    {
      name: 'location country',
      facts: makeFacts({ location: { city: 'Kyiv', country: 'Україна' } }),
      path: 'location.country',
    },
    {
      name: 'skill',
      facts: makeFacts({
        skills: ['Пайтон', 'JavaScript', 'TypeScript', 'React', 'Node.js'],
      }),
      path: 'skills.0',
    },
    {
      name: 'company',
      facts: makeFacts({ experience: [makeExperience({ company: 'Компанія' })] }),
      path: 'experience.0.company',
    },
    {
      name: 'role',
      facts: makeFacts({ experience: [makeExperience({ role: 'Інженер' })] }),
      path: 'experience.0.role',
    },
    {
      name: 'experience location',
      facts: makeFacts({ experience: [makeExperience({ location: 'Київ' })] }),
      path: 'experience.0.location',
    },
    {
      name: 'technology',
      facts: makeFacts({ experience: [makeExperience({ technologies: ['Котлин'] })] }),
      path: 'experience.0.technologies.0',
    },
    {
      name: 'note',
      facts: makeFacts({ experience: [makeExperience({ notes: ['Працював над проєктом'] })] }),
      path: 'experience.0.notes.0',
    },
    {
      name: 'education institution',
      facts: makeFacts({
        education: [{ institution: 'КПІ', degree: 'BSc', startYear: 2015, endYear: 2019 }],
      }),
      path: 'education.0.institution',
    },
    {
      name: 'education degree',
      facts: makeFacts({
        education: [{ institution: 'KPI', degree: 'Бакалавр', startYear: 2015, endYear: 2019 }],
      }),
      path: 'education.0.degree',
    },
    {
      name: 'language name',
      facts: makeFacts({ languages: [{ name: 'Українська', level: 'native' }] }),
      path: 'languages.0.name',
    },
  ]

  it.each(nonLatinCases)('NON_LATIN: $name', ({ facts, path }) => {
    const issues = checkResumeCompleteness(facts, CTX)
    expect(issues.filter((issue) => issue.code === 'NON_LATIN')).toEqual([
      { path, code: 'NON_LATIN' },
    ])
  })

  it('reports issues deterministically: top-level fields first, then experience in order', () => {
    const facts = makeFacts({
      headline: '',
      location: { city: 'Київ', country: 'Україна' },
      skills: ['Пайтон'],
      experience: [
        makeExperience({
          company: '',
          role: 'Інженер',
          location: null,
          start: null,
          end: null,
          current: false,
          technologies: ['Котлин'],
          notes: ['call me +380 67 123 45 67'],
        }),
        BASE_EXPERIENCE,
      ],
      education: [{ institution: 'КПІ', degree: 'Бакалавр', startYear: null, endYear: null }],
      languages: [{ name: 'Українська', level: 'native' }],
    })

    expect(checkResumeCompleteness(facts, { ...CTX, displayName: 'Іван Петренко' })).toEqual([
      { path: 'displayName', code: 'NAME_NON_LATIN' },
      { path: 'headline', code: 'HEADLINE_MISSING' },
      { path: 'location.city', code: 'NON_LATIN' },
      { path: 'location.country', code: 'NON_LATIN' },
      { path: 'skills', code: 'TOO_FEW_SKILLS' },
      { path: 'skills.0', code: 'NON_LATIN' },
      { path: 'experience.0.company', code: 'COMPANY_MISSING' },
      { path: 'experience.0.role', code: 'NON_LATIN' },
      { path: 'experience.0.start', code: 'START_MISSING' },
      { path: 'experience.0.end', code: 'END_MISSING' },
      { path: 'experience.0.technologies.0', code: 'NON_LATIN' },
      { path: 'experience.0.notes.0', code: 'CONTACT_IN_TEXT' },
      { path: 'education.0.institution', code: 'NON_LATIN' },
      { path: 'education.0.degree', code: 'NON_LATIN' },
      { path: 'languages', code: 'ENGLISH_MISSING' },
      { path: 'languages.0.name', code: 'NON_LATIN' },
    ])
  })
})

describe('findPhoneSpans', () => {
  it.each([
    'Released 2015-01-01 - 2019-12-31',
    'Promoted 10.05.2020 - 15.06.2023',
    'From 2015/01/01 to 2019.12.31',
    'Shipped 31-12-2019 – 01-02-2020',
  ])('does not read a run of full dates as a phone: %s', (text) => {
    expect(findPhoneSpans(text)).toEqual([])
  })

  it('finds exactly the phone after a date range', () => {
    const text = '2015-01-01 - 2019-12-31, call +380 67 123 4567'
    expect(findPhoneSpans(text).map(({ start, end }) => text.slice(start, end))).toEqual([
      '+380 67 123 4567',
    ])
  })

  it('finds every phone, with its offsets', () => {
    expect(findPhoneSpans('a +380671234567 b 0671234567')).toEqual([
      { start: 2, end: 15 },
      { start: 18, end: 28 },
    ])
  })

  it('keeps a bare ten-digit run as a phone (a UA mobile has the same shape)', () => {
    expect(findPhoneSpans('order 9876543210 shipped')).toEqual([{ start: 6, end: 16 }])
  })

  it('keeps a run that mixes a date with more digits as a phone', () => {
    expect(findPhoneSpans('2015-01-01 0671234567')).toEqual([{ start: 0, end: 21 }])
  })

  it('CONTACT_IN_TEXT uses the same rule: a date-range note passes', () => {
    const facts = makeFacts({
      experience: [makeExperience({ notes: ['Promoted 10.05.2020 - 15.06.2023'] })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([])
  })
})

describe('RESUME_PHONE_PATTERN', () => {
  it.each(['+380 67 123 45 67', '(067) 123-45-67', '+1 415 555 2671', '123456789'])(
    'flags %s',
    (phone) => {
      expect(RESUME_PHONE_PATTERN.test(phone)).toBe(true)
    },
  )

  it.each([
    '2015 – 2019',
    'Mar 2021 – May 2023',
    'C++ 17',
    '1,000,000 requests',
    'Node.js 18',
    '2020-01-15',
    // Nine digits are present, but split by separators a phone does not use.
    '1,000,000,000 requests',
    '2019/2020/2021',
  ])('does not flag %s', (text) => {
    expect(RESUME_PHONE_PATTERN.test(text)).toBe(false)
  })

  it('matches the whole number, the leading + or ( included', () => {
    expect('call +380 67 123 45 67 now'.match(RESUME_PHONE_PATTERN)?.[0]).toBe('+380 67 123 45 67')
    expect('(067) 123-45-67'.match(RESUME_PHONE_PATTERN)?.[0]).toBe('(067) 123-45-67')
  })

  it('accepts an en-dash as a separator', () => {
    expect('call +38 067 123–45–67 now'.match(RESUME_PHONE_PATTERN)?.[0]).toBe('+38 067 123–45–67')
  })

  it('is stateless: repeated tests give the same answer without a g flag', () => {
    expect(RESUME_PHONE_PATTERN.flags).not.toContain('g')
    expect(RESUME_PHONE_PATTERN.test('+380 67 123 45 67')).toBe(true)
    expect(RESUME_PHONE_PATTERN.test('+380 67 123 45 67')).toBe(true)
  })
})

describe('RESUME_EMAIL_PATTERN', () => {
  it.each(['jane.doe@example.com', 'a+b@sub.example.co.uk', '123@example.com', 'jane@123.com'])(
    'flags %s',
    (email) => {
      expect(RESUME_EMAIL_PATTERN.test(email)).toBe(true)
    },
  )

  it('matches the whole local part, not its last character', () => {
    expect('mail jane.doe@example.com today'.match(RESUME_EMAIL_PATTERN)?.[0]).toBe(
      'jane.doe@example.com',
    )
  })

  it.each(['jane at example dot com', 'no-address-here', 'a@b.c'])('does not flag %s', (text) => {
    expect(RESUME_EMAIL_PATTERN.test(text)).toBe(false)
  })

  it('is stateless: repeated tests give the same answer without a g flag', () => {
    expect(RESUME_EMAIL_PATTERN.flags).not.toContain('g')
    expect(RESUME_EMAIL_PATTERN.test('jane@example.com')).toBe(true)
    expect(RESUME_EMAIL_PATTERN.test('jane@example.com')).toBe(true)
  })
})

describe('isLatinScript', () => {
  it.each(['', 'José Müller', 'C++ 17', 'Node.js 18', '1,000,000 requests', 'Kyiv'])(
    'accepts %s',
    (text) => {
      expect(isLatinScript(text)).toBe(true)
    },
  )

  it.each(['Інженер', 'Київ', '日本語', 'hello Іван'])('rejects %s', (text) => {
    expect(isLatinScript(text)).toBe(false)
  })
})
