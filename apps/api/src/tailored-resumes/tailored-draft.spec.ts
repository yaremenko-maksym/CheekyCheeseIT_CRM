import { EMPTY_RESUME_CONTENT, RESUME_LIMITS, type ResumeContent } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import type { TailorReply } from './tailor-writer.client'
import {
  bulletPath,
  COVER_GREETING,
  COVER_MAX_WORDS,
  COVER_MIN_WORDS,
  coverClosing,
  frozenFieldsEqual,
  mergeDraft,
  sourceBullets,
  validateTailorReply,
  wordCount,
  type TailoredDraft,
} from './tailored-draft'

const base: ResumeContent = {
  ...EMPTY_RESUME_CONTENT,
  summary: 'Builds APIs.',
  skills: ['Postgres', 'React'],
  experience: [
    { company: 'Acme', role: 'Dev', period: '2020 - 2022', bullets: ['A1', 'A2', 'A3'] },
    { company: 'Initech', role: 'Lead', period: '2018 - 2020', bullets: ['B1', '  ', 'B2'] },
    { company: 'Old', role: 'Intern', period: '2017', bullets: ['C1'] },
  ],
  education: [{ institution: 'KPI', degree: 'BSc', period: '2013 - 2017' }],
  languages: [{ name: 'English', level: 'C1' }],
  links: [{ label: 'GitHub', url: 'https://github.com/x' }],
}

const reply = (over: Partial<TailorReply> = {}): TailorReply => ({
  summary: 'Builds  APIs.',
  skills: [
    { index: 0, name: 'PostgreSQL' },
    { index: 1, name: 'React' },
  ],
  items: [
    {
      bullets: [
        { text: 'A one', sourceIndices: [0] },
        { text: 'A two', sourceIndices: [1, 2] },
      ],
    },
    { bullets: [{ text: 'B one', sourceIndices: [0, 1] }] },
  ],
  coverLetter: 'I build APIs.',
  ...over,
})

const validate = (r: TailorReply, sentItems = 2) =>
  validateTailorReply(r, base, sentItems, 'classic')

describe('tailored draft constants', () => {
  it('the cover letter frame and its word bounds are the spec values (D8)', () => {
    expect(COVER_GREETING).toBe('Dear Hiring Team,')
    expect(coverClosing('Tara Prep')).toBe('Kind regards,\nTara Prep')
    expect(COVER_MIN_WORDS).toBe(100)
    expect(COVER_MAX_WORDS).toBe(220)
    expect(bulletPath(1, 2)).toBe('experience.1.bullets.2')
  })

  it('wordCount counts whitespace-separated words', () => {
    expect(wordCount('  one two\nthree  ')).toBe(3)
    expect(wordCount('')).toBe(0)
  })
})

describe('sourceBullets', () => {
  it('numbers the base bullets as the payload notes do: blank bullets dropped', () => {
    expect(sourceBullets(base, 1)).toEqual(['B1', 'B2'])
    expect(sourceBullets(base, 0)).toEqual(['A1', 'A2', 'A3'])
    expect(sourceBullets(base, 9)).toEqual([])
  })
})

