/**
 * Resume completeness check (verified-base-resume spec §5.1).
 *
 * Deterministic and dependency-free: it runs live in the HR form and again on
 * the server at Submit, so the same facts must always produce the same issues in
 * the same order. Paths address a field (`experience.1.start`) or a list
 * (`skills`, `experience.<i>.notes`); the UI maps them to inputs.
 *
 * `now` is injected rather than read from the clock, so the future-start check
 * is testable and the server can freeze one timestamp for a whole check run.
 */
import { resumeLinkSchema } from './resume'
import { resumeYear, type ResumeFacts, type ResumeFactsExperience } from './resume-facts'
import { mergeSkills } from './resume-skills'

export const COMPLETENESS_CODES = [
  'HEADLINE_MISSING',
  'NO_EXPERIENCE',
  'COMPANY_MISSING',
  'ROLE_MISSING',
  'START_MISSING',
  'END_MISSING',
  'END_BEFORE_START',
  'START_IN_FUTURE',
  'END_IN_FUTURE',
  'NO_NOTES',
  'TOO_FEW_SKILLS',
  'ENGLISH_MISSING',
  'NON_LATIN',
  'NAME_NON_LATIN',
  'CONTACT_IN_TEXT',
  'LINK_INVALID',
  'YEAR_INVALID',
] as const
export type CompletenessCode = (typeof COMPLETENESS_CODES)[number]

export type CompletenessIssue = { path: string; code: CompletenessCode }

/**
 * A phone number: at least nine digits, with `+`, spaces, dots, parentheses, the middle dot
 * `·`, hyphens and every dash (U+2010, the non-breaking hyphen U+2011, U+2012, the en / em dash,
 * U+2015, the minus U+2212) allowed between them. The digit lookahead is what keeps dates,
 * version numbers and large figures out (`2015 – 2019`, `Mar 2021 – May 2023`,
 * `C++ 17`, `1,000,000 requests`, `Node.js 18`); commas are deliberately not a
 * separator for the same reason.
 * shortcut: `/` and `_` are not separators (`10/100/1000 users`, `build_123_456_789`); upgrade if
 * slash- or underscore-separated phones show up in real resumes.
 *
 * Stateless on purpose (no `g` flag): the same pattern is reused by the API, so
 * `.test()` on a shared RegExp must not depend on an earlier call's lastIndex. The first
 * lookahead runs the digit-count one only where a phone can start; without it a long run of
 * separators is rescanned from each of its positions (quadratic).
 */
