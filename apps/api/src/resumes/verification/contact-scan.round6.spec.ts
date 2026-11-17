/**
 * PR #1351 fix round 6: the redaction is never worse than main. It redacts the union of its own
 * spans and the spans main's matcher finds on the same text (SR-H-4), so a compatibility character
 * glued to a contact (`²`, `™`, fullwidth letters, ligatures) no longer hides it. Plus control
 * characters (findings 3, 4), a bare mark as an edge (SR-M-4) and the split reading of a stored
 * name (finding 5, CR-M-3, Addenda B and C). Round 7: the oracle is main's own code, the property
 * compares spans, main's arms are pinned (CR-M-6) and the split reading is redacted whole.
 */
import {
  findPhoneSpans,
  normaliseTelegramHandle,
  RESUME_EMAIL_PATTERN,
  RESUME_TELEGRAM_LABEL_PATTERN,
  RESUME_URL_PATTERN,
} from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { hasContact } from './content-gates'
import {
  mainSpans,
  redactContacts,
  redactedSpans,
  scanContacts,
  type ContactContext,
} from './contact-scan'

const IVAN: ContactContext = { fullName: 'Ivan Petrenko', emails: [], telegram: 'ivan_dev' }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/*
 * Main's matcher, copied from main @ 267885ded so the test shares no code with the redaction it
 * checks (round 7, Addendum S finding 4): main's own `foldAccents` and `UNDECOMPOSED`, its
 * whole-token name patterns and its `\w` handle. The generic patterns come from `@crm/shared`: the
 * URL, label and email patterns and `normaliseTelegramHandle` are unchanged since main, and
 * `findPhoneSpans` changed on purpose (year runs are not phones, backlog 444).
 */
const MAIN_UNDECOMPOSED: Record<string, string> = {
  ł: 'l',
  Ł: 'L',
  ø: 'o',
  Ø: 'O',
  đ: 'd',
  Đ: 'D',
  ß: 'ss',
  ẞ: 'SS',
  ı: 'i',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  þ: 'th',
  Þ: 'TH',
  ħ: 'h',
  Ħ: 'H',
}

function mainFoldAccents(text: string): { text: string; from: number[]; to: number[] } {
  let folded = ''
  const from: number[] = []
  const to: number[] = []
  for (const { 0: cluster, index } of text.matchAll(/\P{M}\p{M}*/gu)) {
    const base = cluster.normalize('NFD').replace(/\p{M}/gu, '')
    const piece = MAIN_UNDECOMPOSED[base] ?? base
    folded += piece
    for (let k = 0; k < piece.length; k++) {
      from.push(index)
      to.push(index + cluster.length)
    }
  }
  return { text: folded, from, to }
}

type MainSpan = { kind: 'generic' | 'telegram' | 'name'; start: number; end: number }

