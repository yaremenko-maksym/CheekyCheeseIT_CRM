/**
 * Contact scanner: zero-width / fullwidth normalisation (task 444) and year lists (task 445).
 */
import { checkResumeCompleteness, normaliseContactText, type ResumeFacts } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { redactContacts, scanContacts } from './contact-scan'

const ctx = {
  fullName: 'Mark Levin',
  emails: ['mark@example.com'],
  telegram: 'mark_dev',
}

describe('redactContacts and scanContacts \u{2014} zero-width and fullwidth (Task 444 AC 2)', () => {
  it('redacts email with zero-width characters: j\\u200Bohn@x.com', () => {
    expect(redactContacts('j\u200Bohn@x.com', ctx)).toBe('[REDACTED]')
    expect(redactContacts('email: j\u200Bohn@x.com ok', ctx)).toBe('email: [REDACTED] ok')
  })

  it('redacts email with fullwidth characters: \u{FF4A}\u{FF4F}\u{FF48}\u{FF4E}\u{FF20}\u{FF58}\u{FF0E}\u{FF43}\u{FF4F}\u{FF4D}', () => {
    expect(
      redactContacts(
        '\u{FF4A}\u{FF4F}\u{FF48}\u{FF4E}\u{FF20}\u{FF58}\u{FF0E}\u{FF43}\u{FF4F}\u{FF4D}',
        ctx,
      ),
    ).toBe('[REDACTED]')
    expect(
      redactContacts(
        'reach \u{FF4A}\u{FF4F}\u{FF48}\u{FF4E}\u{FF20}\u{FF58}\u{FF0E}\u{FF43}\u{FF4F}\u{FF4D} now',
        ctx,
      ),
    ).toBe('reach [REDACTED] now')
  })

  it('scans email with zero-width and fullwidth characters', () => {
    expect(scanContacts('j\u200Bohn@x.com', ctx)).toEqual([
      { kind: 'email', match: 'j\u200Bohn@x.com' },
    ])
    expect(
      scanContacts(
        '\u{FF4A}\u{FF4F}\u{FF48}\u{FF4E}\u{FF20}\u{FF58}\u{FF0E}\u{FF43}\u{FF4F}\u{FF4D}',
        ctx,
      ),
    ).toEqual([
      {
        kind: 'email',
        match: '\u{FF4A}\u{FF4F}\u{FF48}\u{FF4E}\u{FF20}\u{FF58}\u{FF0E}\u{FF43}\u{FF4F}\u{FF4D}',
      },
    ])
  })

  it('returns plain text without contacts byte-identical', () => {
    const plain = 'Senior Frontend Engineer with 10 years experience'
    expect(redactContacts(plain, ctx)).toBe(plain)
    const emptyContacts = 'no contacts here'
    expect(redactContacts(emptyContacts, ctx)).toBe(emptyContacts)
  })
})

describe('redactContacts and scanContacts \u{2014} year lists (Task 445 AC 3)', () => {
  it.each([
    '2019 \u{00B7} 2020 \u{00B7} 2021',
    '1999\u{2014}2003\u{2014}2007',
    '1999\u{2013}2003\u{2013}2007',
  ])('does not redact year lists: %s', (years) => {
    expect(redactContacts(`Active in ${years} on projects`, ctx)).toBe(
      `Active in ${years} on projects`,
    )
    expect(scanContacts(years, ctx)).toEqual([])
  })

  it.each([
    ['+380 67 123 45 67', 'call [REDACTED]'],
    ['067-123-45-67', 'call [REDACTED]'],
  ])('still redacts real phone numbers: %s', (phone, expected) => {
    expect(redactContacts(`call ${phone}`, ctx)).toBe(expected)
    expect(scanContacts(`call ${phone}`, ctx)).toEqual([{ kind: 'phone', match: phone }])
  })
})

