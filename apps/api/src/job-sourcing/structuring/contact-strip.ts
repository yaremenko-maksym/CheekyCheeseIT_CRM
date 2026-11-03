/**
 * Removes personal contact details from page text before that text may leave the host (model input).
 *
 * Deliberately over-strips: a false positive costs one word of job text, a false negative leaks a
 * person's contact to a third party. Known over-strip costs, accepted: `Engineer at Acme.com` (the
 * bare ` at ` email form), `Signal: strong` (a messenger label with a colon takes the next word).
 *
 * Deliberately NOT stripped: a bare run of digits with no separator and no phone label before it
 * (`4155550132`, `600700800`). It cannot be told apart from a job id, a salary or a reference
 * number; preceded by a phone label (`tel`, `phone`, `call`, `тел`, `т.` …) it is stripped.
 *
 * Pure, no I/O.
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
 * Every Unicode default-ignorable code point: zero-width space/joiners, bidi marks and overrides,
 * soft hyphen, combining grapheme joiner, variation selectors, Hangul fillers, tag characters.
 * Any of them can split a contact so no pattern sees it. ZWJ goes too, so an emoji ZWJ sequence
 * falls apart into its members; accepted, the text stays readable.
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu
/** C0 controls and DEL, except tab / newline / carriage return. Includes NUL. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** URL remainder that never ends on sentence punctuation (`linkedin.com/in/x.` keeps the `.`). */
const TAIL = String.raw`[^\s<>"'()\[\]]*[^\s<>"'()\[\].,;:!?]`
/** Not glued to a preceding word or host label (`notgithub.com`, `art.me`). */
const HOST_START = String.raw`(?<![\p{L}\p{N}_.\-])(?:https?:\/\/)?`

const MAILTO = String.raw`(?<![\p{L}\p{N}])mailto:[^\s<>"']+`
const TEL = String.raw`(?<![\p{L}\p{N}])(?:tel|callto|sms):[^\s<>"']+`

const MESSENGER_LINK = [
  String.raw`(?<![\p{L}\p{N}])(?:tg|viber|whatsapp|signal):\/\/[^\s<>"']+`,
  String.raw`${HOST_START}(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog|wa\.me|m\.me|signal\.me|discord\.gg|discord\.com\/users|(?:api\.|web\.|chat\.)?whatsapp\.com)\/${TAIL}`,
].join('|')

/** One path segment; a dot may sit inside it (`jane.doe`) but never at its end. */
const SEGMENT = String.raw`[\p{L}\p{N}_\-](?:[\p{L}\p{N}_.\-]*[\p{L}\p{N}_\-])?`
/** The segment ends here: no further segment follows (`github.com/org/repo` is a repo, not a person). */
const SINGLE_SEGMENT_END = String.raw`(?![\p{L}\p{N}_\-]|\.[\p{L}\p{N}_\-]|\/[\p{L}\p{N}_.\-])\/?(?:\?${TAIL})?`
const PROFILE_URL = [
  String.raw`${HOST_START}(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub|profile)\/${TAIL}`,
  String.raw`${HOST_START}lnkd\.in\/${TAIL}`,
  String.raw`${HOST_START}(?:www\.)?calendly\.com\/${TAIL}`,
  String.raw`${HOST_START}(?:www\.|m\.)?(?:medium\.com|tiktok\.com)\/@${TAIL}`,
  String.raw`${HOST_START}(?:www\.|m\.)?(?:github\.com|gitlab\.com|x\.com|twitter\.com|facebook\.com|fb\.com|instagram\.com|vk\.com)\/${SEGMENT}${SINGLE_SEGMENT_END}`,
].join('|')

/** `@`, `[at]`, `(at)`, `{at}`, `[@]`, the bare word ` at `, or `@` URL/HTML-encoded (once or twice). */
const AT = String.raw`(?:\s*[\[({]\s*(?:at|@)\s*[\])}]\s*|\s+at\s+|\s*(?:@|%40|&(?:amp;)?#0*64;|&#x0*40;|&commat;)\s*)`
/**
 * `.` / ideographic `。` / `,`, `[dot]`, `(dot)`, `{dot}`, `[.]`, the bare word ` dot `, a dot with
 * a space before it (`gmail . com`), or `.` URL/HTML-encoded. A dot glued to the left
 * (`example.com. Next`) takes no space after it, so a sentence-ending email keeps the next word.
 */
const DOT = String.raw`(?:\s*[\[({]\s*(?:dot|[.。])\s*[\])}]\s*|\s+dot\s+|[ \t]+[.。][ \t]*|[.。,]|%2e|&(?:amp;)?#0*46;|&#x0*2e;|&period;)`
const LABEL = String.raw`[\p{L}\p{N}\-]{1,63}`
/** `jane dot doe`: the ` dot ` inside a local part takes 1–3 spaces each side (bounded, see EMAIL). */
const LOCAL = String.raw`[\p{L}\p{N}._%+\-]+(?:\s{1,3}dot\s{1,3}[\p{L}\p{N}._%+\-]+)*`
/**
 * Local part anchored to its own start so a long non-matching run is scanned once, not per position;
 * a word after ` dot ` is never a start either (else `a dot a dot …` rescans per word: quadratic).
 * That look-behind is bounded: unbounded, it would walk a whitespace run back from every position.
 */
