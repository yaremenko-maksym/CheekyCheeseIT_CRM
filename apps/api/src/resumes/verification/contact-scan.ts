/**
 * Contact scan (verified-base-resume Task 9).
 *
 * Text bound for a third-party AI writer passes through here first: a senior's
 * phone, email, URL, Telegram handle and name are found and replaced by `[REDACTED]`. A missed
 * contact is a leak, so every recognisable email and phone counts, not only the
 * senior's own. Pure: no I/O, no Nest providers.
 */
import {
  findPhoneSpans,
  normaliseTelegramHandle,
  RESUME_EMAIL_PATTERN,
  RESUME_TELEGRAM_LABEL_PATTERN,
  RESUME_URL_PATTERN,
} from '@crm/shared'

export interface ContactContext {
  fullName: string
  /** `users.email` plus every `user_emails` row. */
  emails: string[]
  /** `users.telegram`, as stored (`@h`, `h`, `t.me/h`); null or absent adds no match. */
  telegram?: string | null | undefined
}

/** No context of the senior: the generic email and phone patterns still run. */
// Stryker disable next-line StringLiteral,ArrayDeclaration: equivalent — the placeholder only has to match nothing: a blank name yields no pattern (namePatterns filters it) and an empty list no email literal, so any other unmatched value scans the same
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

/** Token characters, as in the ATS checker and `mentionsSkill`: `Levin` is not in `Levine` or `Levin#`. */
const TOKEN_CHAR = '[\\p{L}\\p{N}#+]'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** A JSON-style escape (`\n`, `\t`, a `\u` code): its final letter or digit is not part of a name. */
const ESCAPE = String.raw`\\(?:[bfnrt]|u[\dA-Fa-f]{4})`
/** Whitespace between name parts, raw or escaped. */
const NAME_GAP = String.raw`(?:\s|\\[nrt])+`

/** Curly apostrophes read as `'`, one code unit for one, so offsets stay valid. */
const APOSTROPHES = /[’ʼ‘]/gu

