import { Module } from '@nestjs/common'
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
 * module is needed for that (same pattern those services already use for
 * `telemetry_errors`/`telemetry_events`, no separate "read" service).
 */
@Module({
  controllers: [CspReportsController],
  providers: [CspReportsService],
  exports: [CspReportsService],
})
export class CspReportsModule {}