/** A name, written the same odd way in the context and in the text (PR #1351 fix round 1, finding 1). */
const ODD_NAMES = [
  'Ana Gri\u{FB03}n',
  'Ana Mar\u200Cia',
  '\u{FF21}\u{FF4E}\u{FF41} \u{FF27}\u{FF52}\u{FF49}\u{FF46}\u{FF46}\u{FF49}\u{FF4E}',
  '\u{AC00}\u{B098}',
]

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
    expect(
      redactContacts('mail ana@\u{FB01}rm now', { fullName: '', emails: ['ana@\u{FB01}rm'] }),
    ).toBe('mail [REDACTED] now')
  })

  it('redacts the Telegram handle stored in fullwidth forms', () => {
    expect(
      redactContacts('ping mark_dev now', {
        fullName: '',
        emails: [],
        telegram: '\u{FF4D}\u{FF41}\u{FF52}\u{FF4B}\u{FF3F}\u{FF44}\u{FF45}\u{FF56}',
      }),
    ).toBe('ping [REDACTED] now')
  })

  it('redacts name \u{AC00}\u{B098} written as jamo in the text, stored precomposed (and the reverse)', () => {
    expect(
      redactContacts('by \u1100\u1161\u1102\u1161 today', {
        fullName: '\u{AC00}\u{B098}',
        emails: [],
      }),
    ).toBe('by [REDACTED] today')
    expect(
      scanContacts('by \u1100\u1161\u1102\u1161 today', {
        fullName: '\u{AC00}\u{B098}',
        emails: [],
      }),
    ).toEqual([{ kind: 'name', match: '\u{AC00}\u{B098}' }])
    expect(
      redactContacts('by \u{AC00}\u{B098} today', {
        fullName: '\u1100\u1161\u1102\u1161',
        emails: [],
      }),
    ).toBe('by [REDACTED] today')
    expect(
      scanContacts('by \u{AC00}\u{B098} today', {
        fullName: '\u1100\u1161\u1102\u1161',
        emails: [],
      }),
    ).toEqual([{ kind: 'name', match: '\u{AC00}\u{B098}' }])
  })
})

/** Invisible characters outside `\p{Cf}`: variation selectors, CGJ, Mongolian FVS, Hangul fillers (finding 2). */
const IGNORABLES = ['\uFE00', '\uFE0F', '\u034F', '\u180B', '\u180C', '\u180D', '\u3164', '\uFFA0']

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
    expect(redactContacts('Cafe\u0301 call 0671234567', ctx)).toBe('Caf\u{00E9} call [REDACTED]')
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
    'j\u200Bohn@x.com',
    '\u{FF4A}\u{FF4F}\u{FF48}\u{FF4E}\u{FF20}\u{FF58}\u{FF0E}\u{FF43}\u{FF4F}\u{FF4D}',
    'see github.com\u200B/repo',
    'ping \u{FF4D}\u{FF41}\u{FF52}\u{FF4B}\u{FF3F}\u{FF44}\u{FF45}\u{FF56}',
    'tg: @mark_dev',
    'Cafe\u0301 call 0671234567',
    '\u{041C}\u{0430}\u{0440}\u{043A} Levin, +380 67 123 45 67',
    'Ana Griffin \u{FF47}\u{FF49}\u{FF54}\u{FF48}\u{FF55}\u{FF42}\u{FF0E}\u{FF43}\u{FF4F}\u{FF4D}\u{FF0F}ana',
    '2019 \u{00B7} 2020 \u{00B7} 2021',
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

describe('a stripped invisible is a token boundary (PR #1351 round 3, SR-H-1)', () => {
  const ivan = { fullName: 'Ivan Petrenko', emails: [], telegram: '@ivan_dev' }

  it.each(['\u200B', '\u2060', '\uFEFF', '\u00AD', '\u2800'].map((c) => [c.codePointAt(0), c]))(
    'redacts the name glued to the next word by code point %i',
    (_code, c) => {
      expect(redactContacts(`Ivan Petrenko${c}Senior`, ivan)).toBe(`[REDACTED]${c}Senior`)
    },
  )

  it.each([
    ['1\u200BPetrenko', '1\u200B[REDACTED]'],
    ['0671234567\u200BIvan Petrenko', '[REDACTED]\u200B[REDACTED]'],
    ['@ivan_dev\u200Bsenior', '[REDACTED]\u200Bsenior'],
    ['by Iv\u200Can Petrenko', 'by [REDACTED]'],
    ['by Iv\u200Can Petrenko\u200BSenior', 'by [REDACTED]\u200BSenior'],
    ['Ivan PetrenkoSenior', 'Ivan PetrenkoSenior'],
  ])('redacts %j as %j', (text, redacted) => {
    expect(redactContacts(text, ivan)).toBe(redacted)
  })

  it('redacts a jamo-written name with an invisible inside the run (CR-L-2)', () => {
    const gana = { fullName: '\u{AC00}\u{B098}', emails: [] }
    expect(redactContacts('by \u1100\u1161\u200D\u1102\u1161 today', gana)).toBe(
      'by [REDACTED] today',
    )
  })
})

