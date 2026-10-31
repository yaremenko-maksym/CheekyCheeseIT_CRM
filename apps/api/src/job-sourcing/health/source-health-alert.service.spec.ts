import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_TITLES } from '@crm/shared'
import type { DrizzleTx } from '../../database/types'
import type { NotificationsService } from '../../notifications/notifications.service'
import {
  earlierEventsTodaySql,
  SourceHealthAlertService,
  sourceLockSql,
  stateBeforeSql,
  type AlertTransition,
} from './source-health-alert.service'

/**
 * Unit seam: what the service hands to `NotificationsService` (who, what, with or without email),
 * the order of its statements, and the statements themselves. The real enqueue / role / cap /
 * concurrency behaviour against Postgres is `source-health-alerts.integration.spec`.
 */
const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const ADMIN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ADMIN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const dialect = new PgDialect()

function transition(over: Partial<AlertTransition> = {}): AlertTransition {
  return {
    eventId: EVENT_ID,
    at: new Date('2026-03-02T10:00:00.000Z'),
    sourceId: '22222222-2222-4222-8222-222222222222',
    sourceName: 'remotive_api',
    to: { state: 'FAILING', reason: null },
    failures: 1,
    since: new Date('2026-03-02T08:00:00.000Z'),
    ...over,
  }
}

interface Earlier {
  from: string | null
  to: string
  reason?: string
}

function harness(
  opts: {
    admins?: string[]
    /** The latest OTHER event of the source, as the log has it under the lock. */
    before?: { state: string; reason?: string } | null
    earlier?: Earlier[]
  } = {},
) {
  const admins = (opts.admins ?? [ADMIN_A, ADMIN_B]).map((id) => ({ id }))
  const before = opts.before === undefined ? { state: 'HEALTHY' } : opts.before
  const statements: string[] = []
  const execute = vi.fn(async (q: SQL) => {
    const text = dialect.sqlToQuery(q).sql
    statements.push(text)
    if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (text.includes('LIMIT 1')) {
      return {
        rows:
          before === null ? [] : [{ to_state: before.state, reason_code: before.reason ?? null }],
      }
    }
    return {
      rows: (opts.earlier ?? []).map((e) => ({
        from_state: e.from,
        to_state: e.to,
        reason_code: e.reason ?? null,
      })),
    }
  })
  const where = vi.fn().mockResolvedValue(admins)
  const tx = { select: () => ({ from: () => ({ where }) }), execute } as unknown as DrizzleTx
  const createManyInTx = vi.fn().mockResolvedValue(undefined)
  const emitInTx = vi.fn(async (t: DrizzleTx, produce: (sp: DrizzleTx) => Promise<void>) =>
    produce(t),
  )
  const service = new SourceHealthAlertService({
    emitInTx,
    createManyInTx,
  } as unknown as NotificationsService)
  return { service, tx, createManyInTx, emitInTx, execute, statements }
}