export const RESUME_PHONE_PATTERN =
  /(?=[+(]?\d)(?=(?:[^\d\p{L}]*\d){9})[+(]?\d[\d\s().·‐‑‒–—―−-]{7,}\d/u

/** A full date: `YYYY-MM-DD` / `YYYY.MM.DD` / `YYYY/MM/DD` or `DD-MM-YYYY` / `DD.MM.YYYY` / `DD/MM/YYYY`. */
const FULL_DATE = String.raw`(?:(?:19|20)\d\d[-./](?:0[1-9]|1[0-2])[-./](?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|[12]\d|3[01])[-./](?:0[1-9]|1[0-2])[-./](?:19|20)\d\d)`
/** A phone candidate made only of full dates and separators (`2015-01-01 - 2019-12-31`). */
const DATES_ONLY = new RegExp(String.raw`^${FULL_DATE}(?:[\s().·‐‑‒–—―−-]+${FULL_DATE})*$`)

/**
 * A phone candidate made only of 4-digit years in 1950..2099 joined by separators
 * (`2019 · 2020 · 2021`, `1999—2003—2007`).
 */
function isYearsOnly(match: string): boolean {
  if (match.includes('+')) return false
  return Array.from(match.matchAll(/\d+/gu), ([group]) => group).every((group) => {
    const year = Number(group)
    return group.length === 4 && year >= 1950 && year <= 2099
  })
}

/**
 * Every phone in `text` as `[start, end)` offsets: `RESUME_PHONE_PATTERN` runs,
 * minus runs that are only full dates or year lists. The one rule both the
 * completeness check and the API contact scan use. A bare ten-digit run stays
 * a phone: a UA mobile `0671234567` has that shape, and a missed phone is a leak.
 */
export function findPhoneSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  // A fresh global copy per call, so the exported pattern stays stateless.
  for (const m of text.matchAll(new RegExp(RESUME_PHONE_PATTERN.source, 'gu'))) {
    if (!DATES_ONLY.test(m[0]) && !isYearsOnly(m[0])) {
      spans.push({ start: m.index, end: m.index + m[0].length })
    }
  }
  return spans
}

/**
 * An email address shape: local part with every RFC 5322 atext character (``!#$%&'*+/=?^_`{|}~-``)
 * and dots, and a dot TLD of letters or punycode (`xn--p1ai`). Letters in the local part and the
 * host may carry combining marks (`परीक्षा.भारत`, `ตัวอย่าง.ไทย`, `x́y`). The local part starts after the text start or any character that is not
 * a local-part one, which the pattern consumes, so its hit is group 1: a run of local-part
 * characters is tried from its start only, and a long `a.a.a…` or a Cyrillic paragraph without an
 * `@` costs linear time, not quadratic. So the local part needs no bound and matches whole, however
 * long. Host labels are bounded (63, at most 20) for the same reason.
 */
export const RESUME_EMAIL_PATTERN =
  /(?:^|[^\p{L}\p{M}\p{N}._%+!#$&'*\/=?^`{|}~-])([\p{L}\p{M}\p{N}._%+!#$&'*\/=?^`{|}~-]+@(?:[\p{L}\p{M}\p{N}-]{1,63}\.){1,20}(?:[Xx][Nn]--[\p{L}\p{M}\p{N}-]{1,59}|[\p{L}\p{M}]{2,}))/u

/**
 * A URL: any `scheme://…`, any `www.…`, or `label.tld/path` with Unicode labels and any 2–24
 * letter TLD in any case and script (`bit.ly/x`, `GitHub.Com/x`, `иван.рф/cv`) or a punycode TLD
 * (`example.xn--p1ai/cv`), except `js` / `ts` right before the slash (`Express.js/Nest`,
 * `Node.js/Express`). `ASP.NET/Core` reads as a URL, which is accepted. Labels may carry combining
 * marks (`उदाहरण.भारत/x`), and a port may sit before the slash (`example.com:8080/cv`, 1–5
 * digits). The bare form starts after
 * the text start or any character that is not a label one (`foo_github.com/x` hits `github.com/x`);
 * it consumes that character, so its hit is group 1, and a run of label characters is tried from
 * its start only, never from each of its letters. Runs are bounded as in the email pattern
 * (scheme 31, labels 63 × 20), so the scan stays linear. Stateless (no `g`), like the phone pattern.
 * shortcut: a bare domain with no path (`johndoe.dev`, `github.com`) is not a URL, because
 * `Socket.io` is a skill; upgrade to a domain allow-list if such leaks show up.
 */
export const RESUME_URL_PATTERN =
  /\b(?:[A-Za-z][\w+.-]{0,30}:\/\/\S+|[Ww]{3}\.\S+)|(?:^|[^\p{L}\p{M}\p{N}-])((?:[\p{L}\p{M}\p{N}-]{1,63}\.){1,20}(?![Jj][Ss]\/|[Tt][Ss]\/)(?:[Xx][Nn]--[\p{L}\p{M}\p{N}-]{1,59}|[\p{L}\p{M}]{2,24})(?::\d{1,5})?\/\S*)/u

/** `word` in any case without the `i` flag, which would also let `\p{Ll}` match a capital. */
function anyCase(word: string): string {
  return [...word].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join('')
}

/**
 * After a label: a colon (also the fullwidth `：`) or a dash other than the hyphen (U+2010, U+2012,
 * the en / em dash, U+2015, the minus U+2212), then optional `@`s (`tg: mark_dev`, `tg—mark_dev`);
 * or nothing / a hyphen, then at least one `@` (`TG @mark_dev`, `Telegram - @mark_dev`), so
 * `Telegram bots`, `TG integration` and `Telegram-integration` are not handles. Spaces may follow
 * the `@`s (`Telegram:@ mark_dev`). Each branch has one way to split its spaces, so a label
 * followed by a long run of spaces stays linear.
 * shortcut: a punctuation-wrapped label (`Telegram (@x)`, `Telegram | @x`, `Telegram.@x`, `tg/@x`)
 * is not caught; upgrade if seen in real resumes.
 */
const LABEL_HANDLE = String.raw`(?:\s*[:：‐‒–—―−]\s*(?:@+\s*)?|\s*(?:-\s*)?@+\s*)[A-Za-z]\w{4,}`

/**
 * An optional word between the label and `LABEL_HANDLE` (`Telegram handle: x`, `TG nick — x`,
 * `Telegram ID @x`, `Телеграм нік: x`). The word needs a space before it and the separator or `@`
 * after it, so `Telegram user base` and `TG identity: builder` are not handles. Longer words come
 * first (`username` before `user`, `nickname` before `nick`).
 */
const LABEL_WORD = String.raw`(?:\s+(?:${['handle', 'username', 'user', 'nickname', 'nick', 'id', 'нікнейм', 'ник', 'нік'].map(anyCase).join('|')}))?`

/**
 * A labelled Telegram handle that need not be the stored one: `tg`, `тг`, `telegram`,
 * `телеграм` or `телеграмм`, any case, then an optional `LABEL_WORD`, then `LABEL_HANDLE` and a
 * handle as Telegram allows it (a letter first, 5+ characters), so `tg:12345` is not one. `telegram` / `телеграм` may be glued (`MyTelegram:`).
 * The short `tg` / `тг` must start a word or follow a camel-case join (`PersonalTG:`, `моїТГ:`),
 * so `xtg:` is not one; that prefix stands in for a lookbehind (Safari < 16.4), and group 1 is the
 * short-label hit without it. A bare `@handle` is not one (`@angular/core`, `@nestjs/common`).
 * shortcut: a glued all-caps (`MYTG:`) or all-lowercase (`mytg:`) short label is not caught;
 * upgrade if seen in real resumes.
 */
export const RESUME_TELEGRAM_LABEL_PATTERN = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}]|\p{Ll}(?=[TТ]))((?:${anyCase('tg')}|${anyCase('тг')})${LABEL_WORD}${LABEL_HANDLE})|(?:${anyCase('telegram')}|${anyCase('телеграм')}[мМ]?)${LABEL_WORD}${LABEL_HANDLE}`,
  'u',
)

/**
 * A stored `users.telegram` as Telegram spells the handle: trimmed, without a
 * `tg://resolve?domain=` link, a `tg:` / `telegram:` label, an `http(s)://`, a `www.`, a `t.me/`
 * (also `t.me/s/`) or `telegram.me/` prefix, or leading `@`s, and ending at the first `/`, `?`,
 * `#` or `&` (`t.me/mark_dev?start=1`). Undefined unless that is a Telegram username (a letter,
 * then 4+ of `[A-Za-z0-9_]`): an invite link (`t.me/joinchat/…`, `t.me/+…`) or a stray word would
 * otherwise redact every occurrence of it.
 */
