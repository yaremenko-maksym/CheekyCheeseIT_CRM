import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { asc, inArray, lt, sql } from 'drizzle-orm'
import { CSP_REPORTS_ROW_CAP } from '../csp-reports/csp-reports.service'
import { DatabaseService } from '../database/database.service'
import { cspReports, telemetryErrors, telemetryEvents } from '../database/schema'

/**
 * TelemetryRetentionCronService — task-telemetry-api contract
 * ("Retention cron ... ежесуточно, fail-loud лог количеств"), mirrors
 * `VacanciesRetentionCronService`'s error-handling pattern (outer try/catch,
 * never rethrow from the `@Cron` handler — an unhandled rejection there
 * would silently kill the scheduler for every OTHER cron in the process).
 *
 * Three independent cleanup rules:
 *   - `telemetry_events` older than `EVENTS_RETENTION_DAYS` (90) — deleted.
 *   - `telemetry_errors` with `last_seen` older than `ERRORS_RETENTION_DAYS`
 *     (180) — deleted REGARDLESS OF STATUS (not-repeated-in-6-months is
 *     stale, whether or not it was ever RESOLVED).
 *   - `telemetry_events` row-count safety cap (`EVENTS_ROW_CAP`, 1M) — a
 *     defensive backstop on top of the age-based delete, in case of a
 *     sudden event-volume spike; runs AFTER the age-based delete so it only
 *     ever does extra work when the normal 90-day window isn't enough.
 *   - `csp_reports` row-count safety cap (`CSP_REPORTS_ROW_CAP`, 10 000 —
 *     security round 1 HIGH-1a) — same backstop shape as
 *     `enforceEventsCap`, but the PRIMARY defense against unbounded growth
 *     of THIS table is the insert-time budget check in
 *     `CspReportsService.recordViolation` (HIGH-1b): this daily sweep alone
 *     would leave a full day of flood unprotected between runs, so it is a
 *     backstop on top of the insert-time check, not a replacement for it.
 *     Eviction order is `last_seen` ASCENDING (least-recently-seen first) —
 *     the SAME column the age-based delete above already cuts on, so a row
 *     evicted here is one that was already close to aging out naturally.
 *
 * AC7 requires the 89/90/91 + 179/180/181-day BOUNDARY to be unit-tested
 * (not integration, unlike vacancies' equivalent) — `cutoffDate()` is the
 * exact formula `deleteEventsOlderThan`/`deleteErrorsOlderThan` feed into
 * their `lt()` predicate, so a pure unit test of `cutoffDate()` pins the
 * real boundary without needing a live Postgres.
 *
 * task-csp-reports-and-flip §Часть A item 5 ("Ретеншн: 90 дней, через
 * существующий retention-крон"): a fourth cleanup rule reuses this SAME
 * cron/class rather than a new one — `csp_reports` rows with `last_seen`
 * older than `CSP_REPORTS_RETENTION_DAYS` are deleted, same
 * cutoffDate()/`lt()` idiom as the other two age-based rules above.
 */

export const EVENTS_RETENTION_DAYS = 90
export const ERRORS_RETENTION_DAYS = 180
/** task-csp-reports-and-flip §Часть A item 5: "Ретеншн: 90 дней" — same window as telemetry_events. */
export const CSP_REPORTS_RETENTION_DAYS = 90
/** Contract: "если telemetry_events превысила 1 млн строк → удалять старейшие сверх капа". */
export const EVENTS_ROW_CAP = 1_000_000

const DAY_MS = 24 * 60 * 60 * 1000

/** Exported for direct boundary unit-testing — see `telemetry-retention.cron.spec.ts`. */
export function cutoffDate(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS)
}

export interface PurgeResult {
  eventsDeletedByAge: number
  eventsDeletedByCap: number
  eventsDeleted: number
  errorsDeleted: number
  cspReportsDeletedByAge: number
  cspReportsDeletedByCap: number
  cspReportsDeleted: number
}

@Injectable()
export class TelemetryRetentionCronService {
  private readonly logger = new Logger(TelemetryRetentionCronService.name)

  constructor(private readonly db: DatabaseService) {}