describe('validateTailorReply', () => {
  it('a valid reply becomes a cleaned draft', () => {
    const r = validate(reply())
    expect(r).toEqual({
      ok: true,
      draft: {
        summary: 'Builds APIs.',
        skills: ['PostgreSQL', 'React'],
        items: [
          {
            bullets: [
              { text: 'A one', sourceIndices: [0] },
              { text: 'A two', sourceIndices: [1, 2] },
            ],
          },
          { bullets: [{ text: 'B one', sourceIndices: [0, 1] }] },
        ],
        coverBody: 'I build APIs.',
      },
    })
  })

  it('validateTailorReply refuses sourceIndices [0,0]', () => {
    const r = validate(
      reply({ items: [{ bullets: [{ text: 'x', sourceIndices: [0, 0] }] }, reply().items[1]!] }),
    )
    expect(r).toEqual({
      ok: false,
      feedback: [
        'Experience item 1, bullet 1: sourceIndices must be distinct note indexes of that item (0 to 2).',
      ],
    })
  })

  it('… index 5 in a 3-bullet item', () => {
    const r = validate(
      reply({ items: [{ bullets: [{ text: 'x', sourceIndices: [5] }] }, reply().items[1]!] }),
    )
    expect(r.ok).toBe(false)
    expect(!r.ok && r.feedback).toEqual([
      'Experience item 1, bullet 1: sourceIndices must be distinct note indexes of that item (0 to 2).',
    ])
  })

  it('the last index of an item is in range; one past it is not (blank bullets do not count)', () => {
    const at = (i: number) =>
      validate(
        reply({ items: [reply().items[0]!, { bullets: [{ text: 'x', sourceIndices: [i] }] }] }),
      )
    expect(at(1).ok).toBe(true)
    expect(at(2)).toEqual({
      ok: false,
      feedback: [
        'Experience item 2, bullet 1: sourceIndices must be distinct note indexes of that item (0 to 1).',
      ],
    })
  })

  it('… base bullet 1 used by two output bullets', () => {
    const r = validate(
      reply({
        items: [
          {
            bullets: [
              { text: 'x', sourceIndices: [1] },
              { text: 'y', sourceIndices: [0, 1] },
            ],
          },
          reply().items[1]!,
        ],
      }),
    )
    expect(r).toEqual({
      ok: false,
      feedback: ['Experience item 1: each note may be the source of one bullet only.'],
    })
  })

  it('… one item fewer', () => {
    const r = validate(reply({ items: [reply().items[0]!] }))
    expect(r).toEqual({
      ok: false,
      feedback: ['Return exactly 2 experience items, one per item in FACTS, in order.'],
    })
  })

  it('a reply with sentItems items on a trimmed payload validates', () => {
    const r = validate(reply({ items: [reply().items[0]!] }), 1)
    expect(r.ok).toBe(true)
    expect(r.ok && r.draft.items).toHaveLength(1)
  })

  it('more bullets than an item may hold is refused', () => {
    const many = Array.from({ length: RESUME_LIMITS.bulletsPerExperience + 1 }, () => ({
      text: 'x',
      sourceIndices: [0],
    }))
    const r = validate(reply({ items: [{ bullets: many }, reply().items[1]!] }))
    expect(!r.ok && r.feedback[0]).toBe('Experience item 1: return 1 to 20 bullets.')
  })

  it('exactly as many bullets as an item may hold is accepted', () => {
    const max = RESUME_LIMITS.bulletsPerExperience
    const wide: ResumeContent = {
      ...base,
      experience: [
        { ...base.experience[0]!, bullets: Array.from({ length: max }, (_, k) => `N${k}`) },
      ],
    }
    const bullets = Array.from({ length: max }, (_, k) => ({ text: 'x', sourceIndices: [k] }))
    expect(validateTailorReply(reply({ items: [{ bullets }] }), wide, 1, 'classic').ok).toBe(true)
  })

  it('one out-of-range index among in-range ones is refused', () => {
    const r = validate(
      reply({ items: [{ bullets: [{ text: 'x', sourceIndices: [0, 5] }] }, reply().items[1]!] }),
    )
    expect(r.ok).toBe(false)
  })

  it('an item with no bullets is refused', () => {
    const r = validate(reply({ items: [{ bullets: [] }, reply().items[1]!] }))
    expect(!r.ok && r.feedback).toEqual(['Experience item 1: return 1 to 20 bullets.'])
  })

  it('… skill rename to a non-synonym', () => {
    const r = validate(reply({ skills: [{ index: 0, name: 'MySQL' }] }))
    expect(r).toEqual({
      ok: false,
      feedback: [
        'Skill 1: index must be a skill of FACTS (0 to 1) and name that skill or its canonical name.',
      ],
    })
  })

  it('a skill under its base spelling passes; an index past the base skills does not', () => {
    expect(validate(reply({ skills: [{ index: 0, name: 'Postgres' }] })).ok).toBe(true)
    expect(validate(reply({ skills: [{ index: 1, name: 'React' }] })).ok).toBe(true)
    expect(validate(reply({ skills: [{ index: 2, name: 'React' }] })).ok).toBe(false)
  })

  it('every problem is one feedback line, at most 20', () => {
    const skills = Array.from({ length: 25 }, (_, i) => ({ index: 9 + i, name: 'X' }))
    const r = validate(reply({ skills, items: [] }))
    expect(!r.ok && r.feedback).toHaveLength(20)
    expect(!r.ok && r.feedback[0]).toBe(
      'Return exactly 2 experience items, one per item in FACTS, in order.',
    )
  })

  it('every text passes through the cleaner (whitespace collapsed, one line)', () => {
    const r = validate(
      reply({
        summary: 'Builds\n APIs.',
        skills: [{ index: 1, name: ' React ' }],
        coverLetter: 'I build\n\nAPIs.',
        items: [
          { bullets: [{ text: 'A\n one', sourceIndices: [0] }] },
          { bullets: [{ text: ' B one ', sourceIndices: [0] }] },
        ],
      }),
    )
    expect(r.ok && r.draft).toEqual({
      summary: 'Builds APIs.',
      skills: ['React'],
      items: [
        { bullets: [{ text: 'A one', sourceIndices: [0] }] },
        { bullets: [{ text: 'B one', sourceIndices: [0] }] },
      ],
      coverBody: 'I build APIs.',
    })
  })

  it('an item with no base notes takes no bullets from the reply (CR-H-1)', () => {
    const noNotes: ResumeContent = {
      ...base,
      experience: [
        { company: 'Acme', role: 'Dev', period: '2020 - 2022', bullets: [] },
        { company: 'Initech', role: 'Lead', period: '2018 - 2020', bullets: ['  '] },
        base.experience[2]!,
      ],
    }
    // The wire schema makes the writer send one bullet per item, with an index it cannot have.
    const r = validateTailorReply(
      reply({
        items: [
          { bullets: [{ text: 'Invented', sourceIndices: [0] }] },
          { bullets: [{ text: 'Invented too', sourceIndices: [2] }] },
          { bullets: [{ text: 'C one', sourceIndices: [0] }] },
        ],
      }),
      noNotes,
      3,
      'classic',
    )
    expect(r.ok && r.draft.items).toEqual([
      { bullets: [] },
      { bullets: [] },
      { bullets: [{ text: 'C one', sourceIndices: [0] }] },
    ])
  })

  it('a bullet with no sourceIndices is refused', () => {
    const r = validate(
      reply({ items: [{ bullets: [{ text: 'A', sourceIndices: [] }] }, reply().items[1]!] }),
    )
    expect(!r.ok && r.feedback).toEqual([
      'Experience item 1, bullet 1: sourceIndices must be distinct note indexes of that item (0 to 2).',
    ])
  })

  it('a skill index named twice is refused (CR-M-2)', () => {
    const r = validate(
      reply({
        skills: [
          { index: 0, name: 'Postgres' },
          { index: 0, name: 'PostgreSQL' },
        ],
      }),
    )
    expect(!r.ok && r.feedback).toEqual(['Skill 2: name each skill of FACTS once.'])
  })

  const twice = { ...base, skills: ['Postgres', 'PostgreSQL', 'React'] }
  it('two base skills that are synonyms may both be named (code-review L2)', () => {
    const r = validateTailorReply(
      reply({
        skills: [
          { index: 0, name: 'Postgres' },
          { index: 1, name: 'PostgreSQL' },
          { index: 2, name: 'React' },
        ],
      }),
      twice,
      2,
      'classic',
    )
    expect(r.ok && r.draft.skills).toEqual(['Postgres', 'PostgreSQL', 'React'])
  })

  it('one name written for two base skills is refused (CR-M-2)', () => {
    const r = validateTailorReply(
      reply({
        skills: [
          { index: 1, name: 'PostgreSQL' },
          { index: 0, name: 'PostgreSQL' },
        ],
      }),
      twice,
      2,
      'classic',
    )
    expect(!r.ok && r.feedback).toEqual(['Skill 2: name each skill of FACTS once.'])
  })

  it('an empty skills list keeps the base skills (CR-M-2)', () => {
    const r = validate(reply({ skills: [] }))
    expect(r.ok && r.draft.skills).toEqual(['Postgres', 'React'])
  })
})