export function normaliseTelegramHandle(stored: string | null | undefined): string | undefined {
  if (!stored) return undefined
  return /^(?:tg:\/\/resolve\?domain=|(?:(?:tg|telegram)\s*:\s*)?(?:https?:\/\/)?(?:www\.)?(?:(?:t|telegram)\.me\/(?:s\/)?)?)@*(?!joinchat(?:$|[/?#&]))([A-Za-z]\w{4,})(?:$|[/?#&])/i.exec(
    stored.trim(),
  )?.[1]
}

const LETTER_PATTERN = /\p{L}/u
const LATIN_LETTER_PATTERN = /\p{Script=Latin}/u

/** Typographic and Ukrainian apostrophes: U+02BC is a modifier letter, not a script letter. */
const APOSTROPHES = '\u2019\u02BC'

/**
 * True when every letter in `text` is Latin-script. Digits, punctuation,
 * symbols, spaces and the empty string pass — `C++ 17` and `Node.js 18` are
 * legitimate skill/technology text, while `José Müller` passes through the same
 * check as `Engineer`. The apostrophes U+2019 and U+02BC are
 * accepted too (`Dʼangelo`).
 */
export function isLatinScript(text: string): boolean {
  for (const char of text) {
    if (APOSTROPHES.includes(char)) continue
    if (LETTER_PATTERN.test(char) && !LATIN_LETTER_PATTERN.test(char)) return false
  }
  return true
}

function isBlank(text: string): boolean {
  return text.trim() === ''
}

type ContactCheck = (text: string) => boolean

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The typographic, reversed and Ukrainian (U+02BC) apostrophes, read as `'` one code unit for one, so offsets stay valid. */
export const CONTACT_APOSTROPHES = /[’ʼ‘]/gu

/** NFC, and the apostrophes as the ASCII one: "O’Neil" and an NFD "José" match. */
const normaliseName = (text: string): string =>
  text.normalize('NFC').replace(CONTACT_APOSTROPHES, "'")

/**
 * Characters that split a contact without showing: format characters (`Cf`), the other
 * default-ignorables (variation selectors, CGJ, Hangul fillers), U+2800 BRAILLE PATTERN BLANK,
 * a symbol (`So`) stripped on purpose because it renders blank, and the C0 and C1 controls other
 * than the whitespace ones (`\t\n\v\f\r`), U+0085 included: `P`, NUL, `etrenko` is the name.
 */
const INVISIBLE_PATTERN = /[⠀\x00-\x08\x0E-\x1F\x7F-\x9F\p{Cf}\p{Default_Ignorable_Code_Point}]/gu
/**
 * A conjoining Hangul jamo run or a visible character plus the marks after it, the characters of
 * `INVISIBLE_PATTERN` between them included, so jamo compose into a syllable and a base letter
 * with its mark once those go. A stripped character not followed by a mark or a jamo starts no
 * cluster.
 */
const CLUSTER_PATTERN =
  /[ᄀ-ᇿꥠ-꥿ힰ-퟿](?:[⠀\x00-\x08\x0E-\x1F\x7F-\x9F\p{Cf}\p{Default_Ignorable_Code_Point}]*[ᄀ-ᇿꥠ-꥿ힰ-퟿])*|[^⠀\x00-\x08\x0E-\x1F\x7F-\x9F\p{Cf}\p{Default_Ignorable_Code_Point}](?:[⠀\x00-\x08\x0E-\x1F\x7F-\x9F\p{Cf}\p{Default_Ignorable_Code_Point}]*\p{M})*/gu
/** A `CLUSTER_PATTERN` hit that is a jamo run. No anchor needed: the other branch never takes a jamo, so its clusters hold none. */
const isJamoRun = (cluster: string): boolean => /[ᄀ-ᇿꥠ-꥿ힰ-퟿]/u.test(cluster)

/** Whether one character (the loop hands it one code point) is in `INVISIBLE_PATTERN`; no `g` flag, so `.test` keeps no state. */
const INVISIBLE_CHAR = /[⠀\x00-\x08\x0E-\x1F\x7F-\x9F\p{Cf}\p{Default_Ignorable_Code_Point}]/u

/** A character `normaliseContactText` has to cluster: a stripped one, a mark or a conjoining jamo. */
const CLUSTERED_CHAR =
  // Stryker disable next-line Regex: the `\P` forms are equivalent (more text goes to the cluster loop, which returns the same); the `[^…]` form is killed when unsuppressed
  /[⠀\x00-\x08\x0E-\x1F\x7F-\x9F\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}ᄀ-ᇿꥠ-꥿ힰ-퟿]/u

/** A decimal digit other than `0-9` (`٣`, `۳`, `३`): a phone written in it is still a phone (453c). */
const NON_ASCII_DIGIT = /[^\P{Nd}0-9]/u

/**
 * `text` with every non-ASCII decimal digit as its ASCII digit, one code point for one. Unicode
 * assigns `Nd` in contiguous blocks of 0..9 (pinned in the residuals spec), so a digit's value is
 * its distance from the start of its block, modulo ten for the blocks of several sets.
 */
function foldDigits(text: string): string {
  return text.replace(new RegExp(NON_ASCII_DIGIT.source, 'gu'), (digit) => {
    const cp = digit.codePointAt(0) ?? 0
    let zero = cp
    while (NON_ASCII_DIGIT.test(String.fromCodePoint(zero - 1))) zero--
    return String((cp - zero) % 10)
  })
}

/** The offset maps of text in which every code point is its own cluster and maps to itself. */
function identityMaps(text: string): { from: number[]; to: number[] } {
  const from: number[] = []
  const to: number[] = []
  for (let index = 0; index < text.length;) {
    const width = (text.codePointAt(index) ?? 0) >= 0x10000 ? 2 : 1
    for (let k = 0; k < width; k++) {
      from.push(index)
      to.push(index + width)
    }
    index += width
  }
  return { from, to }
}

const isLeadingJamo = (c: number): boolean => c >= 0x1100 && c <= 0x1112
const isVowelJamo = (c: number): boolean => c >= 0x1161 && c <= 0x1175

/**
 * The gaps inside a conjoining jamo run, as offsets of its composed form plus `at`: where a
 * stripped character sits before a jamo that starts a new syllable, never inside one (`ᄀ`, ZWSP,
 * `ᅡ` is one syllable). NFC composes a vowel after a leading consonant and a trailing consonant
 * (U+11A8..U+11C2) after both, and nothing else in a run, so each jamo that does not compose is one
 * composed character. One pass, so a run of many invisibles stays linear.
 */
function addJamoRunGaps(run: string, at: number, gaps: Set<number>): void {
  let previous = 0
  let beforePrevious = 0
  let composed = 0
  let pending = false
  for (const char of run) {
    if (INVISIBLE_CHAR.test(char)) {
      pending = true
      continue
    }
    const c = char.codePointAt(0) ?? 0
    const joins =
      (isVowelJamo(c) && isLeadingJamo(previous)) ||
      (c >= 0x11a8 && c <= 0x11c2 && isVowelJamo(previous) && isLeadingJamo(beforePrevious))
    if (!joins) {
      if (pending) gaps.add(at + composed)
      composed++
    }
    pending = false
    beforePrevious = previous
    previous = c
  }
  // a run may end with a stripped filler (U+1160)
  if (pending) gaps.add(at + composed)
}

/**
 * Normalise text for contact scanning: strip the characters of `INVISIBLE_PATTERN`, then NFKC per
 * cluster, maintaining offset maps (`from` and `to`) from each code unit back to its cluster in the
 * original string. No visible character NFKC-maps to a stripped one, so one strip suffices.
 * `gaps` holds each normalised offset where a stripped character sat between two characters
 * (not inside a composed one): `findWholeTokens` counts it as a token boundary, so a name glued to
 * the next word by a zero-width space still stands alone, as it did before the strip. A letter that
 * took a stripped character and a mark (`o`, ZWSP, acute) ends at a gap too: before the strip the
 * invisible split the letter from the mark, and the mark from the next word.
 * `digits` folds non-ASCII digits to ASCII (453c). Pass `false` for the text main scanned: there a
 * non-ASCII digit is a non-word edge (`١www.site.dev` has a `\b` before `www`), so the generic
 * patterns run on both forms and the fold only adds hits.
 */
export function normaliseContactText(
  text: string,
  digits = true,
): {
  text: string
  from: number[]
  to: number[]
  gaps: Set<number>
} {
  // Most text has nothing to cluster and is NFKC already: every code point is then its own cluster
  // and maps to itself, so the per-cluster loop below would return the text unchanged.
  // Stryker disable next-line ConditionalExpression,BlockStatement: `false` and `{}` are equivalent (the loop returns the same); the `true` forms are killed when unsuppressed
  if (
    // Stryker disable next-line ConditionalExpression: equivalent — `false` only skips the fast path, and the loop returns the same
    !CLUSTERED_CHAR.test(text) &&
    // Stryker disable next-line LogicalOperator: equivalent — `&&` only narrows the fast path; the loop returns the same text for any text the fast path takes, so skipping it is never wrong
    (!digits || !NON_ASCII_DIGIT.test(text)) &&
    text.normalize('NFKC') === text
  ) {
    return { text, ...identityMaps(text), gaps: new Set() }
  }
  let normalised = ''
  const from: number[] = []
  const to: number[] = []
  const gaps = new Set<number>()
  let cursor = 0
  for (const { 0: cluster, index } of text.matchAll(CLUSTER_PATTERN)) {
    // Stripped characters between clusters: the next character starts after a gap.
    if (index > cursor) gaps.add(normalised.length)
    const stripped = cluster.replace(INVISIBLE_PATTERN, '')
    const compatible = stripped.normalize('NFKC')
    // A digit stays a digit, so the fold comes after the edge test below and adds no edge.
    const piece = digits ? foldDigits(compatible) : compatible
    if (isJamoRun(cluster)) addJamoRunGaps(cluster, normalised.length, gaps)
    else if (stripped.length < cluster.length) gaps.add(normalised.length + piece.length)
    // A compatibility character (`™`, `²`, `ｘ`, `ﬁ`) is an edge on both sides, as it was before
    // NFKC made letters of it: `Petrenko™` still ends the name (PR #1351 round 6, SR-H-4).
    if (compatible !== stripped.normalize('NFC')) {
      gaps.add(normalised.length).add(normalised.length + piece.length)
    }
    normalised += piece
    for (let k = 0; k < piece.length; k++) {
      from.push(index)
      to.push(index + cluster.length)
    }
    cursor = index + cluster.length
  }
  return { text: normalised, from, to, gaps }
}

/**
 * Letters NFD does not decompose and `/iu` does not case-fold to the mapped form
 * (`/ss/iu` misses `ẞ`), folded by hand; `ß` becomes two code units.
 */
const UNDECOMPOSED: Record<string, string> = {
  ł: 'l',
  Ł: 'L',
  ø: 'o',
  Ø: 'O',
  đ: 'd',
  Đ: 'D',
  ß: 'ss',
  ẞ: 'SS',
  ı: 'i',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  þ: 'th',
  Þ: 'TH',
  ħ: 'h',
  Ħ: 'H',
}
/** A mark or an `UNDECOMPOSED` letter: a character `foldAccents` changes in NFD-stable text. */
const FOLDED_CHAR = new RegExp(
  // Stryker disable next-line StringLiteral: equivalent — a wider class only sends more text to the fold loop, which returns the same
  String.raw`[\p{M}${Object.keys(UNDECOMPOSED).join('')}]`,
  'u',
)

/**
 * `text` without accents (NFD, marks dropped, plus `UNDECOMPOSED`), for each of its code units the
 * span of the character, marks included, it came from, and `gaps` (offsets of `text`) carried to
 * folded offsets. Names are matched on this on both sides, so `Muller` hits `Müller`.
 */
export function foldAccents(
  text: string,
  gaps: ReadonlySet<number> = new Set(),
): { text: string; from: number[]; to: number[]; gaps: Set<number> } {
  // No gap, no mark, nothing NFD splits and no hand-folded letter: the loop below would keep the text.
  // Stryker disable next-line ConditionalExpression,BlockStatement: `false` and `{}` are equivalent (the loop returns the same); the `true` forms are killed when unsuppressed
  if (gaps.size === 0 && text.normalize('NFD') === text && !FOLDED_CHAR.test(text)) {
    return { text, ...identityMaps(text), gaps: new Set() }
  }
  let folded = ''
  const from: number[] = []
  const to: number[] = []
  const foldedGaps = new Set<number>()
  for (const { 0: cluster, index } of text.matchAll(/\P{M}\p{M}*/gu)) {
    if (gaps.has(index)) foldedGaps.add(folded.length)
    // A cluster is one base letter plus marks, so after the marks go it is one key.
    const base = cluster.normalize('NFD').replace(/\p{M}/gu, '')
    const piece = UNDECOMPOSED[base] ?? base
    folded += piece
    for (let k = 0; k < piece.length; k++) {
      from.push(index)
      to.push(index + cluster.length)
    }
    // A mark left in normalised text is bare (`o`, U+0903): no letter took it, so it is an edge
    // after the letter, as main's check read it (SR-M-4). That covers a gap on one of the marks
    // too (stripped before a mark that follows a jamo run).
    if (/\p{M}/u.test(cluster)) foldedGaps.add(folded.length)
  }
  return { text: folded, from, to, gaps: foldedGaps }
}

/**
 * Whitespace between name parts, raw or JSON-escaped (`\n`, `\r`, `\t`), or none where a gap is
 * (`Ivan`, U+FEFF, `Petrenko`): the group may match empty, and `findWholeTokens` takes an empty
 * group only on a gap.
 */
export const CONTACT_NAME_GAP = String.raw`((?:\s|\\[nrt])*)`

/**
 * The one token boundary of both sides (completeness and the API redaction). A name is a token of
 * letters and digits (`Levin` is not in `Levine` or `Levin7`, but is in `Levin#`); it may also
 * start right after a JSON-style escape (`\n`, a `\u` code), whose last letter is not part of it.
 * A Telegram username is `[A-Za-z0-9_]`, so `\w` is its boundary, and it has no escape rule.
 */
const TOKEN_BOUNDARY = {
  name: {
    before: /[\p{L}\p{N}]$/u,
    after: /^[\p{L}\p{N}]/u,
    escape: /\\(?:[bfnrt]|u[\dA-Fa-f]{4})$/u,
  },
  handle: { before: /\w$/u, after: /^\w/u, escape: null },
  /**
   * The API redaction's name boundary: fail-closed, so a digit is an edge too (`Petrenko1990`,
   * backlog 453d). Completeness and the API gate keep `name`, main's token.
   */
  redactedName: {
    before: /\p{L}$/u,
    after: /^\p{L}/u,
    escape: /\\(?:[bfnrt]|u[\dA-Fa-f]{4})$/u,
  },
} as const

/**
 * Every hit of `source` (any case) in `text` that stands as a whole token: each edge is the text
 * edge, a non-token character, or a gap (`normaliseContactText`). Only the edges may use a gap; a
 * gap inside a hit changes nothing (`Iv`, ZWNJ, `an` is `Ivan`). Every start is tried, one code
 * point apart, so a hit refused at its edges hides no later overlapping one. An empty capture group
 * (`CONTACT_NAME_GAP` that matched no whitespace) must sit on a gap. No lookbehind: it
 * throws on Safari < 16.4, and the completeness check runs in the browser.
 */
export function findWholeTokens(
  text: string,
  gaps: ReadonlySet<number>,
  source: string,
  kind: keyof typeof TOKEN_BOUNDARY,
): Array<{ start: number; end: number }> {
  const boundary = TOKEN_BOUNDARY[kind]
  const spans: Array<{ start: number; end: number }> = []
  // `d`: the group offsets, so an empty `CONTACT_NAME_GAP` can be checked against `gaps`.
  const pattern = new RegExp(source, 'dgiu')
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const start = m.index
    const end = start + m[0].length
    const before = text.slice(Math.max(0, start - 6), start)
    const { indices } = m
    if (
      // Stryker disable next-line OptionalChaining,UnaryOperator: equivalent — the `d` flag always sets indices and every group of a source takes part, so neither the chain nor the -1 fallback is reached
      !m.some((group, g) => group === '' && !gaps.has(indices?.[g]?.[0] ?? -1)) &&
      (gaps.has(start) ||
        !boundary.before.test(before) ||
        (boundary.escape?.test(before) ?? false)) &&
      (gaps.has(end) || !boundary.after.test(text.slice(end, end + 2)))
    ) {
      spans.push({ start, end })
    }
    // One code point on: a lastIndex inside a surrogate pair snaps back under `u` and never moves.
    pattern.lastIndex = start + ((text.codePointAt(start) ?? 0) >= 0x10000 ? 2 : 1)
  }
  return spans
}

