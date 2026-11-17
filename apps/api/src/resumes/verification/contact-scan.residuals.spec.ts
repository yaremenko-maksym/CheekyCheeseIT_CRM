/**
 * Contact scanner residuals after PR #1351. Backlog 449: the redaction runs to a fixed point, so a
 * contact glued to another falls in the same call. Backlog 453: the gate refuses split parts of a
 * stored name joined by a hyphen or a comma (a) and in any subsequence (b); non-ASCII digits (c)
 * and a mark on a digit (e) are phones; a digit next to a name is an edge for the redaction (d).
 */
import { describe, expect, it } from 'vitest'
import { redactContacts, scanContacts, type ContactContext } from './contact-scan'

const IVAN: ContactContext = { fullName: 'Ivan Petrenko', emails: [], telegram: '@ivan_dev' }

describe('the redaction is a fixed point (449)', () => {
  it.each([
    ['0671234567Petrenko', '[REDACTED]'],
    ['tg: @ivan_dev0671234567', '[REDACTED]'],
    ['ping @ivan_dev0671234567 now', 'ping [REDACTED] now'],
    ['by Ivan Petrenko#', 'by [REDACTED]#'],
  ])('%j reads %j', (text, redacted) => {
    expect(redactContacts(text, IVAN)).toBe(redacted)
  })

  it('a contact that only a second pass finds is redacted in the same call', () => {
    // the handle is glued to the phone (`v0`, both `\w`), so it is a whole token only once the
    // phone is gone
    expect(redactContacts('ping @ivan_dev0671234567', IVAN)).toBe('ping [REDACTED]')
    expect(scanContacts('ping @ivan_dev0671234567', IVAN).map((hit) => hit.kind)).toEqual(['phone'])
  })

  it('a field that never settles is redacted whole: fail-closed', () => {
    // a stored handle equal to the placeholder hits every placeholder a pass writes
    const redacted: ContactContext = { fullName: 'Ivan Petrenko', emails: [], telegram: 'redacted' }
    expect(redactContacts('call 0671234567 today', redacted)).toBe('[REDACTED]')
    // and a field with nothing to redact is not touched by the bound
    expect(redactContacts('Senior engineer', redacted)).toBe('Senior engineer')
  })

  it('redactContacts(redactContacts(x)) === redactContacts(x) on a corpus of glued contacts', () => {
    const atoms = [
      'Ivan',
      'Petrenko',
      '@ivan_dev',
      'ivan_dev',
      '0671234567',
      '+380 67 123 45 67',
      'ivan@corp.io',
      'github.com/ivan',
      'tg: mark_dev',
      '1990',
      '#',
      '+',
      ' ',
      '-',
      'x',
      '_',
      '\u{200B}',
      '\u{0301}',
      '\u{0661}',
    ]
    let seed = 449
    const next = () => (seed = (seed * 48271) % 2147483647)
    const unstable: string[] = []
    let changed = 0
    for (let i = 0; i < 3000; i++) {
      const length = 2 + (next() % 6)
      const text = Array.from({ length }, () => atoms[next() % atoms.length]).join('')
      const once = redactContacts(text, IVAN)
      if (once !== text.normalize('NFC')) changed++
      if (redactContacts(once, IVAN) !== once) unstable.push(text)
    }
    expect(unstable).toEqual([])
    // not vacuous: most texts hold a contact
    expect(changed).toBeGreaterThan(2000)
  })
})

describe('a digit next to a name part is an edge for the redaction (453d)', () => {
  it.each([
    ['Petrenko1990', '[REDACTED]1990'],
    ['1990Petrenko', '1990[REDACTED]'],
    ['by Ivan Petrenko2020.', 'by [REDACTED]2020.'],
    ['Petrenko\u{0661}\u{0669}\u{0669}\u{0660}', '[REDACTED]\u{0661}\u{0669}\u{0669}\u{0660}'],
  ])('%j reads %j', (text, redacted) => {
    expect(redactContacts(text, IVAN)).toBe(redacted)
  })

  it('a letter is still not an edge, and the gate keeps main boundary', () => {
    expect(redactContacts('Petrenkox', IVAN)).toBe('Petrenkox')
    // main's gate reads a digit as part of the token, so the gate is unchanged: never weaker
    expect(scanContacts('Petrenko1990', IVAN)).toEqual([])
  })
})