describe('mergeDraft', () => {
  const draft: TailoredDraft = {
    summary: 'New summary.',
    skills: ['React'],
    items: [{ bullets: [{ text: 'A new', sourceIndices: [0] }] }],
    coverBody: 'Body.',
  }

  it('mergeDraft keeps company/role/period/education/languages/links byte-equal', () => {
    const merged = mergeDraft(base, draft)
    expect(merged).toEqual({
      ...base,
      summary: 'New summary.',
      skills: ['React'],
      experience: [
        { ...base.experience[0]!, bullets: ['A new'] },
        base.experience[1],
        base.experience[2],
      ],
    })
    expect(frozenFieldsEqual(base, merged)).toBe(true)
  })

  it.each([
    [
      'company',
      (c: ResumeContent) => ({ ...c, experience: [{ ...c.experience[0]!, company: 'X' }] }),
    ],
    ['an item', (c: ResumeContent) => ({ ...c, experience: c.experience.slice(1) })],
    ['education', (c: ResumeContent) => ({ ...c, education: [] })],
    ['languages', (c: ResumeContent) => ({ ...c, languages: [] })],
    ['links', (c: ResumeContent) => ({ ...c, links: [] })],
    [
      'role',
      (c: ResumeContent) => ({
        ...c,
        experience: [{ ...c.experience[0]!, role: 'X' }, ...c.experience.slice(1)],
      }),
    ],
    [
      'period',
      (c: ResumeContent) => ({
        ...c,
        experience: [{ ...c.experience[0]!, period: 'X' }, ...c.experience.slice(1)],
      }),
    ],
  ])('frozenFieldsEqual is false when %s changed', (_, change) => {
    expect(frozenFieldsEqual(base, change(base))).toBe(false)
  })

  it('frozenFieldsEqual ignores the summary, skills and bullets', () => {
    expect(
      frozenFieldsEqual(base, {
        ...base,
        summary: 'x',
        skills: [],
        experience: base.experience.map((e) => ({ ...e, bullets: [] })),
      }),
    ).toBe(true)
  })
})
