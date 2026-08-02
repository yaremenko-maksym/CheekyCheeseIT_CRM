/**
 * VacanciesRetentionCronService — task-vacancies-api §6 (+ task-google-indexing-api §3
 * + task-file-storage-hardening §2).
 *
 * Daily job that purges vacancy applications / their resume files that are
 * no longer needed:
 *   - Row + R2 object: `status='REJECTED'` AND `created_at` older than 90 days
 *   - Row + R2 object: applications of a vacancy whose `closed_at` is older
 *     than 90 days (regardless of the application's own status)
 *   - R2 object ONLY (row survives): ANY application — any status, evergreen
 *     vacancy or not — older than 180 days (`purgeExpiredResumeFiles`, owner
 *     decision 2026-08-01). This is the rule that actually bounds candidate
 *     PII lifetime: without it, a NEW/VIEWED application on a vacancy that
 *     never closes kept its resume file + email + phone + cover letter
 *     forever. The application row itself stays (hiring-history value —
 *     "did we ever hear from this person" survives), only the file+size are
 *     scrubbed (`resumeS3Key`/`resumeSizeBytes` set to `null`).
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
 * (both `S3Service.deleteOrThrow` and this purge are idempotent).
 *
 * sec MED-1 (task-fix-pr-390-round3 / F1): this cron calls
 * `S3Service.deleteOrThrow`, NOT `S3Service.delete`. `delete()`'s contract is
 * "log and swallow — never throws" (see its own doc comment), which made the
 * try/catch below dead code and the F4 ordering fix above a no-op: the catch
 * branch could never be reached with the real service, so a failed R2 delete
 * was silently treated as success and the DB row was purged anyway — exactly
 * the orphan-PII bug F4 was meant to close. `deleteOrThrow` propagates
 * transport failures for real, so the catch below is now reachable.
 *
 * task-google-indexing-api §3: this class ALSO owns a second, unrelated
 * weekly job (`handleWeeklyIndexingRefresh`) that re-notifies Google of
 * every currently-PUBLISHED vacancy — sharing the class (rather than adding
 * a new one) mirrors how the task explicitly allows "existing
 * vacancies-retention.cron.ts (или отдельный cron-метод)"; NestJS supports
 * multiple `@Cron` methods per class, and both jobs are small/vacancies-
 * scoped enough that a second file would just be indirection.
 */
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import { and, eq, isNotNull, lt } from 'drizzle-orm'
import type { Env } from '../config/env'
import { DatabaseService } from '../database/database.service'
import { S3Service } from '../documents/s3.service'
import { vacancies, vacancyApplications } from '../database/schema'
import { careersUrl } from './careers-url'
import { GoogleIndexingService } from './google-indexing.service'

/** Retention window (full row + file) — 90 days (task §6). */
export const RETENTION_DAYS = 90
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000

/**
 * File-only retention window — 180 days (task-file-storage-hardening §2,
 * owner decision 2026-08-01). Applies to EVERY application regardless of
 * status/vacancy state — see `purgeExpiredResumeFiles`.
 */
export const FILE_RETENTION_DAYS = 180
const FILE_RETENTION_MS = FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000

interface PurgeCandidate {
  id: string
  // Nullable: `purgeExpiredApplications` — the FULL ROW purge — can still
  // match an application whose file was already cleared by the 180-day
  // file-only purge (§2) running on an earlier cycle; the row-level purge
  // deletes the row either way, it just has nothing left to delete in R2.
  resumeS3Key: string | null
}

@Injectable()
export class VacanciesRetentionCronService {
  private readonly logger = new Logger(VacanciesRetentionCronService.name)
  private readonly landingOrigin: string

  constructor(
    private readonly db: DatabaseService,
    private readonly s3: S3Service,
    private readonly googleIndexing: GoogleIndexingService,
    config: ConfigService<Env, true>,
  ) {
    this.landingOrigin = config.get('PUBLIC_LANDING_ORIGIN', { infer: true })
  }

