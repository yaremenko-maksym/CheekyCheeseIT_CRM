import { Injectable, Logger } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import type { TelemetryErrorSource } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { telemetryErrors } from '../database/schema'
import { computeFingerprint } from './fingerprint'
import { toPathname } from './route'
import { sanitizeAndTruncate } from './sanitize'

/** Contract: `message text (≤500)` / `stack text (≤4000, санитизированный)`. */
export const MESSAGE_MAX_LENGTH = 500
export const STACK_MAX_LENGTH = 4000

/**
 * Aggregation-key (fingerprint) row cap — task-telemetry-caps (security
 * audit, MED). `telemetry_errors` is reachable by ANY authenticated employee
 * (POST /api/telemetry/errors) AND by every 5xx the API itself throws
 * (`TelemetryExceptionFilter`) — like `csp_reports`
 * (`CspReportsService.recordViolation`, `CSP_REPORTS_ROW_CAP`), it groups by
 * a value that is ultimately attacker/bug-controlled (the error message —
 * `fingerprint` is derived from it), and unlike `csp_reports` it previously
 * had NO cap at all: an attacker who can reach the endpoint (or a bug that
 * mints a fresh unique message every call) could grow this table without
 * bound. `recordError` enforces the cap at INSERT time (refusing a NEW
 * fingerprint once the table is at `TELEMETRY_ERRORS_ROW_CAP` — an EXISTING
 * fingerprint's `count++` always still succeeds, that is the safe, bounded
 * case, and is exactly the signal we most need during a REAL mass-error
 * incident). 10 000 mirrors `CSP_REPORTS_ROW_CAP` — generous for legitimate
 * error diversity while bounding worst-case table size to roughly the same
 * order of magnitude.
 */
export const TELEMETRY_ERRORS_ROW_CAP = 10_000

/**
 * A FIXED message — never the rejected occurrence's own message, or the cap-
 * reached signal itself would reopen the unbounded-cardinality channel the
 * cap exists to close. Recorded via the SAME upsert this service already
 * uses (keyed on `fingerprint`, itself derived from this fixed message), so
 * a sustained cap-exhaustion attempt shows up as ONE row with a growing
 * `count`, never a flood. Self-referential (there is no separate table to
 * escalate into, unlike CSP reports escalating INTO `telemetry_errors`) —
 * `recordCapReachedError` bypasses the cap check entirely for this one
 * fixed fingerprint so the signal can never itself be swallowed by the cap.
 */
export const TELEMETRY_ERRORS_CAP_REACHED_MESSAGE =
  'telemetry-errors: aggregation-key row cap reached'

/** Deterministic given the fixed message above (no stack) — computed once at module load. */
const CAP_REACHED_FINGERPRINT = computeFingerprint({
  source: 'API',
  message: TELEMETRY_ERRORS_CAP_REACHED_MESSAGE,
})

/** How long the cached approximate row count (used for the cap check above) is trusted before a fresh `COUNT(*)`. */
const ROW_COUNT_CACHE_TTL_MS = 30_000

export interface RecordErrorInput {
  source: TelemetryErrorSource
  message: string
  // `| undefined` (not just `| null`, on top of the property already being
  // optional) — callers commonly pass through an optional-chained value
  // (`exception.stack`, `request.user?.id`) directly; exactOptionalPropertyTypes
  // rejects assigning `undefined` to a declared-optional prop whose type
  // doesn't itself include `undefined`.
  stack?: string | null | undefined
  route?: string | null | undefined
  userId?: string | null | undefined
  userRole?: string | null | undefined
  meta?: Record<string, unknown> | undefined
}

/**
 * TelemetryErrorsService — task-telemetry-api §"Таблицы" + §"Endpoints",
 * row-cap hardening per task-telemetry-caps (security audit, MED).
 *
 * The ONE place that writes to `telemetry_errors`. Used by BOTH:
 *   - `TelemetryController.reportError` (POST /api/telemetry/errors, a real
 *     client-submitted report)
 *   - `TelemetryExceptionFilter` (server-side 5xx/unhandled exceptions,
 *     source='API')
 *
 * so there is exactly one upsert implementation — no drift between the two
 * ingest paths.
 *
 * Row-cap budget (task-telemetry-caps), same shape as
 * `CspReportsService.recordViolation`: a NEW `fingerprint` is refused once
 * the table is at `TELEMETRY_ERRORS_ROW_CAP` — an EXISTING fingerprint's
 * `count++` always still succeeds (checked FIRST via `isNewFingerprint`, so
 * the cap can only ever block genuinely NEW aggregation keys, never a repeat
 * of an error we are already tracking — losing that signal during a real
 * mass-error incident would be exactly the wrong moment to go blind). The
 * approximate row count is cached for `ROW_COUNT_CACHE_TTL_MS` (mirrors
 * `CspReportsService.getApproxRowCount`) so legitimate low-volume traffic
 * doesn't pay a `COUNT(*)` on every single call.
 */
@Injectable()
export class TelemetryErrorsService {
  private readonly logger = new Logger(TelemetryErrorsService.name)
  private cachedRowCount = 0
  private cachedRowCountAt = 0

  constructor(private readonly db: DatabaseService) {}

