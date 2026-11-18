/**
 * PR #1416 round 3: one invariant on the parts of a stored name (`splitNameText`), the per-source
 * reading budget, and the name arms agreeing on a part. Wall-clock bounds live in
 * `contact-scan.timing.spec.ts`; here only outcomes and decisions. Every name here is invented.
 */
import { describe, expect, it } from 'vitest'
import { checkResumeCompleteness, contactNameParts, type ResumeFacts } from '@crm/shared'
import { redactContacts, scanContacts, type ContactContext } from './contact-scan'
import { redactAll } from './content-gates'
import { nameReadingCount, READING_BUDGET } from './name-transliteration'

const ctx = (fullName: string): ContactContext => ({ fullName, emails: [] })

const FACTS: ResumeFacts = {
  headline: 'Backend Engineer',
  location: { city: 'Lviv', country: 'Ukraine' },
  workFormat: 'remote',
  skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'React', 'Docker'],
  experience: [],
  education: [],
  languages: [{ name: 'English', level: 'C1' }],
  links: [],
}

/** Whether the shared completeness check flags `text` as a contact of `displayName`. */
const completenessFlags = (text: string, displayName: string): boolean =>
  checkResumeCompleteness(
    { ...FACTS, headline: text },
    { displayName, now: new Date('2026-11-18T00:00:00Z') },
  ).some((issue) => issue.code === 'CONTACT_IN_TEXT')

describe('a stored name with an escaped newline (findings 2, 8)', () => {
  it('reads `\\n` as one separator, so the letter after it is no part of the name', () => {
    expect(redactContacts('by Ivan Petrenko', ctx('Ivan\\nPetrenko'))).toBe('by [REDACTED]')
    expect(redactContacts('by Petrenko', ctx('Ivan\\nPetrenko'))).toBe('by [REDACTED]')
    // `nPetrenko` was the old part: the name no longer hides behind it
    expect(redactContacts('by nPetrenko', ctx('Ivan\\nPetrenko'))).toBe('by nPetrenko')
  })

  it('matches its own text, escaped or with a space', () => {
    expect(redactContacts('by Olena\\nKoval', ctx('Olena\\nKoval'))).toBe('by [REDACTED]')
    expect(redactContacts('by Olena Koval', ctx('Olena\\nKoval'))).toBe('by [REDACTED]')
    expect(scanContacts('by Olena\\nKoval', ctx('Olena\\nKoval'))).not.toEqual([])
    expect(completenessFlags('by Olena Koval', 'Olena\\nKoval')).toBe(true)
  })

  it('makes no part of a name that is only an escape, so a lone `n` is not redacted', () => {
    expect(redactContacts('n and n more', ctx('\\n'))).toBe('n and n more')
    expect(redactContacts('n and n more', ctx('\\n\\N'))).toBe('n and n more')
    expect(scanContacts('n and n more', ctx('\\n'))).toEqual([])
  })
})

describe('a bare backslash in a stored name (finding 7)', () => {
  it('redacts the surname of `Olena\\Koval` in its own text; the first name alone stays', () => {
    // accepted (Assumptions, round 3): the gap reads no bare backslash, and none is in a real name
    expect(redactContacts('by Olena\\Koval', ctx('Olena\\Koval'))).toBe('by Olena\\[REDACTED]')
    expect(redactContacts('by Olena Koval', ctx('Olena\\Koval'))).toBe('by [REDACTED]')
  })
})

describe('parts with no letter (SR-H-3) and part edges (finding 3)', () => {
  it('drops a part of spaced combining marks, so the real parts still match', () => {
    const name = ['Ivan', ...Array.from({ length: 8 }, () => '̈'), 'Petrenko'].join(' ')
    expect(contactNameParts(name)).toEqual([['Ivan', 'Petrenko']])
    expect(redactAll('by Ivan Petrenko', [ctx(name)])).toBe('by [REDACTED]')
    expect(redactAll(`Ivan${' '.repeat(40)}x`, [ctx(name)])).toBe(`Ivan${' '.repeat(40)}x`)
  })

  it('trims gap punctuation off a ZWSP-split part, so `a.` is the part `a`', () => {
    const name = ['Ivan', ...Array.from({ length: 8 }, () => 'a.'), 'Ba'].join('​')
    expect(contactNameParts(name).at(-1)).toEqual(['Ivan', ...Array(8).fill('a'), 'Ba'])
  })

  it('keeps a hyphenated surname one part, in its stored script and in Latin', () => {
    expect(redactContacts('by Ivan Petrenko-Kovalenko here', ctx('Ivan Petrenko-Kovalenko'))).toBe(
      'by [REDACTED] here',
    )
    expect(redactContacts('by Petrenko-Kovalenko here', ctx('Ivan Petrenko-Kovalenko'))).toBe(
      'by [REDACTED] here',
    )
    expect(redactContacts('by Ivan Petrenko-Kovalenko here', ctx('Іван Петренко-Коваленко'))).toBe(
      'by [REDACTED] here',
    )
    expect(redactContacts('by Petrenko-Kovalenko here', ctx('Іван Петренко-Коваленко'))).toBe(
      'by [REDACTED] here',
    )
  })
})

describe('the reading budget is decided per source (finding 5)', () => {
  // invented five-part legal name: the whole name is past the budget, each part is within it
  const name = "Андрій Юрійович Олексій Мар'ян Ковальський"

  it('keeps the full readings of a lone surname of a long name', () => {
    expect(nameReadingCount(name)).toBeGreaterThan(READING_BUDGET)
    expect(nameReadingCount('Ковальський')).toBeLessThanOrEqual(READING_BUDGET)
    // `Kovalskyi` is no national romanisation (`y` for `й`), so only the full readings hold it
    expect(redactContacts('by Kovalskyi today', ctx(name))).toBe('by [REDACTED] today')
    expect(redactContacts('by Kovalskyy today', ctx(name))).toBe('by [REDACTED] today')
  })

  it('reads the joined full name, past the budget, in its national romanisation only', () => {
    const full = 'Andrii Yuriiovych Oleksii Marian Kovalskyi'
    // the surname alone still redacts, so the tail goes: the first four parts stay as Latin text
    expect(redactContacts(`by ${full}`, ctx(name))).toBe(
      'by Andrii Yuriiovych Oleksii Marian [REDACTED]',
    )
    expect(redactContacts('by Andriy Yuriyovych Oleksiy Maryan Kovalskyy', ctx(name))).toBe(
      'by [REDACTED]',
    )
  })
})

describe('a contact the completeness check flags is one the API redacts (finding 9)', () => {
  it.each([
    '\\n\\n Ivan',
    'Ivan\\Petrov',
    'Ivan\\nPetrov',
    'Ivan＼Petrov',
    'Ivan ̈ Petrov',
    'Ivan a. Petrov',
    'Ivan​a.​Petrov',
    'Ivan Petrov-Koval',
  ])('stored %j: its own text and its parts', (stored) => {
    for (const text of [stored, 'by Ivan Petrov', 'by Petrov', 'by Ivan', 'by Koval']) {
      const flagged = completenessFlags(text, stored)
      const redacted = redactAll(text, [ctx(stored)])
      expect({ text, leaks: flagged && redacted === text }).toEqual({ text, leaks: false })
    }
  })
})
