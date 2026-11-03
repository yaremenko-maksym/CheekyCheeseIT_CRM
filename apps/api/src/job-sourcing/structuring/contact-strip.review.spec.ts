import { beforeAll, describe, expect, it } from 'vitest'
import { expectScaling } from './__fixtures__/scaling'
import { CONTACT_TOKEN, stripContacts } from './contact-strip'

/**
 * PR #1239 review round (SR-H-1, SR-M-1..4, CR-M-1, CR-M-2): every security-review probe input and
 * every reviewer example. `secret` is what must not survive; an all-digit secret is checked against
 * the output's digits only, so a separator change cannot hide a surviving number.
 */
const T = CONTACT_TOKEN

function digitsOf(text: string): string {
  return text.normalize('NFKC').replace(/\D/g, '')
}

function expectStripped(input: string, secret: string): void {
  const out = stripContacts(input).text
  expect(out, input).toContain(T)
  if (/^\d+$/.test(secret)) {
    expect(digitsOf(out), input).not.toContain(secret)
  } else {
    expect(out.normalize('NFKC').toLowerCase(), input).not.toContain(secret.toLowerCase())
  }
}

const PHONES: ReadonlyArray<readonly [string, string]> = [
  // SR-H-1: glued to a label
  ['тел.0501234567', '501234567'],
  ['т.0501234567', '501234567'],
  ['Tel0501234567', '501234567'],
  ['Viber+380501234567', '501234567'],
  ['+380501234567Telegram', '501234567'],
  ['тел.050 123 45 67', '501234567'],
  ['моб. 0501234567', '501234567'],
  ['WhatsApp:0501234567', '501234567'],
  ['Phone 600700800', '600700800'],
  ['call 4155550132', '4155550132'],
  ['mobile:+48 600 700 800', '600700800'],
  ['Телефон:0501234567', '501234567'],
  // SR-H-1: typographic dashes
  ['+380–50–123–45–67', '501234567'],
  ['+380−50−123', '50123'],
  ['+380‐50‐123‐45‐67', '501234567'],
  ['050–123–45–67', '501234567'],
  ['050—123—45—67', '501234567'],
  ['(050)―123‑45‒67', '501234567'],
  // probe.ts
  ['0 5 0 1 2 3 4 5 6 7', '501234567'],
  ['+380   501234567', '501234567'],
  ['07700 900123', '7700900123'],
  ['030 12345678', '12345678'],
  ['+44 7700 900123', '7700900123'],
  ['+1 (555) 123-4567', '5551234567'],
  ['+٣٨٠٥٠١٢٣٤٥٦٧', '٥٠١٢٣٤٥٦٧'],
  // probe2.ts
  ['Тел.:+38(050)123-45-67', '501234567'],
  ['тел: 050-123-45-67', '501234567'],
  ['+38 (050) 123 45 67', '501234567'],
  ['+38(050)1234567', '501234567'],
  ['(050)1234567', '501234567'],
  ['050 1234567', '501234567'],
  ['+38-050-123-45-67', '501234567'],
  ['050-123-45-67.', '501234567'],
  ['Tel.:050 123 45 67', '501234567'],
  ['tel.+380501234567', '501234567'],
  ['050 123 4567', '501234567'],
  ['(067) 123 45 67', '671234567'],
  ['+380 (67) 123-45-67', '671234567'],
  // CR-M-1: grouped national formats
  ['020 7946 0958', '79460958'],
  ['UK mobile 07700 900123.', '7700900123'],
  ['Berlin 030 12345678', '12345678'],
  ['612 34 56 78', '612345678'],
  ['ES: 612-34-56-78', '612345678'],
]

