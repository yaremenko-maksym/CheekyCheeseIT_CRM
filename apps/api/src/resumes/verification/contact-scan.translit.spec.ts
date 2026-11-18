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
import { transliteratedNameSource } from './name-transliteration'

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
  // The two endings that carry most real spellings: `ія` written `ia`, `ий`/`ій` written `y`
  ['Марія', 'by Maria', 'Maria'],
  ['Юлія', 'by Yulia', 'Yulia'],
  ['Зеленський', 'by Zelensky', 'Zelensky'],
  ['Дмитрій', 'by Dmitry', 'Dmitry'],
  ['Андрій', 'by Andrii', 'Andrii'],
  // є read `e`
  ['Євгенів', 'owner Evheniv', 'Evheniv'],
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

  it('transliterates the Cyrillic part of a mixed-script name and keeps the Latin one', () => {
    const mixed = ctx("Дем'яненко Smith")
    expect(redactContacts('by Demianenko Smith', mixed)).toBe('by [REDACTED]')
    // the last part is Latin, so its stored spelling is the surname source
    expect(redactContacts('by Smith', mixed)).toBe('by [REDACTED]')
  })
})

describe('transliteratedNameSource (backlog 463)', () => {
  it('is null for a part with no Cyrillic letter, so a Latin name keeps one reading', () => {
    expect(transliteratedNameSource('Smith')).toBeNull()
    expect(transliteratedNameSource('Müller')).toBeNull()
    expect(transliteratedNameSource('')).toBeNull()
  })

  it('is null for a part that reads as nothing at all, or as optional pieces only', () => {
    expect(transliteratedNameSource('ь')).toBeNull()
    expect(transliteratedNameSource('ъь')).toBeNull()
    expect(transliteratedNameSource("'")).toBeNull()
    // every piece optional (`ь` reads as nothing, the apostrophe is optional, `й` may be left out)
    expect(transliteratedNameSource("ь'")).toBeNull()
    expect(transliteratedNameSource('й')).toBeNull()
    expect(redactContacts('nothing here at all', ctx("ь'"))).toBe('nothing here at all')
  })

  it('is null for a Cyrillic letter outside the table, rather than half a reading', () => {
    // ў (Belarusian) has no row: the part stays matched in the stored script only
    expect(transliteratedNameSource('Ваўчок')).toBeNull()
    expect(redactContacts('by Vauchok', ctx('Ваўчок'))).toBe('by Vauchok')
    expect(redactContacts('веде Ваўчок', ctx('Ваўчок'))).toBe('веде [REDACTED]')
  })

  /** The source is a regex, so it is asserted by what it matches, not by its exact text. */
  const matches = (part: string, text: string): boolean =>
    new RegExp(`^${transliteratedNameSource(part) ?? '(?!)'}$`, 'iu').test(text)

  it('drops the silent apostrophe', () => {
    expect(matches("Дем'ян", 'Demian')).toBe(true)
    expect(matches("Дем'ян", 'Demyan')).toBe(true)
    expect(redactContacts("by Dem'ian", ctx("Дем'ян"))).toBe('by [REDACTED]')
  })

  it('keeps a non-Cyrillic character as a literal, so a hyphenated part matches as written', () => {
    expect(matches('Ко-ва', 'Ko-va')).toBe(true)
    expect(matches('Ко-ва', 'Kodva')).toBe(false)
    // a regex metacharacter in a part is escaped, never read as syntax
    expect(matches('Ко.ва', 'Ko.va')).toBe(true)
    expect(matches('Ко.ва', 'Koxva')).toBe(false)
  })

  it('reads an upper-case letter as its lower-case row', () => {
    expect(transliteratedNameSource('ЩЕРБАНЬ')).toBe(transliteratedNameSource('щербань'))
  })

  it('makes a letter with an empty reading optional, not dropped', () => {
    const source = transliteratedNameSource('ий') ?? ''
    expect(new RegExp(`^${source}$`, 'iu').test('y')).toBe(true)
    expect(new RegExp(`^${source}$`, 'iu').test('yy')).toBe(true)
  })

  it('adds no capture group, which findWholeTokens would read as an empty-group hit', () => {
    const source = transliteratedNameSource('Щербань') ?? ''
    expect(source).not.toBe('')
    // length 1 is the whole match alone: any capture group would make it 2 or more
    expect(new RegExp(source, 'diu').exec('Shcherban')?.length).toBe(1)
  })

  it('refuses a part whose readings multiply past the budget, so the pattern cannot backtrack', () => {
    // `ий` reads `(?:y|i)(?:y|i|j)?`: each unit may consume one character or two, so a long run of
    // them would make the engine try exponentially many ways to match a near-miss. A stored name is
    // user-settable, so the budget, not the goodwill of the name, is what bounds the search.
    expect(transliteratedNameSource('ийийийий')).not.toBeNull()
    const adversarial = 'ий'.repeat(16)
    expect(transliteratedNameSource(adversarial)).toBeNull()
    const started = Date.now()
    expect(redactContacts(`by ${'y'.repeat(60)}z`, ctx(adversarial))).toContain('z')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('never yields a source that can match the empty string', () => {
    for (const part of ['Щербань', 'ий', "Дем'ян", 'Ко-ва', 'Юлія']) {
      expect(new RegExp(`^(?:${transliteratedNameSource(part) ?? '(?!)'})$`, 'iu').test('')).toBe(
        false,
      )
    }
  })
})
