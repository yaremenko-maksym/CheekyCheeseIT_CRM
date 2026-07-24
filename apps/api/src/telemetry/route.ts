/**
 * route.ts — task-telemetry-api security fix (review round 1, HIGH).
 *
 * `route`/`request.url` MUST be stored as pathname-only, everywhere it is
 * written to `telemetry_errors`/`telemetry_events`. A raw URL/route can carry
 * a query string (`?code=...&state=...` — an OAuth callback, or any future
 * token-in-URL pattern) or a hash fragment; the digest endpoint later hands
 * this value verbatim to `.github/workflows/telemetry-digest.yml`, which
 * posts it into a PUBLIC GitHub issue body. Storing the full query string
 * would leak that data into the issue.
 *
 * ONE helper, reused at every write site (`TelemetryErrorsService`,
 * `TelemetryEventsService`, `TelemetryExceptionFilter`) — no second,
 * drifting implementation of "strip the query/hash".
 */
export function toPathname(route: string): string {
  const withoutHash = route.split('#')[0] ?? ''
  return withoutHash.split('?')[0] ?? ''
}
