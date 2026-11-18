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
import type { ResumeFacts } from '@crm/shared'
import { redactContacts, scanContacts, type ContactContext } from './contact-scan'
import { redactAll, writingPayload } from './content-gates'
import { deriveFrozenContent } from './derive-content'
import { nameReadingCount, READING_BUDGET, transliteratedNameSource } from './name-transliteration'

const ctx = (fullName: string): ContactContext => ({ fullName, emails: [] })

/** CPU time of `fn` in ms: wall time would count a loaded CI box against the pattern. */
const cpuMs = (fn: () => void): number => {
  const start = process.cpuUsage()
  fn()
  const { user, system } = process.cpuUsage(start)
  return (user + system) / 1000
}

/** The time bound of the backtracking rows. Under Stryker it is unbounded (instrumentation stretches
 * the clock; a mutant that makes a pattern super-linear is caught by Stryker's own timeout). */
const BOUND_MS =
  process.env['STRYKER_MUTATOR_WORKER'] === undefined ? 200 : Number.POSITIVE_INFINITY

/** The bound of the budget-edge row: under the old budget's 98 ms, 3x over the current 24 ms. */
const BUDGET_EDGE_BOUND_MS =
  process.env['STRYKER_MUTATOR_WORKER'] === undefined ? 80 : Number.POSITIVE_INFINITY

const notesFacts = (notes: string[]): ResumeFacts => ({
  headline: 'Backend Engineer',
  location: { city: 'Lviv', country: 'Ukraine' },
  workFormat: 'remote',
  skills: ['TypeScript'],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Engineer',
      location: null,
      start: '2021-03',
      end: null,
      current: true,
      technologies: ['TypeScript'],
      notes,
    },
  ],
  education: [],
  languages: [],
  links: [],
})

/** The notes `writingPayload` sends to the writer for a senior stored under `fullName`. */
const payloadNotes = (fullName: string, notes: string[]): string[] =>
  writingPayload({
    facts: notesFacts(notes),
    frozen: deriveFrozenContent(notesFacts(notes)),
    contacts: [ctx(fullName)],
    template: 'classic',
    now: new Date('2026-11-18T12:00:00Z'),
  }).experience[0]?.notes ?? []

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
  ['Сироварський', 'by Syrovarsky', 'Syrovarsky'],
  ['Дмитрій', 'by Dmitry', 'Dmitry'],
  ['Андрій', 'by Andrii', 'Andrii'],
  // є read `e`
  ['Євгенів', 'owner Evheniv', 'Evheniv'],
  // SR-M-1: е read `ye`, ь read as an apostrophe, кс read `x`
  ['Еремчук', 'by Yeremchuk', 'Yeremchuk'],
  ['Ільчак', "by Il'chak", "Il'chak"],
  ['Ксаневич', 'by Xanevych', 'Xanevych'],
  ['Максюта', 'by Maxyuta', 'Maxyuta'],
  ['Максюта', 'by Maksyuta', 'Maksyuta'],
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

  it('reads a part past the budget with its primary readings only, so it cannot backtrack', () => {
    // `ий` reads `(?:y|i)(?:y|i|j)?`: each unit may consume one character or two, so a long run of
    // them would make the engine try exponentially many ways to match a near-miss. A stored name is
    // user-settable, so the budget, not the goodwill of the name, is what bounds the search.
    expect(transliteratedNameSource('ийийийий')).toMatch(/[|?]/u)
    const adversarial = 'ий'.repeat(16)
    expect(transliteratedNameSource(adversarial)).toBe('yy'.repeat(16))
    const ms = cpuMs(() => redactContacts(`by ${'y'.repeat(60)}z`, ctx(adversarial)))
    expect(ms).toBeLessThan(BOUND_MS)
  })

  it('never yields a source that can match the empty string', () => {
    for (const part of ['Щербань', 'ий', "Дем'ян", 'Ко-ва', 'Юлія']) {
      expect(new RegExp(`^(?:${transliteratedNameSource(part) ?? '(?!)'})$`, 'iu').test('')).toBe(
        false,
      )
    }
  })

  it('counts an apostrophe toward the reading budget, like an ambiguous letter', () => {
    // `а` reads one way and each apostrophe doubles the readings, so 6 of them sit exactly on the
    // budget and 7 are past it, where the part keeps its primary reading (the apostrophe dropped).
    expect(nameReadingCount(`а${"'".repeat(6)}`)).toBe(READING_BUDGET)
    expect(transliteratedNameSource(`а${"'".repeat(6)}`)).toMatch(/\?/u)
    expect(transliteratedNameSource(`а${"'".repeat(7)}`)).toBe('a')
  })

  it('treats a Latin letter beside a silent Cyrillic one as the mandatory piece', () => {
    const source = transliteratedNameSource('ьb')
    expect(source).not.toBeNull()
    expect(new RegExp(`^${source as string}$`, 'iu').test('b')).toBe(true)
  })

  it('reads every apostrophe variant as the ASCII one, so a typographic stored name matches', () => {
    // The scanned text is normalised to the ASCII apostrophe, so a literal `’` kept in the source
    // would match no text at all — and a stored name usually carries the typographic one.
    for (const apostrophe of ["'", '’', 'ʼ', '‘']) {
      const source = transliteratedNameSource(`Дем${apostrophe}ян`)
      expect(source).not.toBeNull()
      const pattern = new RegExp(`^${source as string}$`, 'iu')
      expect(pattern.test('Demian')).toBe(true)
      expect(pattern.test("Dem'ian")).toBe(true)
    }
  })
})

