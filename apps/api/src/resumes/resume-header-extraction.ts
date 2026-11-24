/**
 * The resume header an upload writes (owner request 2026-11-25): the name, email, phone and
 * Telegram printed in the uploaded file replace the header overrides, so a senior whose CRM name
 * is Cyrillic still gets the Latin name the file carries.
 *
 * The model's answer is untrusted, so a contact counts only when it passes the header rules AND
 * appears in the file's own text: a hallucinated or injected value never reaches the PDF. A field
 * the file does not yield keeps the stored override. A value equal to the profile one is stored as
 * `null` (`ownHeaderOverrides`), so it keeps following later profile edits.
 */
import {
  normaliseTelegramHandle,
  resumeHeaderEmailSchema,
  resumeHeaderNameSchema,
  resumeHeaderPhoneSchema,
  resumeHeaderTelegramSchema,
  type ResumeHeaderOverrides,
  type ResumeHeaderValues,
} from '@crm/shared'

/** The contacts the extraction model read from the file, as it answered them. */
export interface ExtractedContacts {
  name: string
  email: string
  phone: string
  telegram: string
}

export const NO_EXTRACTED_CONTACTS: ExtractedContacts = {
  name: '',
  email: '',
  phone: '',
  telegram: '',
}

// Stryker disable next-line MethodExpression: both sides are folded alike, so upper case matches the same as lower case
const fold = (s: string) => s.toLowerCase()
const squash = (s: string) => fold(s.normalize('NFKC').replace(/\s+/g, ' '))
const digits = (s: string) => s.replace(/\D/g, '')
const WORD_CHAR = /[\p{L}\p{N}_]/u

/**
 * `value` occurs in `body` as a whole token: no letter, digit or `_` touches its end, and `opens`
 * accepts what precedes it (by default: not a letter, digit or `_` either).
 */
function hasToken(
  body: string,
  value: string,
  opens = (at: number) => !WORD_CHAR.test(body.charAt(at - 1)),
): boolean {
  for (let at = body.indexOf(value); at !== -1; at = body.indexOf(value, at + 1)) {
    if (opens(at) && !WORD_CHAR.test(body.charAt(at + value.length))) return true
  }
  return false
}

/** One printed phone number: a digit run joined only by phone punctuation, compared whole. */
const hasPhone = (text: string, phone: string) =>
  text.match(/\d[\d ().-]*\d/g)?.some((run) => digits(run) === digits(phone))

export function headerFromUpload(
  contacts: ExtractedContacts,
  text: string,
  stored: ResumeHeaderOverrides,
): ResumeHeaderOverrides {
  const body = squash(text)
  const inText = (value: string) => hasToken(body, squash(value))
  const name = resumeHeaderNameSchema.safeParse(contacts.name).data
  const email = resumeHeaderEmailSchema.safeParse(contacts.email).data
  const phone = resumeHeaderPhoneSchema.safeParse(contacts.phone).data
  const handle = normaliseTelegramHandle(contacts.telegram)
  const telegram = handle && resumeHeaderTelegramSchema.safeParse(`@${handle}`).data
  // A handle counts only where the file prints it as one: `@handle` (not an email's `@domain`) or `t.me/handle`.
  const printedHandle = (h: string) =>
    hasToken(body, squash(h), (at) => {
      const lead = body.charAt(at - 1)
      return lead === '/' || (lead === '@' && !WORD_CHAR.test(body.charAt(at - 2)))
    })
  return {
    displayName: name && inText(name) ? name : stored.displayName,
    email: email && inText(email) ? email : stored.email,
    phone: phone && hasPhone(text, phone) ? phone : stored.phone,
    telegram: telegram && printedHandle(telegram.slice(1)) ? telegram : stored.telegram,
  }
}

/** The overrides as stored: a value equal to the profile one is `null`, so it follows the profile. */
export function ownHeaderOverrides(
  header: ResumeHeaderOverrides,
  profile: ResumeHeaderValues,
): ResumeHeaderOverrides {
  const handle = (v: string | null) => v?.replace(/^@/, '') ?? null
  return {
    displayName: header.displayName === profile.displayName ? null : header.displayName,
    email: header.email?.toLowerCase() === profile.email?.toLowerCase() ? null : header.email,
    phone: header.phone === profile.phone ? null : header.phone,
    telegram: handle(header.telegram) === handle(profile.telegram) ? null : header.telegram,
  }
}