describe('non-ASCII digits and marks on digits are phones (453c, 453e)', () => {
  it.each([
    [
      'call \u{0660}\u{0666}\u{0667}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667}',
      'call [REDACTED]',
    ],
    [
      'call \u{06F0}\u{06F6}\u{06F7} \u{06F1}\u{06F2}\u{06F3} \u{06F4}\u{06F5} \u{06F6}\u{06F7} now',
      'call [REDACTED] now',
    ],
    ['call 067\u{0301} 123 45 67', 'call [REDACTED]'],
    ['call 06\u{0300}7 123 45 67', 'call [REDACTED]'],
    ['call \u{104A0}\u{104A6}\u{104A7}1234567', 'call [REDACTED]'],
  ])('%j reads %j', (text, redacted) => {
    expect(redactContacts(text, [])).toBe(redacted)
    expect(scanContacts(text, IVAN).map((hit) => hit.kind)).toEqual(['phone'])
  })

  it('a mark on the surname is still redacted, as on main', () => {
    const petrin: ContactContext = { fullName: 'Ivan Petrin', emails: [] }
    expect(redactContacts('by Petrin\u{0301} now', petrin)).toBe('by [REDACTED] now')
    expect(redactContacts('by Petrin\u{0353} now', petrin)).toBe('by [REDACTED] now')
    expect(scanContacts('by Petrin\u{0353}', petrin).map((hit) => hit.kind)).toEqual(['name'])
    // S2 (AC6): the gate row for the mark the task names; the leak on main is recorded in the PR body
    expect(scanContacts('by Petrin\u{0301}', petrin).map((hit) => hit.kind)).toEqual(['name'])
  })

  it('a year list in Arabic-Indic digits is not a phone', () => {
    const years =
      '\u{0662}\u{0660}\u{0661}\u{0669} \u{00B7} \u{0662}\u{0660}\u{0662}\u{0660} \u{00B7} \u{0662}\u{0660}\u{0662}\u{0661}'
    expect(redactContacts(years, [])).toBe(years)
  })

  // the differential against main: the fold must not take away the edge a non-ASCII digit was
  it.each([
    ['\u{0661}www.site.devBo', '\u{0661}[REDACTED]'],
    ['\u{0661}www.site.dev today', '\u{0661}[REDACTED] today'],
    // the NFKC pass reads `xhttps://x.io/p` and takes the fullwidth `x` too
    ['@\u{0661}\u{FF58}https://x.io/p', '@\u{0661}[REDACTED]'],
  ])('a URL after a non-ASCII digit %j is still redacted, as on main', (text, redacted) => {
    expect(redactContacts(text, [])).toBe(redacted)
    expect(scanContacts(text, IVAN).map((hit) => hit.kind)).toEqual(['url'])
  })
})

describe('the gate refuses split parts joined by a hyphen or a comma (453a)', () => {
  const liYu: ContactContext = { fullName: 'Ivan Li\u{200B}Yu', emails: [] }

  it.each(['Li Yu', 'Li-Yu', 'Li - Yu', 'Li, Yu', 'Li ,Yu', 'Yu-Li', 'Yu, Li', 'Li\u{2010}Yu'])(
    'refuses %j',
    (text) => {
      expect(scanContacts(`by ${text} today`, liYu).map((hit) => hit.kind)).toEqual(['name'])
    },
  )

  // one row per joiner the run gap takes beyond the hyphen and comma above (backlog 453a, fix item 10)
  it.each([
    'Li\u{2012}Yu',
    'Li\u{2013}Yu',
    'Li\u{2014}Yu',
    'Li\u{2015}Yu',
    'Li\u{2011}Yu',
    'Li\u{2212}Yu',
    'Li.Yu',
    'Li_Yu',
    'Li\u{00B7}Yu',
  ])('refuses %j: joiner added with the dash family and . _ middle dot', (text) => {
    expect(scanContacts(`by ${text} today`, liYu).map((hit) => hit.kind)).toEqual(['name'])
  })

  it.each(['Li; Yu', 'Li / Yu', 'Li--Yu', 'Li,, Yu', 'Li and Yu'])(
    'passes %j: not a joiner the gate takes',
    (text) => {
      expect(scanContacts(`by ${text} today`, liYu)).toEqual([])
    },
  )

  it('ordinary text still passes for a fragment split stored name', () => {
    const petrin: ContactContext = { fullName: 'Ivan Petr\u{200C}in', emails: [] }
    expect(scanContacts('Senior engineer in Kyiv since 2020', petrin)).toEqual([])
    expect(scanContacts('Senior engineer, in Kyiv since 2020', petrin)).toEqual([])
  })
})

describe('the gate refuses non-adjacent split parts (453b)', () => {
  const liYuBo: ContactContext = { fullName: 'Ivan Li\u{200B}Yu\u{200B}Bo', emails: [] }

  // `LI BO`: the in-text filter on the parts folds case like the match does
  it.each(['Li Bo', 'Bo Li', 'Li-Bo', 'Bo, Li', 'Li Yu Bo', 'Yu Bo', 'Bo Yu Li', 'LI BO', 'bo li'])(
    'refuses %j',
    (text) => {
      expect(scanContacts(`by ${text} today`, liYuBo).map((hit) => hit.kind)).toEqual(['name'])
    },
  )

  it('a subsequence of two letters alone is no source, as with runs', () => {
    const liBo: ContactContext = { fullName: 'Ivan L\u{200B}Y\u{200B}B', emails: [] }
    expect(scanContacts('by L B today', liBo)).toEqual([])
  })

  it('a stored name past the bound keeps round 7 gate: lone parts refuse, subsequences add none', () => {
    const many = Array.from({ length: 9 }, (_, i) => ['Li', 'Yu', 'Bo'][i % 3] ?? '').join(
      '\u{200B}',
    )
    const stored: ContactContext = { fullName: `Ivan ${many}`, emails: [] }
    expect(scanContacts('by Li today', stored)).toEqual([{ kind: 'name', match: 'Li' }])
  })
})
