import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_TITLES } from '@crm/shared'
import type { DrizzleTx } from '../../database/types'
import type { NotificationsService } from '../../notifications/notifications.service'
import {
  earlierEventsTodaySql,
  SourceHealthAlertService,
  type AlertTransition,
} from './source-health-alert.service'

/**
 * Unit seam: what the service hands to `NotificationsService` (who, what, with or without email).
 * The real enqueue / role / cap behaviour against Postgres is `source-health-alerts.integration.spec`.
 */
const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const ADMIN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ADMIN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function transition(over: Partial<AlertTransition> = {}): AlertTransition {
  return {
    eventId: EVENT_ID,
    at: new Date('2026-03-02T10:00:00.000Z'),
    sourceId: '22222222-2222-4222-8222-222222222222',
    sourceName: 'remotive_api',
    from: { state: 'HEALTHY', reason: null },
    to: { state: 'FAILING', reason: null },
    ...over,
  }
}

function harness(
  opts: {
    admins?: string[]
    earlier?: { prev: string | null; to: string; reason?: string }[]
  } = {},
) {
  const admins = (opts.admins ?? [ADMIN_A, ADMIN_B]).map((id) => ({ id }))
  const where = vi.fn().mockResolvedValue(admins)
  const execute = vi.fn().mockResolvedValue({
    rows: (opts.earlier ?? []).map((e) => ({
      prev_state: e.prev,
      to_state: e.to,
      reason_code: e.reason ?? null,
    })),
  })
  const tx = { select: () => ({ from: () => ({ where }) }), execute } as unknown as DrizzleTx
  const createManyInTx = vi.fn().mockResolvedValue(undefined)
  const emitInTx = vi.fn(async (t: DrizzleTx, produce: (sp: DrizzleTx) => Promise<void>) =>
    produce(t),
  )
  const service = new SourceHealthAlertService({
    emitInTx,
    createManyInTx,
  } as unknown as NotificationsService)
  return { service, tx, createManyInTx, emitInTx, execute, where }
}

