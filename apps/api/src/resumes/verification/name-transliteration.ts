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
 * part untransliterated rather than half-transliterated. Pure: no I/O.
 */
import { foldAccents } from '@crm/shared'

/**
 * Lowercase Cyrillic letter to its Latin readings, longest first (so a match takes the longest
 * reading). An empty reading is a letter that is not written in Latin at all (`ь`, `ъ`).
 */
const CYRILLIC_READINGS: Readonly<Record<string, readonly string[]>> = {
  а: ['a'],
  б: ['b'],
  в: ['v', 'w'],
  г: ['h', 'g'],
  ґ: ['g'],
  д: ['d'],
  е: ['e'],
  є: ['ye', 'ie', 'je'],
  ж: ['zh', 'j'],
  з: ['z'],
  и: ['y', 'i'],
  і: ['i'],
  ї: ['yi', 'ji', 'i'],
  й: ['y', 'i', 'j'],
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
  ь: [''],
  ю: ['yu', 'iu', 'ju'],
  я: ['ya', 'ia', 'ja'],
  // Russian letters Ukrainian lacks
  ё: ['yo', 'jo', 'e'],
  ы: ['y'],
  ъ: [''],
  э: ['e'],
}

/** The apostrophe of a Cyrillic name is silent in Latin (`Дем'ян` is `Demian`). */
const SILENT = new Set(["'"])

/** Any letter the table reads; a Cyrillic letter outside it stops the part (see the file note). */
const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** One letter as a regex source: a literal, a non-capturing alternation, or '' for a silent one. */
function letterSource(readings: readonly string[]): string {
  const escaped = readings.filter(Boolean).map(escapeRegExp)
  if (escaped.length === 0) return ''
  // Stryker disable next-line ConditionalExpression: equivalent — a one-reading alternation `(?:a)` matches exactly what the literal `a` does
  if (escaped.length === 1) return escaped[0] ?? ''
  // Non-capturing: `findWholeTokens` requires every capture group that matches empty to sit on a
  // gap, so a capturing group here would drop real hits.
  return `(?:${escaped.join('|')})`
}

/**
 * `part` as a regex source matching its Latin readings, or `null` when the part has no Cyrillic
 * letter (a Latin part is matched by the stored-spelling source already), holds a Cyrillic letter
 * the table does not read, or reads as nothing at all (an empty source would match everywhere).
 *
 * The part is read in NFC, BEFORE the accent fold: the fold drops the breve of `й` and the diaeresis
 * of `ї`, turning them into `и` and `і` and losing their readings. Non-Cyrillic characters are
 * folded and escaped, so a mixed name (`Коваль Smith`) keeps its Latin part.
 */
export function transliteratedNameSource(part: string): string | null {
  const nfc = part.normalize('NFC')
  if (!CYRILLIC_LETTER.test(nfc)) return null
  let source = ''
  for (const character of nfc) {
    const readings = CYRILLIC_READINGS[character.toLowerCase()]
    if (readings) {
      source += letterSource(readings)
      continue
    }
    if (SILENT.has(character)) continue
    // A Cyrillic letter the table does not read: a half-transliterated part would match the wrong
    // words, so the part gets no Latin source at all.
    if (CYRILLIC_LETTER.test(character)) return null
    source += escapeRegExp(foldAccents(character).text)
  }
  return source === '' ? null : source
}
