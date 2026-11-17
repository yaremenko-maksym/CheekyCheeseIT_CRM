/**
 * Contact scan (verified-base-resume Task 9).
 *
 * Text bound for a third-party AI writer passes through here first: a senior's
 * phone, email, URL, Telegram handle and name are found and replaced by `[REDACTED]`. A missed
 * contact is a leak, so every recognisable email and phone counts, not only the
 * senior's own. Pure: no I/O, no Nest providers.
 */
import {
  CONTACT_APOSTROPHES,
  CONTACT_NAME_GAP,
  contactNameParts,
  findPhoneSpans,
  findWholeTokens,
  foldAccents,
  normaliseContactText,
  normaliseTelegramHandle,
  RESUME_EMAIL_PATTERN,
  RESUME_TELEGRAM_LABEL_PATTERN,
  RESUME_URL_PATTERN,
  splitNameLoneParts,
  splitNameOrders,
} from '@crm/shared'

export interface ContactContext {
  fullName: string
  /** `users.email` plus every `user_emails` row. */
  emails: string[]
  /** `users.telegram`, as stored (`@h`, `h`, `t.me/h`); null or absent adds no match. */
  telegram?: string | null | undefined
}

/** No context of the senior: the generic email and phone patterns still run. */
// Stryker disable next-line StringLiteral,ArrayDeclaration: equivalent — the placeholder only has to match nothing: a blank name yields no pattern (nameSources filters it) and an empty list no email literal, so any other unmatched value scans the same
const NO_CONTEXT: ContactContext = { fullName: '', emails: [] }

/** The contexts to scan with; an empty list still scans with `NO_CONTEXT`. */
export function scanContexts(
  ctx: ContactContext | readonly ContactContext[],
): readonly ContactContext[] {
  const list = Array.isArray(ctx) ? ctx : [ctx]
  return list.length > 0 ? list : [NO_CONTEXT]
}

export interface ContactHit {
  kind: 'phone' | 'email' | 'name' | 'telegram' | 'url'
  match: string
}

