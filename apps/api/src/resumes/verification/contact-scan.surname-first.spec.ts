/**
 * Backlog 464 and 466: the surname of a surname-first legal name, and the cap on name sources.
 *
 * 464 — the joined reading of a stored name matched the full name and its LAST part alone. A legal
 * name stored surname first (`Петренко Іван`, the order contracts use) therefore redacted the given
 * name alone and left the real surname, written alone, in the text. The redaction now also matches
 * the FIRST part of a multi-part name alone, unless the normal-order spelling of the same name
 * (`displayName`) confirms the last part is the surname.
 *
 * 466 — a stored name split by zero-width spaces into many parts built one source per part and per
 * order. Past `MAX_NAME_SOURCES` the redaction stops building them and redacts the field whole,
 * which removes the name and costs nothing.
 *
 * The gate scan (`scanContacts`) is NOT widened by either (owner rule): it refuses a submission, so
 * a new hit there would refuse honest text. Every name here is invented.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_NAME_SOURCES,
  nameSources,
  redactContacts,
  scanContacts,
  type ContactContext,
} from './contact-scan'

/** A `legalFullName` context: stored surname first, as the runner marks it. */
const ctx = (fullName: string, normalOrderName?: string): ContactContext => ({
  fullName,
  emails: [],
  surnameFirst: true,
  ...(normalOrderName === undefined ? {} : { normalOrderName }),
})

/** A `displayName` context: normal order, unmarked, so main's last-part rule stands. */
const displayCtx = (fullName: string): ContactContext => ({ fullName, emails: [] })

const ZWSP = '​'

/** The legal order contracts use: surname first. Invented. */
const LEGAL = 'Петренко Іван'
/** The same invented person, normal order, as a `displayName` is written. */
const DISPLAY_LATIN = 'Ivan Petrenko'

describe('464: the surname of a surname-first legal name is redacted alone', () => {
  it('redacts the surname alone in the stored script', () => {
    expect(redactContacts('Reviewed by Петренко last week', [ctx(LEGAL)])).toBe(
      'Reviewed by [REDACTED] last week',
    )
  })

  it('redacts the surname alone in its Latin reading (4 letters or more)', () => {
    expect(redactContacts('Reviewed by Petrenko last week', [ctx(LEGAL)])).toBe(
      'Reviewed by [REDACTED] last week',
    )
  })

  it('still redacts the given name alone, as before (the last part is kept)', () => {
    expect(redactContacts('Reviewed by Іван last week', [ctx(LEGAL)])).toBe(
      'Reviewed by [REDACTED] last week',
    )
  })

  it('still redacts the full name in the stored order', () => {
    expect(redactContacts('Петренко Іван signed', [ctx(LEGAL)])).toBe('[REDACTED] signed')
  })

  it('keeps a part under four letters out of the Latin pass (latinLone still applies)', () => {
    // `Ян` alone reads as the English `an`: matched in the stored script only, both edges
    expect(redactContacts('an hour of work', [ctx('Ян Коваленко')])).toBe('an hour of work')
    expect(redactContacts('Ян again', [ctx('Ян Коваленко')])).toBe('[REDACTED] again')
  })

  it('redacts the surname alone of a surname-first name with a patronymic', () => {
    const name = 'Коваленко Андрій Юрійович'
    expect(redactContacts('by Коваленко', [ctx(name)])).toBe('by [REDACTED]')
    expect(redactContacts('by Kovalenko', [ctx(name)])).toBe('by [REDACTED]')
  })

  it('leaves a one-part name with one lone source', () => {
    expect(redactContacts('Петренко alone', [ctx('Петренко')])).toBe('[REDACTED] alone')
  })
})