/** Characters a name part may start or end with: none of them is gap text (`CONTACT_NAME_GAP`, the API's run gap). */
const NAME_PART_EDGE = /^[^\p{L}\p{M}\p{N}']+|[^\p{L}\p{M}\p{N}']+$/gu

/**
 * Normalised name text as its parts, under one invariant that keeps every name pattern linear
 * (PR #1416 round 3, the class of SR-H-1/2/3): a part is never empty, holds no whitespace and no
 * backslash, starts and ends with a letter, a mark, a digit or an apostrophe, and keeps a letter
 * after `foldAccents`. So no part source can match empty or match gap text, and two gaps never sit
 * side by side. An escaped `\n`, `\r` or `\t` (any case, as the gap reads it) is one separator, so
 * `Ivan\nPetrenko` is `Ivan`, `Petrenko`, not `Ivan`, `nPetrenko`. Punctuation inside a part stays
 * (`Petrenko-Kovalenko` is one part, matched as written). The two backslashes NFKC turns into `\`
 * (U+FF3C, U+FE68) count as one before it too, so NFC and NFKC text split alike: every name arm, the
 * completeness raw arm and the API's main arm included, splits through this one function.
 */
export function splitNameText(text: string): string[] {
  return text
    .replace(/[\\＼﹨][nrt]/giu, ' ')
    .split(/[\s\\＼﹨]/u)
    .map((part) => part.replace(NAME_PART_EDGE, ''))
    .filter((part) => /\p{L}/u.test(foldAccents(part).text))
}

