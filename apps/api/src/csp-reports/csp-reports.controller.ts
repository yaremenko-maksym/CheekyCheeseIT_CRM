import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { cspReportToBodySchema, cspReportUriBodySchema } from '@crm/shared'
import { Public } from '../auth/public.decorator'
import { CSP_REPORT_LIMIT, RelaxableThrottle } from '../config/throttle-decorators'
import { CspReportsService } from './csp-reports.service'

/** Contract: "ориентир 60/час" — an hourly bucket (see throttle-decorators.ts). */
const CSP_REPORT_TTL_MS = 60 * 60 * 1000

/**
 * CspReportsController — `POST /api/public/csp-report` (task-csp-reports-and-
 * flip КОНТРАКТ). PUBLIC, unauthenticated — browsers submit these natively,
 * with no session — `@Public()` opts out of the globally registered
 * `JwtAuthGuard`, same pattern as `PublicVacanciesController`.
 *
 * Body-shape dispatch is by JS TYPE (`Array.isArray`), NOT the Content-Type
 * header string: `application/reports+json` (report-to) is ALWAYS a JSON
 * array; `application/csp-report` (report-uri) is ALWAYS a
 * `{ "csp-report": {...} }` object. This is more robust than re-parsing a
 * header that can carry a `; charset=...` suffix, and both branches funnel
 * into the SAME outer try/catch below.
 *
 * КОНТРАКТ: the response is UNCONDITIONALLY 204 — a malformed/garbage body
 * (including a `.parse()` throw, or a body that failed to even JSON.parse in
 * `csp-report-content-type-parser.ts` and arrived here as `null`) is caught
 * and swallowed, never surfaced as a 4xx/5xx to the reporting browser — same
 * fire-and-forget rationale as `TelemetryController.reportEvents`.
 */
@Controller('public/csp-report')
export class CspReportsController {
  private readonly logger = new Logger(CspReportsController.name)

  constructor(@Inject(CspReportsService) private readonly service: CspReportsService) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RelaxableThrottle(CSP_REPORT_LIMIT, CSP_REPORT_TTL_MS)
  async report(@Body() body: unknown, @Req() req: FastifyRequest): Promise<void> {
    try {
      const uaHeader = req.headers['user-agent']
      const userAgent = typeof uaHeader === 'string' ? uaHeader : null

      if (Array.isArray(body)) {
        // application/reports+json — Reporting API batch.
        const items = cspReportToBodySchema.parse(body)
        for (const item of items) {
          if (item.type !== 'csp-violation' || !item.body) continue
          await this.service.recordViolation({
            effectiveDirective: item.body.effectiveDirective,
            blockedUri: item.body.blockedURL,
            documentUri: item.body.documentURL,
            disposition: item.body.disposition,
            userAgent,
          })
        }
        return
      }

      // application/csp-report — CSP Level 2 report-uri.
      const parsed = cspReportUriBodySchema.parse(body)
      const report = parsed['csp-report']
      if (!report) return
      await this.service.recordViolation({
        effectiveDirective: report['effective-directive'],
        violatedDirective: report['violated-directive'],
        blockedUri: report['blocked-uri'],
        documentUri: report['document-uri'],
        disposition: report.disposition,
        userAgent,
      })
    } catch (err: unknown) {
      this.logger.warn(
        `csp report ingest failed (swallowed — contract is unconditional 204): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}