/**
 * The reading table, written out here independently of the module. A reading asserted against the
 * module's own constant would still pass with that constant mutated away, which is the one defect
 * the mutation gate exists to catch — so these rows are a second, hand-written original.
 *
 * Each row is read with the carrier letter `а`, because a letter whose readings are all optional
 * (`й`) or absent (`ь`, `ъ`) yields no source on its own.
 */
const TABLE: ReadonlyArray<readonly [letter: string, readings: readonly string[]]> = [
  ['а', ['a']],
  ['б', ['b']],
  ['в', ['v', 'w']],
  ['г', ['h', 'g']],
  ['ґ', ['g']],
  ['д', ['d']],
  ['е', ['e', 'ye']],
  ['є', ['ye', 'ie', 'je', 'e']],
  ['ж', ['zh', 'j']],
  ['з', ['z']],
  ['и', ['y', 'i']],
  ['і', ['i', 'y']],
  ['ї', ['yi', 'ji', 'i']],
  ['й', ['y', 'i', 'j', '']],
  ['к', ['k']],
  ['л', ['l']],
  ['м', ['m']],
  ['н', ['n']],
  ['о', ['o']],
  ['п', ['p']],
  ['р', ['r']],
  ['с', ['s']],
  ['т', ['t']],
  ['у', ['u']],
  ['ф', ['f']],
  ['х', ['kh', 'ch', 'h']],
  ['ц', ['ts', 'tz', 'c']],
  ['ч', ['ch', 'tch']],
  ['ш', ['sh']],
  ['щ', ['shch', 'sch']],
  ['ь', ['', "'"]],
  ['ю', ['yu', 'iu', 'ju', 'u']],
  ['я', ['ya', 'ia', 'ja', 'a']],
  ['ё', ['yo', 'jo', 'e']],
  ['ы', ['y']],
  ['ъ', []],
  ['э', ['e']],
]

/** Every spelling any row lists, so "accepts exactly its own readings" is a closed question. */
const PROBES = [...new Set(['', ...TABLE.flatMap(([, readings]) => readings)])]

describe('the transliteration table, row by row (backlog 463)', () => {
  it('covers every Ukrainian letter and the four Russian letters Ukrainian lacks', () => {
    expect(TABLE.map(([letter]) => letter).join('')).toBe('абвгґдеєжзиіїйклмнопрстуфхцчшщьюяёыъэ')
  })

  it.each(TABLE)('reads %s as exactly the spellings listed for it', (letter, readings) => {
    const source = transliteratedNameSource(`а${letter}`)
    expect(source).not.toBeNull()
    const pattern = new RegExp(`^${source as string}$`, 'iu')
    const accepted = PROBES.filter((probe) => pattern.test(`a${probe}`)).sort()
    // A letter with no readings contributes nothing, so the carrier alone must match.
    const expected = [...new Set(readings.length === 0 ? [''] : readings)].sort()
    expect(accepted).toEqual(expected)
  })
})

