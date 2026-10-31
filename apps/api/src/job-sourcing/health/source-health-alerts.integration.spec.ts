import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { jobSourceHealthEvents } from '../../database/schema'
import { NotificationsService } from '../../notifications/notifications.service'
import { makeTelemetryErrorsStub } from '../../telemetry/__test-helpers__/telemetry-errors-stub'
import { LedgerFixtures } from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { JobSourceHealthService } from './job-source-health.service'
import { SourceHealthAlertService } from './source-health-alert.service'

/**
 * Source-fetch-strategy U5a AC 1-4 against a REAL Postgres, as `crm_app`.
 *
 *  - AC 1: entering FAILING enqueues one notification (and one email) per ACTIVE ADMIN, none to any
 *    other role.
 *  - AC 2: staying FAILING across passes enqueues nothing more.
 *  - AC 3: the 4th alerting entry of one source in one Kyiv day is in-app only (no 4th email).
 *  - AC 4: a deactivated (archived) ADMIN receives nothing.
 * Plus: the cap is per KYIV day (events either side of Kyiv midnight), and two racing passes
 * produce one alert, not two (CR-M-1).
 *
 * AC 1, 2 and 4 drive the real detector pass. AC 3, the midnight case and the race drive the alert
 * service directly with events at FIXED instants, so no result depends on the wall clock.
 * NEVER crm_db; DATABASE_URL points at a scratch database, inline.
 */
const STAGED_FILE = join(
  __dirname,
  '..',
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-10-31_job_source_health_events.sql',
)

let session: CrmAppSession
let admin: Pool
let fx: LedgerFixtures
let health: JobSourceHealthService
let alerts: SourceHealthAlertService
const userIds: string[] = []
const NOW = new Date('2026-02-01T12:00:00.000Z')

async function makeUser(role: string, archived = false): Promise<string> {
  const id = randomUUID()
  userIds.push(id)
  await admin.query(
    `INSERT INTO users (id, email, display_name, role, archived_at)
     VALUES ($1, $2, 'u5a-spec', $3::role, ${archived ? 'now()' : 'NULL'})`,
    [id, `u5a-${id}@example.invalid`, role],
  )
  return id
}

async function setFailures(sourceId: string, n: number): Promise<void> {
  await admin.query(`UPDATE job_sources SET consecutive_failures = $2 WHERE id = $1`, [sourceId, n])
}

interface AlertRow {
  user_id: string
  role: string
  archived: boolean
  email_rows: number
}

/** Every SOURCE_HEALTH_ALERT notification of one source, oldest first, with the email-row count. */
async function alertsFor(manifestId: string): Promise<AlertRow[]> {
  const { rows } = await admin.query<AlertRow>(
    `SELECT n.user_id, u.role::text AS role, (u.archived_at IS NOT NULL) AS archived,
            (SELECT count(*)::int FROM notification_emails e WHERE e.notification_id = n.id) AS email_rows
       FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.type = 'SOURCE_HEALTH_ALERT' AND n.data->>'sourceName' = $1
      ORDER BY n.created_at, n.id`,
    [manifestId],
  )
  return rows
}

/** One transition at a FIXED instant, written and alerted in one transaction, as the pass does. */
async function fire(
  sourceId: string,
  sourceName: string,
  at: string,
  fromState: string | null,
  toState: string,
  reason: string | null = null,
  hold?: () => Promise<void>,
): Promise<void> {
  await session.databaseService.db.transaction(async (tx) => {
    const [event] = await tx
      .insert(jobSourceHealthEvents)
      .values({
        sourceId,
        kind: 'TRANSITION',
        fromState,
        toState,
        reasonCode: reason,
        at: new Date(at),
      } as typeof jobSourceHealthEvents.$inferInsert)
      .returning({ id: jobSourceHealthEvents.id, at: jobSourceHealthEvents.at })
    await alerts.alertOnTransition(tx, {
      eventId: event!.id,
      at: event!.at,
      sourceId,
      sourceName,
      to: { state: toState, reason },
      failures: 1,
      since: null,
    })
    if (hold !== undefined) await hold()
  })
}

