/**
 * Backlog 463: the redaction matches a Latin transliteration of a Cyrillic stored name.
 *
 * `redactAll` built its name patterns from the stored spelling only, so a Cyrillic
 * `displayName` or `legalFullName` left its Latin spelling in a free-text value, and
 * `writingPayload` sent it to the third-party writer. Every name here is invented.
 *
 * The gate scan (`scanContacts`) is deliberately NOT widened: it refuses a submission, and a
 * transliteration table that over-matches would refuse ordinary text. See the contract note above
 * `scanContacts`.
 */
import { describe, expect, it } from 'vitest'
import { redactContacts, scanContacts, type ContactContext } from './contact-scan'

const ctx = (fullName: string): ContactContext => ({ fullName, emails: [] })

/** Each row: a stored Cyrillic name, and a Latin spelling the redaction must replace. */
const SPELLINGS: [name: string, text: string, spelling: string][] = [
  // х/и/ж/я — the KMU reading and the common variants
  ['Хижняк', 'led by Khyzhniak in Lviv', 'Khyzhniak'],
  ['Хижняк', 'led by Khyzhnyak in Lviv', 'Khyzhnyak'],
  ['Хижняк', 'led by Hyzhnyak in Lviv', 'Hyzhnyak'],
  // щ
  ['Щербань', 'reviewed by Shcherban', 'Shcherban'],
  ['Щербань', 'reviewed by Scherban', 'Scherban'],
  // є
  ['Євгенів', 'owner Yevheniv', 'Yevheniv'],
  ['Євгенів', 'owner Ievheniv', 'Ievheniv'],
  // ї
  ['Їжакевич', 'by Yizhakevych', 'Yizhakevych'],
  // й
  ['Йосипів', 'by Yosypiv', 'Yosypiv'],
  ['Йосипів', 'by Iosypiv', 'Iosypiv'],
  // г/ґ
  ['Гринів', 'by Hryniv', 'Hryniv'],
  ['Гринів', 'by Gryniv', 'Gryniv'],
  // ю
  ['Юхименко', 'by Yukhymenko', 'Yukhymenko'],
  ['Юхименко', 'by Iukhymenko', 'Iukhymenko'],
  // ь drops, ц/ч/ш
  ['Цьомик', 'by Tsomyk', 'Tsomyk'],
  ['Чубань', 'by Chuban', 'Chuban'],
  ['Шульга', 'by Shulha', 'Shulha'],
  // Russian letters: ё, ы, э, ъ
  ['Ёлкин', 'by Yolkin', 'Yolkin'],
  ['Мышкин', 'by Myshkin', 'Myshkin'],
  ['Эдуардов', 'by Eduardov', 'Eduardov'],
]

describe('redactContacts — a Latin transliteration of a Cyrillic stored name (backlog 463)', () => {
  it.each(SPELLINGS)('stored %s redacts %s', (name, text, spelling) => {
    const redacted = redactContacts(text, ctx(name))
    expect(redacted).not.toContain(spelling)
    expect(redacted).toContain('[REDACTED]')
  })

  it('redacts the Latin spelling of a two-part stored name, and of its last part alone', () => {
    // The joined reading gives the full name and the last part alone, never the first name
    // (the note above `scanContacts`); the transliteration adds a reading, not a part order.
    const full = ctx('Євгенія Хижняк')
    expect(redactContacts('by Yevheniia Khyzhniak, 2020', full)).toBe('by [REDACTED], 2020')
    expect(redactContacts('reviewed by Khyzhniak', full)).toBe('reviewed by [REDACTED]')
    expect(redactContacts('reviewed by Yevheniia', full)).toBe('reviewed by Yevheniia')
  })

  it('redacts the Latin spelling of a surname-first legal name', () => {
    const legal = ctx('Щербань Юхим Гнатович')
    expect(redactContacts('Shcherban Yukhym Hnatovych wrote it', legal)).toBe('[REDACTED] wrote it')
  })

  it('keeps a Latin word that is not a transliteration of the name', () => {
    expect(redactContacts('the khan shipped it', ctx('Хижняк'))).toBe('the khan shipped it')
    expect(redactContacts('schema review done', ctx('Щербань'))).toBe('schema review done')
    expect(redactContacts('Khyzhniakov shipped', ctx('Хижняк'))).toBe('Khyzhniakov shipped')
  })

  it('leaves a Latin stored name matching exactly as before', () => {
    const latin = ctx('Olena Koval')
    expect(redactContacts('by Olena Koval', latin)).toBe('by [REDACTED]')
    expect(redactContacts('by Kovalenko', latin)).toBe('by Kovalenko')
  })

  it('adds no source for a name that transliterates to nothing', () => {
    expect(redactContacts('nothing here at all', ctx('ь'))).toBe('nothing here at all')
    expect(redactContacts('a b c', ctx("ь'ъ"))).toBe('a b c')
  })

  it('does not widen the gate scan: scanContacts stays on the stored script', () => {
    expect(scanContacts('led by Khyzhniak', ctx('Хижняк'))).toEqual([])
    expect(scanContacts('led by Хижняк', ctx('Хижняк'))).toEqual([
      { kind: 'name', match: 'Хижняк' },
    ])
  })

  it('redacts the stored Cyrillic spelling as before', () => {
    expect(redactContacts('веде Хижняк', ctx('Хижняк'))).toBe('веде [REDACTED]')
  })
})
