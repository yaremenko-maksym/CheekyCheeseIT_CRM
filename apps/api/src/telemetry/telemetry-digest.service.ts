import { Injectable, Logger } from '@nestjs/common'
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import type {
  CspViolationItem,
  TelemetryErrorItem,
  TelemetryFeatureClick,
  TelemetryFormAbandonRate,
  TelemetryMedianDuration,
  TelemetryTopRoute,
  TelemetryUxAggregates,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { cspReports, telemetryErrors, telemetryEvents } from '../database/schema'

/** Contract: "ux? {... — за 7 дней}" — fixed 7-day rolling window, independent of `since`. */
export const UX_WINDOW_DAYS = 7
/** Caps the size of each UX aggregate array — a digest is a summary, not a full dump. */
export const TOP_ROUTES_LIMIT = 20
export const FEATURE_CLICKS_LIMIT = 20
/**
 * Security round 1 (HIGH-2): caps how many `csp_reports` rows the digest
 * ever materializes in one response. Before this cap, `getCspViolations`
 * selected the ENTIRE matching window with no `.limit()` — a table an
 * anonymous caller can grow (HIGH-1) being read WITHOUT a limit, on an
 * UNCONDITIONAL, hourly-automated endpoint, is a straight line to an OOM
 * crash-loop of the whole API container. `totalMatching` (returned
 * alongside the capped array) makes truncation visible instead of silent.
 */
export const CSP_VIOLATIONS_DIGEST_LIMIT = 200

type TelemetryErrorRow = typeof telemetryErrors.$inferSelect
type CspReportRow = typeof cspReports.$inferSelect

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
 *
 * cspViolations (task-csp-reports-and-flip §4 "Видимость"): every
 * `csp_reports` row with `last_seen >= since`, capped at
 * `CSP_VIOLATIONS_DIGEST_LIMIT` (security round 1 HIGH-2 — this table can
 * be grown by an anonymous caller, see csp-reports.service.ts, so an
 * UNLIMITED select here is an OOM vector) — ALWAYS included (not gated
 * behind `ux=1`), same as `errors`, plus a sibling `cspViolationsTotal`
 * (the full matching count, so truncation is visible). Unlike
 * `telemetry_errors` there is no NOTIFIED/status tracking on this table —
 * the aggregate itself IS the summary, and the caller's advancing `since`
 * (the GH Action workflow already calls this hourly/weekly with a fresh
 * `since`) naturally avoids re-reporting an unchanged row.
 */
@Injectable()
export class TelemetryDigestService {
  private readonly logger = new Logger(TelemetryDigestService.name)

  constructor(private readonly db: DatabaseService) {}

  async getDigest(params: GetDigestParams): Promise<{
    errors: TelemetryErrorItem[]
    cspViolations: CspViolationItem[]
    cspViolationsTotal: number
    ux?: TelemetryUxAggregates
  }> {
    const [errors, csp] = await Promise.all([
      this.fetchAndNotifyNewErrors(params.since),
      this.getCspViolations(params.since),
    ])
    const cspViolations = csp.items
    const cspViolationsTotal = csp.totalMatching
    if (!params.includeUx) {
      return { errors, cspViolations, cspViolationsTotal }
    }
    const ux = await this.getUxAggregates()
    return { errors, cspViolations, cspViolationsTotal, ux }
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

  /**
   * Selects at most `CSP_VIOLATIONS_DIGEST_LIMIT` `csp_reports` rows with
   * `last_seen >= since`, ordered by `count` descending (a digest is a
   * summary — surface the worst offenders first, security round 1 HIGH-2).
   * `totalMatching` is the FULL count of matching rows (before the limit),
   * a separate cheap `COUNT(*)` query — this is what makes truncation
   * visible to a digest consumer instead of silently dropping rows. See the
   * class doc comment above for why there is no NOTIFIED-style status
   * transition here (unlike `fetchAndNotifyNewErrors`).
   */
  async getCspViolations(
    since: Date,
  ): Promise<{ items: CspViolationItem[]; totalMatching: number }> {
    const [countRow] = await this.db.db
      .select({ count: sql<number>`count(*)::int` })
      .from(cspReports)
      .where(gte(cspReports.lastSeen, since))
    const totalMatching = countRow?.count ?? 0

    const rows = await this.db.db
      .select()
      .from(cspReports)
      .where(gte(cspReports.lastSeen, since))
      .orderBy(desc(cspReports.count))
      .limit(CSP_VIOLATIONS_DIGEST_LIMIT)

    return { items: rows.map((row) => this.mapCspViolationRow(row)), totalMatching }
  }

  private mapCspViolationRow(row: CspReportRow): CspViolationItem {
    return {
      id: row.id,
      effectiveDirective: row.effectiveDirective,
      blockedUri: row.blockedUri,
      documentPath: row.documentPath,
      disposition: row.disposition,
      userAgent: row.userAgent,
      count: row.count,
      firstSeen: row.firstSeen.toISOString(),
      lastSeen: row.lastSeen.toISOString(),
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
