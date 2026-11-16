/**
 * PR #1351 fix round 6: the redaction is never worse than main. It redacts the union of its own
 * spans and the spans main's matcher finds on the same text (SR-H-4), so a compatibility character
 * glued to a contact (`²`, `™`, fullwidth letters, ligatures) no longer hides it. Plus control
 * characters (findings 3, 4), a bare mark as an edge (SR-M-4) and the split reading of a stored
 * name (finding 5, CR-M-3, Addenda B and C).
 */
import { CONTACT_APOSTROPHES, foldAccents } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { hasContact } from './content-gates'
import { redactContacts, scanContacts, type ContactContext } from './contact-scan'

const IVAN: ContactContext = { fullName: 'Ivan Petrenko', emails: [], telegram: 'ivan_dev' }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Main's name and handle matcher, copied from main before PR #1351 so the test does not share code
 * with the redaction it checks: whole tokens of `[\p{L}\p{N}#+]`, a JSON escape in front counts as
 * an edge, and the handle is a `\w` token.
 */
function mainHits(text: string, ctx: ContactContext): boolean {
  const tokenChar = '[\\p{L}\\p{N}#+]'
  const wholeToken = (source: string) =>
    new RegExp(
      `(?:(?<!${tokenChar})|(?<=\\\\(?:[bfnrt]|u[\\dA-Fa-f]{4})))${source}(?!${tokenChar})`,
      'iu',
    )
  const plain = text.normalize('NFC').replace(CONTACT_APOSTROPHES, "'")
  const name = foldAccents(ctx.fullName.normalize('NFC').replace(CONTACT_APOSTROPHES, "'")).text
  const parts = name.trim().split(/\s+/u)
  const surname = parts.at(-1) ?? ''
  const sources = [parts.map(escapeRegExp).join('(?:\\s|\\\\[nrt])+')]
  if (surname.replace(/\P{L}/gu, '').length >= 2) sources.push(escapeRegExp(surname))
  const folded = foldAccents(plain).text
  const nameHit = sources.filter(Boolean).some((source) => wholeToken(source).test(folded))
  const handle = ctx.telegram?.replace(/^@+/u, '')
  const handleHit =
    !!handle && new RegExp(`(?<!\\w)@*${escapeRegExp(handle)}(?!\\w)`, 'iu').test(plain)
  return nameHit || handleHit
}