/**
 * The parts of a stored name, normalised like the text, read two ways: split on whitespace after
 * the strip (`Iv`, ZWNJ, `an` is one part), and split on whitespace and the stripped characters
 * (`Ivan`, ZWSP, `Petrenko` is two). A control character splits in both (`Ivan`, U+0085,
 * `Petrenko`). Equal readings are one (CR-M-5). The split reading is checked through
 * `splitNameOrders` and `splitNameLoneParts`; which side takes it is noted above `splitNameOrders`.
 *
 * A backslash splits too, after the normalisation (NFKC makes one of U+FF3C): `CONTACT_NAME_GAP`
 * matches an escaped `\n`, so a part that could match one as well would let a pattern split a run
 * of `\n` between parts and gaps in exponentially many ways (PR #1416, SR-H-2). Every part obeys
 * `splitNameText`'s invariant.
 */
export function contactNameParts(name: string): string[][] {
  const parts = (text: string) =>
    // a control character splits like whitespace
    splitNameText(
      normaliseContactText(text.replace(/\p{Cc}/gu, ' ')).text.replace(CONTACT_APOSTROPHES, "'"),
    )
  const joined = parts(name)
  const split = parts(name.replace(INVISIBLE_PATTERN, ' '))
  return split.join(' ') === joined.join(' ') ? [joined] : [joined, split]
}

