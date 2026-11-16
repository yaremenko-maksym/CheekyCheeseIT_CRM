/**
 * PR #1351 fix round 3: a stripped invisible is a token boundary (SR-H-1), one name and handle
 * boundary shared with the API redaction (SR-M-1), the single-token Hangul rule (CR-M-1), and
 * invisibles inside a jamo run (CR-L-2).
 */
import { describe, expect, it } from 'vitest'
import type { ResumeFacts } from './resume-facts'
import {
  checkResumeCompleteness,
  findWholeTokens,
  foldAccents,
  normaliseContactText,
} from './resume-completeness'

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

const INVISIBLES = ['\u200B', '\u2060', '\uFEFF', '\u00AD', '\u2800']

describe('a stripped invisible is a token boundary (SR-H-1)', () => {
  it.each(INVISIBLES.map((c) => [c.codePointAt(0)?.toString(16), c]))(
    'flags the name glued to the next word by U+%s',
    (_code, c) => {
      expect(flags(`Ivan Petrenko${c}Senior developer`)).toBe(true)
    },
  )

  it('flags the name after a digit and an invisible: 1\\u200BIvan Petrenko', () => {
    expect(flags('1\u200BIvan Petrenko')).toBe(true)
  })

  it('flags the full name after a letter and an invisible', () => {
    expect(flags('x\u200BIvan Petrenko')).toBe(true)
  })

  it('flags the stored handle glued to the next word: @ivan_dev\\u200Bsenior', () => {
    expect(flags('ping @ivan_dev\u200Bsenior', 'Mark Levin', '@ivan_dev')).toBe(true)
    expect(flags('ping ivan_dev\u200B', 'Mark Levin', '@ivan_dev')).toBe(true)
  })

  it('still matches a name with an invisible inside it: Iv\\u200Can', () => {
    expect(flags('by Iv\u200Can Petrenko')).toBe(true)
    expect(flags('by Iv\u200Can Petrenko\u200BSenior')).toBe(true)
  })

  it('without an invisible the glued name is not a token', () => {
    expect(flags('Ivan PetrenkoSenior')).toBe(false)
    expect(flags('xIvan Petrenko')).toBe(false)
    expect(flags('ping ivan_devsenior', 'Mark Levin', '@ivan_dev')).toBe(false)
  })

  it('no stored handle adds no handle check', () => {
    expect(flags('null pointer', 'Mark Levin')).toBe(false)
  })
})

describe('normaliseContactText gaps', () => {
  it('records a gap where stripped characters sat between clusters, once per run', () => {
    expect([...normaliseContactText('ab\u200B\u2060cd\u200B').gaps]).toEqual([2])
    expect([...normaliseContactText('abcd').gaps]).toEqual([])
  })

  it('records no gap inside a composed character', () => {
    // e, ZWJ, acute compose into one letter, with a gap after it (round 4, SR-H-2); \u1100, ZWSP, \u1161
    // into one syllable
    expect(normaliseContactText('xe\u200D\u0301y')).toMatchObject({
      text: 'xéy',
      gaps: new Set([2]),
    })
    expect(normaliseContactText('\u1100\u200B\u1161')).toMatchObject({
      text: '가',
      gaps: new Set(),
    })
  })

  it('a gap after a syllable composed across an earlier invisible still counts', () => {
    // the first ZWSP is inside the syllable, the second between the syllables
    expect([...normaliseContactText('\u1100\u200B\u1161\u200B\u1102\u1161').gaps]).toEqual([1])
  })

  it('a jamo run does not reach over a visible character', () => {
    expect(normaliseContactText('\u1100x\u1161')).toMatchObject({
      text: '\u1100x\u1161',
      from: [0, 1, 2],
      to: [1, 2, 3],
    })
  })

  it('records a gap between two syllables of one jamo run', () => {
    expect(normaliseContactText('\u1100\u1161\u200B\u1102\u1161')).toMatchObject({
      text: '가나',
      gaps: new Set([1]),
    })
  })
})

describe('foldAccents', () => {
  it('folds accents and carries gaps to the folded offsets', () => {
    expect(foldAccents('Wałęsa', new Set([1, 3]))).toMatchObject({
      text: 'Walesa',
      gaps: new Set([1, 3]),
    })
    expect(foldAccents('ßa', new Set([1]))).toMatchObject({ text: 'ssa', gaps: new Set([2]) })
    expect(foldAccents('é')).toMatchObject({ text: 'e', from: [0], to: [1], gaps: new Set() })
  })

  it('folds by hand the letters NFD does not decompose', () => {
    expect(foldAccents('łŁøØđĐßẞıæÆœŒþÞħĦ').text).toBe('lLoOdDssSSiaeAEoeOEthTHhH')
  })
})

