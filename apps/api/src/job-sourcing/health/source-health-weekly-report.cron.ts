/**
 * Source-fetch-strategy U5a — the Monday ADMIN report (ADR 2026-10-25 section 11).
 *
 * Monday 09:00 `Europe/Kyiv`, per reporting source over the trailing 7 days: the current state, the
 * transitions of the week, runs, freshness (median and 90th percentile) and request / byte totals.
 * One notification per active ADMIN (its email goes through the existing outbox).
 *
 * The scheduler is the project's `@nestjs/schedule` `@Cron` (like `JobSourcingCronService`), never
 * rethrowing: an unhandled rejection in a `@Cron` handler would silence every other cron in the
 * process. Two replicas firing one Monday share the dedupe key (`SOURCE_HEALTH_WEEKLY_REPORT:<Kyiv
 * date of the window start>`), so the second finds the rows already there.
 *
 * Freshness is `first_seen_at - published_at` of the first revision of each record first seen in
 * the window, EXCLUDING records first seen in the source's first run (the backlog, not news) —
 * ADR section 9. A source with no such record reports "not measurable" (null), not a number.
 */
import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { NOTIFICATION_TITLES, type WeeklySourceRow } from '@crm/shared'
import { DatabaseService } from '../../database/database.service'
import { dbErrorLogSuffix, safeErrorStack } from '../../database/pg-errors'
import { jobSources, users } from '../../database/schema'
import { NotificationsService } from '../../notifications/notifications.service'
import { REPORTING_TYPES } from './reporting-types'

/** Mondays at 09:00. */
export const WEEKLY_REPORT_CRON = '0 9 * * 1'
const TIME_ZONE = 'Europe/Kyiv'
const WEEK_MS = 7 * 86_400_000

const KYIV_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE })

/** `YYYY-MM-DD` of an instant on the Kyiv calendar. */
export function kyivDate(at: Date): string {
  return KYIV_DATE.format(at)
}

interface AggRow {
  source_id: string
  runs: string | number
  requests: string | number
  bytes: string | number
  transitions: string | number
  state: string | null
  p50: string | number | null
  p90: string | number | null
}

const num = (v: string | number | null): number => (v === null ? 0 : Number(v))
const numOrNull = (v: string | number | null): number | null => (v === null ? null : Number(v))

@Injectable()
export class SourceHealthWeeklyReportCron {
  private readonly logger = new Logger(SourceHealthWeeklyReportCron.name)

  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(WEEKLY_REPORT_CRON, { timeZone: TIME_ZONE })
  async handleWeeklyReport(): Promise<void> {
    try {
      const sent = await this.run(new Date())
      this.logger.log(`source health weekly report: ${sent} notification(s)`)
    } catch (err: unknown) {
      // Do NOT rethrow — see the file doc.
      this.logger.error(
        `source health weekly report failed${dbErrorLogSuffix(err)}`,
        safeErrorStack(err),
      )
    }
  }

  /** Builds the report for the 7 days before `now` and enqueues it for every active ADMIN. */
  async run(now: Date): Promise<number> {
    const rows = await this.buildRows(now)
    if (rows.length === 0) return 0
    const weekStart = kyivDate(new Date(now.getTime() - WEEK_MS))
    const admins = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'ADMIN'), isNull(users.archivedAt)))
    let sent = 0
    for (const admin of admins) {
      const created = await this.notifications.create({
        userId: admin.id,
        type: 'SOURCE_HEALTH_WEEKLY_REPORT',
        title: NOTIFICATION_TITLES.SOURCE_HEALTH_WEEKLY_REPORT,
        data: { weekStart, sources: rows },
        dedupeKey: `SOURCE_HEALTH_WEEKLY_REPORT:${weekStart}`,
      })
      if (created !== null) sent++
    }
    return sent
  }

  /** One row per reporting source that the detector pass has classified at least once. */
  private async buildRows(now: Date): Promise<WeeklySourceRow[]> {
    const db = this.database.db
    const from = new Date(now.getTime() - WEEK_MS)
    const sources = await db
      .select({ id: jobSources.id, type: jobSources.type, manifestId: jobSources.manifestId })
      .from(jobSources)
      .where(inArray(jobSources.type, REPORTING_TYPES))
    if (sources.length === 0) return []
    const ids = sources.map((s) => s.id)

    const result = await db.execute(sql`
      WITH src AS (SELECT id, type, namespace FROM job_sources WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})),
      run AS (
        SELECT source_id, count(*) AS runs,
               coalesce(sum(request_count), 0) AS requests, coalesce(sum(bytes_read), 0) AS bytes
          FROM job_collection_runs
         WHERE started_at >= ${from} AND started_at < ${now}
         GROUP BY source_id),
      tr AS (
        SELECT source_id, count(*) AS transitions
          FROM job_source_health_events
         WHERE kind = 'TRANSITION' AND at >= ${from} AND at < ${now}
         GROUP BY source_id),
      cur AS (
        SELECT DISTINCT ON (source_id) source_id, to_state AS state
          FROM job_source_health_events WHERE kind = 'TRANSITION'
         ORDER BY source_id, at DESC),
      fresh AS (
        SELECT s.id AS source_id,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY m))::int AS p50,
               round(percentile_cont(0.9) WITHIN GROUP (ORDER BY m))::int AS p90
          FROM src s
          JOIN job_source_records r ON r.source_type = s.type AND r.namespace = coalesce(s.namespace, '')
          JOIN LATERAL (
            SELECT published_at FROM job_source_record_revisions v
             WHERE v.source_record_id = r.id ORDER BY v.received_seq ASC LIMIT 1) first_rev ON true
          CROSS JOIN LATERAL (
            SELECT greatest(0, extract(epoch FROM (r.first_seen_at - first_rev.published_at)) / 60) AS m) calc
         WHERE r.first_seen_at >= ${from} AND r.first_seen_at < ${now}
           AND first_rev.published_at IS NOT NULL
           AND r.first_seen_at > coalesce(
                 (SELECT min(ended_at) FROM job_collection_runs WHERE source_id = s.id), 'infinity'::timestamptz)
         GROUP BY s.id)
      SELECT s.id AS source_id, coalesce(run.runs, 0) AS runs, coalesce(run.requests, 0) AS requests,
             coalesce(run.bytes, 0) AS bytes, coalesce(tr.transitions, 0) AS transitions,
             cur.state AS state, fresh.p50 AS p50, fresh.p90 AS p90
        FROM src s
        LEFT JOIN run ON run.source_id = s.id
        LEFT JOIN tr ON tr.source_id = s.id
        LEFT JOIN cur ON cur.source_id = s.id
        LEFT JOIN fresh ON fresh.source_id = s.id`)

    const byId = new Map(sources.map((s) => [s.id, s]))
    const rows: WeeklySourceRow[] = []
    for (const raw of result.rows as unknown as AggRow[]) {
      const source = byId.get(raw.source_id)
      // Never classified yet: no state to report.
      if (source === undefined || raw.state === null) continue
      rows.push({
        name: source.manifestId ?? source.type,
        state: raw.state as WeeklySourceRow['state'],
        transitions: num(raw.transitions),
        runs: num(raw.runs),
        freshnessP50Min: numOrNull(raw.p50),
        freshnessP90Min: numOrNull(raw.p90),
        requests: num(raw.requests),
        bytes: num(raw.bytes),
      })
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  }
}
