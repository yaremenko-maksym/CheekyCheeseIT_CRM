import { type ExternalVacancyPrefill, externalVacancyPrefillSchema } from '@crm/shared'

/**
 * `#external=<base64url of UTF-8 JSON>`: how the bookmarklet hands a vacancy to the CRM. The hash
 * never reaches the server, and the page it came from is untrusted, so every failure here is
 * `null` and the dialog opens empty.
 */

const HASH_PREFIX = '#external='

/** Transport cap on the encoded part: long fragments are cut or refused by some browsers. */
export const PREFILL_HASH_MAX = 32000

/** Survives the Google login round-trip; read once, then removed. */
export const PREFILL_STASH_KEY = 'crm.externalPrefill'

/** Bytes per `String.fromCharCode` call: spreading a whole large array overflows the call stack. */
const CHUNK = 8192

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  // Stryker disable next-line EqualityOperator: one more pass at i === length appends String.fromCharCode() of an empty slice, which is ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  // Stryker disable next-line Regex: btoa only ever puts '=' at the very end, so /=+/ and /=+$/ match the same run
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(encoded: string): string {
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export function encodePrefill(p: ExternalVacancyPrefill): string {
  return toBase64Url(JSON.stringify(p))
}

/** `#external=<b64>` → a validated payload; anything else, oversized or malformed → `null`. */
export function decodePrefill(hash: string): ExternalVacancyPrefill | null {
  if (!hash.startsWith(HASH_PREFIX)) return null
  const encoded = hash.slice(HASH_PREFIX.length)
  // an empty part needs no check: '' is not JSON, so it ends in the catch below
  if (encoded.length > PREFILL_HASH_MAX) return null
  try {
    const parsed = externalVacancyPrefillSchema.safeParse(JSON.parse(fromBase64Url(encoded)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** A valid `#external=` in `loc` goes to session storage; `true` only when it was stored. */
export function stashPrefillFromLocation(loc: Pick<Location, 'hash'>): boolean {
  if (decodePrefill(loc.hash) === null) return false
  try {
    sessionStorage.setItem(PREFILL_STASH_KEY, loc.hash)
    return true
  } catch {
    return false
  }
}

/** Whether a payload is waiting, without consuming it. */
export function hasStashedPrefill(): boolean {
  try {
    return sessionStorage.getItem(PREFILL_STASH_KEY) !== null
  } catch {
    return false
  }
}

/** Reads, removes and validates the stashed payload: a second call returns `null`. */
export function takeStashedPrefill(): ExternalVacancyPrefill | null {
  try {
    const raw = sessionStorage.getItem(PREFILL_STASH_KEY)
    sessionStorage.removeItem(PREFILL_STASH_KEY)
    return decodePrefill(raw ?? '')
  } catch {
    return null
  }
}