  /** Runs daily at 03:00 — off-peak, no user-facing traffic depends on it. */
  @Cron('0 3 * * *')
  async handleRetention(): Promise<void> {
    try {
      const deleted = await this.purgeExpiredApplications()
      const filesPurged = await this.purgeExpiredResumeFiles()
      this.logger.log(
        `Vacancies retention: deleted ${deleted} application(s), purged ${filesPurged} expired resume file(s) (180-day rule)`,
      )
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
   * Runs weekly, Monday 04:00 — re-sends a Google Indexing `notifyUpdated`
   * for every currently-PUBLISHED vacancy. Keeps JobPosting freshness (Google
   * treats a stale-looking JobPosting as expiring) up to date even for
   * vacancies nobody has edited recently, and self-heals any single
   * publish-time notification that was missed (GoogleIndexingService's
   * no-retry, fail-soft contract means a transient failure at publish time
   * is otherwise silently dropped until this job runs).
   */
  @Cron('0 4 * * 1')
  async handleWeeklyIndexingRefresh(): Promise<void> {
    try {
      const count = await this.refreshPublishedIndexing()
      this.logger.log(`Weekly Google Indexing refresh: notified ${count} PUBLISHED vacancy(ies)`)
    } catch (err: unknown) {
      this.logger.error(
        'Weekly Google Indexing refresh failed — will retry next cycle',
        err instanceof Error ? err.stack : String(err),
      )
      // Do NOT rethrow — same rationale as handleRetention above.
    }
  }

  /**
   * Core weekly-refresh logic, exposed directly for unit testing (mirrors
   * `purgeExpiredApplications` above). Returns the number of PUBLISHED
   * vacancies notified.
   */
  async refreshPublishedIndexing(): Promise<number> {
    const rows = await this.db.db
      .select({ slug: vacancies.slug })
      .from(vacancies)
      .where(eq(vacancies.status, 'PUBLISHED'))

    for (const row of rows) {
      await this.googleIndexing.notifyUpdated(careersUrl(this.landingOrigin, row.slug))
    }
    return rows.length
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
    //
    // deleteOrThrow (NOT delete — sec MED-1 / F1, see file header): this is
    // the one call site in the codebase that needs the reject signal.
    let deletedCount = 0
    for (const row of candidates.values()) {
      // resumeS3Key can already be null here (the 180-day file-only purge,
      // below, ran on an earlier cycle) — nothing left in R2 to delete, go
      // straight to removing the row.
      if (row.resumeS3Key) {
        try {
          await this.s3.deleteOrThrow(row.resumeS3Key)
        } catch (err) {
          this.logger.warn(
            `Retention: R2 delete failed for applicationId=${row.id} — leaving DB row for next run: ${(err as Error).message}`,
          )
          continue
        }
      }
      await this.db.db.delete(vacancyApplications).where(eq(vacancyApplications.id, row.id))
      deletedCount += 1
    }

    return deletedCount
  }

  /**
   * File-only purge — task-file-storage-hardening §2 (owner decision
   * 2026-08-01). Unlike `purgeExpiredApplications` above, this rule does NOT
   * care about `status` or the parent vacancy's `closedAt` — ANY application
   * older than `FILE_RETENTION_DAYS` (180) loses its resume, full stop. This
   * is what actually bounds candidate PII lifetime: a NEW/VIEWED application
   * sitting on a vacancy that's still PUBLISHED never matches the 90-day
   * row-purge rule and would otherwise keep its file (plus email/phone/cover
   * letter on the surviving row) forever.
   *
   * The application ROW is intentionally kept — `remove()` (deleted by the
   * DB row) and the applicant's contact info retain hiring-history value
   * ("did this person ever apply") independent of whether the actual PDF is
   * still around; only `resumeS3Key`/`resumeSizeBytes` are cleared. Ordering
   * mirrors `purgeExpiredApplications`: R2 delete FIRST via the throwing
   * `deleteOrThrow`, DB update only after it succeeds — a failed R2 delete
   * leaves the row exactly as it was so the next daily run retries it,
   * instead of marking the file "gone" while it still sits in R2.
   *
   * Exposed directly for testing; `now` is injectable for boundary tests
   * (179/180/181 days). Returns the number of applications whose file was
   * purged.
   */
  async purgeExpiredResumeFiles(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - FILE_RETENTION_MS)

    const rows = await this.db.db
      .select({ id: vacancyApplications.id, resumeS3Key: vacancyApplications.resumeS3Key })
      .from(vacancyApplications)
      .where(
        and(lt(vacancyApplications.createdAt, cutoff), isNotNull(vacancyApplications.resumeS3Key)),
      )

    let purgedCount = 0
    for (const row of rows) {
      if (!row.resumeS3Key) continue // isNotNull() above already guarantees this, defensive only
      try {
        await this.s3.deleteOrThrow(row.resumeS3Key)
      } catch (err) {
        this.logger.warn(
          `Retention: R2 delete failed for applicationId=${row.id} (180-day file purge) — leaving for next run: ${(err as Error).message}`,
        )
        continue
      }
      await this.db.db
        .update(vacancyApplications)
        .set({ resumeS3Key: null, resumeSizeBytes: null })
        .where(eq(vacancyApplications.id, row.id))
      purgedCount += 1
    }

    return purgedCount
  }
}