/** Main's spans on `text.normalize('NFC')`, in its offsets. */
function mainOracleSpans(text: string, ctx: ContactContext): MainSpan[] {
  const plain = text.normalize('NFC').replace(/[’ʼ‘]/gu, "'")
  const spans: MainSpan[] = []
  const global = (p: RegExp) => new RegExp(p.source, `${p.flags}g`)
  const literalEmails = ctx.emails
    .map((email) => email.normalize('NFC').trim())
    .filter(Boolean)
    .map((email) => new RegExp(escapeRegExp(email), 'giu'))
  for (const pattern of [
    global(RESUME_URL_PATTERN),
    global(RESUME_TELEGRAM_LABEL_PATTERN),
    ...literalEmails,
  ]) {
    for (const m of plain.matchAll(pattern)) {
      const end = m.index + m[0].length
      spans.push({ kind: 'generic', start: end - (m[1] ?? m[0]).length, end })
    }
  }
  const email = new RegExp(RESUME_EMAIL_PATTERN.source, 'gu')
  for (let m = email.exec(plain); m; m = email.exec(plain)) {
    const end = m.index + m[0].length
    const start = end - (m[1] ?? m[0]).length
    spans.push({ kind: 'generic', start, end })
    email.lastIndex = start + ((plain.codePointAt(start) ?? 0) >= 0x10000 ? 2 : 1)
  }
  for (const span of findPhoneSpans(plain)) spans.push({ kind: 'generic', ...span })
  const handle = normaliseTelegramHandle(ctx.telegram)
  if (handle) {
    for (const m of plain.matchAll(new RegExp(`(?<!\\w)@*${escapeRegExp(handle)}(?!\\w)`, 'giu'))) {
      spans.push({ kind: 'telegram', start: m.index, end: m.index + m[0].length })
    }
  }
  const tokenChar = '[\\p{L}\\p{N}#+]'
  const wholeToken = (source: string) =>
    new RegExp(
      `(?:(?<!${tokenChar})|(?<=\\\\(?:[bfnrt]|u[\\dA-Fa-f]{4})))${source}(?!${tokenChar})`,
      'giu',
    )
  const name = mainFoldAccents(ctx.fullName.normalize('NFC').replace(/[’ʼ‘]/gu, "'")).text
  const parts = name.trim().split(/\s+/u)
  const surname = parts.at(-1) ?? ''
  const sources = [parts.map(escapeRegExp).join('(?:\\s|\\\\[nrt])+')]
  if (surname.replace(/\P{L}/gu, '').length >= 2) sources.push(escapeRegExp(surname))
  const folded = mainFoldAccents(plain)
  for (const source of sources.filter(Boolean)) {
    for (const m of folded.text.matchAll(wholeToken(source))) {
      spans.push({
        kind: 'name',
        start: folded.from[m.index] ?? 0,
        end: folded.to[m.index + m[0].length - 1] ?? plain.length,
      })
    }
  }
  return spans
}

/** Main's redaction of `text`: its spans merged and replaced on the NFC text. */
function mainRedact(text: string, ctx: ContactContext): string {
  const nfc = text.normalize('NFC')
  const merged: { start: number; end: number }[] = []
  for (const { start, end } of mainOracleSpans(nfc, ctx).sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else merged.push({ start, end })
  }
  let result = ''
  let cursor = 0
  for (const { start, end } of merged) {
    result += `${nfc.slice(cursor, start)}[REDACTED]`
    cursor = end
  }
  return result + nfc.slice(cursor)
}

/** Whether main's matcher finds a name or a handle in `text`. */
function mainHits(text: string, ctx: ContactContext): boolean {
  return mainOracleSpans(text, ctx).some((span) => span.kind !== 'generic')
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
    ['e\u0301 x™tg: mark_dev', 'é x™[REDACTED]'],
    ['\u0301\u0301x™tg: mark_dev', '\u0301\u0301x™[REDACTED]'],
    ['\u09C7\u09BE x™tg: mark_dev', '\u09CB x™[REDACTED]'],
    ['\u1100\u1161 x™tg: mark_dev', '가 x™[REDACTED]'],
    ['x™tg: mark_dev\u0301\u0301 ok', 'x™[REDACTED]\u0301\u0301 ok'],
    // the apostrophe fold keeps the length, so offsets after a U+2019 stay put
    ['it’s x™tg: mark_dev', 'it’s x™[REDACTED]'],
    ['it’s by Ivan Petrenko now', 'it’s by [REDACTED] now'],
  ])('redacts %j as %j', (text, redacted) => {
    expect(redactContacts(text, IVAN)).toBe(redacted)
  })
})

describe('rules both passes share (each pass alone would still redact these)', () => {
  it.each([
    [{ fullName: 'Wei Li', emails: [] }, 'by Li today', 'by [REDACTED] today'],
    [{ fullName: 'Wei Li', emails: [] }, 'by Wei today', 'by Wei today'],
    // only the own pass reads a compat letter as an edge, so this pins its two-letter surname rule
    [{ fullName: 'Wei Li', emails: [] }, 'by Liｘ today', 'by [REDACTED]ｘ today'],
    [
      { fullName: 'O’Neil Smith', emails: [] },
      "by O'Neil Smith and Smith",
      'by [REDACTED] and [REDACTED]',
    ],
    // the apostrophe is folded to `'`, not dropped: `ONeil` is not the stored first name
    [{ fullName: 'O’Neil Smith', emails: [] }, 'by ONeil Smith', 'by ONeil [REDACTED]'],
    [IVAN, 'ping ivan_dev now, @ivan_dev too', 'ping [REDACTED] now, [REDACTED] too'],
    [IVAN, 'ping ivan_dev2 and xivan_dev', 'ping ivan_dev2 and xivan_dev'],
  ])('with %j redacts %j as %j', (ctx, text, redacted) => {
    expect(redactContacts(text, ctx)).toBe(redacted)
  })
})

