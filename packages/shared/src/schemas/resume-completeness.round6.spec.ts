/**
 * PR #1351 fix round 6: control characters split a stored name and vanish from the text (findings
 * 3, 4), a bare mark is an edge (SR-M-4), equal readings are one (CR-M-5). Round 7: completeness
 * takes the split reading only for a joined reading of one part, so a fragment never flags (CR-M-3,
 * CR-M-7); the split helpers keep every pair, deduped (finding 8).
 */
import { describe, expect, it } from 'vitest'
import type { ResumeFacts } from './resume-facts'
import {
  checkResumeCompleteness,
  contactNameParts,
  normaliseContactText,
  splitNameLoneParts,
  splitNameOrders,
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

const flags = (text: string, displayName = 'Ivan Petrenko') =>
  checkResumeCompleteness(
    { ...FACTS, headline: text },
    { displayName, now: new Date('2026-11-10T00:00:00Z') },
  ).some((issue) => issue.code === 'CONTACT_IN_TEXT')

describe('control characters (findings 3, 4)', () => {
  it('a C0 or C1 control in a stored name splits it, U+0085 included', () => {
    expect(contactNameParts('Ivan\u0085Petrenko')).toEqual([['Ivan', 'Petrenko']])
    expect(contactNameParts('Ivan\u001FPetrenko')).toEqual([['Ivan', 'Petrenko']])
    expect(contactNameParts('Ivan\u0080Petrenko')).toEqual([['Ivan', 'Petrenko']])
  })

  it('a backslash in a stored name splits it, a fullwidth one too (PR #1416, SR-H-2)', () => {
    // a part holding `\n` would overlap the escaped-newline gap between parts
    expect(contactNameParts('Ivan\\Petrenko')).toEqual([['Ivan', 'Petrenko']])
    expect(contactNameParts('\\n\\n Ivan')).toEqual([['n', 'n', 'Ivan']])
    expect(contactNameParts('Ivan＼Petrenko')).toEqual([['Ivan', 'Petrenko']])
  })

  it('a stored name of escaped-newline parts checks a run of them in bounded time', () => {
    const start = process.cpuUsage()
    const flagged = flags(`${'\\n'.repeat(40)} x`, `${Array(10).fill('\\n').join(' ')} Ba`)
    const { user, system } = process.cpuUsage(start)
    expect(flagged).toBe(false)
    expect((user + system) / 1000).toBeLessThan(200)
  })

  it('a C0 or C1 control in the text is stripped, so the name around it still hits', () => {
    expect(normaliseContactText('P\u0000etrenko').text).toBe('Petrenko')
    expect(normaliseContactText('P\u009Fetrenko').text).toBe('Petrenko')
    expect(flags('Ivan P\u0000etrenko')).toBe(true)
    expect(flags('Ivan\u0085Petrenko')).toBe(true)
    expect(flags('by Ivan\u0085Petrenko', 'Ivan\u0085Petrenko')).toBe(true)
  })

  it('tab, newline and the other whitespace controls stay whitespace', () => {
    expect(normaliseContactText('a\tb\nc\rd').text).toBe('a\tb\nc\rd')
  })
})

describe('a compatibility character is an edge on both sides (SR-H-4)', () => {
  it.each([
    ['Petrenko™x', 'PetrenkoTMx', [8, 10]],
    ['a²b', 'a2b', [1, 2]],
    ['ﬁx', 'fix', [0, 2]],
    ['a\u200Bb', 'ab', [1]],
  ] as const)('normalises %j to %j with gaps %j', (text, normalised, gaps) => {
    const result = normaliseContactText(text)
    expect(result.text).toBe(normalised)
    expect([...result.gaps]).toEqual(gaps)
  })
})

describe('main check keeps its apostrophe fold', () => {
  it('an apostrophe in the stored name is not dropped', () => {
    expect(flags('ONeil Smith', 'O’Neil Smith')).toBe(false)
    expect(flags("O'Neil Smith", 'O’Neil Smith')).toBe(true)
  })
})

describe('a bare mark is an edge (SR-M-4)', () => {
  it('flags a name glued to a bare mark, behind a zero-width space', () => {
    expect(flags('Ivan\u200BPetrenko\u0903x')).toBe(true)
    expect(flags('Ivan Petrenko\u0903x')).toBe(true)
  })

  it('a precomposed accent stays part of the word', () => {
    expect(flags('Ivan Petrenkóv')).toBe(false)
  })
})

describe('readings (CR-M-5)', () => {
  it('a name with no invisible has one reading', () => {
    expect(contactNameParts('Ivan Petrenko')).toEqual([['Ivan', 'Petrenko']])
  })

  it('a name with an invisible has the joined and the split reading', () => {
    expect(contactNameParts('Ivan Petr\u200Cin')).toEqual([
      ['Ivan', 'Petrin'],
      ['Ivan', 'Petr', 'in'],
    ])
    expect(contactNameParts('Wei\u200BLi')).toEqual([['WeiLi'], ['Wei', 'Li']])
  })
})
describe('split helpers (round 7)', () => {
  it('orders: every part, and the first with each later part both ways, whatever its length', () => {
    expect(splitNameOrders(['Ivan', 'Petrenko', 'Kovalenko'])).toEqual([
      ['Ivan', 'Petrenko', 'Kovalenko'],
      ['Ivan', 'Petrenko'],
      ['Petrenko', 'Ivan'],
      ['Ivan', 'Kovalenko'],
      ['Kovalenko', 'Ivan'],
    ])
    expect(splitNameOrders(['Iv', 'an', 'Li'])).toEqual([
      ['Iv', 'an', 'Li'],
      ['Iv', 'an'],
      ['an', 'Iv'],
      ['Iv', 'Li'],
      ['Li', 'Iv'],
    ])
    expect(splitNameOrders([])).toEqual([[]])
  })

  it('orders: a two-part reading is its own first pair, listed once (finding 8)', () => {
    expect(splitNameOrders(['Wei', 'Li'])).toEqual([
      ['Wei', 'Li'],
      ['Li', 'Wei'],
    ])
    expect(splitNameOrders(['Ivan', "d'"])).toEqual([
      ['Ivan', "d'"],
      ["d'", 'Ivan'],
    ])
  })

  it('lone parts: each part after the first with two letters or more', () => {
    expect(splitNameLoneParts(['Ivan', 'Petrenko', 'Kovalenko'])).toEqual(['Petrenko', 'Kovalenko'])
    expect(splitNameLoneParts(['Ivan', 'Petr', 'in'])).toEqual(['Petr', 'in'])
    // punctuation and marks do not count as letters
    expect(splitNameLoneParts(['Ivan', 'Y', "d'", 'o-', 'Li'])).toEqual(['Li'])
    expect(splitNameLoneParts(['Wei', 'Li'])).toEqual(['Li'])
    expect(splitNameLoneParts([])).toEqual([])
  })
})

describe('completeness ignores the split reading of a joined reading of two or more parts (round 7)', () => {
  it('stored Ivan Petr, ZWNJ, in: the fragment never flags (CR-M-3)', () => {
    const stored = 'Ivan Petr\u200Cin'
    expect(flags('Ivan in Kyiv since 2020', stored)).toBe(false)
    expect(flags('Ivan Petr', stored)).toBe(false)
    expect(flags('Ivan Petrin', stored)).toBe(true)
  })

  it('stored Ivan Peter, ZWNJ, son: the fragment never flags (CR-M-7)', () => {
    const stored = 'Ivan Peter\u200Cson'
    expect(flags('Ivan son is here', stored)).toBe(false)
    expect(flags('his son Ivan', stored)).toBe(false)
    expect(flags('Ivan Peterson', stored)).toBe(true)
  })

  it('stored Ivan Petren, ZWNJ, ko: the fragment never flags', () => {
    const stored = 'Ivan Petren\u200Cko'
    expect(flags('Ivan ko', stored)).toBe(false)
    expect(flags('Ivan Petrenko', stored)).toBe(true)
  })

  it('stored Ivan Petrenko, ZWSP, Kovalenko: only the joined orders flag; the API redacts the rest', () => {
    const stored = 'Ivan Petrenko\u200BKovalenko'
    expect(flags('Ivan PetrenkoKovalenko', stored)).toBe(true)
    expect(flags('PetrenkoKovalenko Ivan', stored)).toBe(true)
    expect(flags('Ivan Kovalenko', stored)).toBe(false)
    expect(flags('Ivan Petrenko', stored)).toBe(false)
    expect(flags('Petrenko', stored)).toBe(false)
  })

  it('stored Li Petrenko, ZWSP, Kovalenko: only the joined orders flag', () => {
    const stored = 'Li Petrenko\u200BKovalenko'
    expect(flags('Li PetrenkoKovalenko', stored)).toBe(true)
    expect(flags('Li Kovalenko', stored)).toBe(false)
  })

  it('stored Ivan, ZWSP, Olegovych Petrenko: only the joined reading flags', () => {
    const stored = 'Ivan\u200BOlegovych Petrenko'
    expect(flags('IvanOlegovych Petrenko', stored)).toBe(true)
    expect(flags('Ivan Petrenko', stored)).toBe(false)
    expect(flags('Ivan Olegovych Petrenko', stored)).toBe(false)
  })
})

describe('completeness takes the split reading of a joined reading of one part (round 7)', () => {
  it('stored Wei, ZWSP, Li: both orders are flagged', () => {
    expect(flags('Wei Li', 'Wei\u200BLi')).toBe(true)
    expect(flags('Li Wei', 'Wei\u200BLi')).toBe(true)
    // one token of Latin letters is a single word, never flagged alone (as on main); the API redacts it
    expect(flags('WeiLi', 'Wei\u200BLi')).toBe(false)
    // a lone part is not flagged, as a lone surname is not on main; the API redacts it
    expect(flags('by Li today', 'Wei\u200BLi')).toBe(false)
  })

  it('stored Iv, ZWSP, an: a pair of short parts still flags both orders', () => {
    expect(flags('Iv an', 'Iv\u200Ban')).toBe(true)
    expect(flags('an Iv', 'Iv\u200Ban')).toBe(true)
  })
})

describe("main's whitespace reading of a U+FEFF name stays in completeness (round 8, CR-H-1)", () => {
  it.each([
    // main splits a stored name on `\s`, which includes U+FEFF, so main flags this
    ['Ivan\uFEFFOlegovych Petrenko', 'Ivan Petrenko'],
    // main splits a stored name on `\s`, which includes U+FEFF, so main flags this
    ['Ivan\uFEFFOlegovych Petrenko', 'Ivan Olegovych Petrenko'],
    // main splits a stored name on `\s`, which includes U+FEFF, so main flags this
    ['Ivan Petrenko\uFEFFKovalenko', 'Ivan Kovalenko'],
  ])('stored %j flags %j', (stored, text) => {
    expect(flags(text, stored)).toBe(true)
  })

  it('U+FEFF is the only character outside \\p{Cc} that the strip removes and \\s matches', () => {
    const whitespace: string[] = []
    for (let code = 0; code <= 0x10ffff; code++) {
      // a lone surrogate is not a character
      if (code >= 0xd800 && code <= 0xdfff) continue
      const char = String.fromCodePoint(code)
      if (/\s/u.test(char) && !/\p{Cc}/u.test(char)) whitespace.push(char)
    }
    // the set is the Unicode spaces, not an empty loop
    expect(whitespace.length).toBeGreaterThan(15)
    expect(whitespace.filter((char) => normaliseContactText(`a${char}b`).text === 'ab')).toEqual([
      '\uFEFF',
    ])
  })
})
