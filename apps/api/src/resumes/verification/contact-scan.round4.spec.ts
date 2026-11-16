/**
 * PR #1351 fix round 4: an invisible plus a mark at a name or handle edge (SR-H-2), an invisible
 * between name parts (SR-M-3), and a leak oracle over generated texts: what the redaction leaves
 * holds no name part and no handle, whatever invisibles and marks sit around them.
 */
import { checkResumeCompleteness, type ResumeFacts } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { redactContacts, scanContacts, type ContactContext } from './contact-scan'

/** 김민준 written as conjoining jamo. */
const KIM_JAMO = '\u1100\u1175\u11B7\u1106\u1175\u11AB\u110C\u116E\u11AB'
const ivan: ContactContext = { fullName: 'Ivan Petrenko', emails: [], telegram: '@ivan_dev' }
const kim: ContactContext = { fullName: '김민준', emails: [] }

describe('an invisible plus a mark at a name or handle edge (SR-H-2)', () => {
  it.each([
    ['Ivan Petrenko\u200B\u0301Senior', '[REDACTED]Senior'],
    ['x\u200B\u0301Petrenko', 'x\u200B\u0301[REDACTED]'],
    ['Petrenko\u200B\u0308x', '[REDACTED]x'],
    ['ivan_dev\u200C\u0301Petrenko Ivan', '[REDACTED] Ivan'],
    ['by x\u200B\u0301Ivan Petrenko today', 'by x\u200B\u0301[REDACTED] today'],
  ])('redacts %j as %j', (text, redacted) => {
    expect(redactContacts(text, ivan)).toBe(redacted)
  })

  it.each([
    [`${KIM_JAMO}\u0301\uFEFF\u0308Senior`, '[REDACTED]Senior'],
    [`${KIM_JAMO}\u200B\u0301Senior`, '[REDACTED]Senior'],
    [`Senior\u200B\u0301${KIM_JAMO}`, 'Senior\u200B\u0301[REDACTED]'],
  ])('redacts the jamo-written name in %j as %j', (text, redacted) => {
    expect(redactContacts(text, kim)).toBe(redacted)
  })

  it('redacts a stored handle whose last letter took an invisible and a mark', () => {
    const dee: ContactContext = { fullName: 'Mark Levin', emails: [], telegram: 'ivan_dee' }
    expect(redactContacts('ping ivan_dee\u200B\u0301x', dee)).toBe('ping [REDACTED]x')
    expect(redactContacts('ping ivan_dev\u0301x', ivan)).toBe('ping [REDACTED]x')
    expect(redactContacts('ping ivan_deex', dee)).toBe('ping ivan_deex')
    // found on the folded text only, and still reported as the handle, as written
    expect(scanContacts('ping ivan_dee\u200B\u0301x', dee)).toEqual([
      { kind: 'telegram', match: 'ivan_dee\u200B\u0301' },
    ])
  })

  it('a blank name redacts nothing, a gap in the text included', () => {
    const blank: ContactContext = { fullName: ' ', emails: [] }
    expect(redactContacts('Senior\u200Bdeveloper', blank)).toBe('Senior\u200Bdeveloper')
  })
})

describe('an invisible between name parts is a name gap (SR-M-3)', () => {
  it.each(['\uFEFF', '\u200B', '\u2060', '\u00AD'].map((c) => [c.codePointAt(0)?.toString(16), c]))(
    'redacts the full name joined by U+%s; the reversed order loses its surname, as with a space',
    (_code, c) => {
      expect(redactContacts(`by Ivan${c}Petrenko today`, ivan)).toBe('by [REDACTED] today')
      expect(redactContacts(`by Petrenko${c}Ivan today`, ivan)).toBe(`by [REDACTED]${c}Ivan today`)
      expect(redactContacts('by Petrenko Ivan today', ivan)).toBe('by [REDACTED] Ivan today')
    },
  )

  it('a glued name with no invisible keeps its first name, as before', () => {
    expect(redactContacts('by IvanPetrenko today', ivan)).toBe('by IvanPetrenko today')
  })
})