describe('464: a normal-order name adds no first-part source when displayName decides', () => {
  it('leaves the given name of a normal-order legal name when displayName confirms the surname', () => {
    const normalOrder = ctx('Іван Петренко', DISPLAY_LATIN)
    expect(redactContacts('Іван Петренко signed', [normalOrder])).toBe('[REDACTED] signed')
    expect(redactContacts('Петренко signed', [normalOrder])).toBe('[REDACTED] signed')
    // the first part is not a surname here, so it is not matched alone
    expect(redactContacts('Іван signed', [normalOrder])).toBe('Іван signed')
  })

  it('picks the first part when displayName names it as the surname', () => {
    const surnameFirst = ctx(LEGAL, DISPLAY_LATIN)
    expect(redactContacts('by Петренко', [surnameFirst])).toBe('by [REDACTED]')
    expect(redactContacts('by Petrenko', [surnameFirst])).toBe('by [REDACTED]')
  })

  it.each([LEGAL, `  ${LEGAL.replace(' ', '   ')}  `, LEGAL.toLowerCase()])(
    'matches both edges when displayName repeats the stored name as %j (nothing is decided)',
    (display) => {
      const same = ctx(LEGAL, display)
      expect(redactContacts('by Петренко', [same])).toBe('by [REDACTED]')
      expect(redactContacts('by Іван', [same])).toBe('by [REDACTED]')
    },
  )

  it('matches both edges when normalOrderName is blank', () => {
    for (const display of ['', '   ']) {
      expect(redactContacts('by Петренко', [ctx(LEGAL, display)])).toBe('by [REDACTED]')
      expect(redactContacts('by Іван', [ctx(LEGAL, display)])).toBe('by [REDACTED]')
    }
  })

  it('matches both edges when displayName shares no part with the stored name', () => {
    const other = ctx(LEGAL, 'Olena Shevchuk')
    expect(redactContacts('by Петренко', [other])).toBe('by [REDACTED]')
    expect(redactContacts('by Іван', [other])).toBe('by [REDACTED]')
  })

  it('decides the wrong edge when the displayName is itself written surname first (a known limit)', () => {
    // the normal-order spelling is ASSUMED given-name first: `Petrenko Ivan` names `Ivan` as the
    // surname, so the first part is not added and the real surname is left standing. Recorded in
    // spec §11 Q1 as the limit of this fix, not fixed here: nothing in the row says which order it is
    const misread = ctx(LEGAL, 'Petrenko Ivan')
    expect(redactContacts('by Петренко', [misread])).toBe('by Петренко')
    expect(redactContacts('by Іван', [misread])).toBe('by [REDACTED]')
  })

  it('decides on a stored-script displayName too', () => {
    const decided = ctx('Іван Петренко', 'Іван Петренко-Коваль')
    // the display surname is `Петренко-Коваль`, which is neither edge: nothing is decided
    expect(redactContacts('by Іван', [decided])).toBe('by [REDACTED]')
  })
})

describe('464: an unmarked context keeps main the last-part rule', () => {
  it('leaves the first part of a displayName context alone, as before', () => {
    expect(redactContacts('Reviewed by Іван', [displayCtx('Іван Петренко')])).toBe(
      'Reviewed by Іван',
    )
    expect(redactContacts('Reviewed by Петренко', [displayCtx('Іван Петренко')])).toBe(
      'Reviewed by [REDACTED]',
    )
  })

  it('leaves the surname of a surname-first name unmarked, which is the backlog 464 symptom', () => {
    // the whole point of the marker: without it the behaviour is main's, unchanged
    expect(redactContacts('Reviewed by Петренко', [displayCtx(LEGAL)])).toBe('Reviewed by Петренко')
  })

  it('redacts both names when the display and legal contexts are scanned together', () => {
    const contacts = [displayCtx(DISPLAY_LATIN), ctx(LEGAL, DISPLAY_LATIN)]
    expect(redactContacts('by Петренко and Petrenko', contacts)).toBe(
      'by [REDACTED] and [REDACTED]',
    )
    // the given name alone was already redacted before this change: it is the LAST part of the
    // surname-first legal name, which both passes have always matched alone (the backlog 464 symptom)
    expect(redactContacts('by Іван and Ivan', contacts)).toBe('by [REDACTED] and [REDACTED]')
  })
})

