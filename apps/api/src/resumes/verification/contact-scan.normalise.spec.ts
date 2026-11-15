/**
 * Contact scanner: zero-width / fullwidth normalisation (task 444) and year lists (task 445).
 */
import { describe, expect, it } from 'vitest'
import { redactContacts, scanContacts } from './contact-scan'

const ctx = {
  fullName: 'Mark Levin',
  emails: ['mark@example.com'],
  telegram: 'mark_dev',
}

describe('redactContacts and scanContacts — zero-width and fullwidth (Task 444 AC 2)', () => {
  it('redacts email with zero-width characters: j\\u200Bohn@x.com', () => {
    expect(redactContacts('j\u200Bohn@x.com', ctx)).toBe('[REDACTED]')
    expect(redactContacts('email: j\u200Bohn@x.com ok', ctx)).toBe('email: [REDACTED] ok')
  })

  it('redacts email with fullwidth characters: ｊｏｈｎ＠ｘ．ｃｏｍ', () => {
    expect(redactContacts('ｊｏｈｎ＠ｘ．ｃｏｍ', ctx)).toBe('[REDACTED]')
    expect(redactContacts('reach ｊｏｈｎ＠ｘ．ｃｏｍ now', ctx)).toBe('reach [REDACTED] now')
  })

  it('scans email with zero-width and fullwidth characters', () => {
    expect(scanContacts('j\u200Bohn@x.com', ctx)).toEqual([
      { kind: 'email', match: 'j\u200Bohn@x.com' },
    ])
    expect(scanContacts('ｊｏｈｎ＠ｘ．ｃｏｍ', ctx)).toEqual([
      { kind: 'email', match: 'ｊｏｈｎ＠ｘ．ｃｏｍ' },
    ])
  })

  it('returns plain text without contacts byte-identical', () => {
    const plain = 'Senior Frontend Engineer with 10 years experience'
    expect(redactContacts(plain, ctx)).toBe(plain)
    const emptyContacts = 'no contacts here'
    expect(redactContacts(emptyContacts, ctx)).toBe(emptyContacts)
  })
})

describe('redactContacts and scanContacts — year lists (Task 445 AC 3)', () => {
  it.each(['2019 · 2020 · 2021', '1999—2003—2007', '1999–2003–2007'])(
    'does not redact year lists: %s',
    (years) => {
      expect(redactContacts(`Active in ${years} on projects`, ctx)).toBe(
        `Active in ${years} on projects`,
      )
      expect(scanContacts(years, ctx)).toEqual([])
    },
  )

  it.each([
    ['+380 67 123 45 67', 'call [REDACTED]'],
    ['067-123-45-67', 'call [REDACTED]'],
  ])('still redacts real phone numbers: %s', (phone, expected) => {
    expect(redactContacts(`call ${phone}`, ctx)).toBe(expected)
    expect(scanContacts(`call ${phone}`, ctx)).toEqual([{ kind: 'phone', match: phone }])
  })
})