describe('leak oracle: no name part or handle survives redaction (PR #1351 round 4)', () => {
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
  /** mulberry32: a full-period PRNG, so every atom pair comes up. */
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const INVISIBLES = ['\u200B', '\u2060', '\uFEFF', '\u00AD', '\u2800', '\u200C']
  /** An invisible and a mark in every order, and a mark that precedes an invisible. */
  const INVISIBLE_MARKS = [
    '\u200B\u0301',
    '\u200C\u0301',
    '\uFEFF\u0308',
    '\u0301\uFEFF\u0308',
    '\u0301\u200B',
    '\u200B\u0301\u200B\u0308',
  ]
  /** What may stand between a target and its neighbour: never nothing, never a bare mark. */
  const HANDLE_EDGES = [' ', '\n', ',', '#', '+', '-', '(', ...INVISIBLES, ...INVISIBLE_MARKS]
  const EDGES = [...HANDLE_EDGES, '\\n']
  /** What may stand between two name parts: whitespace, or an invisible in place of it. */
  const NAME_GAPS = [' ', '\n', '\t', '\\n', ...INVISIBLES, ...INVISIBLE_MARKS]
  /** No filler holds a name part or the handle, alone or next to another one. */
  const FILLERS = ['Senior', 'x', '7', 'React', '가', 'Kyiv']
  /** Inside a token: nothing, or an invisible that is not a boundary there. */
  const INSIDE = ['', '', '\u200C', '\u200B', '\u2800']

  it.each([
    ['Latin', 'Ivan Petrenko', ['Ivan', 'Petrenko'], 1],
    ['Korean precomposed', '김민준', ['김민준'], 2],
    ['Korean jamo', '김민준', [KIM_JAMO], 3],
    // stress marks have no precomposed form: only the fold drops them (round 5, CR-H-1)
    ['Cyrillic', 'Іван Петренко', ['Іва\u0301н', 'Петре\u0301нко'], 4],
  ] as const)('%s: 20000 generated texts', (_label, fullName, rendered, seed) => {
    const random = prng(seed)
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
    const some = (list: readonly string[], max: number) =>
      Array.from({ length: 1 + Math.floor(random() * max) }, () => pick(list)).join('')
    const inside = (part: string) => {
      const chars = [...part]
      const at = 1 + Math.floor(random() * (chars.length - 1))
      return chars.slice(0, at).join('') + pick(INSIDE) + chars.slice(at).join('')
    }
    const context: ContactContext = { fullName, emails: [], telegram: 'ivan_dev' }
    // The oracle reads the output as a person would: invisibles and marks gone, accents folded,
    // any case; a target is found anywhere, not only as a whole token. Its own strip and the
    // platform's NFKC, so a normaliser bug that drops a character cannot hide a leak (round 5).
    const visible = (text: string) =>
      text
        .replace(/[\u2800\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .normalize('NFKC')
        .toLowerCase()
    const targets = [...fullName.split(' '), 'ivan_dev'].map(visible)
    const leaks: string[] = []
    const unflagged: string[] = []
    for (let i = 0; i < 20000; i++) {
      const name = rendered
        .map(inside)
        .reduce((text, part) => `${text}${some(NAME_GAPS, 2)}${part}`)
      const items = [name, ...Array.from({ length: Math.floor(random() * 3) }, () => pick(FILLERS))]
      if (random() < 0.5) items.push(`${random() < 0.5 ? '@' : ''}${inside('ivan_dev')}`)
      // a random order, each pair split by an edge, and an optional edge at either end
      items.sort(() => random() - 0.5)
      const lead = random() < 0.5 ? some(HANDLE_EDGES, 2) : ''
      const tail = random() < 0.5 ? some(EDGES, 2) : ''
      // A handle has no escape rule: `\n` written out glues its `n` to the handle as a word letter.
      const edge = (item: string) => some(item.includes('_') ? HANDLE_EDGES : EDGES, 2)
      const text = lead + items.reduce((acc, item) => `${acc}${edge(item)}${item}`) + tail
      const out = visible(redactContacts(text, context))
      if (targets.some((target) => out.includes(target))) leaks.push(text)
      const flagged = checkResumeCompleteness(
        { ...FACTS, headline: text },
        { displayName: fullName, telegram: context.telegram, now },
      ).some((issue) => issue.code === 'CONTACT_IN_TEXT')
      if (!flagged) unflagged.push(text)
    }
    expect({ leaks: leaks.length, sample: leaks.slice(0, 3) }).toEqual({ leaks: 0, sample: [] })
    // every text holds the full name, so completeness flags every one of them
    expect({ unflagged: unflagged.length, sample: unflagged.slice(0, 3) }).toEqual({
      unflagged: 0,
      sample: [],
    })
  })
})
