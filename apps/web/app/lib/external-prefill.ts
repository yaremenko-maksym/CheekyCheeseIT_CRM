import { type ExternalVacancyPrefill, externalVacancyPrefillSchema } from '@crm/shared'
import { fromBase64Url, toBase64Url } from './base64url'

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

/** Set once the CRM has received a bookmarklet payload; until then the install dialog opens itself. */
export const BOOKMARKLET_USED_KEY = 'crm.bookmarkletUsed'

/** Whether this browser has used the bookmarklet. Unreadable storage counts as used: no nagging. */
export function bookmarkletUsed(): boolean {
  try {
    return localStorage.getItem(BOOKMARKLET_USED_KEY) !== null
  } catch {
    return true
  }
}

/** Reads, removes and validates the stashed payload: a second call returns `null`. */
export function takeStashedPrefill(): ExternalVacancyPrefill | null {
  let prefill: ExternalVacancyPrefill | null
  try {
    const raw = sessionStorage.getItem(PREFILL_STASH_KEY)
    sessionStorage.removeItem(PREFILL_STASH_KEY)
    // Stryker disable next-line StringLiteral: any fallback without the #external= prefix decodes to null, exactly like ''
    prefill = decodePrefill(raw ?? '')
  } catch {
    return null
  }
  if (prefill !== null) {
    try {
      localStorage.setItem(BOOKMARKLET_USED_KEY, '1')
    } catch {
      // Without the flag the install dialog may open again; the payload still goes through.
    }
  }
  return prefill
}
