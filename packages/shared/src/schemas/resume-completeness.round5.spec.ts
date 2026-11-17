/**
 * PR #1351 fix round 5: a Cyrillic stress mark is folded off (CR-H-1), completeness flags at least
 * what main flagged (SR-H-3), and a stored name split only by an invisible still reads as two parts.
 */
import { describe, expect, it } from 'vitest'
import type { ResumeFacts } from './resume-facts'
import { checkResumeCompleteness, contactNameParts, foldAccents } from './resume-completeness'

const FACTS: ResumeFacts = {
  headline: 'Senior Frontend Engineer',
  location: { city: 'Kyiv', country: 'Ukraine' },
  workFormat: 'remote',
  skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL'],
  experience: [],
  education: [],
  languages: [{ name: 'English', level: 'C1' }],
  links: [],
}

const flags = (text: string, displayName = 'Ivan Petrenko', telegram?: string) =>
  checkResumeCompleteness(
    { ...FACTS, headline: text },
    { displayName, telegram, now: new Date('2026-11-10T00:00:00Z') },
  ).some((issue) => issue.code === 'CONTACT_IN_TEXT')

describe('a Cyrillic stress mark is folded off (CR-H-1)', () => {
  // `е` + U+0301 has no precomposed form, so NFKC keeps the mark and only the fold drops it. The
  // texts hold none of `p`, `{`, `M`, `}`: the class read without its `u` flag would match those.
  it('foldAccents drops it', () => {
    expect(foldAccents('Петре\u0301нко').text).toBe('Петренко')
    expect(foldAccents('Ива\u0301н').text).toBe('Иван')
  })

  it('a name written with stress marks is flagged', () => {
    expect(flags('Senior Ива\u0301н Петре\u0301нко here', 'Иван Петренко')).toBe(true)
    expect(flags('Senior Иван Петре\u0301нко here', 'Иван Петренко')).toBe(true)
  })
})

describe('a bare mark at a name edge is flagged, as on main (SR-H-3)', () => {
  it.each([
    ['Ivan Petrenko\u0903x', 'Ivan Petrenko'],
    ['ivan PETRENKO\u0903x', 'Ivan Petrenko'],
    ['Senior\u0308Ivan Petrenko', 'Ivan Petrenko'],
    ['Ivan \uFEFFPetrenko\u0903é/', 'Ivan Petrenko'],
    ['Petrenko Ivan\u0903x', 'Ivan Petrenko'],
    ['Ivan Olegovych Petrenko\u0903x', 'Ivan Olegovych Petrenko'],
    ['Ivan Petrenko\u0903x', 'Ivan Olegovych Petrenko'],
    ['김 민준\u03017', '김 민준'],
    ['김민준\u03017', '김민준'],
  ])('flags %j for %j', (text, displayName) => {
    expect(flags(text, displayName)).toBe(true)
  })

  it.each([
    ['XIvan Petrenko\u0903', 'Ivan Petrenko'],
    ['Ivan Petrenkox\u0903', 'Ivan Petrenko'],
    ['Ivan\u0903', 'Ivan'],
    [' Petrenko', ' Ivan Petrenko'],
    ['Ivan Olegovych\u0903x', 'Ivan Olegovych Petrenko'],
  ])('does not flag %j for %j', (text, displayName) => {
    expect(flags(text, displayName)).toBe(false)
  })

  it('reads every apostrophe as the ASCII one, on both checks', () => {
    // the main-era check: the mark glues `x` to the name for the other one
    expect(flags('O’Neil Smith\u0903x', "O'Neil Smith")).toBe(true)
    // the boundary check: the invisible stands where main needed whitespace
    expect(flags('by O’Neil\u200BSmith today', "O'Neil Smith")).toBe(true)
    expect(flags("by O'Neil\u200BSmith today", 'O’Neil Smith')).toBe(true)
    // equal readings are one reading (round 6, CR-M-5)
    expect(contactNameParts('O’Neil  Smith')).toEqual([["O'Neil", 'Smith']])
  })

  it('flags the stored handle next to a character NFKC turns into a word character', () => {
    expect(flags('ping ivan_dev²', 'Mark Levin', 'ivan_dev')).toBe(true)
    expect(flags('ping IVAN_DEVｘ', 'Mark Levin', 'ivan_dev')).toBe(true)
    expect(flags('ping xivan_dev²', 'Mark Levin', 'ivan_dev')).toBe(false)
    expect(flags('ping ivan_dev²', 'Mark Levin')).toBe(false)
  })
})

