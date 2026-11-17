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

const issuesFor = (note: string, displayName: string, telegram?: string) =>
  checkResumeCompleteness(
    { ...FACTS, experience: FACTS.experience.map((e) => ({ ...e, notes: [note] })) },
    { displayName, telegram, now: NOW },
  ).filter((i) => i.code === 'CONTACT_IN_TEXT')

const FLAGGED = [{ path: 'experience.0.notes.0', code: 'CONTACT_IN_TEXT' }]

describe('checkResumeCompleteness — context values normalised like the text (PR #1351 finding 1)', () => {
  it.each(['Ana Griﬃn', 'Ana Mar\u200Cia', 'Ａｎａ Ｇｒｉｆｆｉｎ'])(
    'flags the full name %j written the same way in the text',
    (name) => {
      expect(issuesFor(`written by ${name} today`, name)).toEqual(FLAGGED)
    },
  )

  it('flags the Telegram handle stored in fullwidth forms', () => {
    expect(issuesFor('ping mark_dev now', 'Mark Levin', 'ｍａｒｋ＿ｄｅｖ')).toEqual(FLAGGED)
  })
})

describe('normaliseContactText — default-ignorable characters (PR #1351 finding 2)', () => {
  it.each(['\uFE00', '\uFE0F', '\u034F', '\u180B', '\u180C', '\u180D', '\u3164', '\uFFA0'])(
    'strips %j inside a phone, which is then flagged',
    (c) => {
      const input = `067${c}123${c}4567`
      const res = normaliseContactText(input)
      expect(res.text).toBe('0671234567')
      expect(res.to[res.to.length - 1]).toBe(input.length)
      expect(noteIssues(`call ${input}`)).toEqual(FLAGGED)
    },
  )

  it('lets a base letter compose with a mark across a stripped CGJ, mapped to the whole cluster', () => {
    const res = normaliseContactText('xe\u034F\u0301y')
    expect(res.text).toBe('xéy')
    expect(res.from).toEqual([0, 1, 4])
    expect(res.to).toEqual([1, 4, 5])
  })

  it('leaves no orphan cluster for a stripped variation selector', () => {
    const res = normaliseContactText('1\uFE0F2')
    expect(res.text).toBe('12')
    expect(res.from).toEqual([0, 2])
    expect(res.to).toEqual([2, 3])
  })

  it('still strips a format character that is not default-ignorable (U+0600)', () => {
    expect(normaliseContactText('a\u0600b').text).toBe('ab')
  })

  it('maps nothing to invisible characters at the edges', () => {
    const res = normaliseContactText('\u200Bab\u200B')
    expect(res.text).toBe('ab')
    expect(res.from).toEqual([1, 2])
    expect(res.to).toEqual([2, 3])
  })

  it('strips Braille pattern blank (U+2800) inside a phone: 067\u28001234567, which is then flagged', () => {
    const input = '067\u28001234567'
    const res = normaliseContactText(input)
    expect(res.text).toBe('0671234567')
    expect(res.to[res.to.length - 1]).toBe(input.length)
    expect(noteIssues(`call ${input}`)).toEqual(FLAGGED)
  })

  it('composes a run of conjoining Hangul jamo (U+1100-11FF) as one cluster into precomposed syllables', () => {
    const res = normaliseContactText('\u1100\u1161\u1102\u1161')
    expect(res.text).toBe('가나')
    expect(res.from).toEqual([0, 0])
    expect(res.to).toEqual([4, 4])
  })

  it('flags Korean name 가나 written as jamo in the text, stored precomposed (and the reverse)', () => {
    expect(issuesFor('written by \u1100\u1161\u1102\u1161 today', '가나')).toEqual(FLAGGED)
    expect(issuesFor('written by 가나 today', '\u1100\u1161\u1102\u1161')).toEqual(FLAGGED)
    expect(issuesFor('written by \u1100\u1161 \u1102\u1161 today', '가 나')).toEqual(FLAGGED)
    expect(issuesFor('written by 가 나 today', '\u1100\u1161 \u1102\u1161')).toEqual(FLAGGED)
    // Anchors and length boundary: non-Hangul or single syllable does not match
    expect(issuesFor('written by x가나 today', 'x가나')).toEqual([])
    expect(issuesFor('written by 가나x today', '가나x')).toEqual([])
    expect(issuesFor('written by 가 today', '가')).toEqual([])
  })
})
