import { Injectable, Logger } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import type { TelemetryErrorSource } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { telemetryErrors } from '../database/schema'
import { computeFingerprint } from './fingerprint'
import { toPathname } from './route'
import { sanitizeAndTruncate } from './sanitize'

/** Contract: `message text (≤500)` / `stack text (≤4000, санитизированный)`. */
export const MESSAGE_MAX_LENGTH = 500
export const STACK_MAX_LENGTH = 4000

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
 * TelemetryErrorsService — task-telemetry-api §"Таблицы" + §"Endpoints".
 *
 * The ONE place that writes to `telemetry_errors`. Used by BOTH:
 *   - `TelemetryController.reportError` (POST /api/telemetry/errors, a real
 *     client-submitted report)
 *   - `TelemetryExceptionFilter` (server-side 5xx/unhandled exceptions,
 *     source='API')
 *
 * so there is exactly one upsert implementation — no drift between the two
 * ingest paths.
 */
@Injectable()
export class TelemetryErrorsService {
  private readonly logger = new Logger(TelemetryErrorsService.name)

  constructor(private readonly db: DatabaseService) {}

  /**
   * Upserts on `fingerprint` (AC2):
   *   - new fingerprint → insert, count=1, status=NEW
   *   - existing fingerprint → count++, last_seen bumped, context refreshed
   *     to the LATEST occurrence (route/userId/userRole/meta — more useful
   *     for repro than the first-ever occurrence)
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
    const now = new Date()

    await this.db.db
      .insert(telemetryErrors)
      .values({
        fingerprint,
        source: input.source,
        message,
        stack,
        route,
        userId: input.userId ?? null,
        userRole: input.userRole ?? null,
        meta: input.meta ?? {},
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
          route,
          userId: input.userId ?? null,
          userRole: input.userRole ?? null,
          meta: input.meta ?? {},
        },
      })

    this.logger.debug(`telemetry error recorded (fingerprint=${fingerprint})`)
  }
}