interface Span {
  kind: ContactHit['kind']
  start: number
  end: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * The name sources for `findWholeTokens`, accent-folded, so they run on `foldAccents` text. The
 * joined reading of `contactNameParts` gives the full name (any whitespace between parts) and the
 * surname alone, never the first name. The split reading is taken whole: every order of
 * `splitNameOrders` and every lone part of `splitNameLoneParts`. The redaction takes it always,
 * fail-closed, so a fragment such as `in` (stored `Ivan Petr`, ZWNJ, `in`) is redacted too (PR #1351
 * round 7). The gate scan (`scanContacts`, behind `hasContact`) protects model output, so it keeps
 * the split reading too, every order and every lone part of three letters or more; it drops only a
 * lone part shorter than three letters, and only when the joined reading has two or more parts, so a
 * fragment such as `in` or `an` does not refuse ordinary text (round 8, SR-M-1). A three-letter
 * fragment such as `son` still refuses: accepted. The gate scan also keeps each run of two or more
 * parts after the first, both ways, when the run has three letters or more, so two short parts that
 * form the whole surname still refuse (`Ivan Li`, ZWSP, `Yu` refuses `Li Yu` and `Yu Li`; round 9,
 * SR-M-2). A run is any ordered subsequence, adjacent or not, and its parts may be joined by a dash,
 * a comma, a period, an underscore or a middle dot (`RUN_GAP`; `Li-Yu`, `Li, Bo`; backlog 453, fix 10). Runs grow with 2^parts, and the stored name is
 * HR-edited, so past `MAX_RUN_PARTS` split parts the gate takes no runs and drops no short fragment:
 * round 7's stricter gate, linear in the part count and fail-closed (round 9, Addendum A). The
 * redaction reads a digit next to a name as an edge (`Petrenko1990`, backlog 453d); the gate keeps
 * main's token, in which a digit is part of the word.
 */
/** A last name part is a lone source from two letters on, in both passes (main's rule). */
const isSurnameSource = (part: string): boolean => part.replace(/\P{L}/gu, '').length >= 2

/** Split parts up to which the gate builds runs: 8 parts give at most 120 subsequences, 240 sources. */
const MAX_RUN_PARTS = 8

/**
 * The gate's runs: every ordered subsequence of two or more split parts after the first, adjacent
 * or not (`Li Bo` of `Li`, ZWSP, `Yu`, ZWSP, `Bo`; backlog 453b), both ways, three letters or more.
 * One subset per bit mask of the parts after the first, so at most 2^7 under `MAX_RUN_PARTS`. Only
 * the parts `inText` finds take part: a run hits only where each of its parts does, so the others
 * add no hit. Measured at 8 parts against main: 0.7x on the perf spec's text (3.9x without the
 * filter), 4.6x on a text holding every part, still linear in the text.
 */
function splitNameRuns(parts: readonly string[], inText: (part: string) => boolean): string[][] {
  // Stryker disable next-line MethodExpression: equivalent — the filter drops only parts no run can hit with; without it the same hits come back, slower
  const rest = parts.slice(1).filter(inText)
  const runs: string[][] = []
  // Stryker disable next-line EqualityOperator: equivalent — mask 2^n selects no part, so its empty run is skipped below
  for (let mask = 1; mask < 2 ** rest.length; mask++) {
    const run = rest.filter((_, bit) => (mask >> bit) & 1)
    // Own line, so the one suppression covers only the `multi` check: `true` adds a one-part run of 3+
    // letters, already a lone source (`splitNameLoneParts`), so only duplicates; `false` is hidden too
    // (Stryker suppresses the whole mutator), and is killed by hand (26 tests fail)
    // Stryker disable next-line ConditionalExpression: equivalent for `true` — see the comment above; `false` is killed by hand
    const multi = run.length >= 2
    const letters = run.join('').replace(/\P{L}/gu, '').length >= 3
    if (multi && letters) {
      runs.push(run, [...run].reverse())
    }
  }
  return runs
}

/**
 * Between the parts of a gate run: `CONTACT_NAME_GAP`, or one dash, comma, period, underscore or
 * middle dot with optional whitespace around it (`Li-Yu`, `Li, Yu`, `Li–Yu`, `Li.Yu`; backlog 453a).
 * The dash family is U+2010-U+2015 and U+2212; `/` and `;` stay out (no false-positive measure yet).
 * In the one capture group, so an empty match still has to sit on a gap.
 */
const RUN_GAP = String.raw`((?:\s|\\[nrt])*(?:[\-‐-―−,._·](?:\s|\\[nrt])*)?)`

/** The name sources for the folded text `scanned`: the gate's runs are built only of parts in it. */
function nameSources(fullName: string, failClosed: boolean, scanned: string): string[] {
  // Normalised like the text, so a name with a ligature, a ZWNJ or fullwidth letters matches itself.
  // folded after the split helpers count letters: NFD turns a Hangul syllable into its jamo
  const fold = (parts: readonly string[]) =>
    parts.map((part) => escapeRegExp(foldAccents(part).text))
  const inText = (part: string) =>
    new RegExp(escapeRegExp(foldAccents(part).text), 'iu').test(scanned)
  return contactNameParts(fullName).flatMap((parts, reading, readings) => {
    if (reading > 0) {
      const runs = !failClosed && parts.length <= MAX_RUN_PARTS
      // Stryker disable next-line OptionalChaining: equivalent — contactNameParts always returns the joined reading first, so readings[0] is defined
      const shortFragments = runs && (readings[0]?.length ?? 0) > 1
      const lone = splitNameLoneParts(parts).filter(
        (part) => !shortFragments || part.replace(/\P{L}/gu, '').length >= 3,
      )
      return [
        ...splitNameOrders(parts).map((order) => fold(order).join(CONTACT_NAME_GAP)),
        ...(runs ? splitNameRuns(parts, inText) : []).map((run) => fold(run).join(RUN_GAP)),
        ...fold(lone),
      ]
    }
    const folded = fold(parts)
    const surname = folded.at(-1)
    const sources = [folded.join(CONTACT_NAME_GAP)]
    if (surname !== undefined && isSurnameSource(surname)) {
      sources.push(surname)
    }
    // a blank name leaves an empty source, which would match everywhere
    return sources.filter(Boolean)
  })
}

/**
 * The handle as a `findWholeTokens` source, with any `@`s in front: `ivan_dev` is not in
 * `ivan_dev2` or `xivan_dev`, but `@@ivan_dev` and `x@ivan_dev` hit. A handle equal to a skill
 * word redacts that word too: availability, not a leak.
 */
function telegramSource(telegram: string | null | undefined): string | null {
  const handle = normaliseTelegramHandle(telegram && normaliseContactText(telegram).text)
  return !handle ? null : `@*${escapeRegExp(handle)}`
}

/**
 * URL, labelled-handle and literal-email patterns; generic emails, phones, names and the stored
 * handle are scanned in `findSpans`. The generic ones, and the name and handle boundaries, are
 * shared with completeness, so a contact it flags is one this redacts.
 */
function contactPatterns(ctx: ContactContext): [ContactHit['kind'], RegExp][] {
  const global = (p: RegExp) => new RegExp(p.source, `${p.flags}g`)
  const literalEmails = ctx.emails
    .map((email) => normaliseContactText(email).text.trim())
    .filter(Boolean)
    .map((email): [ContactHit['kind'], RegExp] => ['email', new RegExp(escapeRegExp(email), 'giu')])
  return [
    ['url', global(RESUME_URL_PATTERN)],
    ['telegram', global(RESUME_TELEGRAM_LABEL_PATTERN)],
    ...literalEmails,
  ]
}

/** URL, label, literal-email, email and phone hits on `plain`, in its offsets. */
function patternSpans(plain: string, ctx: ContactContext): Span[] {
  const spans: Span[] = []
  for (const [kind, pattern] of contactPatterns(ctx)) {
    for (const m of plain.matchAll(pattern)) {
      // The bare-URL and label patterns consume one boundary character in front; their group 1
      // is the hit.
      const end = m.index + m[0].length
      spans.push({ kind, start: end - (m[1] ?? m[0]).length, end })
    }
  }
  // The email pattern consumes its boundary too, so an email glued to the next by a local-part
  // character (`a@b.com-c@d.com`) would hide the second: resume one past each hit's start, and
  // the overlapping hits merge on redaction. Group 1 is the hit. The step is one code point: a
  // `lastIndex` inside a surrogate pair (`𝐚@b.com`) snaps back to the pair's start under the `u`
  // flag, the same hit comes back, and the loop never ends (SR5-H-1).
  const email = new RegExp(RESUME_EMAIL_PATTERN.source, 'gu')
  let previous = -1
  for (let m = email.exec(plain); m; m = email.exec(plain)) {
    const end = m.index + m[0].length
    const start = end - (m[1] ?? m[0]).length
    // Defensive: the step below always moves past `start`, so this never fires unless it breaks.
    // It throws rather than breaks, so a broken step fails the field closed instead of leaving
    // the rest of the text unscanned.
    // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement,StringLiteral: unreachable while the code-point step is right; it only fails the scan closed if a later edit breaks that step
    if (start <= previous) throw new Error('email scan did not advance')
    previous = start
    spans.push({ kind: 'email', start, end })
    email.lastIndex = start + ((plain.codePointAt(start) ?? 0) >= 0x10000 ? 2 : 1)
  }
  for (const span of findPhoneSpans(plain)) spans.push({ kind: 'phone', ...span })
  return spans
}

/*
 * Main's name and handle matcher (main @ 267885ded), run on the NFC text beside the normalised
 * scan, so the redaction never loses a span main had (PR #1351 round 6, SR-H-4). NFKC turns a
 * compatibility character next to a contact into a letter (`Petrenko™` reads `PetrenkoTM`), and
 * that glues it to the contact there; on NFC text it is still an edge.
 */

/** Token characters, as in the ATS checker and `mentionsSkill`: `Levin` is not in `Levine` or `Levin#`. */
const MAIN_TOKEN_CHAR = '[\\p{L}\\p{N}#+]'
/** A JSON-style escape (`\n`, `\t`, a `\u` code): its final letter or digit is not part of a name. */
const MAIN_ESCAPE = String.raw`\\(?:[bfnrt]|u[\dA-Fa-f]{4})`
/** Whitespace between name parts, raw or escaped. */
const MAIN_NAME_GAP = String.raw`(?:\s|\\[nrt])+`

function mainWholeToken(source: string): RegExp {
  return new RegExp(
    `(?:(?<!${MAIN_TOKEN_CHAR})|(?<=${MAIN_ESCAPE}))${source}(?!${MAIN_TOKEN_CHAR})`,
    'giu',
  )
}

/**
 * No leak measured without main's name and handle arms: on every input tried, the own pass already
 * redacts each letter they find (4.7M texts with each code point up to U+2FFFF, U+3401–U+F8FF
 * skipped, beside or inside a name, a surname and a handle in four contexts, plus JSON escapes,
 * PR #1351 round 6; 400k random texts in five contexts, round 7). That is a measurement, not an
 * equivalence: the handle arm still widens a span over a trailing jamo in non-NFC text, and
 * `mainSpans` is tested on its own. Only the generic patterns add a span the own pass misses
 * (`x™tg: mark_dev`). The arms stay as the structural guard of the union: do not remove them as
 * dead code. In the gate scan the name arm is load-bearing (round 8): main splits a stored name on
 * `\s`, which includes U+FEFF, the one character the strip also removes, so for `Ivan Petr`,
 * U+FEFF, `in` main flags `in` alone, and the own gate scan, which drops a lone split part shorter
 * than three letters, does not.
 */
/** Main's full-name and surname patterns, accent-folded, for `foldAccents` text of NFC text. */
function mainNamePatterns(fullName: string): RegExp[] {
  const name = foldAccents(fullName.normalize('NFC').replace(CONTACT_APOSTROPHES, "'")).text
  const parts = name.trim().split(/\s+/u)
  const sources = [
    parts.map(escapeRegExp).join(MAIN_NAME_GAP),
    ...parts.slice(-1).filter(isSurnameSource).map(escapeRegExp),
  ]
  // a blank name leaves an empty source, which would match everywhere
  return sources.filter(Boolean).map(mainWholeToken)
}

/**
 * Main's spans on NFC `nfc`: the generic patterns, the handle (`\w` boundary) and the name.
 * Exported for its own test only (round 7, CR-M-6): the redaction output alone does not show its
 * name arm, see the note above `mainNamePatterns`.
 */
export function mainSpans(nfc: string, ctx: ContactContext): Span[] {
  const plain = nfc.replace(CONTACT_APOSTROPHES, "'")
  const spans = patternSpans(plain, ctx)
  const handle = normaliseTelegramHandle(ctx.telegram)
  if (handle) {
    for (const m of plain.matchAll(new RegExp(`(?<!\\w)@*${escapeRegExp(handle)}(?!\\w)`, 'giu'))) {
      spans.push({ kind: 'telegram', start: m.index, end: m.index + m[0].length })
    }
  }
  const folded = foldAccents(plain)
  for (const pattern of mainNamePatterns(ctx.fullName)) {
    for (const m of folded.text.matchAll(pattern)) {
      spans.push(
        foldedSpan('name', folded, { start: m.index, end: m.index + m[0].length }, nfc.length),
      )
    }
  }
  return spans
}

/**
 * One code point and the characters NFC may compose into it: marks, vowel and trailing Hangul
 * jamo, and U+16D67 (a Kirat Rai vowel that is a letter). No other character composes backwards
 * or reorders, so these chunks normalise apart exactly as the whole text does.
 */
const NFC_CHUNK = /[^\p{M}ᅠ-ᇿힰ-퟿\u{16D67}][\p{M}ᅠ-ᇿힰ-퟿\u{16D67}]*|[\p{M}ᅠ-ᇿힰ-퟿\u{16D67}]+/gu

/** For each code unit of `text.normalize('NFC')`, the span of `text` it came from. */
function nfcMaps(text: string): { from: number[]; to: number[] } {
  const from: number[] = []
  const to: number[] = []
  for (const { 0: chunk, index } of text.matchAll(NFC_CHUNK)) {
    for (let k = chunk.normalize('NFC').length; k > 0; k--) {
      from.push(index)
      to.push(index + chunk.length)
    }
  }
  return { from, to }
}

/** A hit on the folded text as a span of the normalised text, marks of its last letter included. */
function foldedSpan(
  kind: ContactHit['kind'],
  folded: ReturnType<typeof foldAccents>,
  span: { start: number; end: number },
  length: number,
): Span {
  return { kind, start: folded.from[span.start] ?? 0, end: folded.to[span.end - 1] ?? length }
}

/** Every raw hit on the normalised text, mapped back to the original text offsets, sorted by start, longer first on a tie. */
function findSpans(
  text: string,
  norm: ReturnType<typeof normaliseContactText>,
  ctx: ContactContext,
  failClosed: boolean,
): Span[] {
  const normText = norm.text
  const plain = normText.replace(CONTACT_APOSTROPHES, "'")
  const rawSpans = patternSpans(plain, ctx)
  const folded = foldAccents(plain, norm.gaps)
  // The generic patterns on the folded text too: a mark on a digit (`067`, acute) splits a phone in
  // `plain`, and the fold drops it (backlog 453e).
  // Stryker disable next-line ConditionalExpression: equivalent — `true` scans the same text twice and adds only duplicate spans
  if (folded.text !== plain) {
    for (const span of patternSpans(folded.text, ctx)) {
      rawSpans.push(foldedSpan(span.kind, folded, span, normText.length))
    }
  }
  const handle = telegramSource(ctx.telegram)
  if (handle !== null) {
    // Stryker disable next-line BlockStatement: no leak measured without it, not an equivalence — the folded-text loop below and main's handle arm redact the same letters; the handle is pinned by the round-6 handle rows
    for (const span of findWholeTokens(plain, norm.gaps, handle, 'handle')) {
      rawSpans.push({ kind: 'telegram', ...span })
    }
    // On the folded text too, as completeness does: a mark composed into the last letter
    // (`ivan_dee`, ZWSP, acute, `x`) is folded off there.
    for (const span of findWholeTokens(folded.text, folded.gaps, handle, 'handle')) {
      rawSpans.push(foldedSpan('telegram', folded, span, normText.length))
    }
  }
  // the redaction reads a digit as an edge too (backlog 453d); the gate keeps main's token
  const nameKind = failClosed ? 'redactedName' : 'name'
  for (const source of nameSources(ctx.fullName, failClosed, folded.text)) {
    for (const span of findWholeTokens(folded.text, folded.gaps, source, nameKind)) {
      rawSpans.push(foldedSpan('name', folded, span, normText.length))
    }
  }
  const spans: Span[] = rawSpans.map((s) => ({
    kind: s.kind,
    // Stryker disable next-line ConditionalExpression: fallback only if index is out of bounds
    start: norm.from[s.start] ?? 0,
    // Stryker disable next-line ConditionalExpression: fallback only if index is out of bounds
    end: norm.to[s.end - 1] ?? text.length,
  }))
  // The generic patterns on the text before the digit fold too: there a non-ASCII digit is the
  // non-word edge a URL or an email needs (`١www.site.dev`), so the fold only adds hits.
  // The apostrophes stay as written: the pass over `plain` above reads them, and this one only adds.
  // Stryker disable next-line Regex: equivalent — the test only skips work: text without a non-ASCII digit unfolds to `normText` and gives the same spans
  const unfolded = /[^\P{Nd}0-9]/u.test(text) ? normaliseContactText(text, false) : norm
  // Stryker disable next-line ConditionalExpression: equivalent — `true` re-scans `normText`, which differs from `plain` only in same-width apostrophes, so its spans are the plain pass's or inside them
  if (unfolded !== norm) {
    for (const s of patternSpans(unfolded.text, ctx)) {
      spans.push({
        kind: s.kind,
        start: unfolded.from[s.start] ?? 0,
        end: unfolded.to[s.end - 1] ?? text.length,
      })
    }
  }
  // Main's spans, on the same text: the normalised scan may only add redactions (SR-H-4). Its name
  // and handle arms add no redaction measured today; keep the union as the guard against a future
  // regression of the own pass, not dead code (round 7). In the gate scan the name arm adds the
  // U+FEFF split reading, see the note above `mainNamePatterns` (round 8).
  const nfc = text.normalize('NFC')
  // Stryker disable next-line ConditionalExpression: `false` is equivalent — the maps of NFC text are the identity
  const maps = nfc === text ? null : nfcMaps(text)
  for (const s of mainSpans(nfc, ctx)) {
    if (maps === null) spans.push(s)
    // Stryker disable next-line ConditionalExpression: fallback only if index is out of bounds
    else
      spans.push({
        kind: s.kind,
        start: maps.from[s.start] ?? 0,
        end: maps.to[s.end - 1] ?? text.length,
      })
  }
  return spans.sort((a, b) => a.start - b.start || b.end - a.end)
}

/**
 * Contacts in `text`, in text order. Of overlapping hits only the first-starting
 * (longest on a tie) is reported. Both sides are normalised, so `match` is
 * the original substring as written.
 *
 * Contract (both functions): call on each raw string field BEFORE
 * `JSON.stringify`, never on serialized JSON; that also keeps every input small.
 * Name matching folds accents (`Muller` hits `Müller`, `Walesa` hits `Wałęsa`,
 * `Strasse` hits `Straße`) and curly apostrophes,
 * but not transliterations (`Mueller`) or scripts: a Cyrillic context name does
 * not hit Latin text, so the caller passes the name in the text's script.
 */
export function scanContacts(text: string, ctx: ContactContext): ContactHit[] {
  const norm = normaliseContactText(text)
  const hits: ContactHit[] = []
  let reachedEnd = 0
  for (const span of findSpans(text, norm, ctx, false)) {
    if (span.start < reachedEnd) continue
    hits.push({
      kind: span.kind,
      match: text.slice(span.start, span.end).normalize('NFC'),
    })
    reachedEnd = span.end
  }
  return hits
}

/** Passes `redactContacts` runs before it gives up on a field and redacts it whole. */
const MAX_REDACTION_PASSES = 8

/**
 * `text` (NFC) with every contact replaced by `[REDACTED]`. Overlapping and adjacent hits merge
 * into one replacement. A fixed point: a contact glued to another one (`@ivan_dev0671234567`) is a
 * whole token only once the other is gone, so the pass runs again on its own result until nothing
 * changes; placeholders a later pass writes next to an earlier one merge too (backlog 449). A field
 * still changing after `MAX_REDACTION_PASSES` is redacted whole: fail-closed. Same contract as
 * `scanContacts`: one raw field at a time, before serialization.
 */
export function redactContacts(
  text: string,
  ctx: ContactContext | readonly ContactContext[],
): string {
  let current = text
  // Stryker disable next-line EqualityOperator: `<=` runs one more pass before the bound; no known text needs exactly nine, and the bound row pins the fail-closed exit
  for (let pass = 0; pass < MAX_REDACTION_PASSES; pass++) {
    const next = redactOnce(current, ctx).replace(/(?:\[REDACTED\]){2,}/gu, '[REDACTED]')
    if (next === current) return next
    current = next
  }
  return '[REDACTED]'
}

/** One pass of `redactContacts`: the spans of `redactedSpans` replaced, the rest NFC. */
function redactOnce(text: string, ctx: ContactContext | readonly ContactContext[]): string {
  let result = ''
  let cursor = 0
  for (const { start, end } of redactedSpans(text, ctx)) {
    result += `${text.slice(cursor, start).normalize('NFC')}[REDACTED]`
    cursor = end
  }
  return result + text.slice(cursor).normalize('NFC')
}

/**
 * The spans of `text` that one pass of `redactContacts` replaces, merged, in text order and
 * original offsets. One pass only: a contact a later pass finds is not among them.
 */
export function redactedSpans(
  text: string,
  ctx: ContactContext | readonly ContactContext[],
): { start: number; end: number }[] {
  const norm = normaliseContactText(text)
  const merged: { start: number; end: number }[] = []
  // Several contexts (display and legal name) merge their spans before any replacement: redacting one
  // context's surname first would break the other's full-name match and leak its first names.
  const spans = scanContexts(ctx)
    .flatMap((c) => findSpans(text, norm, c, true))
    // by start only: the merge below keeps the furthest end, so a tie needs no order
    .sort((a, b) => a.start - b.start)
  for (const { start, end } of spans) {
    const last = merged.at(-1)
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else merged.push({ start, end })
  }
  return merged
}