/** Letters in a name part; marks, digits and punctuation do not count. */
const nameLetters = (part: string): number => part.replace(/\P{L}/gu, '').length

/*
 * The two sides read the split reading differently (PR #1351 round 7). With a joined reading of two
 * or more parts, the invisible sits inside a real part and its fragments are artefacts (`Ivan Petr`,
 * ZWNJ, `in` gives `in`); with a joined reading of one part, the invisible was the only separator
 * and the split reading is the real name (`Wei`, ZWSP, `Li`). The redaction is fail-closed and
 * always takes the whole split reading, a fragment such as `in` included. Completeness takes it only
 * for a joined reading of one part, so `Ivan in Kyiv since 2020` stays submittable.
 */

/**
 * The part orders of the split reading: every part in order, and the first part with each later
 * part, both ways, whatever their length. A two-part reading is its own first pair, so it is not
 * repeated.
 */
export function splitNameOrders(parts: readonly string[]): string[][] {
  const [first, ...rest] = parts
  const pairs =
    // Stryker disable next-line ConditionalExpression: only the `false` form is equivalent (`first` is undefined only for an empty reading, whose `rest` is empty); the `true` form is killed when applied by hand (7 shared tests, 18 api tests fail), and a disable comment cannot name one form
    first === undefined
      ? []
      : rest.flatMap((part) => [
          [first, part],
          [part, first],
        ])
  return parts.length === 2 ? pairs : [[...parts], ...pairs]
}

/** The parts of the split reading the API redacts alone: each part after the first with two letters or more. */
export function splitNameLoneParts(parts: readonly string[]): string[] {
  return parts.slice(1).filter((part) => nameLetters(part) >= 2)
}

/**
 * The part orders a name check tries: every part in order, the first and the last, the last and the
 * first. A one-part name adds them only when it is two or more precomposed Hangul syllables
 * (Korean names are often written as one token); any other single part adds none: a first name or
 * surname alone is a common word too often.
 */
function nameOrders(tokens: string[]): string[][] {
  const first = tokens[0]
  const last = tokens.at(-1)
  return (
    // Stryker disable next-line StringLiteral: equivalent — `first` is undefined only for an empty name, and the Hangul test fails on any non-Hangul fallback as on ''
    (tokens.length >= 2 || /^[가-힣]{2,}$/u.test(first ?? '')) &&
      // Stryker disable next-line ConditionalExpression: type narrowing only — the line above passes only with one token or more, so first is defined and forcing this guard true changes no result
      first !== undefined &&
      // Stryker disable next-line ConditionalExpression: as above, one token or more means the last one is defined
      last !== undefined
      ? [tokens, [first, last], [last, first]]
      : []
  )
}

