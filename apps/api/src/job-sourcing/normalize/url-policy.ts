import { isIP } from 'node:net'

/**
 * Policy for a link we STORE and later render or follow (posting URL, application URL).
 *
 * This is not the egress policy (Task 2.2: DNS pinning, redirects, private ranges at fetch time);
 * it is the cheaper, earlier check on the text itself, so a hostile feed cannot persist a link with
 * credentials, a non-web scheme, an odd port or a raw address that the UI would then hand to
 * `window.open`. The WHATWG `URL` parser does the folding work for us: it lowercases and punycodes
 * the host (one canonical IDN form) and rewrites decimal/hex/octal IPv4 into dotted quads, so one
 * check on the PARSED host catches every spelling of an address.
 */

export const MAX_LINK_CHARS = 2048

export type LinkRejection =
  'UNPARSEABLE' | 'TOO_LONG' | 'UNSAFE_SCHEME' | 'USERINFO' | 'UNSAFE_PORT' | 'IP_LITERAL'

export type LinkCheck = { ok: true; url: URL } | { ok: false; reason: LinkRejection }

export function checkStoredLink(raw: string | null | undefined): LinkCheck {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return { ok: false, reason: 'UNPARSEABLE' }
  if (text.length > MAX_LINK_CHARS) return { ok: false, reason: 'TOO_LONG' }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: 'UNPARSEABLE' }
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'UNSAFE_SCHEME' }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'USERINFO' }
  // `new URL` drops an explicit default port, so any remaining port is a non-default one.
  if (url.port !== '') return { ok: false, reason: 'UNSAFE_PORT' }

  // Normalize the host to its FINAL value, then validate that value. The order matters: the parser
  // keeps `127.0.0.1...` as a name (only a single trailing dot is folded into an address), so a
  // check made before stripping dots passes it and the stripping then manufactures the literal.
  const host = url.hostname.replace(/\.+$/, '')
  if (host.length === 0 || host.includes('..')) return { ok: false, reason: 'UNPARSEABLE' }
  // `isIP` on the final host covers dotted quads and bracket-stripped IPv6; the parser has already
  // folded decimal/hex/octal IPv4 into dotted form, and rejects out-of-range quads outright.
  if (host.startsWith('[') || isIP(host) !== 0) return { ok: false, reason: 'IP_LITERAL' }
  // `example.com.` and `example.com` are one host; the parser keeps the dot.
  if (host !== url.hostname) url.hostname = host
  return { ok: true, url }
}
