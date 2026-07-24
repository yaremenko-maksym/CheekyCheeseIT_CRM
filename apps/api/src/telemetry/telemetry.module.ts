import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { TelemetryController } from './telemetry.controller'
import { TelemetryDigestController } from './telemetry-digest.controller'
import { TelemetryDigestTokenGuard } from './telemetry-digest-token.guard'
import { TelemetryDigestService } from './telemetry-digest.service'
import { TelemetryErrorsService } from './telemetry-errors.service'
import { TelemetryEventsService } from './telemetry-events.service'
import { TelemetryExceptionFilter } from './telemetry-exception.filter'
import { TelemetryRetentionCronService } from './telemetry-retention.cron'

/**
 * TelemetryModule — task-telemetry-api (T1).
 *
 * `ScheduleModule.forRoot()` is imported here for `TelemetryRetentionCronService`'s
 * `@Cron` — same pattern as `VacanciesModule` (`ScheduleModule.forRoot()` is
 * safe to call from multiple feature modules).
 *
 * `TelemetryExceptionFilter` is exported (not just provided) so `main.ts` can
 * resolve a fully-DI-wired instance via `app.get(TelemetryExceptionFilter)`
 * and register it globally with `app.useGlobalFilters()` — it needs
 * `TelemetryErrorsService` (DB access) + `HttpAdapterHost`, both DI-managed.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [TelemetryController, TelemetryDigestController],
  providers: [
    TelemetryErrorsService,
    TelemetryEventsService,
    TelemetryDigestService,
    TelemetryDigestTokenGuard,
    TelemetryExceptionFilter,
    TelemetryRetentionCronService,
  ],
  exports: [TelemetryErrorsService, TelemetryExceptionFilter],
})
export class TelemetryModule {}