describe('findWholeTokens', () => {
  const none = new Set<number>()
  it('finds whole tokens only, any case', () => {
    expect(findWholeTokens('ivan, IVAN Ivanov xivan', none, 'ivan', 'name')).toEqual([
      { start: 0, end: 4 },
      { start: 6, end: 10 },
    ])
  })

  it('counts a gap as a boundary at either edge, and digits as token characters', () => {
    expect(findWholeTokens('xivany', new Set([1]), 'ivan', 'name')).toEqual([])
    expect(findWholeTokens('xivany', new Set([1, 5]), 'ivan', 'name')).toEqual([
      { start: 1, end: 5 },
    ])
    expect(findWholeTokens('7ivan ivan7', none, 'ivan', 'name')).toEqual([])
  })

  it('treats # and + as boundaries for a name, letters 6 back do not count', () => {
    expect(findWholeTokens('#ivan+ abcde ivan', none, 'ivan', 'name')).toEqual([
      { start: 1, end: 5 },
      { start: 13, end: 17 },
    ])
  })

  it('lets a name start right after a JSON escape, not after another backslash pair', () => {
    expect(findWholeTokens('\\nivan', none, 'ivan', 'name')).toEqual([{ start: 2, end: 6 }])
    expect(findWholeTokens('\\u00e9ivan', none, 'ivan', 'name')).toEqual([{ start: 6, end: 10 }])
    expect(findWholeTokens('\\xivan \\u00eivan', none, 'ivan', 'name')).toEqual([])
    expect(findWholeTokens('\\nivan_dev', none, 'ivan_dev', 'handle')).toEqual([])
  })

  it('uses \\w as the handle boundary', () => {
    expect(findWholeTokens('x@ivan_dev #ivan_dev ivan_dev_', none, '@*ivan_dev', 'handle')).toEqual(
      [
        { start: 2, end: 10 },
        { start: 12, end: 20 },
      ],
    )
  })

  it('a hit refused at its edges does not hide an overlapping one', () => {
    expect(findWholeTokens('xana ana ana', none, 'ana ana', 'name')).toEqual([
      { start: 5, end: 12 },
    ])
  })

  it('steps over an astral character at a refused hit', () => {
    expect(findWholeTokens('x𠮷野 𠮷野', none, '𠮷野', 'name')).toEqual([{ start: 5, end: 8 }])
    // U+10000, the first astral code point, is a letter too
    expect(findWholeTokens('x\u{10000}a \u{10000}a', none, '\u{10000}a', 'name')).toEqual([
      { start: 5, end: 8 },
    ])
  })
})

describe('one boundary with the API redaction (SR-M-1)', () => {
  // `김민준`, acute, `7` is flagged too since round 5 (SR-H-3): the redaction misses it, and the
  // check main had reads the mark as an edge, so Submit refuses it, as on main.
  it.each(['+김민준', '김민준#', '김민준\u03017', 'Ivan Petrenko#', '#Petrenko Ivan'])(
    'flags %j',
    (text) => {
      const name = text.includes('김') ? '김민준' : 'Ivan Petrenko'
      expect(flags(text, name)).toBe(true)
    },
  )

  it('matches names accent-folded, as the API does', () => {
    expect(flags('by Ivan Petrénko')).toBe(true)
    expect(flags('by Ivan Petrenko', 'Ivan Petrénko')).toBe(true)
  })

  it('accepts a JSON-escaped gap between the name parts', () => {
    expect(flags('by Ivan\\nPetrenko')).toBe(true)
  })
})

describe('a single-token name (CR-M-1)', () => {
  it('is name-checked when it is two or more precomposed Hangul syllables', () => {
    expect(flags('by 김민준 today', '김민준')).toBe(true)
    expect(flags('by 김민 today', '김민')).toBe(true)
  })

  it('is not name-checked otherwise', () => {
    expect(flags('by 김 today', '김')).toBe(false)
    expect(flags('by Ivan today', 'Ivan')).toBe(false)
    expect(flags('by 김민준x today', '김민준x')).toBe(false)
    expect(flags('by x김민준 today', 'x김민준')).toBe(false)
    expect(flags('by today', '')).toBe(false)
  })

  it('a two-token Latin name is name-checked in either order', () => {
    expect(flags('by Ivan Petrenko')).toBe(true)
    expect(flags('by Petrenko Ivan')).toBe(true)
    expect(flags('by Ivan Olegovych Petrenko', 'Ivan Olegovych Petrenko')).toBe(true)
  })
})

describe('an invisible inside a jamo run (CR-L-2)', () => {
  it('a name written as jamo with an invisible between them is still found', () => {
    expect(flags('by \u1100\u200D\u1161\u1102\u1161 today', '가나')).toBe(true)
    expect(flags('by \u1100\u1161\u200B\u1102\u1161 today', '가나')).toBe(true)
  })

  it('a gap between two jamo syllables is a boundary, one inside a syllable is not', () => {
    expect(flags('\u1100\u1161\u200B\u1102\u1161\u1103\u1161', '나다')).toBe(true)
    expect(flags('\u1100\u200B\u1161\u1102\u1161\u1103\u1161', '나다')).toBe(false)
  })
})
