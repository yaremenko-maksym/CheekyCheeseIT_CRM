import { describe, expect, it } from 'vitest'
import { expectScaling, SCALING_TEST_TIMEOUT_MS } from './__fixtures__/scaling'
import { CONTACT_TOKEN, stripContacts } from './contact-strip'

const T = CONTACT_TOKEN

type Kind = 'email' | 'phone' | 'messenger' | 'profileUrl'

/** [input, expected output, kind removed, count] */
const POSITIVE: ReadonlyArray<readonly [string, string, Kind, number]> = [
  // email
  ['Write to jane.doe@example.com today', `Write to ${T} today`, 'email', 1],
  ['(hr+jobs@corp.co.uk)', `(${T})`, 'email', 1],
  ['Mail: hr@example.com.', `Mail: ${T}.`, 'email', 1],
  ['jane [at] example [dot] com', T, 'email', 1],
  ['jane(at)example(dot)com', T, 'email', 1],
  ['jane {at} mail {dot} example {dot} org', T, 'email', 1],
  ['jane at example dot com', T, 'email', 1],
  ['JANE AT EXAMPLE DOT COM', T, 'email', 1],
  ['jane @ example.com', T, 'email', 1],
  ['jane [@] example [.] com', T, 'email', 1],
  ['олена@приклад.укр', T, 'email', 1],
  ['jane＠example．com', T, 'email', 1],
  ['ja​ne@exa‍mple.com', T, 'email', 1],
  [
    '<a href="mailto:jobs@example.com?subject=CV">apply</a>',
    `<a href="${T}">apply</a>`,
    'email',
    1,
  ],
  ['MAILTO:Jobs@Example.com', T, 'email', 1],
  ['a@b.io and c@d.io', `${T} and ${T}`, 'email', 2],
  // phone
  ['Call +380 50 123 45 67 now', `Call ${T} now`, 'phone', 1],
  ['+380501234567', T, 'phone', 1],
  ['+38 (050) 123-45-67', T, 'phone', 1],
  ['+48 512 345 678', T, 'phone', 1],
  ['+1 (415) 555-0132', T, 'phone', 1],
  ['+1-415-555-0132.', `${T}.`, 'phone', 1],
  ['tel. 050 123 45 67', `tel. ${T}`, 'phone', 1],
  ['(050) 123-45-67', T, 'phone', 1],
  ['0501234567', T, 'phone', 1],
  ['380501234567', T, 'phone', 1],
  ['00380501234567', T, 'phone', 1],
  ['PL: 512-345-678', `PL: ${T}`, 'phone', 1],
  ['US: (415) 555-0132', `US: ${T}`, 'phone', 1],
  ['US: 415.555.0132', `US: ${T}`, 'phone', 1],
  ['＋３８０５０１２３４５６７', T, 'phone', 1],
  ['+٣٨٠٥٠١٢٣٤٥٦٧', T, 'phone', 1],
  ['+380​50‎1234567', T, 'phone', 1],
  ['<a href="tel:+380501234567">call</a>', `<a href="${T}">call</a>`, 'phone', 1],
  // messenger
  ['https://t.me/jane_doe', T, 'messenger', 1],
  ['t.me/jane_doe, or', `${T}, or`, 'messenger', 1],
  ['telegram.me/jane_doe', T, 'messenger', 1],
  ['https://wa.me/380501234567', T, 'messenger', 1],
  ['https://api.whatsapp.com/send?phone=380501234567', T, 'messenger', 1],
  ['viber://chat?number=%2B380501234567', T, 'messenger', 1],
  ['tg://resolve?domain=jane_doe', T, 'messenger', 1],
  ['https://signal.me/#p/+380501234567', T, 'messenger', 1],
  ['skype:jane.doe?call', T, 'messenger', 1],
  ['Skype: live:jane.doe', T, 'messenger', 1],
  ['Telegram: jane_doe', T, 'messenger', 1],
  ['ping @jane_doe on Telegram', `ping ${T} on Telegram`, 'messenger', 1],
  ['(@hr.team)', `(${T})`, 'messenger', 1],
  // profile URL
  ['https://www.linkedin.com/in/jane-doe-123/', T, 'profileUrl', 1],
  ['linkedin.com/in/jane-doe.', `${T}.`, 'profileUrl', 1],
  ['https://ua.linkedin.com/in/jane?trk=abc', T, 'profileUrl', 1],
  ['https://linkedin.com/pub/jane-doe/1/2/3', T, 'profileUrl', 1],
  ['https://github.com/janedoe', T, 'profileUrl', 1],
  ['github.com/jane-doe/', T, 'profileUrl', 1],
  ['https://gitlab.com/janedoe', T, 'profileUrl', 1],
  ['https://x.com/janedoe', T, 'profileUrl', 1],
  ['https://twitter.com/janedoe', T, 'profileUrl', 1],
  ['https://www.facebook.com/jane.doe', T, 'profileUrl', 1],
  ['https://instagram.com/jane.doe', T, 'profileUrl', 1],
]

