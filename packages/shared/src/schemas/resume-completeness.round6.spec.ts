/**
 * PR #1351 fix round 6: control characters split a stored name and vanish from the text (findings
 * 3, 4), a bare mark is an edge (SR-M-4), equal readings are one (CR-M-5), and the split reading
 * keeps every full-name order while a fragment never pairs or stands alone (finding 5, CR-M-3,
 * Addenda B and C).
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

describe('a bare mark is an edge (SR-M-4)', () => {
  it('flags a name glued to a bare mark, behind a zero-width space', () => {
    expect(flags('Ivan​Petrenkoःx')).toBe(true)
    expect(flags('Ivan Petrenkoःx')).toBe(true)
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
    expect(contactNameParts('Ivan Petr‌in')).toEqual([
      ['Ivan', 'Petrin'],
      ['Ivan', 'Petr', 'in'],
    ])
    expect(contactNameParts('Wei​Li')).toEqual([['WeiLi'], ['Wei', 'Li']])
  })
})

describe('split reading, joined reading of two or more parts (Addendum B)', () => {
  it('orders: every part, and the first with each part of three letters or more', () => {
    expect(splitNameOrders(['Ivan', 'Petrenko', 'Kovalenko'], 2)).toEqual([
      ['Ivan', 'Petrenko', 'Kovalenko'],
      ['Ivan', 'Petrenko'],
      ['Petrenko', 'Ivan'],
      ['Ivan', 'Kovalenko'],
      ['Kovalenko', 'Ivan'],
    ])
    expect(splitNameOrders(['Ivan', 'Petr', 'in'], 2)).toEqual([
      ['Ivan', 'Petr', 'in'],
      ['Ivan', 'Petr'],
      ['Petr', 'Ivan'],
    ])
    expect(splitNameOrders(['Iv', 'an', 'Petrenko'], 2)).toEqual([['Iv', 'an', 'Petrenko']])
  })

  it('lone parts: each later part of three letters or more', () => {
    expect(splitNameLoneParts(['Ivan', 'Petrenko', 'Kovalenko'], 2)).toEqual([
      'Petrenko',
      'Kovalenko',
    ])
    expect(splitNameLoneParts(['Ivan', 'Petr', 'in'], 2)).toEqual(['Petr'])
    expect(splitNameLoneParts(['Ivan', 'Petren', 'ko'], 2)).toEqual(['Petren'])
  })

  it('stored Ivan Petrenko, ZWSP, Kovalenko: every two-part order of real parts is flagged', () => {
    const stored = 'Ivan Petrenko​Kovalenko'
    expect(flags('Ivan Kovalenko', stored)).toBe(true)
    expect(flags('Kovalenko Ivan', stored)).toBe(true)
    expect(flags('Ivan Petrenko', stored)).toBe(true)
    expect(flags('Ivan PetrenkoKovalenko', stored)).toBe(true)
    // a surname alone is never flagged (a common word too often); the API redacts it
    expect(flags('Petrenko', stored)).toBe(false)
  })

  it('stored Ivan Petr, ZWNJ, in: the fragment never pairs', () => {
    const stored = 'Ivan Petr‌in'
    expect(flags('Ivan in Kyiv since 2020', stored)).toBe(false)
    expect(flags('Ivan Petrin', stored)).toBe(true)
    expect(flags('Ivan Petr', stored)).toBe(true)
  })

  it('stored Ivan Petren, ZWNJ, ko: the fragment never pairs', () => {
    const stored = 'Ivan Petren‌ko'
    expect(flags('Ivan ko', stored)).toBe(false)
    expect(flags('Ivan Petrenko', stored)).toBe(true)
  })

  it('stored Ivan, ZWSP, Olegovych Petrenko still hits', () => {
    const stored = 'Ivan​Olegovych Petrenko'
    expect(flags('Ivan Petrenko', stored)).toBe(true)
    expect(flags('Ivan Olegovych Petrenko', stored)).toBe(true)
  })
})

describe('split reading, joined reading of one part (Addendum C)', () => {
  it('orders: every pair, whatever its length', () => {
    expect(splitNameOrders(['Wei', 'Li'], 1)).toEqual([
      ['Wei', 'Li'],
      ['Wei', 'Li'],
      ['Li', 'Wei'],
    ])
    expect(splitNameOrders(['Li', 'Wei'], 1)).toEqual([
      ['Li', 'Wei'],
      ['Li', 'Wei'],
      ['Wei', 'Li'],
    ])
  })

  it('lone parts: each later part of two letters or more', () => {
    expect(splitNameLoneParts(['Wei', 'Li'], 1)).toEqual(['Li'])
    expect(splitNameLoneParts(['Wei', 'Y'], 1)).toEqual([])
  })

  it('stored Wei, ZWSP, Li: both orders are flagged', () => {
    expect(flags('Wei Li', 'Wei​Li')).toBe(true)
    expect(flags('Li Wei', 'Wei​Li')).toBe(true)
    // one token of Latin letters is a single word, never flagged alone (as on main); the API redacts it
    expect(flags('WeiLi', 'Wei​Li')).toBe(false)
  })

  it('an empty split reading orders to one empty order and no lone part', () => {
    expect(splitNameOrders([], 0)).toEqual([[]])
    expect(splitNameLoneParts([], 0)).toEqual([])
  })
})