describe('never worse than main, on random text (SR-H-4, round 7 SPEC-L-1)', () => {
  const ATOMS = [
    'Ivan',
    'Petrenko',
    'ivan_dev',
    '@',
    ' ',
    '²',
    '™',
    'ｘ',
    'ﬁ',
    '№',
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
    '가',
    // the generic patterns: emails, URLs, phones and a label
    'ivan@corp.io',
    'a.b@mail.example.org',
    'https://x.io/p',
    'www.site.dev',
    'github.com/ivan',
    '+380 67 123 45 67',
    '0671234567',
    'tg: mark_dev',
  ]
  const CTX: ContactContext = { ...IVAN, emails: ['Ivan@Corp.io'] }
  // a seeded generator, so a failure reproduces
  let seed = 1351
  const next = () => (seed = (seed * 48271) % 2147483647)

  it('the copied matcher hits what main hits', () => {
    expect(mainHits('by Petrenko now', IVAN)).toBe(true)
    expect(mainHits('by Ivan\\nPetrenko™', IVAN)).toBe(true)
    expect(mainHits('ping @ivan_dev²', IVAN)).toBe(true)
    expect(mainHits('by Petrenkox or ivan_dev2', IVAN)).toBe(false)
    expect(mainOracleSpans('mail a@b.io or +380 67 123 45 67', IVAN)).toEqual([
      { kind: 'generic', start: 5, end: 11 },
      { kind: 'generic', start: 15, end: 32 },
    ])
  })

  it('every span main redacts lies inside a span the head redacts', () => {
    const uncovered: string[] = []
    let nfcTexts = 0
    let notFixed = 0
    let mainSpanCount = 0
    let genericCount = 0
    let nonNfcTexts = 0
    let nonNfcSpanCount = 0
    for (let i = 0; i < 3000; i++) {
      const length = 1 + (next() % 8)
      const text = Array.from({ length }, () => ATOMS[next() % ATOMS.length]).join('')
      if (text !== text.normalize('NFC')) {
        nonNfcTexts++
        // the outputs too: main's own output is a fixed point here (a contact glued to a phone is
        // not, on main either: backlog 449)
        if (mainHits(mainRedact(text, CTX), CTX)) notFixed++
        else if (mainHits(redactContacts(text, CTX), CTX)) uncovered.push(text)
        // and every span, emails, URLs and phones included: main's offsets are NFC offsets, so the
        // head spans are taken to NFC offsets through the NFC of the text before each edge
        const nfcOffset = (offset: number) => text.slice(0, offset).normalize('NFC').length
        const head = redactedSpans(text, CTX).map((h) => ({
          start: nfcOffset(h.start),
          end: nfcOffset(h.end),
        }))
        for (const span of mainOracleSpans(text, CTX)) {
          nonNfcSpanCount++
          if (!head.some((h) => h.start <= span.start && span.end <= h.end)) uncovered.push(text)
        }
        continue
      }
      nfcTexts++
      const head = redactedSpans(text, CTX)
      for (const span of mainOracleSpans(text, CTX)) {
        mainSpanCount++
        if (span.kind === 'generic') genericCount++
        if (!head.some((h) => h.start <= span.start && span.end <= h.end)) uncovered.push(text)
      }
    }
    expect(uncovered).toEqual([])
    // the property is not vacuous: most texts are NFC, and main finds names, handles and generics
    expect(nfcTexts).toBeGreaterThan(2000)
    expect(mainSpanCount).toBeGreaterThan(1000)
    expect(genericCount).toBeGreaterThan(300)
    expect(notFixed).toBeLessThan(100)
    // the non-NFC branch runs and compares spans too (seed 1351: 84 texts, 130 spans of main)
    expect(nonNfcTexts).toBeGreaterThan(60)
    expect(nonNfcSpanCount).toBeGreaterThan(100)
  })
})

