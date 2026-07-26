import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { cspReportToBodySchema, cspReportUriBodySchema } from '@crm/shared'
import { Public } from '../auth/public.decorator'
import { CSP_REPORT_LIMIT, RelaxableThrottle } from '../config/throttle-decorators'
import { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'
import {
  CSP_REPORT_ROUTE,
  CspReportsService,
  type RecordCspViolationInput,
} from './csp-reports.service'

/** Contract: "ориентир 60/час" — an hourly bucket (see throttle-decorators.ts). */
const CSP_REPORT_TTL_MS = 60 * 60 * 1000
/** Security round 1 (MED-3) — fixed message, see `recordIngestFailure`'s own doc comment. */
export const CSP_REPORT_WRITE_FAILURE_MESSAGE = 'csp-reports: write to csp_reports failed'

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
 * header that can carry a `; charset=...` suffix.
 *
 * КОНТРАКТ: the response is UNCONDITIONALLY 204 — a malformed/garbage body
 * (including a `.parse()` throw, or a body that failed to even JSON.parse in
 * `csp-report-content-type-parser.ts` and arrived here as `null`) is caught
 * and swallowed, never surfaced as a 4xx/5xx to the reporting browser — same
 * fire-and-forget rationale as `TelemetryController.reportEvents`.
 *
 * Security round 1 (MED-3): garbage input and a REAL write failure are now
 * DELIBERATELY handled by two SEPARATE branches, not one shared `catch`.
 * Both still respond 204 (the contract does not change), but only a write
 * failure is escalated to `telemetry_errors` — otherwise "0 violations"
 * (nothing recorded because the traffic was garbage — expected, any bot on
 * the internet can hit this endpoint) is indistinguishable from "0
 * violations" (nothing recorded because `csp_reports` writes are actually
 * broken — e.g. the DDL step in the OTHER PR didn't run). That distinction
 * matters specifically because the 03.08 enforcing decision is read off
 * this data (see `docs/superpowers/specs/...` runbook / task §"Отложено
 * сознательно").
 */
@Controller('public/csp-report')
export class CspReportsController {
  private readonly logger = new Logger(CspReportsController.name)

  constructor(
    @Inject(CspReportsService) private readonly service: CspReportsService,
    @Inject(TelemetryErrorsService) private readonly telemetryErrors: TelemetryErrorsService,
  ) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RelaxableThrottle(CSP_REPORT_LIMIT, CSP_REPORT_TTL_MS)
  async report(@Body() body: unknown, @Req() req: FastifyRequest): Promise<void> {
    const uaHeader = req.headers['user-agent']
    const userAgent = typeof uaHeader === 'string' ? uaHeader : null

    let inputs: RecordCspViolationInput[]
    try {
      inputs = this.parseBody(body, userAgent)
    } catch (err: unknown) {
      // Garbage/malformed input — EXPECTED noise on a public endpoint (any
      // browser or bot can send anything). `.debug`, not `.warn`/`.error` —
      // this must never look like an ingestion failure in the logs.
      this.logger.debug(
        `csp report input rejected (garbage — swallowed, contract is unconditional 204): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return
    }

    for (const input of inputs) {
      try {
        await this.service.recordViolation(input)
      } catch (err: unknown) {
        await this.recordIngestFailure(err)
      }
    }
  }

  /**
   * Pure parse/shape step — throws on a malformed body (Zod `.parse()`), so
   * the caller can cleanly separate "garbage input" from "write failure"
   * (see the class doc comment). Returns one `RecordCspViolationInput` per
   * well-formed report; an EMPTY array is a valid, non-error result (e.g. a
   * `reports+json` batch with zero `csp-violation` entries, or a
   * `csp-report` body missing the `"csp-report"` key) — not garbage, just
   * nothing to record.
   */
  private parseBody(body: unknown, userAgent: string | null): RecordCspViolationInput[] {
    if (Array.isArray(body)) {
      // application/reports+json — Reporting API batch.
      const items = cspReportToBodySchema.parse(body)
      const inputs: RecordCspViolationInput[] = []
      for (const item of items) {
        if (item.type !== 'csp-violation' || !item.body) continue
        inputs.push({
          effectiveDirective: item.body.effectiveDirective,
          blockedUri: item.body.blockedURL,
          documentUri: item.body.documentURL,
          disposition: item.body.disposition,
          userAgent,
        })
      }
      return inputs
    }

    // application/csp-report — CSP Level 2 report-uri.
    const parsed = cspReportUriBodySchema.parse(body)
    const report = parsed['csp-report']
    if (!report) return []
    return [
      {
        effectiveDirective: report['effective-directive'],
        violatedDirective: report['violated-directive'],
        blockedUri: report['blocked-uri'],
        documentUri: report['document-uri'],
        disposition: report.disposition,
        userAgent,
      },
    ]
  }

  /**
   * A REAL failure writing a WELL-FORMED report (DB down, `csp_reports`
   * table missing — the DDL step lives in a DIFFERENT PR, see the manual
   * migration file's own doc comment) — recorded to `telemetry_errors` so
   * it is visible in the SAME digest that reports CSP violations, making
   * "0 violations" (quiet) vs "ingestion broken" (an error entry) visible
   * at a glance. The `message` is a FIXED string, NEVER the report payload:
   * `telemetry_errors.message` feeds both the fingerprint AND the public
   * digest, so an attacker-controlled message would open a SECOND
   * unbounded-cardinality channel — the exact class of bug HIGH-1 closed
   * for `csp_reports` itself.
   */
  private async recordIngestFailure(err: unknown): Promise<void> {
    this.logger.error(
      'csp report write failed (swallowed at the HTTP layer — contract is unconditional 204; recorded to telemetry_errors so this is distinguishable from "no violations")',
      err instanceof Error ? err.stack : String(err),
    )
    try {
      await this.telemetryErrors.recordError({
        source: 'API',
        message: CSP_REPORT_WRITE_FAILURE_MESSAGE,
        route: CSP_REPORT_ROUTE,
      })
    } catch {
      // Best-effort — if telemetry_errors itself is unwritable there is
      // nothing further to do; the error{} above already reached the logs.
    }
  }
}
