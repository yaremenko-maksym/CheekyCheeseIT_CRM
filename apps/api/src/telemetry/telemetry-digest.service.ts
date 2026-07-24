import { Injectable, Logger } from '@nestjs/common'
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import type {
  TelemetryErrorItem,
  TelemetryFeatureClick,
  TelemetryFormAbandonRate,
  TelemetryMedianDuration,
  TelemetryTopRoute,
  TelemetryUxAggregates,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { telemetryErrors, telemetryEvents } from '../database/schema'

/** Contract: "ux? {... — за 7 дней}" — fixed 7-day rolling window, independent of `since`. */
export const UX_WINDOW_DAYS = 7
/** Caps the size of each UX aggregate array — a digest is a summary, not a full dump. */
export const TOP_ROUTES_LIMIT = 20
export const FEATURE_CLICKS_LIMIT = 20

type TelemetryErrorRow = typeof telemetryErrors.$inferSelect

export interface GetDigestParams {
  since: Date
  includeUx: boolean
}

/**
 * TelemetryDigestService — task-telemetry-api contract for `GET
 * /api/telemetry/digest`.
 *
 * Errors: returns every currently-`NEW` error with `last_seen >= since`
 * (`NEW` already covers first-time errors AND regressions — a RESOLVED
 * error reoccurring is flipped back to NEW by `TelemetryErrorsService.
 * recordError`), then flips them to `NOTIFIED`. AC5 idempotency falls
 * naturally out of the status filter: a repeat call with the same `since`
 * finds nothing (those rows are no longer `status='NEW'`) — `since` is a
 * defensive lower bound on top of that, not the sole idempotency mechanism.
 *
 * UX aggregates (only computed when `includeUx` — the `ux=1` query flag):
 * ALWAYS a fixed trailing 7-day window, independent of `since`.
 */
@Injectable()
export class TelemetryDigestService {
  private readonly logger = new Logger(TelemetryDigestService.name)

  constructor(private readonly db: DatabaseService) {}

  async getDigest(params: GetDigestParams): Promise<{
    errors: TelemetryErrorItem[]
    ux?: TelemetryUxAggregates
  }> {
    const errors = await this.fetchAndNotifyNewErrors(params.since)
    if (!params.includeUx) {
      return { errors }
    }
    const ux = await this.getUxAggregates()
    return { errors, ux }
  }

  /**
   * Selects every `status='NEW'` error with `last_seen >= since`, maps them
   * to the wire shape, THEN marks them `NOTIFIED` (guarded by
   * `status='NEW'` again in the UPDATE's WHERE — a concurrent second digest
   * call racing this one can only notify each row once).
   */
  async fetchAndNotifyNewErrors(since: Date): Promise<TelemetryErrorItem[]> {
    const rows = await this.db.db
      .select()
      .from(telemetryErrors)
      .where(and(eq(telemetryErrors.status, 'NEW'), gte(telemetryErrors.lastSeen, since)))
      .orderBy(asc(telemetryErrors.lastSeen))

    if (rows.length === 0) return []

    const ids = rows.map((row) => row.id)
    await this.db.db
      .update(telemetryErrors)
      .set({ status: 'NOTIFIED' })
      .where(and(inArray(telemetryErrors.id, ids), eq(telemetryErrors.status, 'NEW')))

    this.logger.log(`telemetry digest: ${rows.length} new/regressed error(s) notified`)
    return rows.map((row) => this.mapErrorRow(row))
  }

  private mapErrorRow(row: TelemetryErrorRow): TelemetryErrorItem {
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      source: row.source,
      message: row.message,
      stack: row.stack,
      route: row.route,
      userId: row.userId,
      userRole: row.userRole,
      meta: (row.meta ?? {}) as Record<string, unknown>,
      count: row.count,
      firstSeen: row.firstSeen.toISOString(),
      lastSeen: row.lastSeen.toISOString(),
      // Reported as the status BEFORE this call's own NOTIFIED transition —
      // 'NEW' is what the digest consumer actually cares about (it IS new).
      status: 'NEW',
      githubIssueNumber: row.githubIssueNumber,
    }
  }

  /** Fixed trailing `UX_WINDOW_DAYS`-day window, computed against `now` (injectable for tests). */
  async getUxAggregates(now: Date = new Date()): Promise<TelemetryUxAggregates> {
    const windowStart = new Date(now.getTime() - UX_WINDOW_DAYS * 24 * 60 * 60 * 1000)

    const [topRoutesByRole, featureClicks, formAbandonRates, medianDurations] = await Promise.all([
      this.getTopRoutesByRole(windowStart),
      this.getFeatureClicks(windowStart),
      this.getFormAbandonRates(windowStart),
      this.getMedianDurations(windowStart),
    ])

    return { topRoutesByRole, featureClicks, formAbandonRates, medianDurations }
  }

  /**
   * One row per (role, route) — `visits` counts `route_enter` events;
   * `medianDurationMs` is the median `route_leave` duration for that SAME
   * (role, route) pair, via a `FILTER` clause (single pass, single query —
   * no separate join needed since both event types share the row set).
   */
  private async getTopRoutesByRole(windowStart: Date): Promise<TelemetryTopRoute[]> {
    const rows = await this.db.db
      .select({
        role: telemetryEvents.userRole,
        route: telemetryEvents.route,
        visits: sql<number>`count(*) filter (where ${telemetryEvents.event} = 'route_enter')::int`,
        medianDurationMs: sql<
          number | null
        >`percentile_cont(0.5) within group (order by ${telemetryEvents.durationMs}) filter (where ${telemetryEvents.event} = 'route_leave')::int`,
      })
      .from(telemetryEvents)
      .where(gte(telemetryEvents.createdAt, windowStart))
      .groupBy(telemetryEvents.userRole, telemetryEvents.route)
      .orderBy(desc(sql`count(*) filter (where ${telemetryEvents.event} = 'route_enter')`))
      .limit(TOP_ROUTES_LIMIT)

    // Drop (role, route) pairs with zero route_enter (e.g. only route_leave
    // fired within the window, a boundary artefact — not a real "top route").
    return rows
      .filter((row) => row.visits > 0)
      .map((row) => ({
        role: row.role,
        route: row.route,
        visits: row.visits,
        medianDurationMs: row.medianDurationMs,
      }))
  }

  private async getFeatureClicks(windowStart: Date): Promise<TelemetryFeatureClick[]> {
    const rows = await this.db.db
      .select({
        target: telemetryEvents.target,
        count: sql<number>`count(*)::int`,
      })
      .from(telemetryEvents)
      .where(
        and(
          gte(telemetryEvents.createdAt, windowStart),
          eq(telemetryEvents.event, 'feature_click'),
        ),
      )
      .groupBy(telemetryEvents.target)
      .orderBy(desc(sql`count(*)`))
      .limit(FEATURE_CLICKS_LIMIT)

    // `target` is nullable in the schema (contract: "target text NULL") —
    // a feature_click event SHOULD always carry one, but defensively drop
    // any row where it's missing rather than surface a `null` target.
    return rows
      .filter((row): row is { target: string; count: number } => row.target !== null)
      .map((row) => ({ target: row.target, count: row.count }))
  }

  private async getFormAbandonRates(windowStart: Date): Promise<TelemetryFormAbandonRate[]> {
    const rows = await this.db.db
      .select({
        route: telemetryEvents.route,
        abandonCount: sql<number>`count(*) filter (where ${telemetryEvents.event} = 'form_abandon')::int`,
        submitCount: sql<number>`count(*) filter (where ${telemetryEvents.event} = 'form_submit')::int`,
      })
      .from(telemetryEvents)
      .where(
        and(
          gte(telemetryEvents.createdAt, windowStart),
          inArray(telemetryEvents.event, ['form_abandon', 'form_submit']),
        ),
      )
      .groupBy(telemetryEvents.route)

    return rows.map((row) => {
      const total = row.abandonCount + row.submitCount
      return {
        route: row.route,
        abandonCount: row.abandonCount,
        submitCount: row.submitCount,
        abandonRate: total === 0 ? 0 : row.abandonCount / total,
      }
    })
  }

  private async getMedianDurations(windowStart: Date): Promise<TelemetryMedianDuration[]> {
    const rows = await this.db.db
      .select({
        route: telemetryEvents.route,
        medianDurationMs: sql<number>`percentile_cont(0.5) within group (order by ${telemetryEvents.durationMs})::int`,
      })
      .from(telemetryEvents)
      .where(
        and(
          gte(telemetryEvents.createdAt, windowStart),
          eq(telemetryEvents.event, 'route_leave'),
          sql`${telemetryEvents.durationMs} is not null`,
        ),
      )
      .groupBy(telemetryEvents.route)

    return rows.map((row) => ({ route: row.route, medianDurationMs: row.medianDurationMs }))
  }
}