/** Text that must survive untouched. */
const NEGATIVE: readonly string[] = [
  'Salary 100 000 - 150 000 UAH',
  'Salary $5000-7000 gross',
  'Posted 2026-11-03 10:00',
  'Experience 3+ years, team of 12',
  'Version 1.2.3.4 of the SDK',
  'https://jobs.example.com/view?id=12345&ref=abc',
  'https://example.com/vacancy/0501234567x?utm=1',
  'https://www.linkedin.com/company/acme',
  'https://github.com/acme/widgets',
  'https://github.com/acme/widgets/issues/42',
  'See https://boards.example.com/jobs?page=2&q=node for more.',
  'Work at home or at the office',
  'We look at things.',
  'Use the @ sign and @x',
  'C# and F# and .NET',
  'Price: 1 234,56 EUR',
  'Order #380501234',
  'Kyiv, Ukraine (UTC+2)',
  'telephone allowance',
  'Skype calls are fine',
  'Our Telegram channel is linked below',
]

const emptyCounts = { email: 0, phone: 0, messenger: 0, profileUrl: 0 }

describe('stripContacts — positive cases', () => {
  it.each(POSITIVE)('%j', (input, expected, kind, count) => {
    const result = stripContacts(input)
    expect(result.text).toBe(expected)
    expect(result.removed).toEqual({ ...emptyCounts, [kind]: count })
  })
})

describe('stripContacts — negative cases', () => {
  it.each(NEGATIVE)('%j survives unchanged', (input) => {
    const result = stripContacts(input)
    expect(result.text).toBe(input)
    expect(result.removed).toEqual(emptyCounts)
  })
})

describe('stripContacts — normalisation', () => {
  it('removes bidi and zero-width characters everywhere, not only inside contacts', () => {
    expect(stripContacts('a‮b⁦c​d﻿e­f⁠g؜h').text).toBe('abcdefgh')
  })

  it('removes NUL and other C0 controls but keeps newlines and tabs', () => {
    expect(stripContacts('a\u0000b\u0007c\nd\te\r\nf').text).toBe('abc\nd\te\r\nf')
  })

  it('counts each kind separately in one text', () => {
    const result = stripContacts(
      'a@b.io +380501234567 t.me/jane_doe https://github.com/janedoe @someone x@y.io',
    )
    expect(result.removed).toEqual({ email: 2, phone: 1, messenger: 2, profileUrl: 1 })
    expect(result.text).toBe(`${T} ${T} ${T} ${T} ${T} ${T}`)
  })

  it('the neutral token is not itself a contact', () => {
    expect(stripContacts(T)).toEqual({ text: T, removed: emptyCounts })
  })
})

describe('stripContacts — idempotent', () => {
  it.each([...POSITIVE.map((row) => row[0]), ...NEGATIVE])('%j', (input) => {
    const once = stripContacts(input).text
    const twice = stripContacts(once)
    expect(twice.text).toBe(once)
    expect(twice.removed).toEqual(emptyCounts)
  })
})

describe('stripContacts — bounded time on hostile input', () => {
  it(
    'a 200 000-char run of near-matches grows linearly',
    () => {
      const hostile = (n: number) => 'a.'.repeat(n) + '@'.repeat(n) + '1 '.repeat(n / 2)
      const small = hostile(12_500)
      const big = hostile(50_000)
      expectScaling(
        () => stripContacts(small),
        () => stripContacts(big),
        8,
      )
    },
    SCALING_TEST_TIMEOUT_MS,
  )
})

describe('stripContacts — US phone forms (F1)', () => {
  it.each(['(555)123-4567', '(555) 123-4567', '555-123-4567', '555.123.4567', '(555)-123-4567'])(
    '%j is stripped',
    (phone) => {
      const result = stripContacts(`Call ${phone} today`)
      expect(result.text).toBe(`Call ${T} today`)
      expect(result.removed).toEqual({ ...emptyCounts, phone: 1 })
    },
  )

  it.each([
    'https://example.com/jobs/5551234567/view',
    'https://example.com/jobs?id=5551234567&x=1',
    'https://example.com/v/(555)123-4567',
    'Release 2024.123.4567 is out',
    'Build 10.555.123.4567',
    'ref 5551234567',
    '555123-4567',
  ])('%j survives', (input) => {
    expect(stripContacts(input)).toEqual({ text: input, removed: emptyCounts })
  })
})

describe('stripContacts — token and repetition', () => {
  it('the replacement is the fixed, non-empty token "[contact]"', () => {
    expect(stripContacts('hr@example.com').text).toBe('[contact]')
  })

  it('every tel: link is replaced, in any case', () => {
    const result = stripContacts('TEL:+380501234567 and tel:+48512345678')
    expect(result.text).toBe(`${T} and ${T}`)
    expect(result.removed.phone).toBe(2)
  })

  it('every handle is replaced, in any case', () => {
    const result = stripContacts('@Jane_Doe and @HR_team')
    expect(result.text).toBe(`${T} and ${T}`)
    expect(result.removed.messenger).toBe(2)
  })
})
