/**
 * Finds anything in a committed capture that could be a person's address, by the TOKEN that makes
 * it one rather than by a regex for the finished address. A regex for `local@domain` cannot see
 * `local%40domain`, `local&#64;domain` or `local[at]domain`, which is the class that cost Task 3.2
 * seven review rounds. Lives in `src/test/` like the other fixture helpers: it builds checks, and
 * its mutants say nothing about whether an adapter is tested.
 */

/** Every spelling of "@" the scan knows. A test gives EACH one its own positive control. */
export const AT_FORMS = [
  { name: 'literal @', pattern: '@' },
  { name: 'fullwidth @', pattern: '\\uFF20' },
  { name: 'percent-encoded', pattern: '%40' },
  { name: 'double percent-encoded', pattern: '%2540' },
  { name: 'decimal entity', pattern: '&#0*64;' },
  { name: 'hex entity', pattern: '&#x0*40;' },
  { name: 'named entity', pattern: '&commat;' },
  { name: '[at]', pattern: '\\[at\\]' },
  { name: '(at)', pattern: '\\(at\\)' },
] as const

export interface AddressHit {
  form: string
  /** The whole address-shaped run around the token: local part, the token, the domain part. */
  span: string
}

/** The only literal that is a placeholder. Matched WHOLE, local part included. */
export const PLACEHOLDER = 'redacted@example.invalid'

/**
 * Every address-shaped run in `text`. A hit is an address unless it is exactly the placeholder; the
 * caller allow-lists what is not (by file, value and reason). Case-insensitive, so `%40` and `&COMMAT;`
 * count.
 */
export function addressHits(text: string): AddressHit[] {
  const hits: AddressHit[] = []
  for (const form of AT_FORMS) {
    const re = new RegExp(`[A-Za-z0-9._+\\-]*(?:${form.pattern})[A-Za-z0-9.\\-]*`, 'gi')
    for (const match of text.matchAll(re)) {
      if (match[0] !== PLACEHOLDER) hits.push({ form: form.name, span: match[0] })
    }
  }
  return hits
}
