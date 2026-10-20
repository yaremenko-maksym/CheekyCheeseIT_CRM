import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { sql } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { dbErrorLogSuffix, safeErrorStack } from '../database/pg-errors'

/**
 * The statement, exported so the unit spec can assert on the one place a retention
 * period could hide. Argument-free on purpose — see `purgeExpiredActions`.
 */
export const JOB_QUEUE_ACTION_PURGE_SQL =
  'SELECT public.crm_retention_purge_job_queue_actions() AS purged'

/**
 * JobQueueActionRetentionCronService — r5 Task 1.4a: the caller
 * `crm_retention_purge_job_queue_actions()` shipped without.
 *
 * PR #1026 shipped the end-of-retention path DELIBERATELY INERT: the function is
 * created, owned by `crm_retention_owner`, SECURITY DEFINER, pinned by the catalog
 * check, `EXECUTE` already granted to `crm_app` BY NAME — and nothing invoked it.
 * This service is the invocation, and it needs no privilege change: the API connects
 * as `crm_app`, the function runs as its owner, and the owner identity is what the
 * append-only trigger requires (`current_user = 'crm_retention_owner'`). Measured on
 * a scratch catalog by the integration sibling of this file rather than assumed.
 *
 * WHY ITS OWN SERVICE RATHER THAN A SECOND CALL IN `JobSourcingCronService`
 * (AC1 asks for the one-line justification): that handler's first act is an external
 * HTTP collection, and its single try/catch means a failure there — a dead feed, a
 * timeout, an exhausted budget — returns before any later statement in the same
 * handler runs. A statutory retention duty must not be skippable by a third party
 * being down, so it gets its own handler and its own slot. It also matches what the
 * codebase already does with every other retention duty
 * (`VacanciesRetentionCronService`, `TelemetryRetentionCronService`,
 * `DocumentAccessLogRetentionCronService`, `MeetingRecorderRetentionCronService`).
 *
 * Slot: 04:15 daily — inside the retention band (03:00 / 03:30 / 03:45 / 04:00)
 * that `JobSourcingCronService` documents itself as running AFTER, on a minute no
 * other cron holds, and before the 05:00 collection.
 *
 * Error handling is the shape every cron in this process shares: the handler body is
 * wrapped in try/catch and NEVER rethrows, because an unhandled rejection inside a
 * `@Cron` handler silently kills the scheduler for every OTHER cron in the process
 * (C-23). The failure mode that matters here is `42501` — were the EXECUTE grant ever
 * dropped, this job must log an incident and leave the scheduler alive, not take the
 * other retention jobs down with it.
 *
 * WHAT THIS SERVICE DOES NOT DO, so a later reader does not look for it:
 *   - it does not touch `crm_retention_redact_action_reason`. That half CANNOT RUN
 *     (`42501` under the shipped grant set) and must not be granted, because a
 *     redaction cannot append its legally required `REASON_REDACTED` evidence row
 *     until the enum value and the two CHECK branches land in
 *     `apps/api/src/database/schema/**`. The reasoning is written out in full in the
 *     header of `apps/api/drizzle/manual/2026-10-18_job_queue_append_only_triggers.sql`
 *     ("THE REDACTION HALF SHIPS UNCALLABLE") and is a settled question;
 *   - it keeps NO pre-purge counters. Owner decision, 2026-10-20 — see this PR's
 *     Assumptions. Deletion destroys aggregate counts by construction, so if a report
 *     ever needs per-month dismissal figures reaching back beyond two years, that
 *     counters table must be built BEFORE the first purge that would remove the rows
 *     it summarises.
 */
@Injectable()
export class JobQueueActionRetentionCronService {
  private readonly logger = new Logger(JobQueueActionRetentionCronService.name)

  constructor(private readonly db: DatabaseService) {}

  @Cron('15 4 * * *')
  async handleRetention(): Promise<void> {
    try {
      const purged = await this.purgeExpiredActions()
      // Logged unconditionally, including zero: this discharges a statutory duty, and
      // a silent success is indistinguishable from a job that never ran.
      this.logger.log(`Job queue action-log retention: purged ${purged} expired row(s)`)
    } catch (error: unknown) {
      this.logger.error(
        `Job queue action-log retention cron failed; will retry next cycle${dbErrorLogSuffix(error)}`,
        safeErrorStack(error),
      )
      // Do NOT rethrow — see the class doc comment (C-23).
    }
  }

  /**
   * Call the purge and return how many rows it deleted.
   *
   * NO RETENTION PERIOD IS PASSED, AND NONE IS DECLARED HERE. Two years, uniform
   * across every event kind, is a literal written in exactly two SQL bodies — the
   * append-only trigger and this function — and the catalog check pins BOTH by
   * `md5(pg_get_functiondef(...))` precisely so that there is one place to change it.
   * A TypeScript copy, even one merely passed as an argument, would defeat that
   * pinning: the two sides could then disagree with every checksum still matching.
   * The function therefore takes no argument, and this caller carries no constant.
   */
  async purgeExpiredActions(): Promise<number> {
    const result = await this.db.db.execute(sql.raw(JOB_QUEUE_ACTION_PURGE_SQL))
    const purged = (result.rows[0] as { purged?: string | number | null } | undefined)?.purged
    // `pg` hands a bigint back as a string; without Number() the logged count would
    // be a string and any later comparison lexicographic.
    return purged === null || purged === undefined ? 0 : Number(purged)
  }
}