describe.skipIf(!hasDatabaseUrl())('U5a ADMIN alerts on health transitions', () => {
  let activeAdminA: string
  let activeAdminB: string
  let archivedAdmin: string
  let senior: string
  let hr: string

  beforeAll(async () => {
    session = await openCrmAppSession()
    admin = session.admin
    const { rows } = await admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await admin.query('BEGIN')
    await admin.query(readFileSync(STAGED_FILE, 'utf8'))
    await admin.query('COMMIT')
    fx = new LedgerFixtures(admin, `u5a${Date.now().toString(36)}`)
    const notifications = new NotificationsService(
      session.databaseService,
      makeTelemetryErrorsStub() as never,
    )
    alerts = new SourceHealthAlertService(notifications)
    health = new JobSourceHealthService(session.databaseService, alerts)
    activeAdminA = await makeUser('ADMIN')
    activeAdminB = await makeUser('ADMIN')
    archivedAdmin = await makeUser('ADMIN', true)
    senior = await makeUser('SENIOR')
    hr = await makeUser('HR')
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await admin
        .query(
          `ALTER TABLE job_source_health_events DISABLE TRIGGER trg_job_source_health_events_append_only`,
        )
        .catch(() => undefined)
      for (const id of fx?.sourceIds ?? []) {
        await admin.query(`DELETE FROM job_source_health_events WHERE source_id = $1`, [id])
      }
      // notifications and notification_emails cascade with the user.
      for (const id of userIds) await admin.query(`DELETE FROM users WHERE id = $1`, [id])
      await fx?.cleanup()
    } finally {
      await session.close()
    }
  })

  it('AC 1 + 4: entering FAILING alerts every ACTIVE admin once, with one email each, and nobody else', async () => {
    const sourceId = await fx.source({ type: 'REMOTIVE_API', hostKey: null })
    const manifestId = await fx.manifestIdOf(sourceId)
    await setFailures(sourceId, 1)

    await health.runDetectorPass(NOW)

    const rows = await alertsFor(manifestId)
    const recipients = rows.map((r) => r.user_id)
    expect(recipients).toEqual(expect.arrayContaining([activeAdminA, activeAdminB]))
    // Exactly one notification per recipient, and every recipient is an active ADMIN.
    expect(new Set(recipients).size).toBe(recipients.length)
    expect(rows.every((r) => r.role === 'ADMIN' && !r.archived)).toBe(true)
    expect(recipients).not.toContain(archivedAdmin)
    expect(recipients).not.toContain(senior)
    expect(recipients).not.toContain(hr)
    expect(rows.every((r) => r.email_rows === 1)).toBe(true)
  })

  it('AC 2: staying FAILING across passes enqueues nothing more', async () => {
    const sourceId = await fx.source({ type: 'REMOTIVE_API', hostKey: null })
    const manifestId = await fx.manifestIdOf(sourceId)
    await setFailures(sourceId, 1)
    await health.runDetectorPass(NOW)
    const afterFirst = (await alertsFor(manifestId)).length
    expect(afterFirst).toBeGreaterThanOrEqual(2)

    await setFailures(sourceId, 2) // still FAILING, only the count moved
    await health.runDetectorPass(NOW)
    await health.runDetectorPass(NOW)

    expect(await alertsFor(manifestId)).toHaveLength(afterFirst)
  })

  it('a new alert follows recovery plus a new breakage', async () => {
    const sourceId = await fx.source({ type: 'REMOTIVE_API', hostKey: null })
    const manifestId = await fx.manifestIdOf(sourceId)
    await setFailures(sourceId, 1)
    await health.runDetectorPass(NOW)
    const first = (await alertsFor(manifestId)).length

    await setFailures(sourceId, 0)
    await health.runDetectorPass(NOW) // recovery: HEALTHY, no alert
    expect(await alertsFor(manifestId)).toHaveLength(first)

    await setFailures(sourceId, 1)
    await health.runDetectorPass(NOW)
    expect(await alertsFor(manifestId)).toHaveLength(first * 2)
  })

  it('AC 3: the 4th alerting entry of one source in one Kyiv day is in-app only (fixed clock)', async () => {
    const sourceId = await fx.source({ type: 'REMOTIVE_API', hostKey: null })
    const name = await fx.manifestIdOf(sourceId)
    // 10:00 to 11:00 on 10 March 2026 in Kyiv (UTC+2): one Kyiv day.
    for (const hhmm of ['08:00', '08:20', '08:40', '09:00']) {
      await fire(sourceId, name, `2026-03-10T${hhmm}:00Z`, 'HEALTHY', 'FAILING')
      await fire(
        sourceId,
        name,
        `2026-03-10T${hhmm.replace(/:00$/, ':10')}:00Z`,
        'FAILING',
        'HEALTHY',
      )
    }
    const rows = await alertsFor(name)
    for (const adminId of [activeAdminA, activeAdminB]) {
      const mine = rows.filter((r) => r.user_id === adminId)
      expect(mine.map((r) => r.email_rows)).toEqual([1, 1, 1, 0])
    }
  })

  it('the cap is per KYIV day: the 4th entry before Kyiv midnight is in-app only, the first after it emails', async () => {
    const sourceId = await fx.source({ type: 'REMOTIVE_API', hostKey: null })
    const name = await fx.manifestIdOf(sourceId)
    // Kyiv midnight between 9 and 10 March 2026 is 2026-03-09T22:00:00Z (UTC+2).
    const entries = [
      '2026-03-09T20:00:00Z',
      '2026-03-09T20:20:00Z',
      '2026-03-09T20:40:00Z',
      '2026-03-09T21:50:00Z', // 4th of the Kyiv day of the 9th, 23:50 local
      '2026-03-09T22:10:00Z', // first of the Kyiv day of the 10th, 00:10 local
    ]
    for (const at of entries) {
      await fire(sourceId, name, at, 'HEALTHY', 'FAILING')
      await fire(
        sourceId,
        name,
        new Date(Date.parse(at) + 5 * 60_000).toISOString(),
        'FAILING',
        'HEALTHY',
      )
    }
    const mine = (await alertsFor(name)).filter((r) => r.user_id === activeAdminA)
    expect(mine.map((r) => r.email_rows)).toEqual([1, 1, 1, 0, 1])
  })

  it('two racing passes on one source produce ONE alert, not two (CR-M-1)', async () => {
    const sourceId = await fx.source({ type: 'REMOTIVE_API', hostKey: null })
    const name = await fx.manifestIdOf(sourceId)

    let firstHasAlerted: () => void = () => undefined
    const alerted = new Promise<void>((resolve) => (firstHasAlerted = resolve))
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => (release = resolve))

    // Pass A writes its event, alerts, and holds its transaction open.
    const a = fire(sourceId, name, '2026-03-11T10:00:00Z', 'HEALTHY', 'FAILING', null, async () => {
      firstHasAlerted()
      await released
    })
    await alerted
    // Pass B wrote the SAME transition from the same stale previous state; its alert must wait for
    // A's lock, then find A's event as its predecessor.
    const b = fire(sourceId, name, '2026-03-11T10:00:01Z', 'HEALTHY', 'FAILING')
    await new Promise((r) => setTimeout(r, 300))
    release()
    await Promise.all([a, b])

    const rows = await alertsFor(name)
    for (const adminId of [activeAdminA, activeAdminB]) {
      const mine = rows.filter((r) => r.user_id === adminId)
      expect(mine).toHaveLength(1)
      expect(mine[0]!.email_rows).toBe(1)
    }
  })
})