describe('PR #1416 round 1: the reading budget, short parts, empty sources', () => {
  it('reads a surname past the budget with its primary spelling instead of dropping it', () => {
    // 13 parts of `Вальо` hold 13 `ь`, each optionally an apostrophe: past the budget of 6 optional
    // pieces. The fallback is the national romanisation, so `Valo` is still redacted.
    const surname = Array.from({ length: 13 }, () => 'Вальо').join('-')
    expect(nameReadingCount(surname)).toBeGreaterThan(READING_BUDGET)
    const source = transliteratedNameSource(surname)
    expect(source).not.toBeNull()
    expect(source).not.toMatch(/[|?]/u)
    const primary = Array.from({ length: 13 }, () => 'Valo').join('-')
    expect(payloadNotes(surname, [`Led by ${primary} today`])).toEqual(['Led by [REDACTED] today'])
  })

  it('counts the readings of the whole name, not one part at a time', () => {
    const part = 'ййййий'
    expect(nameReadingCount(part)).toBeLessThanOrEqual(READING_BUDGET)
    // `й` may be left out, so it reads two ways: 2^5 per part, under the budget, 2^10 for two, past it
    expect(nameReadingCount(part)).toBe(32)
    expect(nameReadingCount([part, part].join(' '))).toBe(1024)
    expect(nameReadingCount([part, part].join(' '))).toBeGreaterThan(READING_BUDGET)
    // a prefix-free row reads one way at a time, however many readings it lists
    expect(nameReadingCount('Хижняк')).toBe(1)
    expect(nameReadingCount('Дем’ян')).toBe(2)
  })

  it('decides the budget on the normalised parts the sources are built from, not the raw name', () => {
    // The fullwidth apostrophe is no apostrophe until NFKC turns it into one, so the raw name counts
    // 1 while its normalised parts carry 13 optional apostrophes: past the budget.
    const name = `Ола${'\uFF07'.repeat(13)}н`
    expect(nameReadingCount(name)).toBe(1)
    expect(nameReadingCount(`Ола${"'".repeat(13)}н`)).toBeGreaterThan(READING_BUDGET)
    // primary only: `Olan` with every apostrophe dropped still redacts, the kept-apostrophe spelling
    // (an alternation the budget forbids) does not
    expect(redactContacts('by Olan today', ctx(name))).toBe('by [REDACTED] today')
    expect(redactContacts("by Ola'n today", ctx(name))).toBe("by Ola'n today")
    // the readings of one name may count differently: an invisible between `и` and a combining breve
    // is dropped in the joined reading, where the two compose into `й`, and splits the split one. The
    // joined reading is past the budget (7 `й`), the split one on it, and the name is decided as one.
    const composed = ctx(`а${'й'.repeat(6)}и\u200B\u0306`)
    expect(redactContacts('by aiiiiiii done', composed)).toBe('by aiiiiiii done')
    expect(redactContacts('by ayyyyyyy done', composed)).toBe('by [REDACTED] done')
    // exactly on the budget the whole name keeps every reading, the kept apostrophe included
    const onBudget = ctx(`Ола${'\uFF07'.repeat(6)}н`)
    expect(redactContacts("by Ola'n today", onBudget)).toBe('by [REDACTED] today')
  })

  it('scans a many-part adversarial name against a long near-miss in bounded time', () => {
    for (const parts of [4, 6, 8]) {
      const name = [...Array.from({ length: parts }, () => 'ййййий'), 'Фщ'].join(' ')
      const text = `by ${'y'.repeat(40)} done`
      let redacted = ''
      const ms = cpuMs(() => {
        redacted = redactContacts(text, ctx(name))
      })
      expect(redacted).toContain('done')
      expect(ms).toBeLessThan(BOUND_MS)
    }
  })

  it('adds no Latin source for a part under four letters alone, but keeps the full name', () => {
    const name = ctx('Олена Ян')
    expect(redactContacts('an apple and us', name)).toBe('an apple and us')
    expect(redactContacts('by Olena Yan', name)).toBe('by [REDACTED]')
    expect(redactContacts('веде Ян', name)).toBe('веде [REDACTED]')
    // a one-part name of three letters: its full-name source is that part alone
    expect(redactContacts('but the son', ctx('Бут'))).toBe('but the son')
    expect(redactContacts('веде Бут', ctx('Бут'))).toBe('веде [REDACTED]')
    // the apostrophe is no letter: `Бу'т` is three letters, so `but` stays
    expect(redactContacts('but the son', ctx("Бу'т"))).toBe('but the son')
    // four letters is a Latin lone source again
    expect(redactContacts('by Yulia', ctx('Олена Юлія'))).toBe('by [REDACTED]')
    expect(redactContacts('by Yulia', ctx('Юлія'))).toBe('by [REDACTED]')
  })

  it('never builds an empty source from a combining mark beside a silent letter', () => {
    expect(transliteratedNameSource('ь\u0301')).toBeNull()
    expect(redactContacts('plain words here', ctx('Олена ь\u0301'))).toBe('plain words here')
  })

  it('reads кс as x or ks, as one unit', () => {
    const matches = (text: string) =>
      new RegExp(`^${transliteratedNameSource('Кса') ?? '(?!)'}$`, 'iu').test(text)
    expect(matches('xa')).toBe(true)
    expect(matches('ksa')).toBe(true)
    expect(matches('kxa')).toBe(false)
    expect(matches('xsa')).toBe(false)
  })

  it.each(TABLE)(
    'falls back to the first reading of %s, the national romanisation',
    (letter, readings) => {
      const surname = `а${letter}${"'".repeat(13)}`
      expect(transliteratedNameSource(surname)).toBe(`a${readings[0] ?? ''}`)
    },
  )
})

