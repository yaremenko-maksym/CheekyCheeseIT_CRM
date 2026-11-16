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
 * default-ignorables (variation selectors, CGJ, Hangul fillers), and U+2800 BRAILLE PATTERN BLANK,
 * a symbol (`So`) stripped on purpose because it renders blank.
 */
const INVISIBLE_PATTERN = /[⠀\p{Cf}\p{Default_Ignorable_Code_Point}]/gu
/**
 * A conjoining Hangul jamo run or a visible character plus the marks after it, the characters of
 * `INVISIBLE_PATTERN` between them included, so jamo compose into a syllable and a base letter
 * with its mark once those go. A stripped character not followed by a mark or a jamo starts no
 * cluster.
 */
const CLUSTER_PATTERN =
  /[ᄀ-ᇿꥠ-꥿ힰ-퟿](?:[⠀\p{Cf}\p{Default_Ignorable_Code_Point}]*[ᄀ-ᇿꥠ-꥿ힰ-퟿])*|[^⠀\p{Cf}\p{Default_Ignorable_Code_Point}](?:[⠀\p{Cf}\p{Default_Ignorable_Code_Point}]*\p{M})*/gu
/** A `CLUSTER_PATTERN` hit that is a jamo run. No anchor needed: the other branch never takes a jamo, so its clusters hold none. */
const isJamoRun = (cluster: string): boolean => /[ᄀ-ᇿꥠ-꥿ힰ-퟿]/u.test(cluster)

/** Whether one character (the loop hands it one code point) is in `INVISIBLE_PATTERN`; no `g` flag, so `.test` keeps no state. */
const INVISIBLE_CHAR = /[⠀\p{Cf}\p{Default_Ignorable_Code_Point}]/u

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
 */
export function normaliseContactText(text: string): {
  text: string
  from: number[]
  to: number[]
  gaps: Set<number>
} {
  let normalised = ''
  const from: number[] = []
  const to: number[] = []
  const gaps = new Set<number>()
  let cursor = 0
  for (const { 0: cluster, index } of text.matchAll(CLUSTER_PATTERN)) {
    // Stripped characters between clusters: the next character starts after a gap.
    if (index > cursor) gaps.add(normalised.length)
    const stripped = cluster.replace(INVISIBLE_PATTERN, '')
    const piece = stripped.normalize('NFKC')
    if (isJamoRun(cluster)) addJamoRunGaps(cluster, normalised.length, gaps)
    else if (stripped.length < cluster.length) gaps.add(normalised.length + piece.length)
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

/**
 * `text` without accents (NFD, marks dropped, plus `UNDECOMPOSED`), for each of its code units the
 * span of the character, marks included, it came from, and `gaps` (offsets of `text`) carried to
 * folded offsets. Names are matched on this on both sides, so `Muller` hits `Müller`.
 */
export function foldAccents(
  text: string,
  gaps: ReadonlySet<number> = new Set(),
): { text: string; from: number[]; to: number[]; gaps: Set<number> } {
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
    // A gap on one of the marks (stripped before a mark that follows a jamo run) counts after the
    // letter the mark now joins.
    for (let k = index + 1; k < index + cluster.length; k++) {
      if (gaps.has(k)) foldedGaps.add(folded.length)
    }
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
      // Stryker disable next-line OptionalChaining: equivalent — the `d` flag always sets indices and every group of a source takes part
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

/**
 * Phone, email, the senior's Telegram handle (whole token, with or without its
 * `@`, any case), or the senior's full name, whole words, any case, accents or spacing:
 * every token of the display name in order, or its first and last token in
 * either order. A one-token name adds a name check only when it is two or more
 * precomposed Hangul syllables (Korean names are often written as one token);
 * any other single token adds none: a first name or surname alone is a common word too often.
 * Names and the handle use `findWholeTokens`, the boundary the API redaction uses, so a name this
 * flags is one the API redacts.
 */
function contactCheck(displayName: string, telegram: string | null | undefined): ContactCheck {
  // Split on each whitespace character: the filter drops the empty pieces a run or an edge leaves.
  // Context values are normalised like the text, so a name or handle written with a ligature, a
  // zero-width joiner or fullwidth letters still matches itself written the same way.
  const tokens = normaliseName(normaliseContactText(displayName).text).split(/\s/).filter(Boolean)
  const first = tokens[0]
  const last = tokens.at(-1)
  const names =
    // Stryker disable next-line StringLiteral: equivalent — `first` is undefined only for an empty name, and the Hangul test fails on any non-Hangul fallback as on ''
    (tokens.length >= 2 || /^[가-힣]{2,}$/u.test(first ?? '')) &&
    // Stryker disable next-line ConditionalExpression: type narrowing only — the line above passes only with one token or more, so first is defined and forcing this guard true changes no result
    first !== undefined &&
    // Stryker disable next-line ConditionalExpression: as above, one token or more means the last one is defined
    last !== undefined
      ? [tokens, [first, last], [last, first]].map((parts) =>
          parts.map((part) => escapeRegExp(foldAccents(part).text)).join(CONTACT_NAME_GAP),
        )
      : // Stryker disable next-line ArrayDeclaration: equivalent — a placeholder source matches only its own literal text, so a skipped name check still finds no name
        []
  const handle = normaliseTelegramHandle(telegram && normaliseContactText(telegram).text)
  // Any `@`s in front (`@@h`, `x@h`) still hit. A handle equal to a skill word flags that word
  // too: availability, not a leak.
  const handleSource = handle ? `@*${escapeRegExp(handle)}` : null
  return (raw) => {
    // Strip the characters of INVISIBLE_PATTERN, then NFKC per cluster, as the API scan does.
    const { text, gaps } = normaliseContactText(raw)
    const plain = text.replace(CONTACT_APOSTROPHES, "'")
    const folded = foldAccents(plain, gaps)
    return (
      findPhoneSpans(text).length > 0 ||
      RESUME_EMAIL_PATTERN.test(text) ||
      RESUME_URL_PATTERN.test(text) ||
      RESUME_TELEGRAM_LABEL_PATTERN.test(text) ||
      // The handle on the plain and on the folded text: a mark after its last letter is a boundary
      // (`ivan_dev`, acute, `x`), and one composed into that letter is folded off.
      (handleSource !== null &&
        findWholeTokens(plain, gaps, handleSource, 'handle').length +
          findWholeTokens(folded.text, folded.gaps, handleSource, 'handle').length >
          0) ||
      names.some((source) => findWholeTokens(folded.text, folded.gaps, source, 'name').length > 0)
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
