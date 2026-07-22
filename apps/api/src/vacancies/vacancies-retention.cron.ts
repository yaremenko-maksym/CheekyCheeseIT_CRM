/**
 * VacanciesRetentionCronService — task-vacancies-api §6.
 *
 * Daily job that purges (row + R2 object) vacancy applications that are no
 * longer needed:
 *   - `status='REJECTED'` AND `created_at` older than 90 days
 *   - applications of a vacancy whose `closed_at` is older than 90 days
 *     (regardless of the application's own status)
 *
 * Error handling mirrors SalaryCronService: the whole handler is wrapped in
 * try/catch so an unexpected failure is logged, not propagated as an
 * unhandled rejection (which would silently kill the scheduler).
 *
 * Per-row ordering (sec MED-4 / F4): R2 delete happens FIRST, and the DB row
 * is only removed once that succeeds. The batched "delete DB rows first, R2
 * cleanup best-effort after" order this originally shipped with meant a
 * failed R2 delete left an orphan PII resume in R2 with NO remaining
 * reference to retry it — the DB row (the only thing driving "will retry
 * next run") was already gone. Inverting the order means a failed R2 delete
 * simply leaves that row in place; the next daily run picks it up again
 * (both `S3Service.delete` and this purge are idempotent).
 */
import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { and, eq, lt } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { S3Service } from '../documents/s3.service'
import { vacancies, vacancyApplications } from '../database/schema'

/** Retention window — 90 days (task §6). */
export const RETENTION_DAYS = 90
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000

interface PurgeCandidate {
  id: string
  resumeS3Key: string
}

@Injectable()
export class VacanciesRetentionCronService {
  private readonly logger = new Logger(VacanciesRetentionCronService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly s3: S3Service,
  ) {}

  /** Runs daily at 03:00 — off-peak, no user-facing traffic depends on it. */
  @Cron('0 3 * * *')
  async handleRetention(): Promise<void> {
    try {
      const deleted = await this.purgeExpiredApplications()
      this.logger.log(`Vacancies retention: deleted ${deleted} application(s)`)
    } catch (err: unknown) {
      this.logger.error(
        'Vacancies retention cron failed — will retry next cycle',
        err instanceof Error ? err.stack : String(err),
      )
      // Do NOT rethrow — an unhandled rejection in a @Cron handler silently
      // terminates the job scheduler (see SalaryCronService for the same rationale).
    }
  }

  /**
   * Core purge logic, exposed directly for unit/integration testing (and so
   * the cron entrypoint stays a thin try/catch wrapper). `now` is injectable
   * so boundary tests (89/90/91 days) can pin an exact instant.
   *
   * Returns the number of application rows deleted.
   */
  async purgeExpiredApplications(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_MS)

    const rejectedRows: PurgeCandidate[] = await this.db.db
      .select({ id: vacancyApplications.id, resumeS3Key: vacancyApplications.resumeS3Key })
      .from(vacancyApplications)
      .where(
        and(eq(vacancyApplications.status, 'REJECTED'), lt(vacancyApplications.createdAt, cutoff)),
      )

    // `closedAt < cutoff` naturally excludes NULL (still-open) vacancies —
    // SQL comparisons against NULL evaluate to NULL, not TRUE.
    const closedVacancyRows: PurgeCandidate[] = await this.db.db
      .select({ id: vacancyApplications.id, resumeS3Key: vacancyApplications.resumeS3Key })
      .from(vacancyApplications)
      .innerJoin(vacancies, eq(vacancyApplications.vacancyId, vacancies.id))
      .where(lt(vacancies.closedAt, cutoff))

    const candidates = new Map<string, PurgeCandidate>()
    for (const row of [...rejectedRows, ...closedVacancyRows]) candidates.set(row.id, row)

    if (candidates.size === 0) return 0

    // R2 delete FIRST (idempotent), THEN the DB row — per candidate, isolated.
    // If the R2 delete throws, this row's DB delete is skipped entirely: the
    // row stays and drives a retry on the next daily run instead of orphaning
    // an unreferenced PII resume in R2 (sec MED-4 / F4). A failure on one
    // candidate never blocks the rest of the batch.
    let deletedCount = 0
    for (const row of candidates.values()) {
      try {
        await this.s3.delete(row.resumeS3Key)
      } catch (err) {
        this.logger.warn(
          `Retention: R2 delete failed for applicationId=${row.id} — leaving DB row for next run: ${(err as Error).message}`,
        )
        continue
      }
      await this.db.db.delete(vacancyApplications).where(eq(vacancyApplications.id, row.id))
      deletedCount += 1
    }

    return deletedCount
  }
}