const EMAILS: ReadonlyArray<readonly [string, string]> = [
  // SR-M-1
  ['jane @ gmail . com', 'gmail'],
  ['jane@gmail . com', 'gmail'],
  ['jane@gmail .com', 'gmail'],
  ['jane@gmail。com', 'gmail'],
  ['jane@gmail｡com', 'gmail'],
  ['jane@gmail．com', 'gmail'],
  // SR-M-2 / CR-M-2: invisible splitters
  ['jane@exa\u{E0020}mple.com', 'jane'],
  ['jane@exa͏mple.com', 'jane'],
  ['ann͏a@example.com', 'ann'],
  ['x\u{E0041}y@example.com', 'x'],
  ['jane️@example.com', 'jane'],
  ['jane\u{E0100}@example.com', 'jane'],
  ['janeᅟ@example.com', 'jane'],
  ['janeᅠ@example.com', 'jane'],
  ['janeㅤ@example.com', 'jane'],
  ['janeﾠ@example.com', 'jane'],
  ['jane឴឵@example.com', 'jane'],
  ['jane᠋@example.com', 'jane'],
  // probe.ts
  ['jane@example.com2', 'jane'],
  ['jane%40example.com', 'jane'],
  ['jane&#64;example.com', 'jane'],
  ['jane&#x40;example.com', 'jane'],
  ['jane&commat;example.com', 'jane'],
  ['jane dot doe at gmail dot com', 'jane'],
  ['‮jane@example.com', 'jane'],
  ['ja​ne@exa​mple.com', 'jane'],
  ['ＪＡＮＥ＠ＥＸＡＭＰＬＥ．ＣＯＭ', 'jane'],
]

const MESSENGERS: ReadonlyArray<readonly [string, string]> = [
  // SR-M-3
  ['Telegram jane_doe', 'jane'],
  ['TG - jane_doe', 'jane'],
  ['TG – jane_doe', 'jane'],
  ['Skype jane.doe', 'jane'],
  ['Viber jane2024', 'jane'],
  ['skype: live:.cid.123abc', '123abc'],
  ['live:.cid.9f8e7d', '9f8e7d'],
  ['Discord: jane#1234', '1234'],
  // SR-M-4 (messenger hosts) + probe.ts
  ['m.me/jane.doe', 'jane'],
  ['https://www.m.me/jane.doe', 'jane'],
  ['telegram.dog/jane', 'jane'],
  ['discord.gg/x7k2', 'x7k2'],
  ['wa.me/380501234567', '501234567'],
]

const PROFILES: ReadonlyArray<readonly [string, string]> = [
  // SR-M-4
  ['calendly.com/jane-doe', 'jane'],
  ['https://www.calendly.com/jane-doe/30min', 'jane'],
  ['medium.com/@jane', 'jane'],
  ['https://www.medium.com/@jane/my-story-1a2b', 'jane'],
  ['tiktok.com/@janedoe', 'jane'],
  ['https://m.tiktok.com/@janedoe', 'jane'],
  ['lnkd.in/abc123', 'abc123'],
  ['linkedin.com/profile/view?id=123', 'id=123'],
  ['https://www.linkedin.com/profile/view?id=AAA', 'id=aaa'],
  // probe.ts
  ['https://www.linkedin.com/in/jane-doe-123/', 'jane'],
  ['github.com/jane', 'jane'],
  ['x.com/jane?s=20', 'jane'],
]

describe('stripContacts — review round: everything here must be stripped', () => {
  it.each(PHONES)('phone %j', (input, secret) => {
    expectStripped(input, secret)
    expect(stripContacts(input).removed.phone).toBeGreaterThan(0)
  })
  it.each(EMAILS)('email %j', (input, secret) => {
    expectStripped(input, secret)
    expect(stripContacts(input).removed.email).toBe(1)
  })
  it.each(MESSENGERS)('messenger %j', (input, secret) => {
    expectStripped(input, secret)
    expect(stripContacts(input).removed.messenger).toBeGreaterThan(0)
  })
  it.each(PROFILES)('profile %j', (input, secret) => {
    expectStripped(input, secret)
    expect(stripContacts(input).removed.profileUrl).toBe(1)
  })

  it('an invisible splitter inside an address leaves only the token', () => {
    expect(stripContacts('x\u{E0041}y@example.com').text).toBe(T)
    expect(stripContacts('ann͏a@example.com').text).toBe(T)
  })

  it('a label stays, the number goes', () => {
    expect(stripContacts('тел.0501234567').text).toBe(`тел.${T}`)
    expect(stripContacts('+380501234567Telegram').text).toBe(`${T}Telegram`)
    expect(stripContacts('Viber+380501234567').text).toBe(`Viber${T}`)
  })

  it('the Skype cid id goes with its label', () => {
    expect(stripContacts('skype: live:.cid.123abc').text).toBe(T)
  })

  it('a sentence-ending email does not swallow the next word', () => {
    expect(stripContacts('Mail: hr@example.com. Next sentence').text).toBe(
      `Mail: ${T}. Next sentence`,
    )
  })
})

