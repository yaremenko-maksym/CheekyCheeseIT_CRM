/**
 * Latin readings of a Cyrillic name part, for the redaction's name patterns (backlog 463).
 *
 * `redactAll` built its patterns from the stored spelling only, so a Cyrillic `displayName` or
 * `legalFullName` left its Latin spelling inside a free-text value and `writingPayload` sent it to
 * the third-party writer. A part is turned into one regex source in which each Cyrillic letter
 * becomes a non-capturing alternation of its readings, so the readings of a whole name do not
 * multiply out: a part of n letters stays one pattern, not 2^n of them.
 *
 * The table is the Ukrainian national romanisation (KMU 2010) plus the common variants of the
 * letters that have them, and the four Russian letters Ukrainian lacks. It carries no position
 * rules: `є` reads `ye` and `ie` everywhere, not `ye` word-initially alone. That over-matches
 * rather than under-matches, which is the safe direction for a redaction.
 *
 * Limits, by design: a spelling outside the table is not matched (`зг` as `zgh`, a German or
 * Polish reading such as `Schtscherban`), and a Cyrillic letter outside the table makes the whole
 * part untransliterated rather than half-transliterated. A part whose readings multiply past
 * `READING_BUDGET` gets no Latin source either, so the pattern can never backtrack
 * combinatorially on a stored name chosen to make it (`READING_BUDGET` below). Pure: no I/O.
 */
import { CONTACT_APOSTROPHES, foldAccents } from '@crm/shared'

/**
 * Lowercase Cyrillic letter to its Latin readings, longest first (so a match takes the longest
 * reading). NO readings at all is a letter that is never written in Latin (`ь`, `ъ`); an empty
 * reading BESIDE real ones is a letter the Latin spelling may leave out (`й`).
 */
const CYRILLIC_READINGS: Readonly<Record<string, readonly string[]>> = {
  а: ['a'],
  б: ['b'],
  в: ['v', 'w'],
  г: ['h', 'g'],
  ґ: ['g'],
  д: ['d'],
  е: ['e'],
  є: ['ye', 'ie', 'je', 'e'],
  ж: ['zh', 'j'],
  з: ['z'],
  и: ['y', 'i'],
  і: ['i', 'y'],
  ї: ['yi', 'ji', 'i'],
  // The empty reading is the `ий`/`ій` ending written `y` (`Зеленський` as `Zelensky`).
  й: ['y', 'i', 'j', ''],
  к: ['k'],
  л: ['l'],
  м: ['m'],
  н: ['n'],
  о: ['o'],
  п: ['p'],
  р: ['r'],
  с: ['s'],
  т: ['t'],
  у: ['u'],
  ф: ['f'],
  х: ['kh', 'ch', 'h'],
  ц: ['ts', 'tz', 'c'],
  ч: ['tch', 'ch'],
  ш: ['sh'],
  щ: ['shch', 'sch'],
  ь: [],
  ю: ['yu', 'iu', 'ju', 'u'],
  // The bare reading is the `ія` ending written `ia` (`Марія` as `Maria`).
  я: ['ya', 'ia', 'ja', 'a'],
  // Russian letters Ukrainian lacks
  ё: ['yo', 'jo', 'e'],
  ы: ['y'],
  ъ: [],
  э: ['e'],
}

/**
 * The apostrophe of a Cyrillic name is silent in Latin (`Дем'ян` is `Demian`). Only the ASCII one is
 * listed: every variant is normalised to it before this set is consulted.
 */
const SILENT = new Set(["'"])

/**
 * The most readings one part's source may multiply out to. A stored name is user-settable
 * (`displayName`), and a run of ambiguous letters (`ий` reads `(?:y|i)(?:y|i|j)?`, each unit able to
 * consume one character or two) makes the regex engine try exponentially many ways to match a
 * near-miss text. Bounding the product bounds that search: past the budget the part keeps its
 * stored-spelling source only. 4096 passes every plausible real name (`Зеленський` is 16).
 */
const READING_BUDGET = 4096

/** Any letter the table reads; a Cyrillic letter outside it stops the part (see the file note). */
const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * One letter as a regex source: a non-capturing alternation of its readings, `''` for a letter with
 * no readings at all (`ь`, `ъ`, never written in Latin), and an optional group for a letter that has
 * an empty reading beside real ones (`й`, left out of `Zelensky`).
 *
 * Non-capturing throughout: `findWholeTokens` requires every capture group that matches empty to sit
 * on a gap, so a capturing group here would drop real hits.
 */
function letterSource(readings: readonly string[]): string {
  // Stryker disable next-line MethodExpression: dropping the filter keeps the empty reading of `й` inside the alternation, so the group reads `(?:y|i|j|)?` instead of `(?:y|i|j)?` — the same language, and no assertion can tell the two apart
  const escaped = readings.filter(Boolean).map(escapeRegExp)
  if (escaped.length === 0) return ''
  const group = `(?:${escaped.join('|')})`
  return readings.includes('') ? `${group}?` : group
}

/**
 * `part` as a regex source matching its Latin readings, or `null` when the part has no Cyrillic
 * letter (a Latin part is matched by the stored-spelling source already), holds a Cyrillic letter
 * the table does not read, reads as nothing at all (an empty source would match everywhere), or
 * multiplies out past `READING_BUDGET`.
 *
 * The part is read in NFC, BEFORE the accent fold: the fold drops the breve of `й` and the diaeresis
 * of `ї`, turning them into `и` and `і` and losing their readings. Non-Cyrillic characters are
 * folded and escaped, so a mixed name (`Коваль Smith`) keeps its Latin part.
 *
 * Every apostrophe variant is read as the ASCII one first, the same way the scanned text is
 * normalised: a stored `Дем’ян` with the typographic apostrophe must still match `Demian`, and a
 * literal `’` in the source would match no normalised text at all.
 */
export function transliteratedNameSource(part: string): string | null {
  const nfc = part.normalize('NFC').replace(CONTACT_APOSTROPHES, "'")
  if (!CYRILLIC_LETTER.test(nfc)) return null
  let source = ''
  // A source every piece of which may match empty would match everywhere, so at least one piece
  // must be mandatory (`ь` alone, and `ь'`, read as nothing and get no source at all).
  let required = false
  // The number of ways the source can read the same text; see `READING_BUDGET`.
  let readingCount = 1
  for (const character of nfc) {
    const readings = CYRILLIC_READINGS[character.toLowerCase()]
    if (readings) {
      const letter = letterSource(readings)
      source += letter
      required ||= letter !== '' && !letter.endsWith('?')
      readingCount *= Math.max(readings.length, 1)
      if (readingCount > READING_BUDGET) return null
      continue
    }
    // Optional, not dropped: the Latin spelling may keep it (`Дем'ян` as `Dem'ian` or `Demian`).
    if (SILENT.has(character)) {
      source += "'?"
      readingCount *= 2
      if (readingCount > READING_BUDGET) return null
      continue
    }
    // A Cyrillic letter the table does not read: a half-transliterated part would match the wrong
    // words, so the part gets no Latin source at all.
    if (CYRILLIC_LETTER.test(character)) return null
    source += escapeRegExp(foldAccents(character).text)
    required = true
  }
  return required ? source : null
}