const entry: Earlier = { from: 'HEALTHY', to: 'FAILING' }
const recovery: Earlier = { from: 'FAILING', to: 'HEALTHY' }
const skipOf = (h: ReturnType<typeof harness>) => h.createManyInTx.mock.calls[0]![1][0].skipEmail

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
        data: { sourceName: 'remotive_api', state: 'FAILING', failures: null, since: null },
        dedupeKey: `SOURCE_HEALTH_ALERT:${EVENT_ID}`,
        skipEmail: false,
      })),
    )
  })

  it('a CAPPED alert carries the failure count and when the failures began', async () => {
    const h = harness({ before: { state: 'FAILING' } })
    await h.service.alertOnTransition(
      h.tx,
      transition({
        to: { state: 'CAPPED', reason: null },
        failures: 5,
        since: new Date('2026-03-01T22:15:00.000Z'),
      }),
    )
    expect(h.createManyInTx.mock.calls[0]![1][0].data).toEqual({
      sourceName: 'remotive_api',
      state: 'CAPPED',
      failures: 5,
      since: '2026-03-01T22:15:00.000Z',
    })
  })

  it('a CAPPED alert with no known first failing run says so with nulls, not a made-up date', async () => {
    const h = harness({ before: { state: 'FAILING' } })
    await h.service.alertOnTransition(
      h.tx,
      transition({ to: { state: 'CAPPED', reason: null }, failures: 5, since: null }),
    )
    expect(h.createManyInTx.mock.calls[0]![1][0].data).toMatchObject({
      failures: 5,
      since: null,
    })
  })

  it('does nothing for a target that is not an alerting state, and takes no lock for it', async () => {
    const h = harness()
    await h.service.alertOnTransition(h.tx, transition({ to: { state: 'HEALTHY', reason: null } }))
    await h.service.alertOnTransition(
      h.tx,
      transition({ to: { state: 'SILENT', reason: 'NO_NEW_ITEMS' } }),
    )
    expect(h.emitInTx).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('does nothing when the log says the source was ALREADY in that state (a racing duplicate or a reason change)', async () => {
    for (const before of [{ state: 'FAILING' }, { state: 'FAILING', reason: 'ACCESS_CHANGED' }]) {
      const h = harness({ before })
      await h.service.alertOnTransition(h.tx, transition())
      expect(h.createManyInTx).not.toHaveBeenCalled()
    }
  })

  it('trusts the log under the lock, not the pass: a first-ever event into a bad state is an entry', async () => {
    const h = harness({ before: null })
    await h.service.alertOnTransition(h.tx, transition({ to: { state: 'EMPTY', reason: null } }))
    expect(h.createManyInTx.mock.calls[0]![1][0].data.state).toBe('EMPTY')
  })

  it('takes the per-source lock BEFORE it reads anything, then reads the state before, then the day', async () => {
    const h = harness()
    await h.service.alertOnTransition(h.tx, transition())
    expect(h.statements).toHaveLength(3)
    expect(h.statements[0]).toContain('pg_advisory_xact_lock')
    expect(h.statements[1]).toContain('LIMIT 1')
    expect(h.statements[2]).toContain('from_state')
    expect(h.emitInTx).toHaveBeenCalledTimes(1)
  })

  it('alerts DEGRADED only with the SCHEMA_DRIFT reason', async () => {
    const h = harness()
    await h.service.alertOnTransition(
      h.tx,
      transition({ to: { state: 'DEGRADED', reason: 'SCHEMA_DRIFT' } }),
    )
    expect(h.createManyInTx.mock.calls[0]![1][0].data.state).toBe('DEGRADED')

    const slow = harness()
    await slow.service.alertOnTransition(
      slow.tx,
      transition({ to: { state: 'DEGRADED', reason: 'SLOW' } }),
    )
    expect(slow.createManyInTx).not.toHaveBeenCalled()
  })

  it('with 2 alerting entries earlier today the 3rd still emails; with 3 it does not', async () => {
    const two = harness({ earlier: [entry, recovery, entry, recovery] })
    await two.service.alertOnTransition(two.tx, transition())
    expect(skipOf(two)).toBe(false)

    const three = harness({ earlier: [entry, recovery, entry, recovery, entry, recovery] })
    await three.service.alertOnTransition(three.tx, transition())
    expect(
      three.createManyInTx.mock.calls[0]![1].map((i: { skipEmail: boolean }) => i.skipEmail),
    ).toEqual([true, true])
  })

  it('counts only entries: events that were not alert entries never use up the budget', async () => {
    const h = harness({
      earlier: [
        { from: 'HEALTHY', to: 'SILENT' },
        { from: 'SILENT', to: 'HEALTHY' },
        { from: 'HEALTHY', to: 'SILENT' },
        { from: 'SILENT', to: 'HEALTHY' },
      ],
    })
    await h.service.alertOnTransition(h.tx, transition())
    expect(skipOf(h)).toBe(false)
  })

  it('a reason-only change inside one state is not an entry, so it never uses up the email budget', async () => {
    const reasonOnly = { from: 'FAILING', to: 'FAILING', reason: 'ACCESS_CHANGED' }
    const h = harness({ earlier: [reasonOnly, reasonOnly, reasonOnly] })
    await h.service.alertOnTransition(h.tx, transition())
    expect(skipOf(h)).toBe(false)
  })

  it('DEGRADED counts toward the budget only with the SCHEMA_DRIFT reason', async () => {
    const drift = { from: 'HEALTHY', to: 'DEGRADED', reason: 'SCHEMA_DRIFT' }
    const recoveryD = { from: 'DEGRADED', to: 'HEALTHY' }
    const used = harness({
      earlier: [drift, recoveryD, drift, recoveryD, drift, recoveryD],
    })
    await used.service.alertOnTransition(used.tx, transition())
    expect(skipOf(used)).toBe(true)

    const slow = { from: 'HEALTHY', to: 'DEGRADED', reason: 'SLOW' }
    const unused = harness({ earlier: [slow, recoveryD, slow, recoveryD, slow, recoveryD] })
    await unused.service.alertOnTransition(unused.tx, transition())
    expect(skipOf(unused)).toBe(false)
  })

  it('sends to no one when there is no active admin (the query already excludes archived users)', async () => {
    const h = harness({ admins: [] })
    await h.service.alertOnTransition(h.tx, transition())
    expect(h.createManyInTx.mock.calls[0]![1]).toEqual([])
  })
})

describe('the statements (pinned)', () => {
  const t = transition()

  it('lock: one advisory transaction lock per source', () => {
    const q = dialect.sqlToQuery(sourceLockSql(t.sourceId))
    expect(q.sql).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))')
    expect(q.params).toEqual([t.sourceId])
  })

  it('state before: the latest OTHER TRANSITION of this source', () => {
    const q = dialect.sqlToQuery(stateBeforeSql(t))
    expect(q.params).toEqual([t.sourceId, t.eventId])
    for (const fragment of [
      'SELECT to_state, reason_code FROM job_source_health_events',
      'source_id = $1',
      "kind = 'TRANSITION'",
      'id <> $2',
      'ORDER BY at DESC, id DESC LIMIT 1',
    ]) {
      expect(q.sql, fragment).toContain(fragment)
    }
  })

  it('earlier today: bounded to the Kyiv day of the event, no scan of the history, this event excluded', () => {
    const q = dialect.sqlToQuery(earlierEventsTodaySql(t))
    expect(q.params).toEqual([t.sourceId, t.eventId, t.at, t.at, 'Europe/Kyiv', 'Europe/Kyiv'])
    for (const fragment of [
      'SELECT from_state, to_state, reason_code FROM job_source_health_events',
      'source_id = $1',
      "kind = 'TRANSITION'",
      'id <> $2',
      'at <= $3',
      "at >= (date_trunc('day', $4::timestamptz AT TIME ZONE $5) AT TIME ZONE $6)",
    ]) {
      expect(q.sql, fragment).toContain(fragment)
    }
    expect(q.sql).not.toContain('lag(')
  })
})
