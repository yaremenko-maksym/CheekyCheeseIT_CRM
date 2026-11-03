import { describe, expect, it } from 'vitest'
import { CONTACT_TOKEN, stripContacts } from './contact-strip'

/** PR #1239 round 3 (SR-M-5, SR-M-6, CR-M-4): every listed leak and over-strip, as a table. */
const T = CONTACT_TOKEN

function digitsOf(text: string): string {
  return text.normalize('NFKC').replace(/\D/g, '')
}

const PHONES: ReadonlyArray<readonly [string, string]> = [
  // SR-M-5: label forms
  ['Phone number: 4155550132', '4155550132'],
  ['Phone - 4155550132', '4155550132'],
  ['Phone № 4155550132', '4155550132'],
  ['Phone # 4155550132', '4155550132'],
  ['Phone No. 4155550132', '4155550132'],
  ['phones: 4155550132', '4155550132'],
  ['tel/fax 4155550132', '4155550132'],
  ['Fax: 4155550132', '4155550132'],
  ['Call me 4155550132', '4155550132'],
  ['Contact: 4155550132', '4155550132'],
  ['Contacts - 600700800', '600700800'],
  // SR-M-5: separated, unlabelled
  ['(415)5550132', '4155550132'],
  ['US (415)555-0132', '4155550132'],
  ['0 67 123 45 67', '671234567'],
  ['0-67-123-45-67', '671234567'],
  // SR-M-6: link schemes
  ['callto:jane', 'jane'],
  ['sms:+380671234567', '671234567'],
]

const EMAILS: readonly string[] = [
  'jane@gmail%2Ecom',
  'jane%40gmail%2Ecom',
  'jane@gmail&#46;com',
  'jane@gmail&#x2e;com',
  'jane@gmail&period;com',
  'jane@gmail&amp;#46;com',
  'jane&amp;#64;gmail.com',
  'jane@gmail,com',
]

const MESSENGERS: ReadonlyArray<readonly [string, string]> = [
  ['Discord jane#1234', 'jane'],
  ['Discord - jane#1234', 'jane'],
  ['vk.com/jane', 'jane'],
  ['https://vk.com/jane.doe', 'jane'],
]

describe('stripContacts — round 3: these are stripped', () => {
  it.each(PHONES)('phone %j', (input, secret) => {
    const out = stripContacts(input)
    expect(out.text).toContain(T)
    const visible = /^\d+$/.test(secret) ? digitsOf(out.text) : out.text.toLowerCase()
    expect(visible).not.toContain(secret)
    expect(out.removed.phone).toBe(1)
  })

  it.each(EMAILS)('email %j', (input) => {
    expect(stripContacts(input)).toEqual({
      text: T,
      removed: { email: 1, phone: 0, messenger: 0, profileUrl: 0 },
    })
  })

  it.each(MESSENGERS)('messenger or profile %j', (input, secret) => {
    const out = stripContacts(input)
    expect(out.text).toBe(T)
    expect(out.text).not.toContain(secret)
  })

  it('the label stays and only the number goes', () => {
    expect(stripContacts('Phone number: 4155550132').text).toBe(`Phone number: ${T}`)
    expect(stripContacts('Call me 4155550132').text).toBe(`Call me ${T}`)
  })

  it('vk.com is a profile, Discord-with-discriminator a messenger', () => {
    expect(stripContacts('vk.com/jane').removed.profileUrl).toBe(1)
    expect(stripContacts('Discord jane#1234').removed.messenger).toBe(1)
  })
})

/** CR-M-4: a colon-less messenger label followed by an ordinary word stays prose. */
const SURVIVES: readonly string[] = [
  'Join our Discord server.',
  'WhatsApp group.',
  'Telegram channel.',
  'We do Signal processing. Next',
  'Skype interview.',
  'Viber chat, Telegram bot.',
  'TG - weekly sync.',
  'https://vk.com/acme/wall',
  'Budget 4155550132 USD',
  'ID 4155550132',
  'number 4155550132',
]

describe('stripContacts — round 3: these survive', () => {
  it.each(SURVIVES)('%j', (input) => {
    expect(stripContacts(input)).toEqual({
      text: input,
      removed: { email: 0, phone: 0, messenger: 0, profileUrl: 0 },
    })
  })
})