  /**
   * Upserts on `fingerprint` (AC2):
   *   - new fingerprint → insert, count=1, status=NEW (refused once the row
   *     cap is reached — see the class doc comment)
   *   - existing fingerprint → count++, last_seen bumped, context refreshed
   *     to the LATEST occurrence (route/userId/userRole/meta — more useful
   *     for repro than the first-ever occurrence); ALWAYS allowed, even at
   *     the cap
   *   - existing fingerprint currently RESOLVED → flips back to NEW
   *     (regression — the digest will pick it up again); NOTIFIED/NEW stay
   *     as-is (already queued / already pending)
   *
   * Sanitization + truncation happen HERE (not at the call sites) so both
   * ingest paths get the same guarantee.
   */
  async recordError(input: RecordErrorInput): Promise<void> {
    const fingerprint = computeFingerprint({
      source: input.source,
      message: input.message,
      stack: input.stack,
    })
    const message = sanitizeAndTruncate(input.message, MESSAGE_MAX_LENGTH)
    const stack = input.stack ? sanitizeAndTruncate(input.stack, STACK_MAX_LENGTH) : null
    // sec HIGH (review round 1): a client-submitted `route` (or the
    // server-side `request.url`, via TelemetryExceptionFilter) can carry a
    // query string (`?code=...&state=...`) — the digest hands this value to
    // a PUBLIC GitHub issue. Pathname-only, always, at this single write path.
    const route = input.route ? toPathname(input.route) : null
    const userId = input.userId ?? null
    const userRole = input.userRole ?? null
    const meta = input.meta ?? {}

    const isNewFingerprint = await this.isNewFingerprint(fingerprint)
    if (isNewFingerprint && (await this.getApproxRowCount()) >= TELEMETRY_ERRORS_ROW_CAP) {
      this.logger.warn(
        `telemetry error dropped — row cap (${TELEMETRY_ERRORS_ROW_CAP}) reached, refusing new fingerprint (source=${input.source})`,
      )
      await this.recordCapReachedError()
      return
    }

    await this.upsertRow({
      fingerprint,
      source: input.source,
      message,
      stack,
      route,
      userId,
      userRole,
      meta,
    })

    if (isNewFingerprint) this.cachedRowCount += 1
    this.logger.debug(`telemetry error recorded (fingerprint=${fingerprint})`)
  }

  private async isNewFingerprint(fingerprint: string): Promise<boolean> {
    const existing = await this.db.db
      .select({ id: telemetryErrors.id })
      .from(telemetryErrors)
      .where(eq(telemetryErrors.fingerprint, fingerprint))
      .limit(1)
    return existing.length === 0
  }

  /**
   * Cached `COUNT(*)` — refreshed at most every `ROW_COUNT_CACHE_TTL_MS`,
   * and bumped optimistically by 1 on every confirmed new-fingerprint insert
   * (`recordError`), so it stays accurate between refreshes without a
   * `COUNT(*)` on every single request under legitimate (low-volume) load.
   */
  private async getApproxRowCount(): Promise<number> {
    const now = Date.now()
    if (now - this.cachedRowCountAt < ROW_COUNT_CACHE_TTL_MS) return this.cachedRowCount
    const [row] = await this.db.db
      .select({ count: sql<number>`count(*)::int` })
      .from(telemetryErrors)
    this.cachedRowCount = row?.count ?? 0
    this.cachedRowCountAt = now
    return this.cachedRowCount
  }

  /**
   * Row-cap rejection signal — see the class doc comment + the
   * `TELEMETRY_ERRORS_CAP_REACHED_MESSAGE` doc comment for why this
   * deliberately bypasses `recordError`'s own cap check (a direct
   * `upsertRow`, never routed back through the cap-checked path) rather than
   * recursing into `recordError`.
   */
  private async recordCapReachedError(): Promise<void> {
    try {
      await this.upsertRow({
        fingerprint: CAP_REACHED_FINGERPRINT,
        source: 'API',
        message: TELEMETRY_ERRORS_CAP_REACHED_MESSAGE,
        stack: null,
        route: null,
        userId: null,
        userRole: null,
        meta: {},
      })
    } catch {
      // Best-effort — if telemetry_errors itself is unwritable there is
      // nothing further to do; the warn log above already reached the logs.
    }
  }

  private async upsertRow(row: {
    fingerprint: string
    source: TelemetryErrorSource
    message: string
    stack: string | null
    route: string | null
    userId: string | null
    userRole: string | null
    meta: Record<string, unknown>
  }): Promise<void> {
    const now = new Date()
    await this.db.db
      .insert(telemetryErrors)
      .values({
        fingerprint: row.fingerprint,
        source: row.source,
        message: row.message,
        stack: row.stack,
        route: row.route,
        userId: row.userId,
        userRole: row.userRole,
        meta: row.meta,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        status: 'NEW',
      })
      .onConflictDoUpdate({
        target: telemetryErrors.fingerprint,
        set: {
          count: sql`${telemetryErrors.count} + 1`,
          lastSeen: now,
          status: sql`CASE WHEN ${telemetryErrors.status} = 'RESOLVED' THEN 'NEW'::telemetry_error_status ELSE ${telemetryErrors.status} END`,
          route: row.route,
          userId: row.userId,
          userRole: row.userRole,
          meta: row.meta,
        },
      })
  }
}