describe("main's name and handle arms, pinned on their own (round 7, CR-M-6)", () => {
  const names = (text: string, ctx: ContactContext = IVAN) =>
    mainSpans(text, ctx)
      .filter((span) => span.kind === 'name')
      .map(({ start, end }) => [start, end])
      .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (b[1] ?? 0) - (a[1] ?? 0))

  it.each([
    [
      'by Ivan Petrenko now',
      [
        [3, 16],
        [8, 16],
      ],
    ],
    [
      'by Ivan\\nPetrenko',
      [
        [3, 17],
        [9, 17],
      ],
    ],
    ['see \\nPetrenko', [[6, 14]]],
    ['by Pétrenko', [[3, 11]]],
    ['Petrenkox, Petrenko2, Petrenko#, Petrenko+, xPetrenko', []],
    ['by Ivan', []],
  ] as const)('finds the name in %j at %j', (text, spans) => {
    expect(names(text)).toEqual(spans)
  })

  it('takes a two-letter surname alone and a one-letter one never', () => {
    expect(names('by Li', { fullName: 'Wei Li', emails: [] })).toEqual([[3, 5]])
    expect(names('by P', { fullName: 'Ivan P', emails: [] })).toEqual([])
  })

  it('reads a stored name trimmed and split on whitespace runs', () => {
    for (const fullName of ['Ivan  Petrenko', ' Ivan Petrenko ']) {
      expect(names('by Ivan Petrenko', { fullName, emails: [] })).toEqual([
        [3, 16],
        [8, 16],
      ])
    }
  })

  it('finds the handle with its `@`s, on a `\\w` boundary', () => {
    expect(
      mainSpans('ping @@ivan_dev², ivan_dev2', IVAN)
        .filter((span) => span.kind === 'telegram')
        .map(({ start, end }) => [start, end]),
    ).toEqual([[5, 15]])
  })

  it.each([
    ['ping ivan_dev\u11A8 now', 'ping [REDACTED]\u11A8 now'],
    // non-NFC text: main's handle span maps through the NFC chunks and takes the trailing jamo
    ['e\u0301 ping ivan_dev\u11A8 now', 'é ping [REDACTED] now'],
  ])('redacts %j as %j', (text, redacted) => {
    expect(redactContacts(text, IVAN)).toBe(redacted)
  })

  it('the widened handle span is the hit scanContacts reports', () => {
    expect(scanContacts('e\u0301 ping ivan_dev\u11A8 now', IVAN)).toEqual([
      { kind: 'telegram', match: 'ivan_dev\u11A8' },
    ])
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

describe('the split reading of a stored name is redacted whole, fail-closed (round 7)', () => {
  const stored = (fullName: string): ContactContext => ({ fullName, emails: [] })

  it.each([
    // the joined reading has two parts: every pair of the first part and every later part of two
    // letters or more is redacted (finding 1, Addendum B)
    ['Ivan Petrenko\u200BKovalenko', 'Ivan Kovalenko', '[REDACTED]'],
    ['Ivan Petrenko\u200BKovalenko', 'Kovalenko Ivan', '[REDACTED]'],
    ['Ivan Petrenko\u200BKovalenko', 'Petrenko', '[REDACTED]'],
    ['Ivan Petrenko\u200BKovalenko', 'Kovalenko', '[REDACTED]'],
    ['Ivan Petrenko\u200BLi', 'Ivan Li, Li Ivan, Li', '[REDACTED], [REDACTED], [REDACTED]'],
    ['Ivan Petrenko\u200BLi', 'by Ivan Petrenko', 'by [REDACTED]'],
    ['Li Petrenko\u200BKovalenko', 'by Li Kovalenko today', 'by [REDACTED] today'],
    ['Li Petrenko\u200BKovalenko', 'Kovalenko Li', '[REDACTED]'],
    [
      'Ivan\u200BOlegovych Petrenko',
      'Ivan Petrenko, Ivan Olegovych Petrenko',
      '[REDACTED], [REDACTED]',
    ],
    // over-redaction accepted: a fragment of a real part is redacted as a part (CR-M-3, CR-M-7)
    [
      'Ivan Petr\u200Cin',
      'Ivan in Kyiv since 2020, Ivan Petrin',
      '[REDACTED] Kyiv since 2020, [REDACTED]',
    ],
    ['Ivan Petr\u200Cin', 'log in now', 'log [REDACTED] now'],
    [
      'Ivan Peter\u200Cson',
      'his son, Ivan son, Ivan Peterson',
      'his [REDACTED], [REDACTED], [REDACTED]',
    ],
    [
      'Ivan Petren\u200Cko',
      'ok ko, Ivan ko, Ivan Petrenko',
      'ok [REDACTED], [REDACTED], [REDACTED]',
    ],
    // the joined reading has one part: the split parts are the name, a two-letter surname included;
    // the first part never stands alone, as on the joined reading
    ['Wei\u200BLi', 'Li, Wei Li, Li Wei', '[REDACTED], [REDACTED], [REDACTED]'],
    ['Wei\u200BLi', 'by Li today', 'by [REDACTED] today'],
    ['Wei\u200BLi', 'by Wei today', 'by Wei today'],
    // a one-letter part neither stands alone nor shields the pair
    ['Wei\u200BY', 'by Y today, Wei Y', 'by Y today, [REDACTED]'],
  ])('stored %j redacts %j as %j', (fullName, text, redacted) => {
    expect(redactContacts(text, stored(fullName))).toBe(redacted)
  })

  it('a split-reading redaction keeps no name part', () => {
    const ctx = stored('Ivan Petrenko\u200BKovalenko')
    for (const text of ['Ivan Kovalenko', 'Petrenko']) {
      expect(redactContacts(text, ctx)).not.toMatch(/Ivan|Petrenko|Kovalenko/u)
    }
  })

  it('the gate scan takes the split reading when the joined reading has one part', () => {
    expect(scanContacts('by Li today', stored('Wei\u200BLi'))).toEqual([
      { kind: 'name', match: 'Li' },
    ])
    expect(hasContact('by Li today', [stored('Wei\u200BLi')])).toBe(true)
  })
})

describe('the gate scan keeps the split reading but its short fragments (round 8, SR-M-1, Addendum A)', () => {
  const stored = (fullName: string): ContactContext => ({ fullName, emails: [] })

  it.each([
    // the joined reading has two parts, so a lone fragment under three letters does not refuse a text
    [
      'Ivan Petr\u200Cin',
      'Senior engineer in Kyiv since 2020',
      'Senior engineer [REDACTED] Kyiv since 2020',
    ],
    ['Iv\u200Can Petrenko', 'Led an API migration', 'Led [REDACTED] API migration'],
    // the letters decide, not the length: `a-n` has three characters and two letters
    ['Ivan Petr\u200Ca-n', 'the a-n ratio', 'the [REDACTED] ratio'],
  ])('stored %j passes %j, still redacted as %j', (fullName, text, redacted) => {
    expect(scanContacts(text, stored(fullName))).toEqual([])
    expect(hasContact(text, [stored(fullName)])).toBe(false)
    // the redaction stays fail-closed on the whole split reading
    expect(redactContacts(text, stored(fullName))).toBe(redacted)
  })

  it.each([
    // every full-name order and every lone part of three letters or more still refuses
    ['Ivan Petrenko\u200BKovalenko', 'Ivan Kovalenko', 'Ivan Kovalenko', '[REDACTED]'],
    ['Ivan Petrenko\u200BKovalenko', 'Kovalenko', 'Kovalenko', '[REDACTED]'],
    // the first split part alone, not only the last (round 9, spec coverage)
    ['Ivan Petrenko\u200BKovalenko', 'Petrenko', 'Petrenko', '[REDACTED]'],
    // accepted cost: a three-letter fragment refuses ordinary text, as in round 6
    [
      'Ivan Peter\u200Cson',
      'He mentored a son of a client',
      'son',
      'He mentored a [REDACTED] of a client',
    ],
    // the joined reading has one part: a two-letter lone part refuses
    ['Wei\u200BLi', 'by Li today', 'Li', 'by [REDACTED] today'],
  ])('stored %j refuses %j on %j, redacted as %j', (fullName, text, match, redacted) => {
    expect(scanContacts(text, stored(fullName))).toEqual([{ kind: 'name', match }])
    expect(hasContact(text, [stored(fullName)])).toBe(true)
    expect(redactContacts(text, stored(fullName))).toBe(redacted)
  })

  it.each([
    // main splits a stored name on `\s`, which includes U+FEFF: main reads `in` as the surname,
    // and main's arm of the union keeps that refusal, which the own scan drops
    ['Ivan Petr\uFEFFin', 'Senior engineer in Kyiv since 2020'],
    ['Ivan Petr\uFEFFin', 'in Kyiv'],
  ])('stored %j still refuses %j, which main flags', (fullName, text) => {
    expect(scanContacts(text, stored(fullName))).toEqual([{ kind: 'name', match: 'in' }])
    expect(hasContact(text, [stored(fullName)])).toBe(true)
  })
})

describe('the gate scan keeps runs of short split parts that form the surname (round 9, SR-M-2)', () => {
  const stored = (fullName: string): ContactContext => ({ fullName, emails: [] })

  it.each([
    // two short parts are the whole surname, so the run refuses, both ways
    ['Ivan Li\u200BYu', 'Li Yu', 'Li Yu', '[REDACTED] [REDACTED]'],
    ['Ivan Li\u200BYu', 'Yu Li', 'Yu Li', '[REDACTED] [REDACTED]'],
    ['Ivan Kovalenko\u200BLi\u200BYu', 'Li Yu', 'Li Yu', '[REDACTED] [REDACTED]'],
    // three letters are enough
    ['Ivan Li\u200BU', 'by Li U today', 'Li U', 'by [REDACTED] U today'],
    // the first name joins no run: the longest hit is still the first-name pair
    [
      'Ivan Kovalenko\u200BLi\u200BYu',
      'Ivan Kovalenko Li',
      'Ivan Kovalenko',
      '[REDACTED] [REDACTED]',
    ],
  ])('stored %j refuses %j on %j, redacted as %j', (fullName, text, match, redacted) => {
    // the redaction is the round-8 redaction: runs are a gate-only source
    expect(redactContacts(text, stored(fullName))).toBe(redacted)
    expect(scanContacts(text, stored(fullName))).toEqual([{ kind: 'name', match }])
    expect(hasContact(text, [stored(fullName)])).toBe(true)
  })

  it.each([
    // a lone part under three letters still passes (Addendum A)
    ['Ivan Li\u200BYu', 'by Li today', 'by [REDACTED] today'],
    ['Ivan Li\u200BYu', 'by Yu today', 'by [REDACTED] today'],
    // a run of two letters passes: the letters of the run decide
    ['Ivan O\u200BU', 'by O U today', 'by O U today'],
    // a digit in the run is no letter
    ['Ivan O\u200BU2', 'by O U2 today', 'by O U2 today'],
    [
      'Ivan Petr\u200Cin',
      'Senior engineer in Kyiv since 2020',
      'Senior engineer [REDACTED] Kyiv since 2020',
    ],
  ])('stored %j passes %j, still redacted as %j', (fullName, text, redacted) => {
    expect(redactContacts(text, stored(fullName))).toBe(redacted)
    expect(scanContacts(text, stored(fullName))).toEqual([])
    expect(hasContact(text, [stored(fullName)])).toBe(false)
  })

  it('takes runs up to 8 split parts; past that the gate drops no short fragment (Addendum A)', () => {
    const eight = stored('Ivan Kovalenko\u200BLi\u200BYu\u200BBo\u200BLi\u200BYu\u200BBo')
    const nine = stored('Ivan Kovalenko\u200BLi\u200BYu\u200BBo\u200BLi\u200BYu\u200BBo\u200BLi')
    expect(scanContacts('Bo Yu', eight)).toEqual([{ kind: 'name', match: 'Bo Yu' }])
    expect(scanContacts('by Li today', eight)).toEqual([])
    // round 7's stricter gate: a lone two-letter part refuses
    expect(scanContacts('by Li today', nine)).toEqual([{ kind: 'name', match: 'Li' }])
    expect(redactContacts('by Li today', nine)).toBe('by [REDACTED] today')
  })
})
