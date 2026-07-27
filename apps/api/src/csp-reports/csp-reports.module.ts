import { Module } from '@nestjs/common'
import { TelemetryModule } from '../telemetry/telemetry.module'
import { CspReportsController } from './csp-reports.controller'
import { CspReportsService } from './csp-reports.service'

/**
 * CspReportsModule — task-csp-reports-and-flip §Часть A.
 *
 * `DatabaseModule` is `@Global()` (see database.module.ts) — no explicit
 * import needed here, same as `TelemetryModule`. The digest
 * (`GET /api/telemetry/digest` `cspViolations` section) and the retention
 * cron query `csp_reports` DIRECTLY from `TelemetryDigestService`/
 * `TelemetryRetentionCronService` — no cross-module dependency on THIS
 * module is needed for THAT direction (same pattern those services already
 * use for `telemetry_errors`/`telemetry_events`, no separate "read"
 * service).
 *
 * `TelemetryModule` IS imported here (one-way, no cycle) — security round 1
 * (MED-3): `CspReportsController` records a write-failure into
 * `telemetry_errors` via the SAME `TelemetryErrorsService` instance
 * telemetry itself uses (that module `exports: [TelemetryErrorsService, ...]`),
 * rather than standing up a second, duplicate provider of it.
 */
@Module({
  imports: [TelemetryModule],
  controllers: [CspReportsController],
  providers: [CspReportsService],
  exports: [CspReportsService],
})
export class CspReportsModule {}
