import { isIP } from 'node:net'

/**
 * Policy for a link we STORE and later render or follow (posting URL, application URL).
 *
 * This is not the egress policy (Task 2.2: DNS pinning, redirects, private ranges at fetch time);
 * it is the cheaper, earlier check on the text itself, so a hostile feed cannot persist a link with
 * credentials, a non-web scheme, an odd port or a raw address that the UI would then hand to
 * `window.open`. The WHATWG `URL` parser does the folding work for us: it lowercases and punycodes
 * the host (one canonical IDN form) and rewrites decimal/hex/octal IPv4 into dotted quads — but it
 * does that folding on ASSIGNMENT as well as on parse, which is why every host check below runs on
 * the value the URL finally holds rather than on the value about to be written into it.
 */

export const MAX_LINK_CHARS = 2048

export type LinkRejection =
  'UNPARSEABLE' | 'TOO_LONG' | 'UNSAFE_SCHEME' | 'USERINFO' | 'UNSAFE_PORT' | 'IP_LITERAL'

export type LinkCheck = { ok: true; url: URL } | { ok: false; reason: LinkRejection }

export function checkStoredLink(raw: string | null | undefined): LinkCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'UNPARSEABLE' }
  // No separate empty-string guard: `new URL('')` throws and lands in the same UNPARSEABLE below,
  // so a guard here would be a branch no input can distinguish.
  const text = raw.trim()
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

  // THE INVARIANT: the host finally stored is the host that was validated. Checking the value we
  // are about to assign cannot deliver that, because two parsers disagree about what an address is:
  // `net.isIP` recognises ONLY dotted-quad IPv4, while the WHATWG hostname SETTER also folds
  // decimal, hex and shorthand forms (`2852039166`, `0xa9fea9fe`, `127.1`) into one. Two or more
  // trailing dots stop the first parse canonicalising, so such a host arrives here as a registrable
  // name, passes a pre-assignment check, and the ASSIGNMENT then manufactures the literal:
  // `https://2852039166../x` became `https://169.254.169.254/x`, the cloud metadata address.
  // So: strip, assign, and validate the value the URL now actually holds.
  const host = url.hostname.replace(/\.+$/, '')
  if (host.length === 0 || host.includes('..')) return { ok: false, reason: 'UNPARSEABLE' }
  // `example.com.` and `example.com` are one host; the parser keeps the dot. Assigning the value
  // the URL already holds is a no-op, so this needs no "only if different" guard.
  url.hostname = host
  // `isIP` covers dotted quads (including every spelling the setter just folded into one) and
  // out-of-range quads, which the parser refuses outright; brackets are tested separately because
  // `isIP('[::1]')` is 0 — it does not strip them.
  if (url.hostname.startsWith('[') || isIP(url.hostname) !== 0) {
    return { ok: false, reason: 'IP_LITERAL' }
  }

  // The cap belongs on the value we STORE, not on the text we received. `href` is the stored form
  // and it percent-encodes every non-ASCII byte, so a 2014-character Cyrillic URL serialises to
  // 12014 characters — six times the cap it was measured against. Checked after host normalization
  // so this measures the final string and nothing can grow it afterwards.
  if (url.href.length > MAX_LINK_CHARS) return { ok: false, reason: 'TOO_LONG' }
  return { ok: true, url }
}
