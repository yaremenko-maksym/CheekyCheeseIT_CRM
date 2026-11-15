/**
 * Contact scanner: zero-width / fullwidth normalisation (task 444) and year lists (task 445).
 */
import { checkResumeCompleteness, type ResumeFacts } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { redactContacts, scanContacts } from './contact-scan'

const ctx = {
  fullName: 'Mark Levin',
  emails: ['mark@example.com'],
  telegram: 'mark_dev',
}

describe('redactContacts and scanContacts — zero-width and fullwidth (Task 444 AC 2)', () => {
  it('redacts email with zero-width characters: j\\u200Bohn@x.com', () => {
    expect(redactContacts('j\u200Bohn@x.com', ctx)).toBe('[REDACTED]')
    expect(redactContacts('email: j\u200Bohn@x.com ok', ctx)).toBe('email: [REDACTED] ok')
  })

  it('redacts email with fullwidth characters: ｊｏｈｎ＠ｘ．ｃｏｍ', () => {
    expect(redactContacts('ｊｏｈｎ＠ｘ．ｃｏｍ', ctx)).toBe('[REDACTED]')
    expect(redactContacts('reach ｊｏｈｎ＠ｘ．ｃｏｍ now', ctx)).toBe('reach [REDACTED] now')
  })

  it('scans email with zero-width and fullwidth characters', () => {
    expect(scanContacts('j\u200Bohn@x.com', ctx)).toEqual([
      { kind: 'email', match: 'j\u200Bohn@x.com' },
    ])
    expect(scanContacts('ｊｏｈｎ＠ｘ．ｃｏｍ', ctx)).toEqual([
      { kind: 'email', match: 'ｊｏｈｎ＠ｘ．ｃｏｍ' },
    ])
  })

  it('returns plain text without contacts byte-identical', () => {
    const plain = 'Senior Frontend Engineer with 10 years experience'
    expect(redactContacts(plain, ctx)).toBe(plain)
    const emptyContacts = 'no contacts here'
    expect(redactContacts(emptyContacts, ctx)).toBe(emptyContacts)
  })
})

describe('redactContacts and scanContacts — year lists (Task 445 AC 3)', () => {
  it.each(['2019 · 2020 · 2021', '1999—2003—2007', '1999–2003–2007'])(
    'does not redact year lists: %s',
    (years) => {
      expect(redactContacts(`Active in ${years} on projects`, ctx)).toBe(
        `Active in ${years} on projects`,
      )
      expect(scanContacts(years, ctx)).toEqual([])
    },
  )

  it.each([
    ['+380 67 123 45 67', 'call [REDACTED]'],
    ['067-123-45-67', 'call [REDACTED]'],
  ])('still redacts real phone numbers: %s', (phone, expected) => {
    expect(redactContacts(`call ${phone}`, ctx)).toBe(expected)
    expect(scanContacts(`call ${phone}`, ctx)).toEqual([{ kind: 'phone', match: phone }])
  })
})

/** A name, written the same odd way in the context and in the text (PR #1351 fix round 1, finding 1). */
const ODD_NAMES = ['Ana Griﬃn', 'Ana Mar‌ia', 'Ａｎａ Ｇｒｉｆｆｉｎ', '가나']

describe('context values are normalised like the text (PR #1351 finding 1)', () => {
  it.each(ODD_NAMES)('redacts the full name %j written the same way in the text', (fullName) => {
    expect(redactContacts(`written by ${fullName} today`, { fullName, emails: [] })).toBe(
      'written by [REDACTED] today',
    )
    expect(scanContacts(`by ${fullName}`, { fullName, emails: [] })).toEqual([
      { kind: 'name', match: fullName },
    ])
  })

  it('redacts a literal email with a ligature that the generic email pattern does not match', () => {
    expect(redactContacts('mail ana@ﬁrm now', { fullName: '', emails: ['ana@ﬁrm'] })).toBe(
      'mail [REDACTED] now',
    )
  })

  it('redacts the Telegram handle stored in fullwidth forms', () => {
    expect(
      redactContacts('ping mark_dev now', {
        fullName: '',
        emails: [],
        telegram: 'ｍａｒｋ＿ｄｅｖ',
      }),
    ).toBe('ping [REDACTED] now')
  })

  it('redacts name 가나 written as jamo in the text, stored precomposed (and the reverse)', () => {
    expect(
      redactContacts('by \u1100\u1161\u1102\u1161 today', { fullName: '가나', emails: [] }),
    ).toBe('by [REDACTED] today')
    expect(
      scanContacts('by \u1100\u1161\u1102\u1161 today', { fullName: '가나', emails: [] }),
    ).toEqual([{ kind: 'name', match: '가나' }])
    expect(
      redactContacts('by 가나 today', { fullName: '\u1100\u1161\u1102\u1161', emails: [] }),
    ).toBe('by [REDACTED] today')
    expect(
      scanContacts('by 가나 today', { fullName: '\u1100\u1161\u1102\u1161', emails: [] }),
    ).toEqual([{ kind: 'name', match: '가나' }])
  })
})

