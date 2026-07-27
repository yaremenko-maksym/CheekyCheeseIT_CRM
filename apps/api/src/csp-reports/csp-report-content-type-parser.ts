import type { NestFastifyApplication } from '@nestjs/platform-fastify'

/**
 * csp-report-content-type-parser.ts — task-csp-reports-and-flip КОНТРАКТ:
 * "поддержать ОБА: application/csp-report (report-uri) и
 * application/reports+json (report-to)". Fastify has NO built-in parser for
 * either — its native support is limited to 'application/json' /
 * 'text/plain' (see Fastify's own ContentTypeParser docs) — so both need an
 * explicit `addContentTypeParser` registration, done ONCE here and called
 * from both `main.ts` (prod/dev) and the integration spec (test Fastify
 * instance), so there is exactly one implementation, no drift.
 *
 * A single RegExp handles BOTH content types (± an optional `; charset=...`
 * suffix some browsers append) — simpler than two separate registrations
 * with identical bodies.
 *
 * `bodyLimit` here is a SEPARATE, much tighter cap than the rest of the API
 * (task §2: "лимит размера тела (~32 КБ), отдельно от глобального лимита")
 * — this is a PUBLIC, unauthenticated endpoint (any browser on the internet),
 * and a real CSP report is always a handful of short URL-shaped strings.
 * Fastify enforces this DURING body collection — an oversized body is
 * rejected with 413 before the parser function below ever runs (see Fastify
 * ContentTypeParser docs, "bodyLimit" option).
 *
 * On malformed JSON, `done(null, null)` — NOT an error — so a garbage body
 * never surfaces as a 4xx: the contract is "мусор → 204 без записи" (always
 * 204). `CspReportsController` treats a non-object/non-array body as nothing
 * to record.
 */
export const CSP_REPORT_BODY_LIMIT_BYTES = 32 * 1024
export const CSP_REPORT_CONTENT_TYPE = /^application\/(csp-report|reports\+json)\s*(;.*)?$/i

export function registerCspReportContentTypeParser(app: NestFastifyApplication): void {
  const fastifyInstance = app.getHttpAdapter().getInstance()
  // Explicit `<string>` type argument — the overload TS would otherwise pick
  // infers `rawBody: string | Buffer` from the `parseAs` conditional type
  // (a known TS limitation with this kind of conditional-type overload), even
  // though `parseAs: 'string'` at runtime always hands us a string.
  fastifyInstance.addContentTypeParser<string>(
    CSP_REPORT_CONTENT_TYPE,
    { parseAs: 'string', bodyLimit: CSP_REPORT_BODY_LIMIT_BYTES },
    (_request, rawBody, done) => {
      try {
        done(null, JSON.parse(rawBody))
      } catch {
        done(null, null)
      }
    },
  )
}