describe('464: the gate scan is not widened', () => {
  it.each([
    ['Петренко', LEGAL],
    ['Petrenko', LEGAL],
    ['Kovalenko', 'Коваленко Андрій Юрійович'],
  ])('scanContacts reports no name hit on %j alone', (text, fullName) => {
    expect(scanContacts(`Reviewed by ${text} last week`, ctx(fullName))).toEqual([])
  })

  it('scanContacts still reports the last part alone, as before', () => {
    expect(scanContacts('Reviewed by Іван', ctx(LEGAL)).map((h) => h.kind)).toEqual(['name'])
  })

  it('scanContacts ignores normalOrderName entirely', () => {
    const text = 'Reviewed by Петренко last week'
    expect(scanContacts(text, ctx(LEGAL, DISPLAY_LATIN))).toEqual(scanContacts(text, ctx(LEGAL)))
  })
})

describe('466: the name sources of one pass are capped', () => {
  /** The worst ZWSP-split name the field length limits admit: `displayName` is capped at 255. */
  const worstSplit = (chars: number): string =>
    Array.from({ length: Math.floor(chars / 3) }, (_, i) => `Б${'аеиоу'[i % 5] as string}`).join(
      ZWSP,
    )

  it('runs at most MAX_NAME_SOURCES sources for a name at the field length limit', () => {
    const name = worstSplit(255)
    expect(name.length).toBeLessThanOrEqual(255)
    const { sources, capped } = nameSources(ctx(name), true, name)
    expect(capped).toBe(true)
    expect(sources.length).toBeLessThanOrEqual(MAX_NAME_SOURCES)
  })

  it('redacts the field whole when the name is past the cap, so the name is still removed', () => {
    const name = worstSplit(255)
    const part = name.split(ZWSP)[3] as string
    const redacted = redactContacts(`Worked with ${part} on the platform`, [ctx(name)])
    expect(redacted).toBe('[REDACTED]')
    expect(redacted).not.toContain(part)
  })

  it('leaves an ordinary name, and an adversarial one just under the cap, uncapped', () => {
    for (const name of ['Іван Петренко', 'Коваленко Андрій Юрійович', worstSplit(60)]) {
      const { sources, capped } = nameSources(ctx(name), true, name)
      expect(capped).toBe(false)
      expect(sources.length).toBeLessThanOrEqual(MAX_NAME_SOURCES)
      expect(redactContacts(`by ${name} today`, [ctx(name)])).not.toBe('[REDACTED]')
    }
  })

  /** A ZWSP-split name of `two` two-letter parts and `one` one-letter parts: the count steps by 2. */
  const sized = (two: number, one: number): string =>
    [
      ...Array.from({ length: two }, (_, i) => `Б${'аеиоу'[i % 5] as string}`),
      ...Array.from({ length: one }, (_, i) => 'бвгдж'[i % 5] as string),
    ].join(ZWSP)

  it('admits a name of exactly MAX_NAME_SOURCES sources and caps the next one up', () => {
    const atCap = nameSources(ctx(sized(18, 5)), true, '')
    expect(atCap.sources.length).toBe(MAX_NAME_SOURCES)
    expect(atCap.capped).toBe(false)
    const overCap = nameSources(ctx(sized(19, 5)), true, '')
    expect(overCap.capped).toBe(true)
    expect(overCap.sources).toEqual([])
  })

  it('builds one lone source per reading for a one-part surname-first name', () => {
    // the joined source and the lone source are the same part: 2 per reading, stored and Latin
    expect(nameSources(ctx('Петренко'), true, '').sources.length).toBe(4)
    // two parts add the first part as the second possible surname: 3 per reading
    expect(nameSources(ctx(LEGAL), true, '').sources.length).toBe(6)
  })

  it('does not cap the gate scan: its source count is unchanged past the cap', () => {
    const name = worstSplit(255)
    const { sources, capped } = nameSources(ctx(name), false, name)
    expect(capped).toBe(false)
    expect(sources.length).toBeGreaterThan(MAX_NAME_SOURCES)
  })

  it('still reports the gate hit on a name past the redaction cap (the gate is not narrowed)', () => {
    const name = worstSplit(255)
    const part = name.split(ZWSP)[3] as string
    expect(scanContacts(`Worked with ${part} today`, ctx(name)).map((h) => h.kind)).toEqual([
      'name',
    ])
  })
})
