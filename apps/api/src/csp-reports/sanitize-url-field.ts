import { BEARER_PATTERN, PASSWORD_PATTERN, stripControlChars } from '../telemetry/sanitize'

/**
 * sanitize-url-field.ts — task-csp-reports-and-flip security round 1 (MED-4).
 *
 * `telemetry/sanitize.ts`'s `sanitizeText` is NOT safe for URL-shaped
 * fields (`blocked-uri` / `document-uri`) — its cookie pattern (a
 * case-insensitive match on "cookie" through end-of-line) matches
 * innocuous substrings like the hostname `consent.cookiebot.com`, turning
 * it into `consent.[redacted]`. Cookie-
 * consent widgets are the single most common real-world source of CSP
 * violations (third-party script/style injected by the consent banner
 * itself) — mangling exactly those URLs breaks the triage this endpoint
 * exists for.
 *
 * This is a NARROWER sanitizer for URL fields: control-character stripping
 * (MED-1 — CRLF/C0/C1 defense, reused from `telemetry/sanitize.ts`) plus
 * Bearer/password redaction (defense-in-depth for the case a same-origin
 * document-uri path happens to embed a token) — deliberately WITHOUT the
 * cookie pattern.
 */
export function sanitizeUrlField(input: string): string {
  return stripControlChars(input)
    .replace(BEARER_PATTERN, '[redacted]')
    .replace(PASSWORD_PATTERN, '[redacted]')
}

/** `sanitizeUrlField` for a nullable/undefined value — passes `null`/`undefined` through unchanged. */
export function sanitizeUrlFieldNullable(
  input: string | null | undefined,
): string | null | undefined {
  if (input === null || input === undefined) return input
  return sanitizeUrlField(input)
}
