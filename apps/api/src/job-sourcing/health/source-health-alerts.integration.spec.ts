import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { NotificationsService } from '../../notifications/notifications.service'
import { makeTelemetryErrorsStub } from '../../telemetry/__test-helpers__/telemetry-errors-stub'
import { LedgerFixtures } from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { JobSourceHealthService } from './job-source-health.service'
import { SourceHealthAlertService } from './source-health-alert.service'

/**
 * Source-fetch-strategy U5a AC 1-4 against a REAL Postgres, as `crm_app`: the alert is a side
 * effect of the detector pass writing a TRANSITION event, so these drive the real pass and read
 * the real `notifications` / `notification_emails` rows.
 *
 *  - AC 1: entering FAILING enqueues one notification (and one email) per ACTIVE ADMIN, none to any
 *    other role.
 *  - AC 2: staying FAILING across passes enqueues nothing more.
 *  - AC 3: the 4th alerting entry of one source in one Kyiv day is in-app only (no 4th email).
 *  - AC 4: a deactivated (archived) ADMIN receives nothing.
 *
 * NEVER crm_db; DATABASE_URL points at a scratch database, inline. A run that straddles Kyiv
 * midnight (21:00-22:00 UTC) could split the day buckets of AC 3: do not run it then.
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

/** Every SOURCE_HEALTH_ALERT notification of one source, with the recipient's role and email rows. */
async function alertsFor(manifestId: string): Promise<AlertRow[]> {
  const { rows } = await admin.query<AlertRow>(
    `SELECT n.user_id, u.role::text AS role, (u.archived_at IS NOT NULL) AS archived,
            (SELECT count(*)::int FROM notification_emails e WHERE e.notification_id = n.id) AS email_rows
       FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.type = 'SOURCE_HEALTH_ALERT' AND n.data->>'sourceName' = $1
      ORDER BY n.created_at`,
    [manifestId],
  )
  return rows
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
    health = new JobSourceHealthService(
      session.databaseService,
      new SourceHealthAlertService(notifications),
    )
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

  it('AC 3: the 4th alerting entry of one source in one Kyiv day is in-app only', async () => {
    const sourceId = await fx.source({ type: 'REMOTIVE_API', hostKey: null })
    const manifestId = await fx.manifestIdOf(sourceId)
    for (let i = 0; i < 4; i++) {
      await setFailures(sourceId, 1)
      await health.runDetectorPass(NOW) // enters FAILING
      await setFailures(sourceId, 0)
      await health.runDetectorPass(NOW) // recovers
    }

    const rows = await alertsFor(manifestId)
    const perAdmin = (userId: string) => rows.filter((r) => r.user_id === userId)
    // Four in-app alerts for each admin, but only the first three carry an email.
    for (const adminId of [activeAdminA, activeAdminB]) {
      expect(perAdmin(adminId)).toHaveLength(4)
      expect(perAdmin(adminId).map((r) => r.email_rows)).toEqual([1, 1, 1, 0])
    }
  })
})