function wholeToken(source: string): RegExp {
  return new RegExp(`(?:(?<!${TOKEN_CHAR})|(?<=${ESCAPE}))${source}(?!${TOKEN_CHAR})`, 'giu')
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
 * `text` without accents (NFD, marks dropped, plus `UNDECOMPOSED`), and for each
 * of its code units the span of the NFC character, marks included, it came from.
 */
function foldAccents(text: string): { text: string; from: number[]; to: number[] } {
  let folded = ''
  const from: number[] = []
  const to: number[] = []
  for (const { 0: cluster, index } of text.matchAll(/\P{M}\p{M}*/gu)) {
    // A cluster is one base letter plus marks, so after the marks go it is one key.
    const base = cluster.normalize('NFD').replace(/\p{M}/gu, '')
    const piece = UNDECOMPOSED[base] ?? base
    folded += piece
    for (let k = 0; k < piece.length; k++) {
      from.push(index)
      to.push(index + cluster.length)
    }
  }
  return { text: folded, from, to }
}

/**
 * The full name (any whitespace between parts) and the surname alone, never
 * the first name; accent-folded, so they run on `foldAccents` text.
 */
function namePatterns(fullName: string): RegExp[] {
  const name = foldAccents(fullName.normalize('NFC').replace(APOSTROPHES, "'")).text
  const parts = name.trim().split(/\s+/u)
  const surname = parts.at(-1) ?? ''
  const sources = [parts.map(escapeRegExp).join(NAME_GAP)]
  if (surname.replace(/\P{L}/gu, '').length >= 2) sources.push(escapeRegExp(surname))
  // a blank name leaves an empty source, which would match everywhere
  return sources.filter(Boolean).map(wholeToken)
}

/**
 * The handle as a whole token, with any `@`s in front, any case: `ivan_dev` is not in
 * `ivan_dev2` or `xivan_dev`, but `@@ivan_dev` and `x@ivan_dev` hit. A Telegram username is
 * `[A-Za-z0-9_]`, so `\w` is its boundary. A handle equal to a skill word redacts that word too:
 * availability, not a leak.
 */
function telegramPattern(telegram: string | null | undefined): RegExp | null {
  const handle = normaliseTelegramHandle(telegram)
  return !handle ? null : new RegExp(`(?<!\\w)@*${escapeRegExp(handle)}(?!\\w)`, 'giu')
}

/**
 * URL, labelled-handle, literal-email and Telegram patterns; generic emails and phones are
 * scanned in `findSpans`. The generic ones are shared with completeness, so a contact it flags is
 * one this redacts.
 */
function contactPatterns(ctx: ContactContext): [ContactHit['kind'], RegExp][] {
  const global = (p: RegExp) => new RegExp(p.source, `${p.flags}g`)
  const literalEmails = ctx.emails
    .map((email) => email.normalize('NFC').trim())
    .filter(Boolean)
    .map((email): [ContactHit['kind'], RegExp] => ['email', new RegExp(escapeRegExp(email), 'giu')])
  const telegram = telegramPattern(ctx.telegram)
  return [
    ['url', global(RESUME_URL_PATTERN)],
    ['telegram', global(RESUME_TELEGRAM_LABEL_PATTERN)],
    ...literalEmails,
    ...(telegram ? [['telegram', telegram] as [ContactHit['kind'], RegExp]] : []),
  ]
}

/** Every raw hit on the NFC text, sorted by start, longer first on a tie. */
function findSpans(text: string, ctx: ContactContext): Span[] {
  const plain = text.replace(APOSTROPHES, "'")
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
  // the overlapping hits merge on redaction. Group 1 is the hit.
  const email = new RegExp(RESUME_EMAIL_PATTERN.source, 'gu')
  for (let m = email.exec(plain); m; m = email.exec(plain)) {
    const end = m.index + m[0].length
    const start = end - (m[1] ?? m[0]).length
    spans.push({ kind: 'email', start, end })
    email.lastIndex = start + 1
  }
  for (const span of findPhoneSpans(plain)) spans.push({ kind: 'phone', ...span })
  const folded = foldAccents(plain)
  for (const pattern of namePatterns(ctx.fullName)) {
    for (const m of folded.text.matchAll(pattern)) {
      const start = folded.from[m.index] ?? 0
      const end = folded.to[m.index + m[0].length - 1] ?? text.length
      spans.push({ kind: 'name', start, end })
    }
  }
  return spans.sort((a, b) => a.start - b.start || b.end - a.end)
}

/**
 * Contacts in `text`, in text order. Of overlapping hits only the first-starting
 * (longest on a tie) is reported. Both sides are NFC-normalised, so `match` is
 * the NFC form of the substring as written.
 *
 * Contract (both functions): call on each raw string field BEFORE
 * `JSON.stringify`, never on serialized JSON; that also keeps every input small.
 * Name matching folds accents (`Muller` hits `Müller`, `Walesa` hits `Wałęsa`,
 * `Strasse` hits `Straße`) and curly apostrophes,
 * but not transliterations (`Mueller`) or scripts: a Cyrillic context name does
 * not hit Latin text, so the caller passes the name in the text's script.
 */
export function scanContacts(text: string, ctx: ContactContext): ContactHit[] {
  const nfc = text.normalize('NFC')
  const hits: ContactHit[] = []
  let reachedEnd = 0
  for (const span of findSpans(nfc, ctx)) {
    if (span.start < reachedEnd) continue
    hits.push({ kind: span.kind, match: nfc.slice(span.start, span.end) })
    reachedEnd = span.end
  }
  return hits
}

/**
 * `text` (NFC) with every contact replaced by `[REDACTED]`. Overlapping and
 * adjacent hits merge into one replacement, so the result is a fixed point:
 * redacting it again, or scanning it, finds nothing. Same contract as
 * `scanContacts`: one raw field at a time, before serialization.
 */
export function redactContacts(
  text: string,
  ctx: ContactContext | readonly ContactContext[],
): string {
  const nfc = text.normalize('NFC')
  const merged: { start: number; end: number }[] = []
  // Several contexts (display and legal name) merge their spans before any replacement: redacting one
  // context's surname first would break the other's full-name match and leak its first names.
  const spans = scanContexts(ctx)
    .flatMap((c) => findSpans(nfc, c))
    // by start only: the merge below keeps the furthest end, so a tie needs no order
    .sort((a, b) => a.start - b.start)
  for (const { start, end } of spans) {
    const last = merged.at(-1)
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else merged.push({ start, end })
  }
  let result = ''
  let cursor = 0
  for (const { start, end } of merged) {
    result += `${nfc.slice(cursor, start)}[REDACTED]`
    cursor = end
  }
  return result + nfc.slice(cursor)
}