/**
 * Phone, email, the senior's Telegram handle (whole token, with or without its
 * `@`, any case), or the senior's full name, whole words, any case, accents or spacing,
 * in the orders of `nameOrders`.
 * Names and the handle use `findWholeTokens`, the boundary the API redaction uses, so a name this
 * flags there is one the API redacts. The check main had runs beside it, so no text main flagged
 * passes: it reads any non-letter next to a name, a bare mark (`Petrenko`, U+0903) included, as an
 * edge, and the redaction does not.
 */
function contactCheck(displayName: string, telegram: string | null | undefined): ContactCheck {
  // Context values are normalised like the text, so a name or handle written with a ligature, a
  // zero-width joiner or fullwidth letters still matches itself written the same way.
  const readings = contactNameParts(displayName)
  // Stryker disable next-line OptionalChaining: equivalent — contactNameParts always returns the joined reading first, so readings[0] is defined
  const joinedLength = readings[0]?.length ?? 0
  const names = readings
    .flatMap((parts, reading) => {
      if (reading === 0) return nameOrders(parts)
      // the split reading only when it is the real name, see above splitNameOrders
      return joinedLength > 1 ? [] : splitNameOrders(parts)
    })
    .map((parts) =>
      parts.map((part) => escapeRegExp(foldAccents(part).text)).join(CONTACT_NAME_GAP),
    )
  const handle = normaliseTelegramHandle(telegram && normaliseContactText(telegram).text)
  // Any `@`s in front (`@@h`, `x@h`) still hit. A handle equal to a skill word flags that word
  // too: availability, not a leak.
  const handleSource = handle ? `@*${escapeRegExp(handle)}` : null
  // Main's check, on the NFC text: no lookbehind (it throws on Safari < 16.4), so `(?:^|…)` in front.
  // Its handle arm is a guarantee, not a second detector: the own check above flags every text it
  // flags on all inputs tried (for `ivan_dev`, each code point up to U+20000, U+3001–U+F8FF skipped,
  // beside the handle, PR #1351 round 6), so the mutants that only weaken it are masked: a
  // measurement, not a proof. Its name arm is load-bearing (round 8): completeness keeps main's
  // whitespace reading of the stored name, and for U+FEFF, which `\s` matches and the strip removes,
  // that reading is the split one, which the own check drops for a joined reading of two or more parts.
  // the one splitter of every name arm, so this arm and the API agree on a part (PR #1416 round 3)
  const rawOrders = nameOrders(splitNameText(normaliseName(displayName)))
  const rawSource = rawOrders.map((parts) => parts.map(escapeRegExp).join('\\s+')).join('|')
  const rawName =
    rawOrders.length > 0
      ? new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${rawSource})(?:$|[^\\p{L}\\p{N}])`, 'iu')
      : null
  const rawHandle = normaliseTelegramHandle(telegram)
  const rawHandleTest = rawHandle
    ? // Stryker disable next-line StringLiteral: the `'i'` flag is masked by the own check, see the note above; the empty-template form is killed when applied by hand (22 tests fail)
      new RegExp(`(?:^|\\W)@*${escapeRegExp(rawHandle)}(?:$|\\W)`, 'i')
    : null
  return (raw) => {
    // Strip the characters of INVISIBLE_PATTERN, then NFKC per cluster, as the API scan does.
    const { text, gaps } = normaliseContactText(raw)
    const plain = text.replace(CONTACT_APOSTROPHES, "'")
    const folded = foldAccents(plain, gaps)
    const nfc = raw.normalize('NFC')
    // the text before the digit fold too: a non-ASCII digit there is the edge a URL needs
    const unfolded = NON_ASCII_DIGIT.test(raw) ? normaliseContactText(raw, false).text : text
    return (
      // the generic patterns on the folded text too: a mark on a digit (`067`, acute) splits a phone
      // in `text`, and the fold drops it (453e). Each distinct form once: most text is all three.
      [...new Set([text, folded.text, unfolded])].some(
        (scanned) =>
          findPhoneSpans(scanned).length > 0 ||
          RESUME_EMAIL_PATTERN.test(scanned) ||
          RESUME_URL_PATTERN.test(scanned) ||
          RESUME_TELEGRAM_LABEL_PATTERN.test(scanned),
      ) ||
      // The handle on the plain and on the folded text: a mark after its last letter is a boundary
      // (`ivan_dev`, acute, `x`), and one composed into that letter is folded off.
      (handleSource !== null &&
        findWholeTokens(plain, gaps, handleSource, 'handle').length +
          findWholeTokens(folded.text, folded.gaps, handleSource, 'handle').length >
          0) ||
      names.some(
        (source) => findWholeTokens(folded.text, folded.gaps, source, 'name').length > 0,
      ) ||
      // Stryker disable next-line LogicalOperator: masked by the own check, see the note above
      (rawHandleTest?.test(nfc) ?? false) ||
      (rawName?.test(normaliseName(nfc)) ?? false)
    )
  }
}

function checkExperienceItem(
  item: ResumeFactsExperience,
  index: number,
  nowMonth: string,
  issues: CompletenessIssue[],
  containsContactData: ContactCheck,
): void {
  const base = `experience.${index}`

  if (isBlank(item.company)) issues.push({ path: `${base}.company`, code: 'COMPANY_MISSING' })
  if (!isLatinScript(item.company)) issues.push({ path: `${base}.company`, code: 'NON_LATIN' })

  if (isBlank(item.role)) issues.push({ path: `${base}.role`, code: 'ROLE_MISSING' })
  if (!isLatinScript(item.role)) issues.push({ path: `${base}.role`, code: 'NON_LATIN' })

  if (item.location !== null && !isLatinScript(item.location)) {
    issues.push({ path: `${base}.location`, code: 'NON_LATIN' })
  }

  if (item.start === null) {
    issues.push({ path: `${base}.start`, code: 'START_MISSING' })
    // `YYYY-MM` sorts lexicographically, so the current month is the cutoff.
  } else {
    if (item.start > nowMonth) issues.push({ path: `${base}.start`, code: 'START_IN_FUTURE' })
    // A missing end falls back to the start, which is never before itself, so
    // no separate null check is needed (one would only add a mutant no test
    // can kill: the fallback already makes a null end compare as not-before).
    if ((item.end ?? item.start) < item.start) {
      issues.push({ path: `${base}.end`, code: 'END_BEFORE_START' })
    }
  }

  if (!item.current && item.end === null) {
    issues.push({ path: `${base}.end`, code: 'END_MISSING' })
  }
  // A null end compares as '', which is never after a month.
  if (!item.current && (item.end ?? '') > nowMonth) {
    issues.push({ path: `${base}.end`, code: 'END_IN_FUTURE' })
  }

  item.technologies.forEach((technology, technologyIndex) => {
    if (!isLatinScript(technology)) {
      issues.push({ path: `${base}.technologies.${technologyIndex}`, code: 'NON_LATIN' })
    }
    // technologies render in the Skills section, so they leak like a skill would
    if (containsContactData(technology)) {
      issues.push({ path: `${base}.technologies.${technologyIndex}`, code: 'CONTACT_IN_TEXT' })
    }
  })

  if (item.notes.every((note) => isBlank(note))) {
    issues.push({ path: `${base}.notes`, code: 'NO_NOTES' })
  }
  item.notes.forEach((note, noteIndex) => {
    if (!isLatinScript(note)) {
      issues.push({ path: `${base}.notes.${noteIndex}`, code: 'NON_LATIN' })
    }
    if (containsContactData(note)) {
      issues.push({ path: `${base}.notes.${noteIndex}`, code: 'CONTACT_IN_TEXT' })
    }
  })
}

/**
 * Every missing/blocked field, in a stable order: display name and top-level
 * fields first, experience items in index order, then education and languages.
 */
export function checkResumeCompleteness(
  facts: ResumeFacts,
  ctx: { displayName: string; telegram?: string | null | undefined; now: Date },
): CompletenessIssue[] {
  const issues: CompletenessIssue[] = []
  const containsContactData = contactCheck(ctx.displayName, ctx.telegram)
  const nowMonth = `${ctx.now.getUTCFullYear()}-${String(ctx.now.getUTCMonth() + 1).padStart(2, '0')}`

  if (!isLatinScript(ctx.displayName)) issues.push({ path: 'displayName', code: 'NAME_NON_LATIN' })

  if (isBlank(facts.headline)) issues.push({ path: 'headline', code: 'HEADLINE_MISSING' })
  if (!isLatinScript(facts.headline)) issues.push({ path: 'headline', code: 'NON_LATIN' })
  if (containsContactData(facts.headline))
    issues.push({ path: 'headline', code: 'CONTACT_IN_TEXT' })

  if (!isLatinScript(facts.location.city)) issues.push({ path: 'location.city', code: 'NON_LATIN' })
  if (!isLatinScript(facts.location.country)) {
    issues.push({ path: 'location.country', code: 'NON_LATIN' })
  }

  const mergedSkills = mergeSkills(
    facts.skills,
    facts.experience.map((item) => item.technologies),
  )
  if (mergedSkills.length < 5) issues.push({ path: 'skills', code: 'TOO_FEW_SKILLS' })
  facts.skills.forEach((skill, skillIndex) => {
    if (!isLatinScript(skill)) issues.push({ path: `skills.${skillIndex}`, code: 'NON_LATIN' })
    if (containsContactData(skill)) {
      issues.push({ path: `skills.${skillIndex}`, code: 'CONTACT_IN_TEXT' })
    }
  })

  if (facts.experience.length === 0) issues.push({ path: 'experience', code: 'NO_EXPERIENCE' })
  facts.experience.forEach((item, index) => {
    checkExperienceItem(item, index, nowMonth, issues, containsContactData)
  })

  facts.education.forEach((item, index) => {
    if (!isLatinScript(item.institution)) {
      issues.push({ path: `education.${index}.institution`, code: 'NON_LATIN' })
    }
    if (!isLatinScript(item.degree)) {
      issues.push({ path: `education.${index}.degree`, code: 'NON_LATIN' })
    }
    // A missing start falls back to the end, which is never before itself.
    if (item.endYear !== null && item.endYear < (item.startYear ?? item.endYear)) {
      issues.push({ path: `education.${index}.endYear`, code: 'END_BEFORE_START' })
    }
    // A year the facts schema refuses would only surface as a 400 on save (R66).
    for (const key of ['startYear', 'endYear'] as const) {
      const year = item[key]
      if (year !== null && !resumeYear.safeParse(year).success) {
        issues.push({ path: `education.${index}.${key}`, code: 'YEAR_INVALID' })
      }
    }
  })

  if (!facts.languages.some((language) => language.name.trim().toLowerCase() === 'english')) {
    issues.push({ path: 'languages', code: 'ENGLISH_MISSING' })
  }
  facts.languages.forEach((language, index) => {
    if (!isLatinScript(language.name)) {
      issues.push({ path: `languages.${index}.name`, code: 'NON_LATIN' })
    }
  })

  facts.links.forEach((link, index) => {
    // A blank label is stricter than the schema on purpose (R66): a link needs a name on the page.
    if (isBlank(link.label) || !resumeLinkSchema.shape.label.safeParse(link.label).success) {
      issues.push({ path: `links.${index}.label`, code: 'LINK_INVALID' })
    }
    if (!resumeLinkSchema.shape.url.safeParse(link.url).success) {
      issues.push({ path: `links.${index}.url`, code: 'LINK_INVALID' })
    }
  })

  return issues
}
