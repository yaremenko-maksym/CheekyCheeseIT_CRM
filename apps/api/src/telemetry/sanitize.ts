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
 */

const REDACTION_PATTERNS: RegExp[] = [
  // `Authorization: Bearer <token>` / bare `Bearer <token>` mentions.
  /Bearer\s+\S+/gi,
  // `Cookie: foo=bar; baz=qux` (up to the next `;` or end of the match).
  /cookie[^;]+/gi,
  // `password=...` / `password: "..."` / `password='...'` in any casing.
  /password["':=\s]+\S+/gi,
]

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
