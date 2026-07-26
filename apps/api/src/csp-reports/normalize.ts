/**
 * normalize.ts — task-csp-reports-and-flip §Часть A: shapes untrusted,
 * client-submitted CSP report fields into the storage-ready aggregation key
 * ("ключ: effective_directive + нормализованный blocked_uri + document_uri-
 * путь без query"). Mirrors `telemetry/route.ts`'s "always store pathname,
 * never the query string" rationale — a `document-uri` is just "the page the
 * browser was on" when the violation fired, and folding two otherwise-
 * identical violations that only differ by query string into ONE aggregate
 * row is also the whole POINT of aggregation (task §3).
 *
 * Security round 1 hardening (see each function's own doc comment):
 *   - `resolveDirective` now checks an ALLOW-LIST of real CSP directive
 *     names (HIGH-1c) instead of accepting arbitrary free text.
 *   - `normalizeBlockedUri` special-cases non-http(s) schemes (LOW/MED-1 —
 *     `url.origin` is the literal string `'null'` for `data:`/`javascript:`
 *     per the WHATWG URL spec, which previously produced garbage like
 *     `"nullalert(1)"`).
 *   - Truncation is now BYTE-based (`truncateBytes`), not UTF-16-code-unit
 *     based (LOW) — see that function's own doc comment.
 *
 * Callers MUST run `isAllowedDocumentOrigin` (origin-check.ts) on the RAW
 * `document-uri`/`documentURL` BEFORE calling `normalizeDocumentPath` here
 * (HIGH-1d) — this file only shapes a value that has ALREADY been proven to
 * belong to our own origin; it has no origin-allowlist knowledge itself.
 */

const MAX_BLOCKED_URI_BYTES = 500
const MAX_DOCUMENT_PATH_BYTES = 500

/**
 * Truncates `value` to at most `maxBytes` UTF-8 bytes — NOT UTF-16 code
 * units (security round 1 LOW). A UTF-16-unit slice can (a) split a
 * surrogate pair, corrupting the string, and (b) under-count multi-byte
 * UTF-8 characters (Cyrillic/CJK/emoji), letting a crafted value exceed
 * Postgres's ~2704-byte btree index-entry limit for the composite
 * aggregation key even though each field individually looked short by JS
 * `.length` (security review MED-3, second bullet). With byte-based caps
 * the same numeric constants (500/500) now mean "at most 500 bytes", so
 * the worst case for the 3-column key is bounded at ~1100 bytes total —
 * comfortably under the btree limit.
 *
 * Node's Buffer UTF-8 decoder replaces an incomplete trailing multi-byte
 * sequence with U+FFFD instead of producing an invalid half-surrogate;
 * that replacement char is stripped if the cut landed mid-sequence.
 */
export function truncateBytes(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf8')
  if (buf.length <= maxBytes) return value
  const truncated = buf.subarray(0, maxBytes).toString('utf8')
  return truncated.endsWith('�') ? truncated.slice(0, -1) : truncated
}

/**
 * `blocked-uri`/`blockedURL` → origin+pathname (query/fragment/credentials
 * stripped) for http(s) URLs. Non-http(s) absolute URLs (`data:`,
 * `javascript:`, `blob:`, `ws:`, ...) get `url.origin === 'null'` per the
 * WHATWG URL spec — concatenating that with `pathname` produced garbage
 * like `"nullalert(1)"` for `javascript:alert(1)` (security round 1 MED-1 /
 * LOW). For those we store just the scheme (`"javascript:"`, `"data:"`,
 * ...) — enough to know WHAT KIND of resource was blocked, without
 * persisting a potentially hostile inline payload. CSP also defines
 * non-URL special values (`inline`, `eval`, or an empty string for a
 * cross-origin redaction) per the spec — those pass through as-is (trimmed
 * + truncated), there is nothing further to normalize.
 */
export function normalizeBlockedUri(raw: string | undefined | null): string {
  const value = (raw ?? '').trim()
  if (!value) return '(empty)'
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return url.protocol
    }
    return truncateBytes(`${url.origin}${url.pathname}`, MAX_BLOCKED_URI_BYTES)
  } catch {
    return truncateBytes(value, MAX_BLOCKED_URI_BYTES)
  }
}

/**
 * `document-uri`/`documentURL` → pathname ONLY (origin AND query/fragment
 * stripped). By the time this runs, `isAllowedDocumentOrigin` has already
 * confirmed the origin is ours (always http/https) — see the file-level
 * doc comment.
 */
export function normalizeDocumentPath(raw: string | undefined | null): string {
  const value = (raw ?? '').trim()
  if (!value) return '(unknown)'
  try {
    const url = new URL(value)
    return truncateBytes(url.pathname || '/', MAX_DOCUMENT_PATH_BYTES)
  } catch {
    // Not an absolute URL (e.g. a bare path) — strip query/hash manually,
    // same idiom as telemetry/route.ts#toPathname.
    const withoutHash = value.split('#')[0] ?? ''
    const withoutQuery = withoutHash.split('?')[0] ?? ''
    return truncateBytes(withoutQuery || '/', MAX_DOCUMENT_PATH_BYTES)
  }
}

/**
 * ~29 real CSP3 directive names (fetch directives, document/navigation
 * directives, reporting directives — including a handful of deprecated-
 * but-still-reported-by-real-browsers ones) — security round 1 HIGH-1c:
 * `effective_directive`/`violated-directive` were previously free text,
 * letting an attacker mint unlimited distinct aggregation keys just by
 * varying this ONE field (on top of `blocked-uri`/`document-uri`
 * diversity). Anything outside this list is dropped — this also fully
 * neutralizes any control-character/injection concern for this field
 * (MED-1): no valid directive name contains one, so a poisoned value fails
 * the allow-list check and the whole report is dropped before storage.
 */
const CSP_DIRECTIVES = new Set([
  'default-src',
  'script-src',
  'script-src-elem',
  'script-src-attr',
  'style-src',
  'style-src-elem',
  'style-src-attr',
  'img-src',
  'connect-src',
  'font-src',
  'object-src',
  'media-src',
  'manifest-src',
  'worker-src',
  'child-src',
  'frame-src',
  'frame-ancestors',
  'base-uri',
  'form-action',
  'sandbox',
  'navigate-to',
  'prefetch-src',
  'upgrade-insecure-requests',
  'block-all-mixed-content',
  'plugin-types',
  'require-trusted-types-for',
  'trusted-types',
  'report-uri',
  'report-to',
])

/**
 * Resolves the aggregation-key directive: prefers `effective-directive`
 * (the modern, precise field); falls back to the FIRST token of
 * `violated-directive` (e.g. `"script-src 'self'"` → `"script-src"`) for
 * reports that omit it (the CSP2 spec makes `effective-directive`
 * optional). Both candidates are checked against `CSP_DIRECTIVES` — a
 * value that isn't a real directive name (including anything with
 * embedded whitespace/control characters, since none of those appear in
 * the allow-list) is rejected. Returns `null` when NEITHER candidate is
 * allow-listed — the caller drops the report entirely (no aggregation key
 * = nothing to group on, and an unrecognized directive is itself a
 * garbage-input signal for a PUBLIC endpoint).
 */
export function resolveDirective(
  effectiveDirective: string | undefined | null,
  violatedDirective: string | undefined | null,
): string | null {
  const effective = (effectiveDirective ?? '').trim()
  if (CSP_DIRECTIVES.has(effective)) return effective

  const violated = (violatedDirective ?? '').trim()
  const firstToken = violated.split(/\s+/)[0] ?? ''
  return CSP_DIRECTIVES.has(firstToken) ? firstToken : null
}
