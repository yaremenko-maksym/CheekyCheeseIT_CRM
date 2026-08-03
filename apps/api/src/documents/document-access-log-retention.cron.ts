/**
 * DocumentAccessLogRetentionCronService — task-file-storage-hardening MED-5
 * (security-review round 1).
 *
 * `document_access_log` (§7) had no retention policy at all — an audit trail
 * that only ever grows is itself a data-lifetime gap the same task set out to
 * close everywhere else (§2 for resumes). No OTHER `*_audit_log` table in
 * this schema (user/team/project/transaction) has a retention cron either —
 * this is a new, project-local precedent for this table specifically, not a
 * regression relative to an established pattern.
 *
 * Retention window: 365 days. This is a REASONED DEFAULT, not an
 * owner-mandated figure — audit trails conventionally outlive the PII/access
 * event they describe (the row itself carries no PII beyond an actor id and
 * a category label, so the storage/exposure cost of a longer window is low),
 * and a year comfortably covers "who accessed this scan" investigations
 * opened well after the fact. Revisit if the owner wants a different window.
 *
 * Error handling mirrors VacanciesRetentionCronService / SalaryCronService:
 * the whole handler is wrapped in try/catch so an unexpected failure is
 * logged, not propagated as an unhandled rejection (which would silently
 * kill the scheduler).
 */
import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { lt } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { documentAccessLog } from '../database/schema'

/** Retention window — 365 days (task-file-storage-hardening MED-5). */
export const ACCESS_LOG_RETENTION_DAYS = 365
const RETENTION_MS = ACCESS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000

@Injectable()
export class DocumentAccessLogRetentionCronService {
  private readonly logger = new Logger(DocumentAccessLogRetentionCronService.name)

  constructor(private readonly db: DatabaseService) {}

  /** Runs daily at 03:30 — off-peak, staggered from the other 03:xx retention crons. */
  @Cron('30 3 * * *')
  async handleRetention(): Promise<void> {
    try {
      const deleted = await this.purgeExpiredEntries()
      this.logger.log(`Document access log retention: deleted ${deleted} row(s)`)
    } catch (err: unknown) {
      this.logger.error(
        'Document access log retention cron failed — will retry next cycle',
        err instanceof Error ? err.stack : String(err),
      )
      // Do NOT rethrow — an unhandled rejection in a @Cron handler silently
      // terminates the job scheduler.
    }
  }

  /**
   * Core purge logic, exposed directly for unit testing (and so the cron
   * entrypoint stays a thin try/catch wrapper). `now` is injectable so
   * boundary tests can pin an exact instant. Returns the number of rows
   * deleted. A plain DELETE is safe here (unlike the resume-file purge) —
   * this table has no external storage object to compensate for, only a DB
   * row.
   */
  async purgeExpiredEntries(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_MS)
    const deleted = await this.db.db
      .delete(documentAccessLog)
      .where(lt(documentAccessLog.createdAt, cutoff))
      .returning({ id: documentAccessLog.id })
    return deleted.length
  }
}
