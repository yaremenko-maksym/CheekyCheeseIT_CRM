/**
 * UTF-8 text ↔ base64url without padding. Kept free of any import so the bookmarklet bundle
 * (`app/bookmarklet/entry.ts`) can use it without pulling zod or the shared schemas.
 */

/** Bytes per `String.fromCharCode` call: spreading a whole large array overflows the call stack. */
const CHUNK = 8192

export function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let rest = bytes; rest.length > 0; rest = rest.subarray(CHUNK)) {
    binary += String.fromCharCode(...rest.subarray(0, CHUNK))
  }
  // btoa puts '=' only at the end, as padding
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export function fromBase64Url(encoded: string): string {
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
