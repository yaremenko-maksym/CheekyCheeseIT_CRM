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
import { SourceHealthWeeklyReportCron } from './source-health-weekly-report.cron'

/**
 * Source-fetch-strategy U5a — the Monday ADMIN report against a REAL Postgres, as `crm_app`.
 * Hand-counted expectations (not recomputed with the code's own formula): see the seed below.
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
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const MIN_MS = 60_000

let session: CrmAppSession
let admin: Pool
let fx: LedgerFixtures
let cron: SourceHealthWeeklyReportCron
const userIds: string[] = []
const namespaces: string[] = []

async function makeUser(role: string, archived = false): Promise<string> {
  const id = randomUUID()
  userIds.push(id)
  await admin.query(
    `INSERT INTO users (id, email, display_name, role, archived_at)
     VALUES ($1, $2, 'u5a-weekly-spec', $3::role, ${archived ? 'now()' : 'NULL'})`,
    [id, `u5a-weekly-${id}@example.invalid`, role],
  )
  return id
}

interface ReportData {
  weekStart: string
  sources: {
    name: string
    state: string
    transitions: number
    runs: number
    freshnessP50Min: number | null
    freshnessP90Min: number | null
    requests: number
    bytes: number
  }[]
}

async function reportsOf(userId: string): Promise<ReportData[]> {
  const { rows } = await admin.query<{ data: ReportData }>(
    `SELECT data FROM notifications WHERE user_id = $1 AND type = 'SOURCE_HEALTH_WEEKLY_REPORT'`,
    [userId],
  )
  return rows.map((r) => r.data)
}

describe.skipIf(!hasDatabaseUrl())('U5a weekly ADMIN report', () => {
  let activeAdmin: string
  let archivedAdmin: string
  let senior: string
  let sourceId: string
  let manifestId: string

  beforeAll(async () => {
    session = await openCrmAppSession()
    admin = session.admin
    const { rows } = await admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await admin.query('BEGIN')
    await admin.query(readFileSync(STAGED_FILE, 'utf8'))
    await admin.query('COMMIT')
    fx = new LedgerFixtures(admin, `u5aw${Date.now().toString(36)}`)
    const notifications = new NotificationsService(
      session.databaseService,
      makeTelemetryErrorsStub() as never,
    )
    cron = new SourceHealthWeeklyReportCron(session.databaseService, notifications)
    activeAdmin = await makeUser('ADMIN')
    archivedAdmin = await makeUser('ADMIN', true)
    senior = await makeUser('SENIOR')

    // The source: a young one, whose FIRST run is 5 days ago (so its backlog falls in the week).
    sourceId = await fx.source({ type: 'REMOTIVE_API', hostKey: null, consecutiveFailures: 1 })
    manifestId = await fx.manifestIdOf(sourceId)
    const ns = `u5aw-ns-${randomUUID()}`
    namespaces.push(ns)
    await admin.query(`UPDATE job_sources SET namespace = $2 WHERE id = $1`, [sourceId, ns])
    const { rows: cyc } = await admin.query(
      `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
      [`u5aw:${randomUUID()}`],
    )
    const now = Date.now()
    const insertRun = async (startedAgoMs: number, requests: number, bytes: number) => {
      const started = new Date(now - startedAgoMs)
      await admin.query(
        `INSERT INTO job_collection_runs
           (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger, outcome,
            received, created, unchanged, started_at, ended_at, account_key, request_count, bytes_read)
         VALUES ($1, $2, $3, 1, 'remotive_api-1', 'SCHEDULED', 'SUCCEEDED', 0, 0, 0, $4, $5, $6, $7, $8)`,
        [
          sourceId,
          cyc[0].id,
          `att-${randomUUID()}`,
          started.toISOString(),
          new Date(started.getTime() + 2_000).toISOString(),
          `#source:${sourceId}`,
          requests,
          bytes,
        ],
      )
    }
    await insertRun(5 * DAY_MS, 10, 1_000) // the FIRST run: ended 5d ago + 2s
    await insertRun(2 * DAY_MS, 5, 500)

    // Records: R1 first seen DURING the first run (backlog, excluded, very old publication),
    // R2 and R3 first seen yesterday, published 30 and 90 minutes before being seen.
    const firstRunEnd = now - 5 * DAY_MS + 2_000
    const yesterday = now - DAY_MS
    const seed = async (seen: number, publishedBefore: number) => {
      const { rows: rec } = await admin.query(
        `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, first_seen_at)
         VALUES ('REMOTIVE_API', $1, 'NATIVE_ID', $2, $3) RETURNING id`,
        [ns, JSON.stringify([randomUUID()]), new Date(seen).toISOString()],
      )
      await admin.query(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, normalized,
            original_identity, published_at)
         VALUES ($1, 'remotive_api-1', 'n1', $2, '{}'::jsonb, '{}'::jsonb, $3)`,
        [rec[0].id, 'a'.repeat(64), new Date(seen - publishedBefore).toISOString()],
      )
    }
    await seed(firstRunEnd - 1_000, 10 * DAY_MS)
    await seed(yesterday, 30 * MIN_MS)
    await seed(yesterday, 90 * MIN_MS)

    // One real pass classifies the source (consecutive_failures = 1 -> FAILING): one TRANSITION.
    await new JobSourceHealthService(session.databaseService).runDetectorPass(new Date())
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await admin
        .query(
          `ALTER TABLE job_source_health_events DISABLE TRIGGER trg_job_source_health_events_append_only`,
        )
        .catch(() => undefined)
      for (const ns of namespaces) {
        await admin.query(
          `DELETE FROM job_source_record_revisions WHERE source_record_id IN
             (SELECT id FROM job_source_records WHERE namespace = $1)`,
          [ns],
        )
        await admin.query(`DELETE FROM job_source_records WHERE namespace = $1`, [ns])
      }
      for (const id of fx?.sourceIds ?? []) {
        await admin.query(`DELETE FROM job_source_health_events WHERE source_id = $1`, [id])
        await admin.query(`DELETE FROM job_collection_runs WHERE source_id = $1`, [id])
      }
      await admin.query(`DELETE FROM job_collection_cycles WHERE trigger_key LIKE 'u5aw:%'`)
      for (const id of userIds) await admin.query(`DELETE FROM users WHERE id = $1`, [id])
      await fx?.cleanup()
    } finally {
      await session.close()
    }
  })

  it('reports the hand-counted figures to every active ADMIN, and to nobody else', async () => {
    const created = await cron.run(new Date())
    expect(created).toBeGreaterThanOrEqual(1)

    const reports = await reportsOf(activeAdmin)
    expect(reports).toHaveLength(1)
    const row = reports[0]!.sources.find((s) => s.name === manifestId)
    expect(row).toEqual({
      name: manifestId,
      state: 'FAILING',
      transitions: 1,
      runs: 2,
      freshnessP50Min: 60, // median of [30, 90]; the backlog record is excluded
      freshnessP90Min: 84, // 30 + 0.9 * (90 - 30)
      requests: 15,
      bytes: 1_500,
    })
    expect(await reportsOf(archivedAdmin)).toEqual([])
    expect(await reportsOf(senior)).toEqual([])
  })

  it('a second run of the same Monday (another replica) adds nothing', async () => {
    await cron.run(new Date())
    expect(await reportsOf(activeAdmin)).toHaveLength(1)
  })
})