/** Unchanged: ids, salaries, versions and prose that only look close to a contact. */
const SURVIVES: readonly string[] = [
  // CR-M-1 refusal: bare unseparated digit runs without a phone label are indistinguishable from ids.
  '4155550132',
  'ref 600700800',
  'Job id 5551234567',
  '٠٥٠١٢٣٤٥٦٧٨',
  'https://example.com/jobs?id=5551234567&x=1',
  'https://example.com/jobs/5551234567/view',
  'Version 1.0501234567',
  'Salary 18 000 – 24 000 PLN',
  'Salary 100 000 - 150 000 UAH',
  '2024–2026 contract',
  'Recall 1234567 times',
  'Our Telegram channel is linked below',
  'Skype calls are fine',
  'TG - weekly sync',
  'Kyiv — remote — full time',
  'https://medium.com/acme-engineering/scaling-postgres-1a2b',
  'https://jobs.example.com/view?id=12345&ref=calendly',
  'https://www.linkedin.com/company/acme/jobs',
  'The Hub at 10:00, call at 12:30',
  'emoji 👨‍👩‍👧 stays readable',
]

describe('stripContacts — review round: these survive', () => {
  it.each(SURVIVES)('%j', (input) => {
    const out = stripContacts(input)
    expect(out.text).not.toContain(T)
    expect(out.removed).toEqual({ email: 0, phone: 0, messenger: 0, profileUrl: 0 })
  })

  it('ZWJ is removed with the other ignorables: an emoji family becomes its members (accepted)', () => {
    expect(stripContacts('👨‍👩‍👧').text).toBe('👨👩👧')
  })

  it('prose dashes are not rewritten', () => {
    expect(stripContacts('Salary 18 000 – 24 000 PLN').text).toBe('Salary 18 000 – 24 000 PLN')
  })
})

describe('stripContacts — review round: linear time on the shapes that went quadratic', () => {
  // V8 tiers a regex up to native code after its first run, separately for one-byte (Latin-1) and
  // two-byte subjects, and the native code does not short-circuit like the cold bytecode: a cubic
  // look-behind took 1 ms cold and 12 s warm on 2 000 spaces (measured). So run every pattern on
  // both kinds of string first; a cold-only timing test passes a cubic pattern.
  beforeAll(() => {
    for (let i = 0; i < 20; i += 1) {
      stripContacts(`ref 600700800, call +380 50 123 45 67, jane dot doe at x dot io ${i}`)
      stripContacts(`тел.050 123 45 67, t.me/a_b, Олена ${i}`)
    }
  })

  // `n` is the repeat count of the 4x input; the small input repeats n / 4 times.
  it.each<readonly [string, (n: number) => string, number]>([
    ['spaces only', (n) => ' '.repeat(n), 400_000],
    ['tabs only', (n) => '\t'.repeat(n), 400_000],
    ['label + spaces', (n) => 'tel' + ' '.repeat(n), 400_000],
    ['a@b + spaces', (n) => 'a@b' + ' '.repeat(n), 400_000],
    ['a dot a dot …', (n) => 'a dot '.repeat(n) + 'b', 70_000],
    ['a@b dot b dot …', (n) => 'a@b' + ' dot b'.repeat(n), 70_000],
    ['digits with U+2015', (n) => '1―'.repeat(n), 200_000],
    ['tel. + spaced digits', (n) => 'тел.' + '1 '.repeat(n), 200_000],
  ])('%s grows linearly', (_name, hostile, n) => {
    const small = hostile(n / 4)
    const big = hostile(n)
    expectScaling(
      () => stripContacts(small),
      () => stripContacts(big),
      8,
    )
  })
})
