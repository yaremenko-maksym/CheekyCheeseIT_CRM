/**
 * Contact scan (verified-base-resume Task 9).
 *
 * Text bound for a third-party AI writer passes through here first: a senior's
 * phone, email and name are found and replaced by `[REDACTED]`. A missed
 * contact is a leak, so every recognisable email and phone counts, not only the
 * senior's own. Pure: no I/O, no Nest providers.
 */
import { RESUME_EMAIL_PATTERN, RESUME_PHONE_PATTERN } from '@crm/shared'

export interface ContactContext {
  fullName: string
  /** `users.email` plus every `user_emails` row. */
  emails: string[]
}

export interface ContactHit {
  kind: 'phone' | 'email' | 'name'
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
/** Built from the map's keys, so the two cannot drift. */
const UNDECOMPOSED_LETTER = new RegExp(`[${Object.keys(UNDECOMPOSED).join('')}]`, 'gu')

/**
 * `text` without accents (NFD, marks dropped, plus `UNDECOMPOSED`), and for each
 * of its code units the span of the NFC character, marks included, it came from.
 */
function foldAccents(text: string): { text: string; from: number[]; to: number[] } {
  let folded = ''
  const from: number[] = []
  const to: number[] = []
  for (const { 0: cluster, index } of text.matchAll(/\P{M}\p{M}*/gu)) {
    const piece = cluster
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(UNDECOMPOSED_LETTER, (letter) => UNDECOMPOSED[letter] ?? letter)
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

function contactPatterns(ctx: ContactContext): [ContactHit['kind'], RegExp][] {
  const global = (p: RegExp) => new RegExp(p.source, `${p.flags}g`)
  const literalEmails = ctx.emails
    .map((email) => email.normalize('NFC').trim())
    .filter(Boolean)
    .map((email): [ContactHit['kind'], RegExp] => ['email', new RegExp(escapeRegExp(email), 'giu')])
  return [
    ['email', global(RESUME_EMAIL_PATTERN)],
    ...literalEmails,
    ['phone', global(RESUME_PHONE_PATTERN)],
  ]
}

/** Every raw hit on the NFC text, sorted by start, longer first on a tie. */
function findSpans(text: string, ctx: ContactContext): Span[] {
  const plain = text.replace(APOSTROPHES, "'")
  const spans: Span[] = []
  for (const [kind, pattern] of contactPatterns(ctx)) {
    for (const m of plain.matchAll(pattern)) {
      spans.push({ kind, start: m.index, end: m.index + m[0].length })
    }
  }
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
export function redactContacts(text: string, ctx: ContactContext): string {
  const nfc = text.normalize('NFC')
  const merged: { start: number; end: number }[] = []
  for (const { start, end } of findSpans(nfc, ctx)) {
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