describe('completeness flags at least what main flagged (SR-H-3)', () => {
  /** Main's name and handle checks (main @ 267885ded), copied: the reference head must cover. */
  const mainCheck = (displayName: string, handle: string) => {
    const normaliseName = (s: string) => s.normalize('NFC').replace(/[\u2019\u02BC]/g, "'")
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const tokens = normaliseName(displayName).split(/\s/).filter(Boolean).map(escape)
    const first = tokens[0] ?? ''
    const last = tokens.at(-1) ?? ''
    const name = new RegExp(
      `(?:^|[^\\p{L}\\p{N}])(?:${tokens.join('\\s+')}|${first}\\s+${last}|${last}\\s+${first})(?:$|[^\\p{L}\\p{N}])`,
      'iu',
    )
    const handleTest = new RegExp(`(?:^|\\W)@*${escape(handle)}(?:$|\\W)`, 'i')
    return (text: string) => {
      const nfc = text.normalize('NFC')
      return (tokens.length >= 2 && name.test(normaliseName(nfc))) || handleTest.test(nfc)
    }
  }
  /** mulberry32: a full-period PRNG, so every atom pair comes up. */
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  /** Spacing (Mc), enclosing (Me), non-composing and composing (Mn) and astral marks. */
  const BARE_MARKS = ['\u0903', '\u20DD', '\u05B0', '\u0301', '\u0308', '\u{1D167}']
  const EDGES = [' ', ',', 'x', '7', '가', '#', '\u200B', '\uFEFF', '²', ...BARE_MARKS]
  const NAME_GAPS = [' ', '\n', '\t', '  ']

  it.each([
    ['Latin', 'Ivan Petrenko', 1],
    ['Korean', '김 민준', 2],
    ['Cyrillic', 'Іван Петренко', 3],
  ] as const)(
    '%s: 10000 generated texts',
    (_label, fullName, seed) => {
      const random = prng(seed)
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
      const some = (list: readonly string[], max: number) =>
        Array.from({ length: Math.floor(random() * (max + 1)) }, () => pick(list)).join('')
      const mainFlags = mainCheck(fullName, 'ivan_dev')
      const missed: string[] = []
      let mainCount = 0
      for (let i = 0; i < 10000; i++) {
        const parts = fullName.split(' ')
        if (random() < 0.3) parts.reverse()
        const name = parts.join(pick(NAME_GAPS))
        const handle = random() < 0.4 ? `${some(EDGES, 2)}${random() < 0.5 ? '@' : ''}ivan_dev` : ''
        const text = `${some(EDGES, 3)}${name}${some(EDGES, 3)}${handle}${some(EDGES, 2)}`
        if (!mainFlags(text)) continue
        mainCount++
        if (!flags(text, fullName, 'ivan_dev')) missed.push(text)
      }
      expect({ missed: missed.length, sample: missed.slice(0, 3) }).toEqual({
        missed: 0,
        sample: [],
      })
      // main flags a good share, so the property is not vacuous
      expect(mainCount).toBeGreaterThan(2500)
    },
    30_000, // generous: the pre-push run shares the machine with the other suites
  )
})

describe('a stored name split only by an invisible (round 5, finding 3)', () => {
  it('is read both ways: joined after the strip, and split at the invisible', () => {
    expect(contactNameParts('Ivan\u200BPetrenko')).toEqual([['IvanPetrenko'], ['Ivan', 'Petrenko']])
    expect(contactNameParts('Iv\u200Can Petrenko')).toEqual([
      ['Ivan', 'Petrenko'],
      ['Iv', 'an', 'Petrenko'],
    ])
    expect(contactNameParts('  ')).toEqual([[]])
  })

  it.each(['\u200B', '\u2060', '\uFEFF', '\u00AD'])(
    'flags the name written with a space when it is stored with %j between the parts',
    (c) => {
      expect(flags('by Ivan Petrenko today', `Ivan${c}Petrenko`)).toBe(true)
      expect(flags('by Petrenko Ivan today', `Ivan${c}Petrenko`)).toBe(true)
      // glued, it is one token, as for a name stored with a space
      expect(flags('by IvanPetrenko today', `Ivan${c}Petrenko`)).toBe(false)
    },
  )

  it('an invisible inside a stored part still matches the part written whole', () => {
    expect(flags('by Ivan Petrenko today', 'Iv\u200Can Petrenko')).toBe(true)
    expect(flags('by Ivan today', 'Ivan\u200B')).toBe(false)
  })
})