describe('compatibility characters glued to a contact (SR-H-4, finding 7)', () => {
  // The security probe rows: 12 compatibility characters, 5 shapes each. A trailing comment holds
  // main's output where it differs; head redacts at least what main redacts on every row.
  it.each([
    ['ping ivan_dev\u00B2 now', 'ping [REDACTED]\u00B2 now'],
    ['ping \u00B2ivan_dev now', 'ping \u00B2[REDACTED] now'],
    ['by Ivan Petrenko\u00B2 now', 'by [REDACTED]\u00B2 now'], // main: 'by Ivan Petrenko\u00B2 now'
    ['by \u00B2Ivan Petrenko now', 'by \u00B2[REDACTED] now'], // main: 'by \u00B2Ivan [REDACTED] now'
    ['by Petrenko\u00B2 now', 'by [REDACTED]\u00B2 now'], // main: 'by Petrenko\u00B2 now'
    ['ping ivan_dev\u00B9 now', 'ping [REDACTED]\u00B9 now'],
    ['ping \u00B9ivan_dev now', 'ping \u00B9[REDACTED] now'],
    ['by Ivan Petrenko\u00B9 now', 'by [REDACTED]\u00B9 now'], // main: 'by Ivan Petrenko\u00B9 now'
    ['by \u00B9Ivan Petrenko now', 'by \u00B9[REDACTED] now'], // main: 'by \u00B9Ivan [REDACTED] now'
    ['by Petrenko\u00B9 now', 'by [REDACTED]\u00B9 now'], // main: 'by Petrenko\u00B9 now'
    ['ping ivan_dev\u2122 now', 'ping [REDACTED]\u2122 now'],
    ['ping \u2122ivan_dev now', 'ping \u2122[REDACTED] now'],
    ['by Ivan Petrenko\u2122 now', 'by [REDACTED]\u2122 now'],
    ['by \u2122Ivan Petrenko now', 'by \u2122[REDACTED] now'],
    ['by Petrenko\u2122 now', 'by [REDACTED]\u2122 now'],
    ['ping ivan_dev\uFF58 now', 'ping [REDACTED]\uFF58 now'],
    ['ping \uFF58ivan_dev now', 'ping \uFF58[REDACTED] now'],
    ['by Ivan Petrenko\uFF58 now', 'by [REDACTED]\uFF58 now'], // main: 'by Ivan Petrenko\uFF58 now'
    ['by \uFF58Ivan Petrenko now', 'by \uFF58[REDACTED] now'], // main: 'by \uFF58Ivan [REDACTED] now'
    ['by Petrenko\uFF58 now', 'by [REDACTED]\uFF58 now'], // main: 'by Petrenko\uFF58 now'
    ['ping ivan_dev\uFB01 now', 'ping [REDACTED]\uFB01 now'],
    ['ping \uFB01ivan_dev now', 'ping \uFB01[REDACTED] now'],
    ['by Ivan Petrenko\uFB01 now', 'by [REDACTED]\uFB01 now'], // main: 'by Ivan Petrenko\uFB01 now'
    ['by \uFB01Ivan Petrenko now', 'by \uFB01[REDACTED] now'], // main: 'by \uFB01Ivan [REDACTED] now'
    ['by Petrenko\uFB01 now', 'by [REDACTED]\uFB01 now'], // main: 'by Petrenko\uFB01 now'
    ['ping ivan_dev\u24D0 now', 'ping [REDACTED]\u24D0 now'],
    ['ping \u24D0ivan_dev now', 'ping \u24D0[REDACTED] now'],
    ['by Ivan Petrenko\u24D0 now', 'by [REDACTED]\u24D0 now'],
    ['by \u24D0Ivan Petrenko now', 'by \u24D0[REDACTED] now'],
    ['by Petrenko\u24D0 now', 'by [REDACTED]\u24D0 now'],
    ['ping ivan_dev\u{1D431} now', 'ping [REDACTED]\u{1D431} now'],
    ['ping \u{1D431}ivan_dev now', 'ping \u{1D431}[REDACTED] now'],
    ['by Ivan Petrenko\u{1D431} now', 'by [REDACTED]\u{1D431} now'], // main: 'by Ivan Petrenko\u{1D431} now'
    ['by \u{1D431}Ivan Petrenko now', 'by \u{1D431}[REDACTED] now'], // main: 'by \u{1D431}Ivan [REDACTED] now'
    ['by Petrenko\u{1D431} now', 'by [REDACTED]\u{1D431} now'], // main: 'by Petrenko\u{1D431} now'
    ['ping ivan_dev\u2161 now', 'ping [REDACTED]\u2161 now'],
    ['ping \u2161ivan_dev now', 'ping \u2161[REDACTED] now'],
    ['by Ivan Petrenko\u2161 now', 'by [REDACTED]\u2161 now'], // main: 'by Ivan Petrenko\u2161 now'
    ['by \u2161Ivan Petrenko now', 'by \u2161[REDACTED] now'], // main: 'by \u2161Ivan [REDACTED] now'
    ['by Petrenko\u2161 now', 'by [REDACTED]\u2161 now'], // main: 'by Petrenko\u2161 now'
    ['ping ivan_dev\u2116 now', 'ping [REDACTED]\u2116 now'],
    ['ping \u2116ivan_dev now', 'ping \u2116[REDACTED] now'],
    ['by Ivan Petrenko\u2116 now', 'by [REDACTED]\u2116 now'],
    ['by \u2116Ivan Petrenko now', 'by \u2116[REDACTED] now'],
    ['by Petrenko\u2116 now', 'by [REDACTED]\u2116 now'],
    ['ping ivan_dev\u00BD now', 'ping [REDACTED]\u00BD now'],
    ['ping \u00BDivan_dev now', 'ping \u00BD[REDACTED] now'],
    ['by Ivan Petrenko\u00BD now', 'by [REDACTED]\u00BD now'], // main: 'by Ivan Petrenko\u00BD now'
    ['by \u00BDIvan Petrenko now', 'by \u00BD[REDACTED] now'], // main: 'by \u00BDIvan [REDACTED] now'
    ['by Petrenko\u00BD now', 'by [REDACTED]\u00BD now'], // main: 'by Petrenko\u00BD now'
    ['ping ivan_dev\u339E now', 'ping [REDACTED]\u339E now'],
    ['ping \u339Eivan_dev now', 'ping \u339E[REDACTED] now'],
    ['by Ivan Petrenko\u339E now', 'by [REDACTED]\u339E now'],
    ['by \u339EIvan Petrenko now', 'by \u339E[REDACTED] now'],
    ['by Petrenko\u339E now', 'by [REDACTED]\u339E now'],
    ['ping ivan_dev\u2103 now', 'ping [REDACTED]\u2103 now'],
    ['ping \u2103ivan_dev now', 'ping \u2103[REDACTED] now'],
    ['by Ivan Petrenko\u2103 now', 'by [REDACTED]\u2103 now'],
    ['by \u2103Ivan Petrenko now', 'by \u2103[REDACTED] now'],
    ['by Petrenko\u2103 now', 'by [REDACTED]\u2103 now'],
  ])('redacts %j as %j', (text, redacted) => {
    expect(redactContacts(text, IVAN)).toBe(redacted)
    expect(mainHits(redacted, IVAN)).toBe(false)
  })
})

