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
  findPhoneSpans,
  findWholeTokens,
  foldAccents,
  normaliseContactText,
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * The full name (any whitespace between parts) and the surname alone, never the first name, as
 * `findWholeTokens` sources; accent-folded, so they run on `foldAccents` text.
 */
function nameSources(fullName: string): string[] {
  // Normalised like the text, so a name with a ligature, a ZWNJ or fullwidth letters matches itself.
  const name = foldAccents(
    normaliseContactText(fullName).text.replace(CONTACT_APOSTROPHES, "'"),
  ).text
  const parts = name.trim().split(/\s+/u)
  const surname = parts.at(-1) ?? ''
  const sources = [parts.map(escapeRegExp).join(CONTACT_NAME_GAP)]
  if (surname.replace(/\P{L}/gu, '').length >= 2) sources.push(escapeRegExp(surname))
  // a blank name leaves an empty source, which would match everywhere
  return sources.filter(Boolean)
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

/** Every raw hit on the normalised text, mapped back to the original text offsets, sorted by start, longer first on a tie. */
function findSpans(
  text: string,
  norm: ReturnType<typeof normaliseContactText>,
  ctx: ContactContext,
): Span[] {
  const normText = norm.text
  const plain = normText.replace(CONTACT_APOSTROPHES, "'")
  const rawSpans: Span[] = []
  for (const [kind, pattern] of contactPatterns(ctx)) {
    for (const m of plain.matchAll(pattern)) {
      // The bare-URL and label patterns consume one boundary character in front; their group 1
      // is the hit.
      const end = m.index + m[0].length
      rawSpans.push({ kind, start: end - (m[1] ?? m[0]).length, end })
    }
  }
  const handle = telegramSource(ctx.telegram)
  if (handle !== null) {
    for (const span of findWholeTokens(plain, norm.gaps, handle, 'handle')) {
      rawSpans.push({ kind: 'telegram', ...span })
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
    rawSpans.push({ kind: 'email', start, end })
    email.lastIndex = start + ((plain.codePointAt(start) ?? 0) >= 0x10000 ? 2 : 1)
  }
  for (const span of findPhoneSpans(plain)) rawSpans.push({ kind: 'phone', ...span })
  const folded = foldAccents(plain, norm.gaps)
  for (const source of nameSources(ctx.fullName)) {
    for (const span of findWholeTokens(folded.text, folded.gaps, source, 'name')) {
      const start = folded.from[span.start] ?? 0
      const end = folded.to[span.end - 1] ?? normText.length
      rawSpans.push({ kind: 'name', start, end })
    }
  }
  const spans: Span[] = rawSpans.map((s) => ({
    kind: s.kind,
    // Stryker disable next-line ConditionalExpression: fallback only if index is out of bounds
    start: norm.from[s.start] ?? 0,
    // Stryker disable next-line ConditionalExpression: fallback only if index is out of bounds
    end: norm.to[s.end - 1] ?? text.length,
  }))
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
  for (const span of findSpans(text, norm, ctx)) {
    if (span.start < reachedEnd) continue
    hits.push({
      kind: span.kind,
      match: text.slice(span.start, span.end).normalize('NFC'),
    })
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
  const norm = normaliseContactText(text)
  const merged: { start: number; end: number }[] = []
  // Several contexts (display and legal name) merge their spans before any replacement: redacting one
  // context's surname first would break the other's full-name match and leak its first names.
  const spans = scanContexts(ctx)
    .flatMap((c) => findSpans(text, norm, c))
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
    result += `${text.slice(cursor, start).normalize('NFC')}[REDACTED]`
    cursor = end
  }
  return result + text.slice(cursor).normalize('NFC')
}
