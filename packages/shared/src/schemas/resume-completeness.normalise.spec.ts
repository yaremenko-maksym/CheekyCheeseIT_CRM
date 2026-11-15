/**
 * Contact scanner: zero-width / fullwidth normalisation (task 444) and year lists (task 445).
 */
import { describe, expect, it } from 'vitest'
import type { ResumeFacts } from './resume-facts'
import {
  checkResumeCompleteness,
  findPhoneSpans,
  normaliseContactText,
} from './resume-completeness'

const NOW = new Date('2026-11-10T00:00:00Z')
const FACTS: ResumeFacts = {
  headline: 'Senior Frontend Engineer',
  location: { city: 'Kyiv', country: 'Ukraine' },
  workFormat: 'remote',
  skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL'],
  experience: [
    {
      company: 'Acme',
      role: 'Engineer',
      location: 'Kyiv',
      start: '2020-01',
      end: '2023-06',
      current: false,
      technologies: ['React'],
      notes: ['Built the design system'],
    },
  ],
  education: [{ institution: 'KPI', degree: 'BSc', startYear: 2015, endYear: 2019 }],
  languages: [{ name: 'English', level: 'C1' }],
  links: [],
}

const noteIssues = (note: string) =>
  checkResumeCompleteness(
    { ...FACTS, experience: FACTS.experience.map((e) => ({ ...e, notes: [note] })) },
    { displayName: 'Mark Levin', now: NOW },
  ).filter((i) => i.code === 'CONTACT_IN_TEXT')

describe('normaliseContactText (Task 444)', () => {
  it('normalises fullwidth Latin characters, @ and dots to ASCII', () => {
    const res = normaliseContactText('ｊｏｈｎ＠ｘ．ｃｏｍ')
    expect(res.text).toBe('john@x.com')
    expect(res.from).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(res.to).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('strips zero-width characters (\\p{Cf}) and maps offsets back to the original text', () => {
    const input = 'j\u200Bohn@x.com'
    const res = normaliseContactText(input)
    expect(res.text).toBe('john@x.com')
    // 'j' at 0..1, 'o' at 2..3
    expect(res.from[0]).toBe(0)
    expect(res.to[0]).toBe(1)
    expect(res.from[1]).toBe(2)
    expect(res.to[res.to.length - 1]).toBe(input.length)
  })

  it('strips other format characters (U+200C, U+200D, U+2060, U+FEFF, U+00AD)', () => {
    const input = 'a\u200Cb\u200Dc\u2060d\uFEFFe\u00ADf'
    const res = normaliseContactText(input)
    expect(res.text).toBe('abcdef')
    expect(res.from).toEqual([0, 2, 4, 6, 8, 10])
    expect(res.to).toEqual([1, 3, 5, 7, 9, 11])
  })

  it('handles expanding ligatures and multi-code-unit characters', () => {
    const input = 'ﬀ'
    const res = normaliseContactText(input)
    expect(res.text).toBe('ff')
    expect(res.from).toEqual([0, 0])
    expect(res.to).toEqual([1, 1])
  })

  it('handles isolated combining marks at the start of text', () => {
    const res = normaliseContactText('\u0301hello')
    expect(res.text).toBe('\u0301hello')
    expect(res.from[0]).toBe(0)
    expect(res.to[0]).toBe(1)
  })
})

describe('checkResumeCompleteness — zero-width and fullwidth contacts (Task 444 AC 2)', () => {
  it('flags an email containing a zero-width space: j\\u200Bohn@x.com', () => {
    expect(noteIssues('reach me at j\u200Bohn@x.com')).toEqual([
      { path: 'experience.0.notes.0', code: 'CONTACT_IN_TEXT' },
    ])
  })

  it('flags an email written in fullwidth forms: ｊｏｈｎ＠ｘ．ｃｏｍ', () => {
    expect(noteIssues('reach me at ｊｏｈｎ＠ｘ．ｃｏｍ')).toEqual([
      { path: 'experience.0.notes.0', code: 'CONTACT_IN_TEXT' },
    ])
  })

  it('flags a URL with fullwidth slash and zero-width chars', () => {
    expect(noteIssues('see github.com\u200B/repo')).toEqual([
      { path: 'experience.0.notes.0', code: 'CONTACT_IN_TEXT' },
    ])
  })
})

describe('findPhoneSpans — year lists (Task 445 AC 3)', () => {
  it.each(['2019 · 2020 · 2021', '1999—2003—2007', '1999–2003–2007', '1950 · 2000 · 2099'])(
    'does not report year list: %s',
    (text) => {
      expect(findPhoneSpans(text)).toEqual([])
      expect(noteIssues(`Projects: ${text}`)).toEqual([])
    },
  )

  it.each([
    ['+380 67 123 45 67', 1],
    ['067-123-45-67', 1],
    ['+1999 2003 2007', 1],
    ['1949 · 2000 · 2021', 1],
    ['2000 · 2021 · 2100', 1],
    ['2019 · 2020 · 20210', 1],
    ['2019 · 202 · 2021', 1],
    ['01999 · 2003 · 2007', 1],
  ])('still reports real phone or out-of-range candidate: %s', (text, count) => {
    expect(findPhoneSpans(text)).toHaveLength(count)
    expect(noteIssues(`Call: ${text}`)).toEqual([
      { path: 'experience.0.notes.0', code: 'CONTACT_IN_TEXT' },
    ])
  })
})