describe('the clauses only main matches, on the original text', () => {
  it.each([
    ['ping ivan_dev\u00B2 now', 'ping [REDACTED]\u00B2 now'],
    ['by Ivan Petrenko\u2122 now', 'by [REDACTED]\u2122 now'],
    ['by Petrenko\u2122 now', 'by [REDACTED]\u2122 now'],
    // NFD text: main's spans map back through the NFC offsets
    ['by Petre\u0301nko\u2122 now', 'by [REDACTED]\u2122 now'],
    [
      'by Pe\u0301trenko\u2122 and e\u0301 Petrenko\u00B2',
      'by [REDACTED]\u2122 and \u00E9 [REDACTED]\u00B2',
    ],
    ['\u1100\u1161 Petrenko\u2122', '\uAC00 [REDACTED]\u2122'],
    // a JSON escape in front is an edge, and an escaped newline is a name gap
    ['see \\nPetrenko\u2122 now', 'see \\n[REDACTED]\u2122 now'],
    ['by Ivan\\nPetrenko\u2122 now', 'by [REDACTED]\u2122 now'],
    ['x\u2122tg: mark_dev', 'x\u2122[REDACTED]'],
  ])('redacts %j as %j', (text, redacted) => {
    expect(redactContacts(text, IVAN)).toBe(redacted)
    expect(scanContacts(text, IVAN).length).toBeGreaterThan(0)
  })

  it('a staged edit with a glued handle is a contact, so it is refused', () => {
    expect(hasContact('ping ivan_dev\u00B2 now', [IVAN])).toBe(true)
    expect(hasContact('by Petrenko\u2122 now', [IVAN])).toBe(true)
    expect(hasContact('by Ivan only', [IVAN])).toBe(false)
  })
})

describe("main's spans map back through the NFC offsets", () => {
  // `x™tg: mark_dev` is a label only main's pass reads (NFKC glues `TM` to `tg`), so its span
  // comes through the NFC maps; the text before it is NFD, a conjoining jamo pair, leading marks
  // or two Bengali marks that NFC composes into one.
  it.each([
    ['é x™tg: mark_dev', 'é x™[REDACTED]'],
    ['́́x™tg: mark_dev', '́́x™[REDACTED]'],
    ['ো x™tg: mark_dev', 'ো x™[REDACTED]'],
    ['가 x™tg: mark_dev', '가 x™[REDACTED]'],
    ['x™tg: mark_dev́́ ok', 'x™[REDACTED]́́ ok'],
  ])('redacts %j as %j', (text, redacted) => {
    expect(redactContacts(text, IVAN)).toBe(redacted)
  })
})

describe('rules both passes share (each pass alone would still redact these)', () => {
  it.each([
    [{ fullName: 'Wei Li', emails: [] }, 'by Li today', 'by [REDACTED] today'],
    [{ fullName: 'Wei Li', emails: [] }, 'by Wei today', 'by Wei today'],
    [
      { fullName: 'O’Neil Smith', emails: [] },
      "by O'Neil Smith and Smith",
      'by [REDACTED] and [REDACTED]',
    ],
    [IVAN, 'ping ivan_dev now, @ivan_dev too', 'ping [REDACTED] now, [REDACTED] too'],
    [IVAN, 'ping ivan_dev2 and xivan_dev', 'ping ivan_dev2 and xivan_dev'],
  ])('with %j redacts %j as %j', (ctx, text, redacted) => {
    expect(redactContacts(text, ctx)).toBe(redacted)
  })
})

