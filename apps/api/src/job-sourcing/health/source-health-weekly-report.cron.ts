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
 * Shortcut: the manifest's `publishedAtMeaning: 'UPDATED'` exclusion is not applied (no such
 * manifest field exists yet); add it where the SQL below reads `published_at`.
 */
import { Inject, Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { sql, type SQL } from 'drizzle-orm'
import { NOTIFICATION_TITLES, type WeeklySourceRow } from '@crm/shared'
import { DatabaseService } from '../../database/database.service'
import { dbErrorLogSuffix, safeErrorStack } from '../../database/pg-errors'
import { NotificationsService } from '../../notifications/notifications.service'
import { activeAdminIds } from './active-admins'
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

/** The report covers the 7 days before `now`; `weekStart` is the Kyiv date it began on. */
export function weeklyWindow(now: Date): { from: Date; weekStart: string } {
  const from = new Date(now.getTime() - WEEK_MS)
  return { from, weekStart: kyivDate(from) }
}

/** One row of the aggregate query; node-postgres returns bigint sums as strings. */
export interface AggRow {
  name: string
  state: string | null
  transitions: string | number
  runs: string | number
  requests: string | number
  bytes: string | number
  p50: string | number | null
  p90: string | number | null
}

/** Rows of sources the detector pass has not classified yet are left out; the rest sort by name. */
export function toWeeklyRows(agg: readonly AggRow[]): WeeklySourceRow[] {
  const rows: WeeklySourceRow[] = []
  for (const raw of agg) {
    if (raw.state === null) continue
    rows.push({
      name: raw.name,
      state: raw.state as WeeklySourceRow['state'],
      transitions: Number(raw.transitions),
      runs: Number(raw.runs),
      freshnessP50Min: raw.p50 === null ? null : Number(raw.p50),
      freshnessP90Min: raw.p90 === null ? null : Number(raw.p90),
      requests: Number(raw.requests),
      bytes: Number(raw.bytes),
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The aggregate statement over `[from, now)`. Exported so a unit spec can pin it; its figures are
 * `source-health-weekly-report.integration.spec.ts` (hand-counted against a real Postgres).
 */
export function weeklyAggregateSql(from: Date, now: Date): SQL {
  const types = sql.join(
    REPORTING_TYPES.map((t) => sql`${t}`),
    sql`, `,
  )
  return sql`
    WITH src AS (
      SELECT id, type, namespace, coalesce(manifest_id, type::text) AS name
        FROM job_sources WHERE type IN (${types})),
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
    SELECT s.name AS name, cur.state AS state, coalesce(tr.transitions, 0) AS transitions,
           coalesce(run.runs, 0) AS runs, coalesce(run.requests, 0) AS requests,
           coalesce(run.bytes, 0) AS bytes, fresh.p50 AS p50, fresh.p90 AS p90
      FROM src s
      LEFT JOIN run ON run.source_id = s.id
      LEFT JOIN tr ON tr.source_id = s.id
      LEFT JOIN cur ON cur.source_id = s.id
      LEFT JOIN fresh ON fresh.source_id = s.id`
}

@Injectable()
export class SourceHealthWeeklyReportCron {
  private readonly logger = new Logger(SourceHealthWeeklyReportCron.name)

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
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
    const { from, weekStart } = weeklyWindow(now)
    const result = await this.database.db.execute(weeklyAggregateSql(from, now))
    const rows = toWeeklyRows(result.rows as unknown as AggRow[])
    if (rows.length === 0) return 0
    let sent = 0
    for (const userId of await activeAdminIds(this.database.db)) {
      const created = await this.notifications.create({
        userId,
        type: 'SOURCE_HEALTH_WEEKLY_REPORT',
        title: NOTIFICATION_TITLES.SOURCE_HEALTH_WEEKLY_REPORT,
        data: { weekStart, sources: rows },
        dedupeKey: `SOURCE_HEALTH_WEEKLY_REPORT:${weekStart}`,
      })
      if (created !== null) sent++
    }
    return sent
  }
}
