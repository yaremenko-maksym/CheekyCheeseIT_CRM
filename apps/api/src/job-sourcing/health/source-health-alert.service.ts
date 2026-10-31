/**
 * Source-fetch-strategy U5a — the ADMIN alert on a source ENTERING a bad health state
 * (ADR 2026-10-25 section 11).
 *
 * Called by the detector pass INSIDE the transaction that writes the `TRANSITION` event, so the
 * event and its alerts commit together. What it decides, in order:
 *  1. is this transition an ENTRY into an alerting state (`isAlertEntry`)? A source that stays in
 *     the state writes no event at all, so it never reaches here;
 *  2. who: active ADMIN users only (`activeAdminIds`);
 *  3. email or in-app only: at most 3 alert emails per source per Kyiv day, counted from the event
 *     log itself (the alerting entries of this source earlier the same Kyiv day), so no counter
 *     can drift from the log.
 *
 * The whole body runs under `NotificationsService.emitInTx`, a savepoint: a failure here is logged
 * and reported, and never rolls back the health event.
 */
import { Inject, Injectable } from '@nestjs/common'
import { sql, type SQL } from 'drizzle-orm'
import { NOTIFICATION_TITLES } from '@crm/shared'
import type { DrizzleTx } from '../../database/types'
import { NotificationsService } from '../../notifications/notifications.service'
import { activeAdminIds } from './active-admins'
import { emailBudgetLeft, isAlertEntry, type StateRef } from './health-alert-policy'

export interface AlertTransition {
  readonly eventId: string
  readonly at: Date
  readonly sourceId: string
  /** The manifest id (or the type) — an object name, never a URL. */
  readonly sourceName: string
  readonly from: StateRef
  readonly to: StateRef
}

const KYIV = 'Europe/Kyiv'

/**
 * The earlier TRANSITION events of this source on the Kyiv day of `t.at` (this event excluded),
 * each with the state it came from (`lag()` over the source's own history; the log stores only the
 * state an event entered). The PREVIOUS reason is not needed: consecutive events always differ in
 * `(state, reason)`, so "was in DEGRADED/SCHEMA_DRIFT and entered DEGRADED/SCHEMA_DRIFT" cannot occur.
 * Exported so a unit spec can pin the statement; its behaviour is
 * `source-health-alerts.integration.spec.ts`.
 */
export function earlierEventsTodaySql(t: AlertTransition): SQL {
  return sql`
    SELECT prev_state, to_state, reason_code
      FROM (
        SELECT id, at, to_state, reason_code,
               lag(to_state) OVER w AS prev_state
          FROM job_source_health_events
         WHERE source_id = ${t.sourceId} AND kind = 'TRANSITION' AND at <= ${t.at}
        WINDOW w AS (ORDER BY at, id)
      ) e
     WHERE id <> ${t.eventId}
       AND (at AT TIME ZONE ${KYIV})::date = (${t.at}::timestamptz AT TIME ZONE ${KYIV})::date`
}

@Injectable()
export class SourceHealthAlertService {
  // Explicit token: the test transformer emits no `design:paramtypes`.
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  /** Enqueues the alerts for one transition; resolves once they are written (or swallowed). */
  async alertOnTransition(tx: DrizzleTx, t: AlertTransition): Promise<void> {
    const entered = isAlertEntry(t.from, t.to)
    if (entered === null) return
    await this.notifications.emitInTx(tx, async (sp) => {
      const emailAllowed = emailBudgetLeft(await this.earlierEntriesToday(sp, t))
      const admins = await activeAdminIds(sp)
      await this.notifications.createManyInTx(
        sp,
        admins.map((userId) => ({
          userId,
          type: 'SOURCE_HEALTH_ALERT' as const,
          title: NOTIFICATION_TITLES.SOURCE_HEALTH_ALERT,
          data: { sourceName: t.sourceName, state: entered },
          // One alert per transition event; a redelivery of the same event finds the row.
          dedupeKey: `SOURCE_HEALTH_ALERT:${t.eventId}`,
          skipEmail: !emailAllowed,
        })),
      )
    })
  }

  private async earlierEntriesToday(sp: DrizzleTx, t: AlertTransition): Promise<number> {
    const result = await sp.execute(earlierEventsTodaySql(t))
    return result.rows.filter((row) => {
      const r = row as Record<string, string | null>
      return (
        isAlertEntry(
          { state: r['prev_state'] ?? null, reason: null },
          { state: r['to_state'] ?? null, reason: r['reason_code'] ?? null },
        ) !== null
      )
    }).length
  }
}