describe('SourceHealthAlertService.alertOnTransition', () => {
  it('enqueues one SOURCE_HEALTH_ALERT per admin with the entered state, an event dedupe key, and email on', async () => {
    const h = harness()
    await h.service.alertOnTransition(h.tx, transition())
    expect(h.createManyInTx).toHaveBeenCalledTimes(1)
    const [, inputs] = h.createManyInTx.mock.calls[0]!
    expect(inputs).toEqual(
      [ADMIN_A, ADMIN_B].map((userId) => ({
        userId,
        type: 'SOURCE_HEALTH_ALERT',
        title: NOTIFICATION_TITLES.SOURCE_HEALTH_ALERT,
        data: { sourceName: 'remotive_api', state: 'FAILING' },
        dedupeKey: `SOURCE_HEALTH_ALERT:${EVENT_ID}`,
        skipEmail: false,
      })),
    )
  })

  it('does nothing for a transition that is not an entry (recovery, same state, reason change)', async () => {
    for (const t of [
      transition({
        from: { state: 'FAILING', reason: null },
        to: { state: 'HEALTHY', reason: null },
      }),
      transition({
        from: { state: 'FAILING', reason: null },
        to: { state: 'FAILING', reason: 'ACCESS_CHANGED' },
      }),
      transition({ to: { state: 'SILENT', reason: 'NO_NEW_ITEMS' } }),
    ]) {
      const h = harness()
      await h.service.alertOnTransition(h.tx, t)
      expect(h.emitInTx).not.toHaveBeenCalled()
      expect(h.createManyInTx).not.toHaveBeenCalled()
    }
  })

  it('alerts DEGRADED only for SCHEMA_DRIFT, and names the state in the data', async () => {
    const h = harness()
    await h.service.alertOnTransition(
      h.tx,
      transition({ to: { state: 'DEGRADED', reason: 'SCHEMA_DRIFT' } }),
    )
    const [, inputs] = h.createManyInTx.mock.calls[0]!
    expect(inputs[0].data).toEqual({ sourceName: 'remotive_api', state: 'DEGRADED' })
  })

  it('with 2 alerting entries earlier today the 3rd still emails; with 3 it does not', async () => {
    const entry = { prev: 'HEALTHY', to: 'FAILING' }
    const recovery = { prev: 'FAILING', to: 'HEALTHY' }
    const two = harness({ earlier: [entry, recovery, entry, recovery] })
    await two.service.alertOnTransition(two.tx, transition())
    expect(two.createManyInTx.mock.calls[0]![1][0].skipEmail).toBe(false)

    const three = harness({ earlier: [entry, recovery, entry, recovery, entry, recovery] })
    await three.service.alertOnTransition(three.tx, transition())
    expect(
      three.createManyInTx.mock.calls[0]![1].map((i: { skipEmail: boolean }) => i.skipEmail),
    ).toEqual([true, true])
  })

  it('counts only entries: events that were not alert entries never use up the budget', async () => {
    const h = harness({
      earlier: [
        { prev: 'HEALTHY', to: 'SILENT' },
        { prev: 'SILENT', to: 'HEALTHY' },
        { prev: 'HEALTHY', to: 'SILENT' },
        { prev: 'SILENT', to: 'HEALTHY' },
      ],
    })
    await h.service.alertOnTransition(h.tx, transition())
    expect(h.createManyInTx.mock.calls[0]![1][0].skipEmail).toBe(false)
  })

  it('a reason-only change inside one state is not an entry, so it never uses up the email budget', async () => {
    const reasonOnly = { prev: 'FAILING', to: 'FAILING', reason: 'ACCESS_CHANGED' }
    const h = harness({ earlier: [reasonOnly, reasonOnly, reasonOnly] })
    await h.service.alertOnTransition(h.tx, transition())
    expect(h.createManyInTx.mock.calls[0]![1][0].skipEmail).toBe(false)
  })

  it('DEGRADED counts as an entry only with the SCHEMA_DRIFT reason', async () => {
    const drift = { prev: 'HEALTHY', to: 'DEGRADED', reason: 'SCHEMA_DRIFT' }
    const recovery = { prev: 'DEGRADED', to: 'HEALTHY' }
    const used = harness({ earlier: [drift, recovery, drift, recovery, drift, recovery] })
    await used.service.alertOnTransition(used.tx, transition())
    expect(used.createManyInTx.mock.calls[0]![1][0].skipEmail).toBe(true)

    const slow = { prev: 'HEALTHY', to: 'DEGRADED', reason: 'SLOW' }
    const unused = harness({ earlier: [slow, recovery, slow, recovery, slow, recovery] })
    await unused.service.alertOnTransition(unused.tx, transition())
    expect(unused.createManyInTx.mock.calls[0]![1][0].skipEmail).toBe(false)
  })

  it('reads the earlier events of this source on the Kyiv day, this event excluded (statement pinned)', () => {
    const t = transition()
    const q = new PgDialect().sqlToQuery(earlierEventsTodaySql(t))
    expect(q.params).toEqual([t.sourceId, t.at, t.eventId, 'Europe/Kyiv', t.at, 'Europe/Kyiv'])
    for (const fragment of [
      'FROM job_source_health_events',
      "kind = 'TRANSITION'",
      'lag(to_state) OVER w AS prev_state',
      'WINDOW w AS (ORDER BY at, id)',
      'at <= $2',
      'id <> $3',
      '(at AT TIME ZONE $4)::date = ($5::timestamptz AT TIME ZONE $6)::date',
    ]) {
      expect(q.sql, fragment).toContain(fragment)
    }
  })

  it('sends to no one when there is no active admin (the query already excludes archived users)', async () => {
    const h = harness({ admins: [] })
    await h.service.alertOnTransition(h.tx, transition())
    expect(h.createManyInTx.mock.calls[0]![1]).toEqual([])
  })
})
