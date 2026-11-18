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

const ctx = (fullName: string, normalOrderName?: string): ContactContext => ({
  fullName,
  emails: [],
  ...(normalOrderName === undefined ? {} : { normalOrderName }),
})

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

  it('matches both edges when displayName repeats the stored name (nothing is decided)', () => {
    const same = ctx(LEGAL, LEGAL)
    expect(redactContacts('by Петренко', [same])).toBe('by [REDACTED]')
    expect(redactContacts('by Іван', [same])).toBe('by [REDACTED]')
  })

  it('matches both edges when displayName shares no part with the stored name', () => {
    const other = ctx(LEGAL, 'Olena Shevchuk')
    expect(redactContacts('by Петренко', [other])).toBe('by [REDACTED]')
    expect(redactContacts('by Іван', [other])).toBe('by [REDACTED]')
  })

  it('decides on a stored-script displayName too', () => {
    const decided = ctx('Іван Петренко', 'Іван Петренко-Коваль')
    // the display surname is `Петренко-Коваль`, which is neither edge: nothing is decided
    expect(redactContacts('by Іван', [decided])).toBe('by [REDACTED]')
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

  it('caps on the stored half alone, before any Latin reading is built', () => {
    // 126 stored sources, 252 with the Latin readings: past the cap only once both halves count
    const { capped } = nameSources(ctx(worstSplit(128)), true, worstSplit(128))
    expect(capped).toBe(true)
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