/** Invisible characters outside `\p{Cf}`: variation selectors, CGJ, Mongolian FVS, Hangul fillers (finding 2). */
const IGNORABLES = ['︀', '️', '͏', '᠋', '᠌', '᠍', 'ㅤ', 'ﾠ']

describe('default-ignorable characters do not split a contact (PR #1351 finding 2)', () => {
  it.each(IGNORABLES.map((c) => [c.codePointAt(0)?.toString(16), c]))(
    'redacts a phone split by U+%s',
    (_code, c) => {
      expect(redactContacts(`call 067${c}123${c}4567 now`, ctx)).toBe('call [REDACTED] now')
    },
  )

  it('redacts a phone split by Braille pattern blank (U+2800): 067\u28001234567', () => {
    expect(redactContacts('call 067\u28001234567 now', ctx)).toBe('call [REDACTED] now')
    expect(scanContacts('call 067\u28001234567 now', ctx)).toEqual([
      { kind: 'phone', match: '067\u28001234567' },
    ])
  })
})

describe('redactContacts output is always NFC (PR #1351 finding 3)', () => {
  it('composes a decomposed letter outside a redacted phone', () => {
    expect(redactContacts('Café call 0671234567', ctx)).toBe('Café call [REDACTED]')
  })
})

describe('flagged implies redacted, redaction is final and idempotent (PR #1351)', () => {
  const FACTS: ResumeFacts = {
    headline: 'Senior Frontend Engineer',
    location: { city: 'Kyiv', country: 'Ukraine' },
    workFormat: 'remote',
    skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL'],
    experience: [],
    education: [],
    languages: [],
    links: [],
  }
  const now = new Date('2026-11-10T00:00:00Z')
  const flagged = (text: string, fullName: string, telegram: string) =>
    checkResumeCompleteness(
      { ...FACTS, headline: text },
      { displayName: fullName, telegram, now },
    ).some((issue) => issue.code === 'CONTACT_IN_TEXT')

  const TRICKY = [
    ...ODD_NAMES.map((name) => `by ${name}`),
    ...IGNORABLES.map((c) => `call 067${c}123${c}4567`),
    'call 067\u28001234567',
    'by \u1100\u1161\u1102\u1161',
    'j​ohn@x.com',
    'ｊｏｈｎ＠ｘ．ｃｏｍ',
    'see github.com​/repo',
    'ping ｍａｒｋ＿ｄｅｖ',
    'tg: @mark_dev',
    'Café call 0671234567',
    'Марк Levin, +380 67 123 45 67',
    'Ana Griffin ｇｉｔｈｕｂ．ｃｏｍ／ana',
    '2019 · 2020 · 2021',
    'Senior Frontend Engineer',
  ]
  const contexts = ODD_NAMES.map((fullName) => ({ fullName, emails: [], telegram: 'mark_dev' }))

  it.each(TRICKY)('holds for %j', (text) => {
    for (const c of contexts) {
      const once = redactContacts(text, c)
      // flagged implies redacted
      expect(flagged(text, c.fullName, c.telegram) && !once.includes('[REDACTED]')).toBe(false)
      expect(flagged(once, c.fullName, c.telegram)).toBe(false)
      expect(redactContacts(once, c)).toBe(once)
    }
  })
})
