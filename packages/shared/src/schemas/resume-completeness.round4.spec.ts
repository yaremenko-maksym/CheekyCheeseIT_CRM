/**
 * PR #1351 fix round 4: an invisible plus a mark at a token edge is a boundary (SR-H-2), an
 * invisible between name parts is a name gap (SR-M-3), and the normaliser is linear in the
 * invisibles of a cluster (CR-M-2).
 */
import { describe, expect, it } from 'vitest'
import type { ResumeFacts } from './resume-facts'
import {
  CONTACT_NAME_GAP,
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

/** 김민준 written as conjoining jamo. */
const KIM_JAMO = '김민준'

describe('an invisible plus a mark at a token edge (SR-H-2)', () => {
  it('a letter that took an invisible and a mark ends at a gap, composed or not', () => {
    expect(normaliseContactText('o​́S')).toMatchObject({
      text: 'óS',
      gaps: new Set([1]),
    })
    // the mark does not compose: the gap is after it, never on it
    expect(normaliseContactText('q​́S')).toMatchObject({
      text: 'q́S',
      gaps: new Set([2]),
    })
    // a mark with no stripped character adds no gap
    expect(normaliseContactText('q́S').gaps).toEqual(new Set())
  })

  it('a gap inside a jamo run sits where the next jamo starts a syllable', () => {
    // a leading consonant after the invisible starts one
    expect(normaliseContactText('ᄀ​ᄀ').gaps).toEqual(new Set([1]))
    // a trailing consonant after a leading consonant and a vowel joins their syllable
    expect(normaliseContactText('가​ᆨ')).toMatchObject({
      text: '각',
      gaps: new Set(),
    })
    // a trailing consonant after a lone vowel or a lone leading consonant does not
    expect(normaliseContactText('ᅡ​ᆨ').gaps).toEqual(new Set([1]))
    expect(normaliseContactText('ᄀ​ᆨ').gaps).toEqual(new Set([1]))
    // a vowel after a vowel does not
    expect(normaliseContactText('가​ᅡ').gaps).toEqual(new Set([1]))
    // the edges of the code-point ranges
    expect(normaliseContactText('ᄒ​ᅵ').gaps).toEqual(new Set())
    expect(normaliseContactText('ᄓ​ᅡ').gaps).toEqual(new Set([1]))
    expect(normaliseContactText('ᄀ​ᅶ').gaps).toEqual(new Set([1]))
    expect(normaliseContactText('ᄀ​ᅠ').gaps).toEqual(new Set([1]))
    expect(normaliseContactText('기​ᇂ').gaps).toEqual(new Set())
    expect(normaliseContactText('가​ᇃ').gaps).toEqual(new Set([1]))
    expect(normaliseContactText('가​ᆧ').gaps).toEqual(new Set([1]))
    // a leading filler: the run's own first character is stripped
    expect(normaliseContactText('xᅟᅡ').gaps).toEqual(new Set([1]))
  })

  it('foldAccents carries a gap that lands on a mark to the end of its letter', () => {
    expect(foldAccents('á̂b', new Set([2]))).toMatchObject({
      text: 'ab',
      gaps: new Set([1]),
    })
    expect(foldAccents('áb', new Set([1]))).toMatchObject({ gaps: new Set([1]) })
    expect(foldAccents('ab', new Set([1]))).toMatchObject({ gaps: new Set([1]) })
    expect(foldAccents('ab́', new Set([0]))).toMatchObject({ gaps: new Set([0]) })
    // a gap at the text end has no letter after it to start
    expect(foldAccents('ab', new Set([2]))).toMatchObject({ gaps: new Set() })
  })

  it('a gap alone is no name: a two-token name still needs its parts', () => {
    expect(flags('Senior​developer')).toBe(false)
    expect(flags('Senior​́developer')).toBe(false)
  })

  it.each([
    ['Ivan Petrenko​́Senior', 'Ivan Petrenko'],
    ['x​́Ivan Petrenko', 'Ivan Petrenko'],
    ['Ivan Petrenko​̈x', 'Ivan Petrenko'],
    [`${KIM_JAMO}́﻿̈Senior`, '김민준'],
    [`${KIM_JAMO}​́Senior`, '김민준'],
  ])('flags %j', (text, name) => {
    expect(flags(text, name)).toBe(true)
  })

  it('flags a stored handle whose last letter took an invisible and a mark', () => {
    expect(flags('ping ivan_dee​́x', 'Mark Levin', 'ivan_dee')).toBe(true)
    expect(flags('ping ivan_dev́x', 'Mark Levin', 'ivan_dev')).toBe(true)
    expect(flags('ping ivan_deex', 'Mark Levin', 'ivan_dee')).toBe(false)
  })
})

describe('text with nothing to cluster or fold keeps its offsets (PR #1351 round 4, finding 7)', () => {
  it('maps each code point to itself, an astral one as two code units', () => {
    expect(normaliseContactText('a\u{10000}b\u{1F600}')).toEqual({
      text: 'a\u{10000}b\u{1F600}',
      from: [0, 1, 1, 3, 4, 4],
      to: [1, 3, 3, 4, 6, 6],
      gaps: new Set(),
    })
    expect(foldAccents('a\u{10000}b')).toEqual({
      text: 'a\u{10000}b',
      from: [0, 1, 1, 3],
      to: [1, 3, 3, 4],
      gaps: new Set(),
    })
  })

  it('a mark, a stripped character or a hand-folded letter still goes through the clusters', () => {
    expect(normaliseContactText('q́x')).toMatchObject({ from: [0, 0, 2], to: [2, 2, 3] })
    expect(normaliseContactText('a⠀b')).toMatchObject({ text: 'ab', gaps: new Set([1]) })
    expect(foldAccents('q́ł')).toMatchObject({ text: 'ql', from: [0, 2], to: [2, 3] })
  })
})

describe('an invisible between name parts is a name gap (SR-M-3)', () => {
  it.each(['﻿', '​', '⁠', '­'].map((c) => [c.codePointAt(0)?.toString(16), c]))(
    'flags the name joined by U+%s, in either order',
    (_code, c) => {
      expect(flags(`by Ivan${c}Petrenko today`)).toBe(true)
      expect(flags(`by Petrenko${c}Ivan today`)).toBe(true)
    },
  )

  it('a glued name with no invisible is still not one', () => {
    expect(flags('by IvanPetrenko today')).toBe(false)
  })

  it('findWholeTokens takes an empty name gap only on a gap', () => {
    const source = `Ivan${CONTACT_NAME_GAP}Petrenko`
    expect(findWholeTokens('IvanPetrenko', new Set([4]), source, 'name')).toEqual([
      { start: 0, end: 12 },
    ])
    expect(findWholeTokens('IvanPetrenko', new Set([3]), source, 'name')).toEqual([])
    expect(findWholeTokens('Ivan Petrenko', new Set(), source, 'name')).toEqual([
      { start: 0, end: 13 },
    ])
  })
})
