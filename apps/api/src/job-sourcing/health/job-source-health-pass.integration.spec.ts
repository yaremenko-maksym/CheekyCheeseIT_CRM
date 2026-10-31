import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { LedgerFixtures } from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { JobSourceHealthService } from './job-source-health.service'

/**
 * Source-fetch-strategy U4 AC 3 and AC 4 — the detector pass against a REAL Postgres, as crm_app.
 *
 *  - AC 3: two passes over unchanged data write ONE event for a source, not two.
 *  - AC 4: a 304 ending does NOT count toward EMPTY_RESPONSE (a source whose recent runs are 304s
 *    over a non-empty history stays HEALTHY), while a genuine pair of empty answers is EMPTY.
 *
 * The append-only UPDATE/DELETE refusal is pinned by job-source-health-events-ddl.integration.
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

const NOW = new Date('2026-02-01T12:00:00.000Z')
const DAY_MS = 86_400_000

/** One SCHEDULED cycle to hang runs off. */
async function makeCycle(): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
    [`u4pass:${randomUUID()}`],
  )
  return rows[0].id as string
}

interface RunSeed {
  daysAgo: number
  received: number
  created?: number
  lastHttpStatus?: number
  outcome?: 'SUCCEEDED' | 'FAILED'
}

/** A terminal run; for SUCCEEDED the dispositions are balanced so ck_succeeded_complete holds. */
async function insertRun(sourceId: string, cycleId: string, seed: RunSeed): Promise<string> {
  const startedAt = new Date(NOW.getTime() - seed.daysAgo * DAY_MS)
  const endedAt = new Date(startedAt.getTime() + 2_000)
  const outcome = seed.outcome ?? 'SUCCEEDED'
  const created = seed.created ?? 0
  const unchanged = outcome === 'SUCCEEDED' ? seed.received - created : 0
  const { rows } = await admin.query(
    `INSERT INTO job_collection_runs
       (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger, outcome,
        received, created, unchanged, last_http_status, started_at, ended_at, account_key)
     VALUES ($1, $2, $3, 1, 'remotive_api-1', 'SCHEDULED', $11,
             $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      sourceId,
      cycleId,
      `att-${randomUUID()}`,
      seed.received,
      created,
      unchanged,
      seed.lastHttpStatus ?? 200,
      startedAt.toISOString(),
      endedAt.toISOString(),
      `#source:${sourceId}`,
      outcome,
    ],
  )
  return rows[0].id as string
}

async function eventsFor(sourceId: string) {
  const { rows } = await admin.query(
    `SELECT kind, from_state, to_state, reason_code FROM job_source_health_events
      WHERE source_id = $1 ORDER BY at ASC`,
    [sourceId],
  )
  return rows as {
    kind: string
    from_state: string | null
    to_state: string | null
    reason_code: string | null
  }[]
}

describe.skipIf(!hasDatabaseUrl())('U4 detector pass', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    admin = session.admin
    const { rows } = await admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    // Apply the staged DDL to public (CREATE TABLE IF NOT EXISTS is a no-op; adds the triggers).
    await admin.query('BEGIN')
    await admin.query(readFileSync(STAGED_FILE, 'utf8'))
    await admin.query('COMMIT')
    fx = new LedgerFixtures(admin, `u4pass${Date.now().toString(36)}`)
    health = new JobSourceHealthService(session.databaseService)
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
        await admin.query(`DELETE FROM job_collection_runs WHERE source_id = $1`, [id])
      }
      await admin.query(`DELETE FROM job_collection_cycles WHERE trigger_key LIKE 'u4pass:%'`)
      await fx?.cleanup()
    } finally {
      await session.close()
    }
  })

  it('AC 3: two passes over unchanged data write ONE event, not two', async () => {
    const sourceId = await fx.source({ type: 'REMOTIVE_API', hostKey: null })
    const cycle = await makeCycle()
    // A healthy history: items arriving, nothing wrong.
    await insertRun(sourceId, cycle, { daysAgo: 1, received: 50, created: 2 })
    await insertRun(sourceId, cycle, { daysAgo: 2, received: 50, created: 1 })

    const first = await health.runDetectorPass(NOW)
    expect(first.eventsWritten).toBeGreaterThanOrEqual(1)
    const afterFirst = await eventsFor(sourceId)
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0]).toMatchObject({
      kind: 'TRANSITION',
      from_state: null,
      to_state: 'HEALTHY',
    })

    // Nothing changed → the second pass writes nothing for this source.
    await health.runDetectorPass(NOW)
    expect(await eventsFor(sourceId)).toHaveLength(1)
  })

  it('AC 4: a 304 ending does not count toward EMPTY_RESPONSE; a real empty pair is EMPTY', async () => {
    const notModified = await fx.source({ type: 'REMOTIVE_API', hostKey: null })
    const cycleA = await makeCycle()
    // Two most recent runs are 304 (received 0), over a non-empty history.
    await insertRun(notModified, cycleA, { daysAgo: 1, received: 0, lastHttpStatus: 304 })
    await insertRun(notModified, cycleA, { daysAgo: 2, received: 0, lastHttpStatus: 304 })
    await insertRun(notModified, cycleA, { daysAgo: 3, received: 40 })
    await insertRun(notModified, cycleA, { daysAgo: 4, received: 40 })

    const empty = await fx.source({ type: 'REMOTIVE_API', hostKey: null })
    const cycleB = await makeCycle()
    // Two most recent runs are genuine empties (200, received 0), over the same non-empty history.
    await insertRun(empty, cycleB, { daysAgo: 1, received: 0 })
    await insertRun(empty, cycleB, { daysAgo: 2, received: 0 })
    await insertRun(empty, cycleB, { daysAgo: 3, received: 40 })
    await insertRun(empty, cycleB, { daysAgo: 4, received: 40 })

    await health.runDetectorPass(NOW)

    const notModifiedEvents = await eventsFor(notModified)
    expect(notModifiedEvents.at(-1)?.to_state).toBe('HEALTHY')
    expect(notModifiedEvents.map((e) => e.reason_code)).not.toContain('EMPTY_RESPONSE')

    const emptyEvents = await eventsFor(empty)
    expect(emptyEvents.at(-1)).toMatchObject({ to_state: 'EMPTY', reason_code: 'EMPTY_RESPONSE' })
  })

  it('records the runs that bracket the change and the evidence', async () => {
    const sourceId = await fx.source({
      type: 'REMOTIVE_API',
      hostKey: null,
      consecutiveFailures: 1,
    })
    const cycle = await makeCycle()
    // Newest is a failed run; the one before it is the last good reading.
    const badRun = await insertRun(sourceId, cycle, {
      daysAgo: 1,
      received: 0,
      outcome: 'FAILED',
      lastHttpStatus: 500,
    })
    const goodRun = await insertRun(sourceId, cycle, { daysAgo: 2, received: 40, created: 1 })

    await health.runDetectorPass(NOW)

    const { rows } = await admin.query(
      `SELECT to_state, first_bad_run_id, last_good_run_id, evidence
         FROM job_source_health_events WHERE source_id = $1 ORDER BY at DESC LIMIT 1`,
      [sourceId],
    )
    expect(rows[0].to_state).toBe('FAILING')
    expect(rows[0].first_bad_run_id).toBe(badRun)
    expect(rows[0].last_good_run_id).toBe(goodRun)
    expect(rows[0].evidence).toMatchObject({ consecutiveFailures: 1 })
    expect(Array.isArray(rows[0].evidence.reasons)).toBe(true)
  })
})