describe('completeness flags exactly the names the API redacts, a bare mark included (PR #1351 rounds 3, 5 and 6, SR-M-1, SR-H-3, CR-M-4)', () => {
  const FACTS: ResumeFacts = {
    headline: '',
    location: { city: 'Kyiv', country: 'Ukraine' },
    workFormat: 'remote',
    skills: [],
    experience: [],
    education: [],
    languages: [],
    links: [],
  }
  const now = new Date('2026-11-10T00:00:00Z')
  const flagged = (text: string, displayName: string) =>
    checkResumeCompleteness({ ...FACTS, headline: text }, { displayName, now }).some(
      (issue) => issue.code === 'CONTACT_IN_TEXT',
    )
  /** mulberry32: a full-period PRNG, so every atom pair comes up (an LCG's low bits cycle). */
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  // No `@` or `.`, and too few digits for a phone: only the name can flag or redact.
  const ATOMS = ['a', 'Z', '\u{AC00}', '7', '#', '+', ' ', '-', ',', '\u0301', '\u0903', '\\n']
  const INVISIBLES = ['\u200B', '\u2060', '\uFEFF', '\u00AD', '\u2800', '\u200C']
  const INSIDE = ['', '', '\u200C', '\u200B', '\u2800']

  it.each([
    ['\u{AE40}\u{BBFC}\u{C900}', 1],
    ['\u{AE40} \u{BBFC}\u{C900}', 2],
    ['Ivan Petrenko', 3],
  ] as const)('for %j over 5000 generated texts', (fullName, seed) => {
    const random = prng(seed)
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
    const atoms = () =>
      Array.from({ length: Math.floor(random() * 4) }, () => pick([...ATOMS, ...INVISIBLES])).join(
        '',
      )
    const parts = fullName.split(' ')
    // an invisible as the only gap between the parts gives the SR-M-4 shape with a bare-mark atom
    // after it (`Ivan`, ZWSP, `Petrenko`, U+0903, `x`), round 7 SPEC-L-2
    const BETWEEN = [' ', ' ', '\u200B', '\u2060']
    const firstToken = parts[0] ?? ''
    let flaggedCount = 0
    let shapeCount = 0
    for (let i = 0; i < 5000; i++) {
      const gap = pick(BETWEEN)
      // an invisible inside each token of two letters or more, at an interior position
      const rendered = parts
        .map((part) => {
          const at = 1 + Math.floor(random() * (part.length - 1))
          return part.length > 1 ? part.slice(0, at) + pick(INSIDE) + part.slice(at) : part
        })
        .join(gap)
      const after = atoms()
      const text = `${atoms()}${rendered}${after}`
      if (gap !== ' ' && after.startsWith('\u0903')) shapeCount++
      const flags = flagged(text, fullName)
      if (flags) flaggedCount++
      // Completeness flags exactly the texts whose full name the API redacts (its first token goes;
      // for one token the full name is the surname, so any redaction is the full name). A bare mark
      // next to the name (U+0301, U+0903) is an edge on both sides since round 6 (SR-M-4, CR-M-4).
      const fullNameRedacted = (input: string) => {
        const redacted = redactContacts(input, { fullName, emails: [] })
        return parts.length === 1
          ? redacted.includes('[REDACTED]')
          : !normaliseContactText(redacted).text.includes(firstToken)
      }
      // Since backlog 453d the redaction alone reads a digit as an edge (`7Ivan Petrenko`), so the
      // exact match holds with the digit read as a letter (`q`: no mark composes with it), and on
      // the text itself the redaction takes every name completeness flags.
      expect([text, flags]).toEqual([text, fullNameRedacted(text.replaceAll('7', 'q'))])
      expect([text, !flags || fullNameRedacted(text)]).toEqual([text, true])
    }
    // both outcomes come up, so the property is not vacuous
    expect(flaggedCount).toBeGreaterThan(500)
    expect(flaggedCount).toBeLessThan(4500)
    // an invisible gap with a bare mark after the name comes up for every name of two parts
    expect(shapeCount).toBeGreaterThan(parts.length > 1 ? 20 : -1)
  })
})