describe('PR #1416 round 2: a backslash in a stored name, the budget edge, silent letters', () => {
  // A run of JSON-escaped newlines: the gap between name parts matches each `\n`, so a part that can
  // match a literal `\n` too lets the pattern split the run in exponentially many ways (SR-H-2).
  const escapes = `${'\\n'.repeat(40)} x`
  const adversarial = (part: string, parts: number, separator = ' ') =>
    [...Array.from({ length: parts }, () => part), 'Ба'].join(separator)

  it.each([
    ['a stored `\\n` part', '\\n'],
    ['a part whose Latin reading is `\\n`', '\\н'],
    ['a part whose Latin reading is `\\n` and an optional apostrophe', '\\nь'],
  ])('redacts %s against a run of escaped newlines in bounded time', (_, part) => {
    for (const separator of [' ', '​']) {
      const name = adversarial(part, 10, separator)
      let redacted = ''
      const ms = cpuMs(() => {
        redacted = redactAll(escapes, [ctx(name)])
      })
      expect(redacted).toContain(' x')
      expect(ms).toBeLessThan(BOUND_MS)
    }
  })

  it.each([
    ['a stored `\\n` part', '\\n'],
    ['a part whose Latin reading is `\\n`', '\\н'],
  ])('gate-scans %s against a run of escaped newlines in bounded time', (_, part) => {
    // the invisible separator makes a split reading, so the gate's runs (`RUN_GAP`) are built too
    for (const separator of [' ', '​']) {
      const name = adversarial(part, 8, separator)
      const ms = cpuMs(() => {
        scanContacts(escapes, ctx(name))
      })
      expect(ms).toBeLessThan(BOUND_MS)
    }
  })

  it('redacts the worst name on the budget against a 40 000-character near-miss in bounded time', () => {
    // The measured worst shape (SR-M-6): every optional `й` may read `y` or nothing, so each start
    // in a run of `y` is tried in every split; one `й` more than the budget allows reads `y` only.
    const optional = Math.log2(READING_BUDGET)
    const name = `${'й'.repeat(optional)}и Ба`
    expect(nameReadingCount(name)).toBe(READING_BUDGET)
    let redacted = ''
    const ms = cpuMs(() => {
      redacted = redactAll(`${'y'.repeat(40_000)} done`, [ctx(name)])
    })
    expect(redacted).toContain('done')
    // generous for CI: 24 ms measured at 64, 98 ms at the old budget of 256
    expect(ms).toBeLessThan(BUDGET_EDGE_BOUND_MS)
  })

  it('counts only the letters every Latin reading writes toward the four-letter rule', () => {
    // `Ільйь` has five letters, but `й` and `ь` may read as nothing, so it may read `il`
    expect(redactContacts('il est la', ctx('Ільйь'))).toBe('il est la')
    expect(redactContacts('веде Ільйь', ctx('Ільйь'))).toBe('веде [REDACTED]')
    // four written letters and a silent one still make a Latin lone source
    expect(redactContacts('by Ilko', ctx('Ілько'))).toBe('by [REDACTED]')
  })

  it('builds no Latin source whose only mandatory piece is not a letter', () => {
    expect(transliteratedNameSource('ь.')).toBeNull()
    expect(transliteratedNameSource('й7')).toBeNull()
    expect(redactContacts('v1.2 and 7 more', ctx('Олена ь. й7'))).toBe('v1.2 and 7 more')
  })

  it('reads a backslash in a stored name as a part separator', () => {
    expect(redactContacts('by Olena Koval', ctx('Olena\\Koval'))).toBe('by [REDACTED]')
    expect(redactContacts('by Олена Коваль', ctx('Олена\\Коваль'))).toBe('by [REDACTED]')
    expect(redactContacts('by Olena Koval', ctx('Олена\\Коваль'))).toBe('by [REDACTED]')
    expect(scanContacts('by Olena Koval', ctx('Olena\\Koval'))).not.toEqual([])
  })
})
