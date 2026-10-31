/**
 * Source-fetch-strategy U5a — the ADMIN alert on a source ENTERING a bad health state
 * (ADR 2026-10-25 section 11).
 *
 * Called by the detector pass INSIDE the transaction that writes the `TRANSITION` event, so the
 * event and its alerts commit together. What it decides, in order:
 *  1. is this transition an alerting target at all (`alertStateOf`)? Cheap exit, no lock;
 *  2. LOCK the source (`pg_advisory_xact_lock`) and re-read its latest other TRANSITION from the
 *     log. Two passes that raced (two replicas, overlapping ticks) each wrote their own event from
 *     the same stale "previous state"; behind the lock the second one sees the first one's event as
 *     its predecessor, finds no ENTRY, and sends nothing. The state before is therefore taken from
 *     the log under the lock, never from the pass's earlier read;
 *  3. who: active ADMIN users only (`activeAdminIds`);
 *  4. email or in-app only: at most 3 alert emails per source per Kyiv day, counted from the event
 *     log itself (the alerting entries of this source earlier the same Kyiv day, under the same
 *     lock, so two entries cannot both take the third slot).
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
import { alertStateOf, emailBudgetLeft, isAlertEntry, type StateRef } from './health-alert-policy'

export interface AlertTransition {
  readonly eventId: string
  readonly at: Date
  readonly sourceId: string
  /** The manifest id (or the type) — an object name, never a URL. */
  readonly sourceName: string
  readonly to: StateRef
  /** Consecutive failures and when the first failing run began; carried by a CAPPED alert. */
  readonly failures: number
  readonly since: Date | null
}

const KYIV = 'Europe/Kyiv'

/** One lock per source, held to the end of the alert transaction. */
export function sourceLockSql(sourceId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${sourceId}, 0))`
}

/** The latest TRANSITION of the source other than this event: the state it was really in. */
export function stateBeforeSql(t: AlertTransition): SQL {
  return sql`
    SELECT to_state, reason_code FROM job_source_health_events
     WHERE source_id = ${t.sourceId} AND kind = 'TRANSITION' AND id <> ${t.eventId}
     ORDER BY at DESC, id DESC LIMIT 1`
}

/**
 * The earlier TRANSITION events of this source on the Kyiv day of `t.at` (this event excluded),
 * each with the state it came from. Bounded to that day (`at >= <Kyiv midnight>`), so the read
 * does not grow with the source's history. The previous REASON is not needed: consecutive events
 * always differ in `(state, reason)`, so "was DEGRADED/SCHEMA_DRIFT and entered it again" cannot
 * occur. Exported so a unit spec can pin the statements; their behaviour is
 * `source-health-alerts.integration.spec.ts`.
 */
export function earlierEventsTodaySql(t: AlertTransition): SQL {
  return sql`
    SELECT from_state, to_state, reason_code FROM job_source_health_events
     WHERE source_id = ${t.sourceId} AND kind = 'TRANSITION' AND id <> ${t.eventId}
       AND at <= ${t.at}
       AND at >= (date_trunc('day', ${t.at}::timestamptz AT TIME ZONE ${KYIV}) AT TIME ZONE ${KYIV})`
}

type Row = Record<string, string | null>

@Injectable()
export class SourceHealthAlertService {
  // Explicit token: the test transformer emits no `design:paramtypes`.
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  /** Enqueues the alerts for one transition; resolves once they are written (or swallowed). */
  async alertOnTransition(tx: DrizzleTx, t: AlertTransition): Promise<void> {
    if (alertStateOf(t.to) === null) return
    await this.notifications.emitInTx(tx, async (sp) => {
      await sp.execute(sourceLockSql(t.sourceId))
      const entered = isAlertEntry(await this.stateBefore(sp, t), t.to)
      if (entered === null) return
      const emailAllowed = emailBudgetLeft(await this.earlierEntriesToday(sp, t))
      const admins = await activeAdminIds(sp)
      const capped = entered === 'CAPPED'
      await this.notifications.createManyInTx(
        sp,
        admins.map((userId) => ({
          userId,
          type: 'SOURCE_HEALTH_ALERT' as const,
          title: NOTIFICATION_TITLES.SOURCE_HEALTH_ALERT,
          data: {
            sourceName: t.sourceName,
            state: entered,
            failures: capped ? t.failures : null,
            since: capped && t.since !== null ? t.since.toISOString() : null,
          },
          // One alert per transition event; a redelivery of the same event finds the row.
          dedupeKey: `SOURCE_HEALTH_ALERT:${t.eventId}`,
          skipEmail: !emailAllowed,
        })),
      )
    })
  }

  private async stateBefore(sp: DrizzleTx, t: AlertTransition): Promise<StateRef> {
    const row = (await sp.execute(stateBeforeSql(t))).rows[0] as Row | undefined
    return { state: row?.['to_state'] ?? null, reason: row?.['reason_code'] ?? null }
  }

  private async earlierEntriesToday(sp: DrizzleTx, t: AlertTransition): Promise<number> {
    const result = await sp.execute(earlierEventsTodaySql(t))
    return result.rows.filter((row) => {
      const r = row as Row
      return (
        isAlertEntry(
          { state: r['from_state'] ?? null, reason: null },
          { state: r['to_state'] ?? null, reason: r['reason_code'] ?? null },
        ) !== null
      )
    }).length
  }
}
