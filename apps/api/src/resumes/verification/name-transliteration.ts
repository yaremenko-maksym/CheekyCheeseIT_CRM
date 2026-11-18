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
 * part untransliterated rather than half-transliterated. A name whose optional pieces multiply past
 * `READING_BUDGET` is read with the first reading of every letter only (no alternation, nothing
 * optional), so the pattern can never backtrack combinatorially on a stored name chosen to make it
 * (`READING_BUDGET` below). Pure: no I/O.
 */
import { CONTACT_APOSTROPHES, foldAccents } from '@crm/shared'

/**
 * Lowercase Cyrillic letter to its Latin readings. The FIRST reading is the national romanisation,
 * the one a name past `READING_BUDGET` keeps; the order of the rest does not matter. NO readings at
 * all is a letter that is never written in Latin (`ъ`); an empty reading is a letter the Latin
 * spelling may leave out (`й`, `ь`).
 *
 * Every row but those two is prefix-free (no reading starts another), so at one text position at
 * most one reading matches and the row adds no backtracking; `nameReadingCount` checks this from the
 * rows rather than trusting it.
 */
const CYRILLIC_READINGS: Readonly<Record<string, readonly string[]>> = {
  а: ['a'],
  б: ['b'],
  в: ['v', 'w'],
  г: ['h', 'g'],
  ґ: ['g'],
  д: ['d'],
  е: ['e', 'ye'],
  є: ['ye', 'ie', 'je', 'e'],
  ж: ['zh', 'j'],
  з: ['z'],
  и: ['y', 'i'],
  і: ['i', 'y'],
  ї: ['yi', 'ji', 'i'],
  // The empty reading is the `ий`/`ій` ending written `y` (`Сироварський` as `Syrovarsky`).
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
  ч: ['ch', 'tch'],
  ш: ['sh'],
  щ: ['shch', 'sch'],
  // Dropped in the national romanisation, written as an apostrophe in another (`Il'chak`).
  ь: ['', "'"],
  ю: ['yu', 'iu', 'ju', 'u'],
  // The bare reading is the `ія` ending written `ia` (`Марія` as `Maria`).
  я: ['ya', 'ia', 'ja', 'a'],
  // Russian letters Ukrainian lacks
  ё: ['yo', 'jo', 'e'],
  ы: ['y'],
  ъ: [],
  э: ['e'],
}

/** Two-letter units read as one, checked before the single letters (`Максим` as `Maxim`). */
const CYRILLIC_DIGRAPHS: Readonly<Record<string, readonly string[]>> = {
  кс: ['ks', 'x'],
}

/**
 * The apostrophe of a Cyrillic name is silent in the national romanisation (`Дем'ян` is `Demian`)
 * and kept in another (`Dem'ian`). Only the ASCII one is read: every variant is normalised to it
 * first, the same way the scanned text is.
 */
const APOSTROPHE = "'"
const APOSTROPHE_READINGS: readonly string[] = ['', APOSTROPHE]

/**
 * The most ways a name's sources may read one text. A stored name is user-settable (`displayName`,
 * `legalFullName`), and the redaction joins its parts with a gap that may match empty, so the
 * optional pieces of every part multiply in one pattern: `ййййий` four times took 1.4 s on a
 * 40-character near-miss. The count is taken over the whole name (`nameReadingCount`), and past the
 * budget every part keeps its first readings only. 4096 is 12 optional pieces, and a real name
 * carries a handful (`Ільчак Андрій Юрійович` is 8).
 */
export const READING_BUDGET = 4096

/** Any letter the table reads; a Cyrillic letter outside it stops the part (see the file note). */
const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * One letter as a regex source: a non-capturing alternation of its readings, `''` for a letter with
 * no readings at all (`ъ`, never written in Latin), and an optional group for a letter that has an
 * empty reading beside real ones (`й`, left out of `Syrovarsky`).
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
 * `text` as one reading list per piece: a digraph, a letter, the apostrophe, or any other character
 * as its accent-folded self. `known` is false when a Cyrillic letter outside the table was skipped.
 *
 * Read in NFC, BEFORE the accent fold: the fold drops the breve of `й` and the diaeresis of `ї`,
 * turning them into `и` and `і` and losing their readings.
 */
function readPieces(text: string): { pieces: (readonly string[])[]; known: boolean } {
  const characters = [...text.normalize('NFC').replace(CONTACT_APOSTROPHES, APOSTROPHE)]
  const pieces: (readonly string[])[] = []
  let known = true
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] as string
    const digraph =
      CYRILLIC_DIGRAPHS[
        characters
          .slice(index, index + 2)
          .join('')
          .toLowerCase()
      ]
    if (digraph) {
      pieces.push(digraph)
      index++
      continue
    }
    const readings =
      CYRILLIC_READINGS[character.toLowerCase()] ??
      (character === APOSTROPHE ? APOSTROPHE_READINGS : undefined)
    if (readings) pieces.push(readings)
    else if (CYRILLIC_LETTER.test(character)) known = false
    else pieces.push([foldAccents(character).text])
  }
  return { pieces, known }
}

/**
 * How many readings of a piece can match at one text position: the longest chain of readings each
 * a prefix of the next (`''` is a prefix of all). A prefix-free row is 1.
 */
function branches(readings: readonly string[]): number {
  return Math.max(
    1,
    ...readings.map((reading) => readings.filter((r) => reading.startsWith(r)).length),
  )
}

/**
 * The most ways the Latin sources of `text` (a whole stored name, or one part) can read one text:
 * the product of `branches` over its pieces. Every source that joins parts joins a subset of the
 * name's pieces, so this bounds each of them (`READING_BUDGET`).
 */
export function nameReadingCount(text: string): number {
  return readPieces(text).pieces.reduce((count, readings) => count * branches(readings), 1)
}

/**
 * `part` as a regex source matching its Latin readings, or `null` when the part has no Cyrillic
 * letter (a Latin part is matched by the stored-spelling source already), holds a Cyrillic letter
 * the table does not read, or has no mandatory piece (a source of optional pieces only would match
 * everywhere: `ь`, `ь'`, `й`, and `ь` beside a lone combining mark, which folds to nothing).
 *
 * `primaryOnly` reads every piece with its first reading alone: no alternation and nothing
 * optional, so the source cannot backtrack. The caller passes the decision taken over the whole name;
 * on its own a part decides by its own count. Non-Cyrillic characters are folded and escaped, so a
 * mixed name (`Коваль Smith`) keeps its Latin part.
 */
export function transliteratedNameSource(
  part: string,
  primaryOnly = nameReadingCount(part) > READING_BUDGET,
): string | null {
  if (!CYRILLIC_LETTER.test(part)) return null
  const { pieces, known } = readPieces(part)
  if (!known) return null
  if (!pieces.some((readings) => readings.length > 0 && !readings.includes(''))) return null
  return pieces
    .map((readings) => (primaryOnly ? escapeRegExp(readings[0] ?? '') : letterSource(readings)))
    .join('')
}
