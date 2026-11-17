/**
 * Contact scanner residuals after PR #1351 (backlog 453): a phone in non-ASCII decimal digits
 * (453c) and a phone with a combining mark on a digit (453e) are phones on the completeness side
 * too. The normaliser folds every `\p{Nd}` digit to its ASCII digit with exact offset maps.
 */
import { describe, expect, it } from 'vitest'
import type { ResumeFacts } from './resume-facts'
import { checkResumeCompleteness, normaliseContactText } from './resume-completeness'

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
    { displayName, now: new Date('2026-11-16T00:00:00Z') },
  ).some((issue) => issue.code === 'CONTACT_IN_TEXT')

describe('non-ASCII decimal digits fold to ASCII (453c)', () => {
  it.each([
    [
      '\u{0660}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667}\u{0668}\u{0669}',
      '0123456789',
    ],
    ['\u{06F0}\u{06F5}\u{06F9}', '059'],
    ['\u{0966}\u{096F}', '09'],
    ['x\u{0E53}y', 'x3y'],
  ])('%j reads %j', (text, folded) => {
    expect(normaliseContactText(text).text).toBe(folded)
  })

  it('an astral digit is one code unit after the fold and maps back to both of its own', () => {
    // U+104A9 OSMANYA DIGIT NINE: NFKC keeps it, so only the digit fold makes it a 9
    const norm = normaliseContactText('a\u{104A9}b')
    expect(norm.text).toBe('a9b')
    expect(norm.from).toEqual([0, 1, 3])
    expect(norm.to).toEqual([1, 3, 4])
  })

  it('a folded digit adds no gap: it was a digit before the fold too', () => {
    expect(normaliseContactText('Ivan\u{0661}').gaps).toEqual(new Set())
  })

  it('every decimal digit block NFKC keeps is ten long, so its value is its offset in the block', () => {
    // pins the assumption of the fold: Unicode assigns `Nd` in contiguous blocks of 0..9
    const blocks: number[] = []
    let previous = -2
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      const char = String.fromCodePoint(cp)
      if (!/\p{Nd}/u.test(char) || char.normalize('NFKC') !== char) continue
      if (cp === previous + 1) blocks[blocks.length - 1] = (blocks.at(-1) ?? 0) + 1
      else blocks.push(1)
      previous = cp
    }
    expect(blocks.length).toBeGreaterThan(50)
    expect(blocks.filter((length) => length % 10 !== 0)).toEqual([])
  })

  it.each([
    'call \u{0660}\u{0666}\u{0667}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667}',
    'call \u{06F0}\u{06F6}\u{06F7} \u{06F1}\u{06F2}\u{06F3} \u{06F4}\u{06F5} \u{06F6}\u{06F7}',
    'call +\u{0663}\u{0668}\u{0660} \u{0666}\u{0667} \u{0661}\u{0662}\u{0663} \u{0664}\u{0665} \u{0666}\u{0667}',
  ])('%j is a phone', (text) => {
    expect(flags(text)).toBe(true)
  })

  it('a list of years in Arabic-Indic digits stays a year list', () => {
    expect(
      flags(
        '\u{0662}\u{0660}\u{0661}\u{0669} \u{00B7} \u{0662}\u{0660}\u{0662}\u{0660} \u{00B7} \u{0662}\u{0660}\u{0662}\u{0661}',
      ),
    ).toBe(false)
  })

  // the differential against main: the fold must not take away the edge a non-ASCII digit was
  it.each(['\u{0661}www.site.devBo', '\u{06F7}\u{06F7}www.site.dev\u{2116}\u{0661}'])(
    'a URL after a non-ASCII digit %j still flags, as on main',
    (text) => {
      expect(flags(text)).toBe(true)
    },
  )

  it('the unfolded form keeps the non-ASCII digit', () => {
    expect(normaliseContactText('\u{0661}www', false).text).toBe('\u{0661}www')
    expect(normaliseContactText('\u{0661}www').text).toBe('1www')
  })
})

describe('a combining mark on a digit does not break a phone (453e)', () => {
  it.each([
    'call 067\u{0301} 123 45 67',
    'call 0\u{0353}6\u{0353}7 123 45 67',
    'call 067 123 45 6\u{0300}7',
  ])('%j is a phone', (text) => {
    expect(flags(text)).toBe(true)
  })

  it('a mark on the name still flags it, as on main', () => {
    expect(flags('by Ivan Petrin\u{0301}', 'Ivan Petrin')).toBe(true)
    expect(flags('by Ivan\u{0353} Petrin', 'Ivan Petrin')).toBe(true)
  })
})
