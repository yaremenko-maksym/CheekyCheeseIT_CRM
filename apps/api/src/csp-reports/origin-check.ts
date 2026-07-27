/**
 * origin-check.ts — task-csp-reports-and-flip security round 1 (HIGH-1d,
 * the PRIMARY fix, applied FIRST in `CspReportsService.recordViolation`).
 *
 * A genuine CSP violation report always carries a `document-uri`/
 * `documentURL` on OUR OWN origin — the browser only ever enforces/reports
 * OUR policy on pages WE served. Checking this BEFORE any other processing
 * kills the mass-reflection vector the security review flagged wholesale:
 * an attacker who embeds `report-uri
 * https://app.cheekycheese.tech/api/public/csp-report` in THEIR OWN site's
 * CSP would have every visitor's browser report THAT page as the
 * `document-uri` — thousands of distinct IPs, each a fresh 60/hour bucket,
 * per-IP rate-limiting is powerless against it. None of those reports can
 * ever carry OUR origin, so they are all dropped right here, before a
 * single byte reaches Postgres.
 *
 * MUST run on the RAW `document-uri`, BEFORE `normalizeDocumentPath()`
 * strips the origin away for storage — that normalization happens AFTER
 * this check succeeds, never before it.
 */
export function isAllowedDocumentOrigin(
  documentUri: string | undefined | null,
  allowedOrigins: readonly (string | RegExp)[],
): boolean {
  if (!documentUri) return false

  let origin: string
  try {
    origin = new URL(documentUri).origin
  } catch {
    return false
  }

  return allowedOrigins.some((allowed) =>
    typeof allowed === 'string' ? allowed === origin : allowed.test(origin),
  )
}