  /**
   * Runs daily at 03:30 — deliberately 30 min after `VacanciesRetentionCronService`'s
   * 03:00 slot (both off-peak, no user-facing traffic depends on either; staggered
   * so two unrelated retention jobs don't contend for the same DB connections).
   */
  @Cron('30 3 * * *')
  async handleRetention(): Promise<void> {
    try {
      const result = await this.purgeExpired()
      this.logger.log(
        `Telemetry retention: events deleted=${result.eventsDeleted} (age=${result.eventsDeletedByAge}, cap=${result.eventsDeletedByCap}), errors deleted=${result.errorsDeleted}, csp reports deleted=${result.cspReportsDeleted} (age=${result.cspReportsDeletedByAge}, cap=${result.cspReportsDeletedByCap})`,
      )
    } catch (err: unknown) {
      this.logger.error(
        'Telemetry retention cron failed — will retry next cycle',
        err instanceof Error ? err.stack : String(err),
      )
      // Do NOT rethrow — an unhandled rejection in a @Cron handler silently
      // terminates the job scheduler (same rationale as VacanciesRetentionCronService).
    }
  }

  /** Core purge logic, exposed directly for unit testing (mirrors the vacancies cron's own pattern). */
  async purgeExpired(now: Date = new Date()): Promise<PurgeResult> {
    const eventsDeletedByAge = await this.deleteEventsOlderThan(
      cutoffDate(now, EVENTS_RETENTION_DAYS),
    )
    const errorsDeleted = await this.deleteErrorsOlderThan(cutoffDate(now, ERRORS_RETENTION_DAYS))
    const cspReportsDeletedByAge = await this.deleteCspReportsOlderThan(
      cutoffDate(now, CSP_REPORTS_RETENTION_DAYS),
    )
    const eventsDeletedByCap = await this.enforceEventsCap()
    const cspReportsDeletedByCap = await this.enforceCspReportsCap()

    return {
      eventsDeletedByAge,
      eventsDeletedByCap,
      eventsDeleted: eventsDeletedByAge + eventsDeletedByCap,
      errorsDeleted,
      cspReportsDeletedByAge,
      cspReportsDeletedByCap,
      cspReportsDeleted: cspReportsDeletedByAge + cspReportsDeletedByCap,
    }
  }

  async deleteEventsOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db.db
      .delete(telemetryEvents)
      .where(lt(telemetryEvents.createdAt, cutoff))
      .returning({ id: telemetryEvents.id })
    return deleted.length
  }

  async deleteErrorsOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db.db
      .delete(telemetryErrors)
      .where(lt(telemetryErrors.lastSeen, cutoff))
      .returning({ id: telemetryErrors.id })
    return deleted.length
  }

  /** task-csp-reports-and-flip §Часть A item 5 — same `last_seen`-based cutoff idiom as `deleteErrorsOlderThan`. */
  async deleteCspReportsOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db.db
      .delete(cspReports)
      .where(lt(cspReports.lastSeen, cutoff))
      .returning({ id: cspReports.id })
    return deleted.length
  }

  /**
   * Defensive row-count cap — runs AFTER the age-based delete above. Deletes
   * the oldest rows beyond `EVENTS_ROW_CAP`, oldest-first (a spike-protection
   * backstop, not the primary retention mechanism).
   */
  async enforceEventsCap(): Promise<number> {
    const [row] = await this.db.db
      .select({ count: sql<number>`count(*)::int` })
      .from(telemetryEvents)
    const total = row?.count ?? 0
    if (total <= EVENTS_ROW_CAP) return 0

    const excess = total - EVENTS_ROW_CAP
    const oldest = await this.db.db
      .select({ id: telemetryEvents.id })
      .from(telemetryEvents)
      .orderBy(asc(telemetryEvents.createdAt))
      .limit(excess)
    if (oldest.length === 0) return 0

    await this.db.db.delete(telemetryEvents).where(
      inArray(
        telemetryEvents.id,
        oldest.map((r) => r.id),
      ),
    )
    return oldest.length
  }

  /**
   * Security round 1 (HIGH-1a) — defensive row-count cap for `csp_reports`,
   * same shape as `enforceEventsCap` above but ordered by `last_seen`
   * ascending (least-recently-seen first — see the class doc comment for
   * why). This is the DAILY backstop; the insert-time budget check in
   * `CspReportsService.recordViolation` (HIGH-1b) is the primary defense
   * and is what actually stops growth WITHIN a single day.
   */
  async enforceCspReportsCap(): Promise<number> {
    const [row] = await this.db.db.select({ count: sql<number>`count(*)::int` }).from(cspReports)
    const total = row?.count ?? 0
    if (total <= CSP_REPORTS_ROW_CAP) return 0

    const excess = total - CSP_REPORTS_ROW_CAP
    const oldest = await this.db.db
      .select({ id: cspReports.id })
      .from(cspReports)
      .orderBy(asc(cspReports.lastSeen))
      .limit(excess)
    if (oldest.length === 0) return 0

    await this.db.db.delete(cspReports).where(
      inArray(
        cspReports.id,
        oldest.map((r) => r.id),
      ),
    )
    return oldest.length
  }
}
