/**
 * normalize.ts — task-csp-reports-and-flip §Часть A: shapes untrusted,
 * client-submitted CSP report fields into the storage-ready aggregation key
 * ("ключ: effective_directive + нормализованный blocked_uri + document_uri-
 * путь без query"). Mirrors `telemetry/route.ts`'s "always store pathname,
 * never the query string" rationale — a `document-uri` is just "the page the
 * browser was on" when the violation fired, and folding two otherwise-
 * identical violations that only differ by query string into ONE aggregate
 * row is also the whole POINT of aggregation (task §3).
 */

const MAX_BLOCKED_URI_LENGTH = 500
const MAX_DOCUMENT_PATH_LENGTH = 500
const MAX_DIRECTIVE_LENGTH = 100

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

/**
 * `blocked-uri`/`blockedURL` → origin+pathname (query/fragment/credentials
 * stripped) when it parses as an absolute URL. CSP also defines non-URL
 * special values (`inline`, `eval`, `data`, `about`, `ws`, or an empty string
 * for a cross-origin redaction) per the spec — those pass through as-is
 * (trimmed + truncated), there is nothing further to normalize.
 */
export function normalizeBlockedUri(raw: string | undefined | null): string {
  const value = (raw ?? '').trim()
  if (!value) return '(empty)'
  try {
    const url = new URL(value)
    return truncate(`${url.origin}${url.pathname}`, MAX_BLOCKED_URI_LENGTH)
  } catch {
    return truncate(value, MAX_BLOCKED_URI_LENGTH)
  }
}

/** `document-uri`/`documentURL` → pathname ONLY (origin AND query/fragment stripped). */
export function normalizeDocumentPath(raw: string | undefined | null): string {
  const value = (raw ?? '').trim()
  if (!value) return '(unknown)'
  try {
    const url = new URL(value)
    return truncate(url.pathname || '/', MAX_DOCUMENT_PATH_LENGTH)
  } catch {
    // Not an absolute URL (e.g. a bare path) — strip query/hash manually,
    // same idiom as telemetry/route.ts#toPathname.
    const withoutHash = value.split('#')[0] ?? ''
    const withoutQuery = withoutHash.split('?')[0] ?? ''
    return truncate(withoutQuery || '/', MAX_DOCUMENT_PATH_LENGTH)
  }
}

/**
 * Resolves the aggregation-key directive: prefers `effective-directive`
 * (the modern, precise field); falls back to the FIRST token of
 * `violated-directive` (e.g. `"script-src 'self'"` → `"script-src"`) for
 * reports that omit it (the CSP2 spec makes `effective-directive` optional).
 * Returns `null` when NEITHER carries anything usable — the caller drops the
 * report (no aggregation key = nothing to group on).
 */
export function resolveDirective(
  effectiveDirective: string | undefined | null,
  violatedDirective: string | undefined | null,
): string | null {
  const effective = (effectiveDirective ?? '').trim()
  if (effective) return truncate(effective, MAX_DIRECTIVE_LENGTH)

  const violated = (violatedDirective ?? '').trim()
  if (!violated) return null
  const firstToken = violated.split(/\s+/)[0]
  return firstToken ? truncate(firstToken, MAX_DIRECTIVE_LENGTH) : null
}
