import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post } from '@nestjs/common'
import { reportErrorSchema, telemetryEventsBatchSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import {
  RelaxableThrottle,
  TELEMETRY_ERROR_LIMIT,
  TELEMETRY_EVENTS_LIMIT,
} from '../config/throttle-decorators'
import { TelemetryErrorsService } from './telemetry-errors.service'
import { TelemetryEventsService } from './telemetry-events.service'

/**
 * TelemetryController — /api/telemetry (authenticated employees only).
 *
 * JwtAuthGuard runs globally (AppModule APP_GUARD), so both handlers below
 * are ALREADY authenticated — no `@UseGuards` needed here. No `@Roles()`
 * either: ANY logged-in employee (any RBAC role) can report an error/event
 * about their own session.
 *
 * A SEPARATE class from `TelemetryDigestController` (the `@Public()` +
 * token-guarded digest route) — mixing public + guarded routes on one class
 * risks a copy-paste guard/decorator landing on the wrong handler (same
 * rationale as VacanciesController / PublicVacanciesController).
 *
 * Explicit `@Inject` on every dependency — same DI pattern as
 * VacanciesController (lets the real controller be instantiated by Nest's
 * DI in the vitest/esbuild test env, which strips `design:paramtypes`).
 */
@Controller('telemetry')
export class TelemetryController {
  private readonly logger = new Logger(TelemetryController.name)

  constructor(
    @Inject(TelemetryErrorsService) private readonly errorsService: TelemetryErrorsService,
    @Inject(TelemetryEventsService) private readonly eventsService: TelemetryEventsService,
  ) {}

  /**
   * POST /api/telemetry/errors — a real client-submitted error report
   * (source=WEB). Validation failures/DB failures propagate normally (400
   * via ZodExceptionFilter / 500 via TelemetryExceptionFilter, which itself
   * skips recording for `/api/telemetry/*` routes — recursion guard).
   */
  @Post('errors')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RelaxableThrottle(TELEMETRY_ERROR_LIMIT)
  async reportError(@CurrentUser() actor: SessionUser, @Body() body: unknown): Promise<void> {
    const dto = reportErrorSchema.parse(body)
    await this.errorsService.recordError({
      source: 'WEB',
      message: dto.message,
      stack: dto.stack,
      route: dto.route,
      userId: actor.id,
      userRole: actor.role,
      meta: dto.meta,
    })
  }

  /**
   * POST /api/telemetry/events — batch UX-event ingest, fire-and-forget.
   * Contract: "ЛЮБАЯ внутренняя ошибка — swallow+лог (fire-and-forget, UX не
   * ломаем)" — unlike `reportError`, EVERY failure here (including a
   * malformed payload) is caught and logged, never surfaced to the caller.
   * The 204 response is unconditional.
   */
  @Post('events')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RelaxableThrottle(TELEMETRY_EVENTS_LIMIT)
  async reportEvents(@CurrentUser() actor: SessionUser, @Body() body: unknown): Promise<void> {
    try {
      const dto = telemetryEventsBatchSchema.parse(body)
      await this.eventsService.recordBatch(dto.events, actor)
    } catch (err: unknown) {
      this.logger.warn(
        `telemetry events ingest failed (swallowed — fire-and-forget): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}