const EMAIL = String.raw`(?<![\p{L}\p{N}._%+\-])(?<!\sdot\s{1,3})${LOCAL}${AT}${LABEL}(?:${DOT}${LABEL})*${DOT}\p{L}{2,24}(?!\p{L})`

const ID = String.raw`[a-z][a-z0-9_.\-]{1,30}[a-z0-9_]`
/**
 * Without a colon the next word is an id only if it looks like one: a `_` or a digit in it, a dot
 * INSIDE it (`jane.doe`, never the sentence dot of `server.`), or a Discord `#1234` after it.
 */
const MARKED_ID = String.raw`(?=[a-z0-9_\-]*(?:[_\d]|\.[a-z0-9])|[a-z0-9_.\-]*#\d{4})${ID}`
/**
 * `Skype: live:jane.doe`, `Telegram: jane_doe`, `Telegram jane_doe`, `TG - jane_doe`,
 * `skype: live:.cid.123abc`, `Discord: jane#1234` — the label goes too.
 */
const MESSENGER_LABEL = [
  String.raw`(?<![\p{L}\p{N}])(?:telegram|tg|skype|viber|signal|whatsapp|discord)(?:\s?:\s?(?:live:(?:\.?cid\.[a-z0-9]+|${ID})|@?${ID})|(?:\s+|\s*[\-–—]\s*)@?${MARKED_ID})(?:#\d{4})?(?:\?[a-z]+)?`,
  String.raw`(?<![\p{L}\p{N}])live:\.?cid\.[a-z0-9]+`,
].join('|')
const HANDLE = String.raw`(?<![\p{L}\p{N}_.@\/\\])@[a-z][a-z0-9_.]{1,30}[a-z0-9_](?![a-z0-9_@])`

const D = String.raw`\p{Nd}`
/** One separator inside a number: space, dot, hyphen, or a typographic dash / minus sign. */
const S = String.raw`[ .\-‐-―−]`
/** Up to three separators or parens between two digits. */
const GAP = String.raw`[ .\-‐-―−()]{0,3}`
/**
 * A phone label right before the number, glued or not: `тел.050…`, `Viber+380…`, `Tel.:050…`.
 * Every quantifier in this look-behind is bounded: it is evaluated at every position of the text,
 * and `[ \t]*:?[ \t]*` made a run of spaces cubic (2 000 spaces: 12 s, measured).
 */
const PHONE_LABEL = String.raw`(?<=(?<![\p{L}\p{N}])(?:(?:telephone|tel|phones?(?:[ \t]number)?|mobile|mob|call(?:[ \t]me)?|contacts?|fax|viber|whatsapp|телефон|тел|моб)\.?|т\.)[ \t]{0,2}(?:[:\-#]|no\.?)?[ \t]{0,3})`
const PHONE = [
  // After a phone label anything of 7–15 digits is a phone, even an unseparated run.
  String.raw`${PHONE_LABEL}\+?\(?${D}(?:${GAP}${D}){6,14}`,
  // International with `+`: 8–15 digits. A letter may sit right before it (`Viber+380…`).
  String.raw`(?<![\p{N}_+])\+${D}(?:${GAP}${D}){7,14}`,
  // National forms; never inside a URL path/query or another number.
  String.raw`(?<![\p{L}\p{N}_\/=#&?.\-+])(?:` +
    [
      String.raw`00${D}(?:${S}?${D}){8,13}`, // 00 international prefix
      String.raw`380${D}{9}`, // UA without +
      String.raw`\(?0${D}{2}\)?${S}?${D}{3}${S}?${D}{2}${S}?${D}{2}`, // UA 0XX XXX XX XX
      // US: `(XXX)XXX-XXXX` / `(XXX)XXXXXXX` (separators optional after a paren) or `XXX-XXX-XXXX`.
      String.raw`(?:\(${D}{3}\)${S}?${D}{3}${S}?|${D}{3}${S}${D}{3}${S})${D}{4}`,
      String.raw`0${S}${D}{2}${S}${D}{3}${S}${D}{2}${S}${D}{2}`, // UA spaced mobile 0 67 123 45 67
      String.raw`${D}{3}${S}${D}{3}${S}${D}{3}`, // PL XXX XXX XXX
      String.raw`\(?0${D}{2,4}\)?${S}${D}{3,4}${S}?${D}{3,4}`, // UK 020 7946 0958 / 07700 900123, DE 030 12345678
      String.raw`${D}{3}${S}${D}{2}${S}${D}{2}${S}${D}{2}`, // FR/ES XXX XX XX XX
      String.raw`${D}(?: ${D}){8,14}`, // one digit at a time: 0 5 0 1 2 3 4 5 6 7
    ].join('|') +
    ')',
]
  .map((alt) => `(?:${alt})`)
  .join('|')
/** A letter may follow (`+380…Telegram`, text extraction glues inline elements); a digit may not. */
const PHONE_END = String.raw`(?!\p{N}|[.\-]\p{N})`

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
  [new RegExp(`(?:${PHONE})${PHONE_END}`, 'giu'), 'phone'],
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
