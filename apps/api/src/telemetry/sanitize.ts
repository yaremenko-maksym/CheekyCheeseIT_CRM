/**
 * sanitize.ts — task-telemetry-api §5 (security): redact secrets from error
 * message/stack BEFORE they are persisted or returned via the digest.
 *
 * There should be no live secrets in client-side error text in the first
 * place (the CRM is a server-rendered-data SPA, not a place that embeds
 * tokens in JS), but this is a pattern-filter safety net — belt-and-braces,
 * same rationale as the design spec: "уже нет секретов в клиенте, но
 * паттерн-фильтр Bearer/cookie на всякий".
 *
 * The SAME function sanitizes:
 *   - client-submitted error reports (POST /api/telemetry/errors)
 *   - server-side exception message/stack (TelemetryExceptionFilter)
 *
 * so there is exactly one place that knows the redaction patterns — no
 * second, drifting implementation.
 *
 * The individual patterns below are also exported — task-csp-reports-and-
 * flip security round 1 (MED-4): `csp-reports/sanitize-url-field.ts` needs
 * Bearer/password redaction WITHOUT the cookie pattern (which mangles
 * innocuous URLs like `consent.cookiebot.com`), so it composes a NARROWER
 * sanitizer from these same regex instances instead of re-implementing them
 * — no second, drifting copy of the patterns themselves either.
 */

/** `Authorization: Bearer <token>` / bare `Bearer <token>` mentions. */
export const BEARER_PATTERN = /Bearer\s+\S+/gi
/**
 * `Cookie: foo=bar; jwt=eyJ...; other=qux` — redact the ENTIRE header value
 * (every `;`-separated pair on the same line), not just up to the first
 * `;`. sec MED (review round 1): a raw `/cookie[^;]+/gi` stops at the FIRST
 * semicolon — a multi-pair Cookie header (the normal shape; browsers always
 * send every cookie on one `Cookie:` line, `; `-joined) left every pair
 * AFTER the first one — e.g. a JWT session cookie — completely unredacted.
 * `[^\n]*` consumes the rest of the LINE instead, so it never bleeds into a
 * following line of a multi-line stack trace.
 */
export const COOKIE_HEADER_PATTERN = /cookie[^\n]*/gi
/** `password=...` / `password: "..."` / `password='...'` in any casing. */
export const PASSWORD_PATTERN = /password["':=\s]+\S+/gi

const REDACTION_PATTERNS: RegExp[] = [BEARER_PATTERN, COOKIE_HEADER_PATTERN, PASSWORD_PATTERN]

/**
 * C0 controls + DEL + C1 controls (`\x00`-`\x1F`, `\x7F`-`\x9F` — CR/LF/TAB
 * included) — task-csp-reports-and-flip security round 1 (MED-1): strips
 * these OUTRIGHT (not redacted-in-place) from untrusted text before
 * storage, so CRLF/control-char injection can never smuggle fake log
 * lines or break a future markdown/table renderer. Exported for reuse by
 * `csp-reports/sanitize-url-field.ts` and `csp-reports.service.ts`'s
 * user-agent handling — same rationale as the exported patterns above.
 */
const CONTROL_CHARS_PATTERN = /[\x00-\x1F\x7F-\x9F]/g

export function stripControlChars(input: string): string {
  return input.replace(CONTROL_CHARS_PATTERN, '')
}

/** Redacts every REDACTION_PATTERNS match in `input`, replacing it with `[redacted]`. */
export function sanitizeText(input: string): string {
  let result = input
  for (const pattern of REDACTION_PATTERNS) {
    result = result.replace(pattern, '[redacted]')
  }
  return result
}

/** `sanitizeText` for a nullable/undefined value — passes `null`/`undefined` through unchanged. */
export function sanitizeNullable(input: string | null | undefined): string | null | undefined {
  if (input === null || input === undefined) return input
  return sanitizeText(input)
}

/**
 * Sanitizes, THEN truncates to `maxLength` — truncation must happen AFTER
 * redaction so a secret straddling the truncation boundary is still caught
 * (redacting a pre-truncated string could leave a partial, still-sensitive
 * token fragment behind).
 */
export function sanitizeAndTruncate(input: string, maxLength: number): string {
  const sanitized = sanitizeText(input)
  return sanitized.length > maxLength ? sanitized.slice(0, maxLength) : sanitized
}
