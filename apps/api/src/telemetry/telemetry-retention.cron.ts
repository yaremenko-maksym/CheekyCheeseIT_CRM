import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { asc, inArray, lt, sql } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { telemetryErrors, telemetryEvents } from '../database/schema'

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
 *
 * AC7 requires the 89/90/91 + 179/180/181-day BOUNDARY to be unit-tested
 * (not integration, unlike vacancies' equivalent) — `cutoffDate()` is the
 * exact formula `deleteEventsOlderThan`/`deleteErrorsOlderThan` feed into
 * their `lt()` predicate, so a pure unit test of `cutoffDate()` pins the
 * real boundary without needing a live Postgres.
 */

export const EVENTS_RETENTION_DAYS = 90
export const ERRORS_RETENTION_DAYS = 180
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
        `Telemetry retention: events deleted=${result.eventsDeleted} (age=${result.eventsDeletedByAge}, cap=${result.eventsDeletedByCap}), errors deleted=${result.errorsDeleted}`,
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
    const eventsDeletedByCap = await this.enforceEventsCap()

    return {
      eventsDeletedByAge,
      eventsDeletedByCap,
      eventsDeleted: eventsDeletedByAge + eventsDeletedByCap,
      errorsDeleted,
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
}
