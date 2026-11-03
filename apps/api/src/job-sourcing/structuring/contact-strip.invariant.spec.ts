import { describe, expect, it } from 'vitest'
import { CONTACT_PAGES } from './__fixtures__/contact-pages'
import { stripContacts } from './contact-strip'

/** ASCII digits only, Arabic-Indic and fullwidth folded — a phone cannot hide behind a separator change. */
function digitsOf(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace(/\D/g, '')
}

describe('stripContacts — corpus invariant', () => {
  it.each(CONTACT_PAGES)('$name: no seeded contact survives', ({ text, contacts, phones }) => {
    const out = stripContacts(text).text
    const folded = out.normalize('NFKC').toLowerCase()
    for (const contact of contacts) {
      expect(folded, contact).not.toContain(contact.normalize('NFKC').toLowerCase())
    }
    const outDigits = digitsOf(out)
    for (const phone of phones) {
      expect(outDigits, phone).not.toContain(digitsOf(phone).slice(-9))
    }
    expect(out).not.toMatch(/@\S/)
  })

  it.each(CONTACT_PAGES)('$name: non-contact job facts survive', ({ text }) => {
    const out = stripContacts(text).text
    const firstLine = text.split('\n')[0]?.replace(/<\/?p>/g, '') ?? ''
    expect(out).toContain(firstLine)
  })

  it('posting URLs with a query survive in the corpus', () => {
    const outs = CONTACT_PAGES.map((page) => stripContacts(page.text).text).join('\n')
    expect(outs).toContain('https://jobs.example.com/vacancy/12345?utm_source=dou&ref=abc')
    expect(outs).toContain('https://careers.example.org/jobs/98765?src=board&amp;page=2')
    expect(outs).toContain('https://github.com/example-org/widgets')
  })
})