describe('never worse than main, on random text (SR-H-4)', () => {
  const ATOMS = [
    'Ivan',
    'Petrenko',
    'ivan_dev',
    '@',
    ' ',
    '\u00B2',
    '\u2122',
    '\uFF58',
    '\uFB01',
    '\u2116',
    '\u0301',
    '\u0903',
    '\u200B',
    '\\n',
    'x',
    '7',
    '#',
    '-',
    '\u0085',
    '\u0000',
    '\uAC00',
  ]
  // a seeded generator, so a failure reproduces
  let seed = 1351
  const next = () => (seed = (seed * 48271) % 2147483647)

  it('the copied matcher hits what main hits', () => {
    expect(mainHits('by Petrenko now', IVAN)).toBe(true)
    expect(mainHits('by Ivan\\nPetrenko™', IVAN)).toBe(true)
    expect(mainHits('ping @ivan_dev²', IVAN)).toBe(true)
    expect(mainHits('by Petrenkox or ivan_dev2', IVAN)).toBe(false)
  })

  it('main finds no name or handle in any redacted output', () => {
    const stillHit: string[] = []
    let mainHitCount = 0
    for (let i = 0; i < 3000; i++) {
      const length = 1 + (next() % 8)
      const text = Array.from({ length }, () => ATOMS[next() % ATOMS.length]).join('')
      if (mainHits(text, IVAN)) mainHitCount++
      const redacted = redactContacts(text, IVAN)
      if (mainHits(redacted, IVAN)) stillHit.push(redacted)
    }
    expect(stillHit).toEqual([])
    // main hits often enough that the property is not vacuous
    expect(mainHitCount).toBeGreaterThan(300)
  })
})

describe('control characters and a bare mark (findings 3, 4, SR-M-4)', () => {
  it.each([
    [IVAN, 'by Ivan\u200BPetrenko\u0903x', 'by [REDACTED]x'],
    [IVAN, 'Ivan P\u0000etrenko', '[REDACTED]'],
    [IVAN, 'by Ivan\u0085Petrenko and Petrenko\u001F', 'by [REDACTED] and [REDACTED]\u001F'],
    [{ fullName: 'Ivan\u0085Petrenko', emails: [] }, 'by Ivan Petrenko', 'by [REDACTED]'],
  ])('with %j redacts %j as %j', (ctx, text, redacted) => {
    expect(redactContacts(text, ctx)).toBe(redacted)
    expect(scanContacts(text, ctx).length).toBeGreaterThan(0)
  })
})

describe('the split reading of a stored name (finding 5, CR-M-3, Addenda B and C)', () => {
  const stored = (fullName: string): ContactContext => ({ fullName, emails: [] })

  it.each([
    // the joined reading has two parts: a fragment under three letters never pairs or stands alone
    ['Ivan Petrenko\u200BKovalenko', 'Ivan Kovalenko', '[REDACTED]'],
    ['Ivan Petrenko\u200BKovalenko', 'Kovalenko Ivan', '[REDACTED]'],
    ['Ivan Petrenko\u200BKovalenko', 'Petrenko', '[REDACTED]'],
    ['Ivan Petrenko\u200BKovalenko', 'Kovalenko', '[REDACTED]'],
    [
      'Ivan Petr\u200Cin',
      'Ivan in Kyiv since 2020, Ivan Petrin',
      'Ivan in Kyiv since 2020, [REDACTED]',
    ],
    ['Ivan Petren\u200Cko', 'ok ko, Ivan ko, Ivan Petrenko', 'ok ko, Ivan ko, [REDACTED]'],
    [
      'Ivan\u200BOlegovych Petrenko',
      'Ivan Petrenko, Ivan Olegovych Petrenko',
      '[REDACTED], [REDACTED]',
    ],
    // the joined reading has one part: the split parts are the name, a two-letter surname included
    ['Wei\u200BLi', 'Li, Wei Li, Li Wei', '[REDACTED], [REDACTED], [REDACTED]'],
    ['Wei\u200BLi', 'by Wei today', 'by Wei today'],
    // Assumption (Addendum C vs CR-M-3): with a joined reading of two parts, a two-letter split
    // part is read as a fragment, so `Li` here neither pairs nor stands alone, as `in` must not
    ['Ivan Petrenko\u200BLi', 'Ivan Li, Li Ivan, Li', 'Ivan Li, Li Ivan, Li'],
    ['Ivan Petrenko\u200BLi', 'by Ivan Petrenko', 'by [REDACTED]'],
  ])('stored %j redacts %j as %j', (fullName, text, redacted) => {
    expect(redactContacts(text, stored(fullName))).toBe(redacted)
  })

  it('Ivan Kovalenko is flagged and its redacted output keeps no name part', () => {
    const ctx = stored('Ivan Petrenko\u200BKovalenko')
    for (const text of ['Ivan Kovalenko', 'Petrenko']) {
      expect(scanContacts(text, ctx).length).toBeGreaterThan(0)
      expect(redactContacts(text, ctx)).not.toMatch(/Ivan|Petrenko|Kovalenko/u)
    }
  })
})
