/**
 * Removes personal contact details from page text before that text may leave the host (model input).
 *
 * Deliberately over-strips: a false positive costs one word of job text, a false negative leaks a
 * person's contact to a third party. Pure, no I/O.
 */

/** Fixed neutral replacement. Contains nothing any pattern below can match, so the strip is idempotent. */
export const CONTACT_TOKEN = '[contact]'

export interface ContactCounts {
  email: number
  phone: number
  messenger: number
  profileUrl: number
}

export interface StrippedText {
  text: string
  removed: ContactCounts
}

/**
 * Invisible characters that can split a contact so no pattern sees it, or spoof text direction:
 * soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width space/joiners, LRM/RLM,
 * bidi embeddings/overrides/isolates, word joiner + invisible operators, BOM. Wider than
 * `build-posting`'s BIDI_CHARS, which only covers what spoofs the UI.
 */
const INVISIBLE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g
/** C0 controls and DEL, except tab / newline / carriage return. Includes NUL. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** URL remainder that never ends on sentence punctuation (`linkedin.com/in/x.` keeps the `.`). */
const TAIL = String.raw`[^\s<>"'()\[\]]*[^\s<>"'()\[\].,;:!?]`
/** Not glued to a preceding word or host label (`notgithub.com`, `art.me`). */
const HOST_START = String.raw`(?<![\p{L}\p{N}_.\-])(?:https?:\/\/)?`

const MAILTO = String.raw`(?<![\p{L}\p{N}])mailto:[^\s<>"']+`
const TEL = String.raw`(?<![\p{L}\p{N}])tel:[^\s<>"']+`

const MESSENGER_LINK = [
  String.raw`(?<![\p{L}\p{N}])(?:tg|viber|whatsapp|signal):\/\/[^\s<>"']+`,
  String.raw`${HOST_START}(?:www\.)?(?:t\.me|telegram\.me|wa\.me|signal\.me|(?:api\.|web\.|chat\.)?whatsapp\.com)\/${TAIL}`,
].join('|')

/** One path segment; a dot may sit inside it (`jane.doe`) but never at its end. */
const SEGMENT = String.raw`[\p{L}\p{N}_\-](?:[\p{L}\p{N}_.\-]*[\p{L}\p{N}_\-])?`
/** The segment ends here: no further segment follows (`github.com/org/repo` is a repo, not a person). */
const SINGLE_SEGMENT_END = String.raw`(?![\p{L}\p{N}_\-]|\.[\p{L}\p{N}_\-]|\/[\p{L}\p{N}_.\-])\/?(?:\?${TAIL})?`
const PROFILE_URL = [
  String.raw`${HOST_START}(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/${TAIL}`,
  String.raw`${HOST_START}(?:www\.|m\.)?(?:github\.com|gitlab\.com|x\.com|twitter\.com|facebook\.com|fb\.com|instagram\.com)\/${SEGMENT}${SINGLE_SEGMENT_END}`,
].join('|')

/** `@`, `[at]`, `(at)`, `{at}`, `[@]`, or the bare word ` at `. */
const AT = String.raw`(?:\s*[\[({]\s*(?:at|@)\s*[\])}]\s*|\s+at\s+|\s*@\s*)`
/** `.`, `[dot]`, `(dot)`, `{dot}`, `[.]`, or the bare word ` dot `. */
const DOT = String.raw`(?:\s*[\[({]\s*(?:dot|\.)\s*[\])}]\s*|\s+dot\s+|\.)`
const LABEL = String.raw`[\p{L}\p{N}\-]{1,63}`
/** Local part anchored to its own start so a long non-matching run is scanned once, not per position. */
const EMAIL = String.raw`(?<![\p{L}\p{N}._%+\-])[\p{L}\p{N}._%+\-]+${AT}${LABEL}(?:${DOT}${LABEL})*${DOT}\p{L}{2,24}(?![\p{L}\p{N}])`

/** `Skype: live:jane.doe`, `Telegram: jane_doe`, `skype:jane?call` — the label goes too. */
const MESSENGER_LABEL = String.raw`(?<![\p{L}\p{N}])(?:telegram|tg|skype|viber|signal|whatsapp|discord)\s?:\s?(?:live:)?@?[a-z][a-z0-9_.\-]{1,30}[a-z0-9_](?:\?[a-z]+)?`
const HANDLE = String.raw`(?<![\p{L}\p{N}_.@\/\\])@[a-z][a-z0-9_.]{1,30}[a-z0-9_](?![a-z0-9_@])`

const D = String.raw`\p{Nd}`
const PHONE = [
  // International with `+`: 8–15 digits, up to two separators between digits.
  String.raw`(?<![\p{L}\p{N}_])\+${D}(?:[ .\-()]{0,2}${D}){7,14}`,
  // National forms; never inside a URL path/query or another number.
  String.raw`(?<![\p{L}\p{N}_\/=#&?.\-+])(?:` +
    [
      String.raw`00${D}(?:[ .\-]?${D}){8,13}`, // 00 international prefix
      String.raw`380${D}{9}`, // UA without +
      String.raw`\(?0${D}{2}\)?[ .\-]?${D}{3}[ .\-]?${D}{2}[ .\-]?${D}{2}`, // UA 0XX XXX XX XX
      String.raw`\(?${D}{3}\)?[ .\-]${D}{3}[ .\-]${D}{4}`, // US (XXX) XXX-XXXX
      String.raw`${D}{3}[ \-]${D}{3}[ \-]${D}{3}`, // PL XXX XXX XXX
    ].join('|') +
    ')',
]
  .map((alt) => `(?:${alt})`)
  .join('|')
const PHONE_END = String.raw`(?![\p{L}\p{N}]|[.\-]\p{N})`

/**
 * Applied in this order: links before the bare forms they contain (`wa.me/380…` is not a phone).
 * Compiled per call (cheap next to the scan): a malformed pattern then fails the call that uses it,
 * not the module import — which the mutation gate could not attribute to a test.
 */
const rules = (): ReadonlyArray<readonly [RegExp, keyof ContactCounts]> => [
  [new RegExp(MAILTO, 'giu'), 'email'],
  [new RegExp(TEL, 'giu'), 'phone'],
  [new RegExp(MESSENGER_LINK, 'giu'), 'messenger'],
  [new RegExp(PROFILE_URL, 'giu'), 'profileUrl'],
  [new RegExp(EMAIL, 'giu'), 'email'],
  [new RegExp(MESSENGER_LABEL, 'giu'), 'messenger'],
  [new RegExp(HANDLE, 'giu'), 'messenger'],
  [new RegExp(`(?:${PHONE})${PHONE_END}`, 'gu'), 'phone'],
]

export function stripContacts(input: string): StrippedText {
  const removed: ContactCounts = { email: 0, phone: 0, messenger: 0, profileUrl: 0 }
  // NFKC folds fullwidth `＠`/`．`/digits to ASCII before matching; then drop what hides a contact.
  let text = input.normalize('NFKC').replace(INVISIBLE, '').replace(CONTROL, '')
  for (const [pattern, kind] of rules()) {
    text = text.replace(pattern, () => {
      removed[kind] += 1
      return CONTACT_TOKEN
    })
  }
  return { text, removed }
}
