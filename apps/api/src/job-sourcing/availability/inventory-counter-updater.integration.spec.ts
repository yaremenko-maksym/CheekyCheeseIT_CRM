import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../../database/schema'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { INVENTORY_CLOSE_REASON, updateInventoryMissCounter } from './inventory-counter-updater'

/**
 * r5 Task 4.6 S8c — the missing-inventory counter DB adapter against a real Postgres, as `crm_app`.
 * Fixtures are written through the migration role; the updater runs as the API's role. The staged
 * counter table is applied idempotently in setup (it is also created by `db:push`, but the apply
 * keeps the spec self-sufficient and documents the staged DDL, mirroring S8a).
 *
 * ISOLATION: every test creates its own source, record and opportunity and removes them in
 * `afterEach`, so a shared crm_qa is safe.
 */
const STAGED_SQL = join(
  __dirname,
  '..',
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-11-01_job_source_record_inventory_misses.sql',
)
const DAY = 24 * 60 * 60 * 1000
const CONFIG = 1

let session: CrmAppSession
let db: ReturnType<typeof drizzle<typeof schema>>

const sources: string[] = []
const records: string[] = []
const opps: string[] = []
const cycles: string[] = []

const q = (text: string, params: unknown[] = []) => session.admin.query(text, params)
const tag = () => randomUUID().slice(0, 12)

async function newCycle(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
    [`s8c-${tag()}`],
  )
  cycles.push(String(rows[0].id))
  return String(rows[0].id)
}

async function newSource(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_sources (type, config, config_version)
     VALUES ('GREENHOUSE_ATS', jsonb_build_object('tag', $1::text), ${CONFIG}) RETURNING id`,
    [tag()],
  )
  sources.push(String(rows[0].id))
  return String(rows[0].id)
}

async function newRecord(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
     VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2) RETURNING id, availability`,
    [`ns-${tag()}`, `key-${tag()}`],
  )
  records.push(String(rows[0].id))
  return String(rows[0].id)
}

async function newRevision(recordId: string): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_source_record_revisions
       (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity)
     VALUES ($1, 'v1', 'v1', $2, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
    [recordId, createHash('sha256').update(tag()).digest('hex')],
  )
  return String(rows[0].id)
}

interface RunSpec {
  readonly sourceId: string
  readonly cycleId: string
  readonly coverage?: string
  readonly outcome?: string
  readonly received: number
  readonly observedMs: number
  readonly configVersion?: number
}

async function addRun(spec: RunSpec): Promise<string> {
  const started = new Date(spec.observedMs - 60_000).toISOString()
  const ended = new Date(spec.observedMs).toISOString()
  const { rows } = await q(
    `INSERT INTO job_collection_runs
       (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger, coverage, outcome,
        received, created, started_at, ended_at, account_key)
     VALUES ($1, $2, $3, $4, 'v1', 'SCHEDULED', $5::job_collection_coverage, $6::job_collection_outcome,
             $7, $7, $8::timestamptz, $9::timestamptz, $10) RETURNING id`,
    [
      spec.sourceId,
      spec.cycleId,
      `attempt-${tag()}`,
      spec.configVersion ?? CONFIG,
      spec.coverage ?? 'FULL_INVENTORY',
      spec.outcome ?? 'SUCCEEDED',
      spec.received,
      started,
      ended,
      `acct-${tag()}`,
    ],
  )
  return String(rows[0].id)
}

async function addMembership(runId: string, recordId: string, revisionId: string): Promise<void> {
  await q(
    `INSERT INTO job_run_records (run_id, source_record_id, revision_id) VALUES ($1, $2, $3)`,
    [runId, recordId, revisionId],
  )
}

async function newOpportunity(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_opportunities (title, title_key) VALUES ($1, $1) RETURNING id`,
    [`s8c-${tag()}`],
  )
  opps.push(String(rows[0].id))
  return String(rows[0].id)
}

async function linkRecord(recordId: string, oppId: string): Promise<void> {
  await q(
    `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version) VALUES ($1, $2, 1)`,
    [recordId, oppId],
  )
}

async function insertCounter(
  recordId: string,
  board: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const base: Record<string, unknown> = {
    source_record_id: recordId,
    board,
    config_version: CONFIG,
    consecutive_misses: 2,
    first_miss_run_id: randomUUID(),
    first_miss_at: new Date(0).toISOString(),
    last_miss_run_id: randomUUID(),
    last_miss_at: new Date(DAY).toISOString(),
    last_inventory_size: 100,
    ...patch,
  }
  const cols = Object.keys(base)
  await q(
    `INSERT INTO job_source_record_inventory_misses (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => base[c]),
  )
}

async function counterRow(
  recordId: string,
  board: string,
): Promise<Record<string, unknown> | undefined> {
  const { rows } = await q(
    `SELECT * FROM job_source_record_inventory_misses
      WHERE source_record_id = $1 AND board = $2 AND config_version = ${CONFIG}`,
    [recordId, board],
  )
  return rows[0]
}

async function recordState(
  recordId: string,
): Promise<{ availability: string; evidence: Record<string, unknown> }> {
  const { rows } = await q(
    `SELECT availability, availability_evidence FROM job_source_records WHERE id = $1`,
    [recordId],
  )
  return { availability: String(rows[0].availability), evidence: rows[0].availability_evidence }
}

async function dirtyForOpp(oppId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await q(
    `SELECT target_version, reason, status FROM job_dirty_work
      WHERE entity_kind = 'OPPORTUNITY' AND entity_id = $1 AND reason = $2`,
    [oppId, INVENTORY_CLOSE_REASON],
  )
  return rows
}

describe.skipIf(!hasDatabaseUrl())('inventory-miss counter updater (r5 Task 4.6 S8c)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    db = drizzle(session.pool, { schema })
    // Idempotent: db:push already creates the table; the staged apply keeps the spec self-sufficient.
    await session.admin.query('BEGIN')
    try {
      await session.admin.query(readFileSync(STAGED_SQL, 'utf8'))
      await session.admin.query('COMMIT')
    } catch (e) {
      await session.admin.query('ROLLBACK')
      throw e
    }
    await session.admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON job_source_record_inventory_misses TO crm_app`,
    )
  }, 120_000)

  afterEach(async () => {
    const o = opps.splice(0)
    const r = records.splice(0)
    const s = sources.splice(0)
    const c = cycles.splice(0)
    if (o.length > 0) await q(`DELETE FROM job_dirty_work WHERE entity_id = ANY($1::uuid[])`, [o])
    if (r.length > 0)
      await q(`DELETE FROM job_opportunity_sources WHERE source_record_id = ANY($1::uuid[])`, [r])
    if (r.length > 0) await q(`DELETE FROM job_source_records WHERE id = ANY($1::uuid[])`, [r])
    if (s.length > 0)
      await q(`DELETE FROM job_collection_runs WHERE source_id = ANY($1::uuid[])`, [s])
    if (s.length > 0) await q(`DELETE FROM job_sources WHERE id = ANY($1::uuid[])`, [s])
    if (o.length > 0) await q(`DELETE FROM job_opportunities WHERE id = ANY($1::uuid[])`, [o])
    if (c.length > 0) await q(`DELETE FROM job_collection_cycles WHERE id = ANY($1::uuid[])`, [c])
  })

  afterAll(async () => {
    await session?.close()
  })

  const boardFor = (sourceId: string) => `GREENHOUSE_ATS:${sourceId.slice(0, 8)}`

  it('advance: a single absent FULL_INVENTORY run writes a fresh counter row', async () => {
    const sourceId = await newSource()
    const recordId = await newRecord()
    const cycleId = await newCycle()
    const board = boardFor(sourceId)
    await addRun({ sourceId, cycleId, received: 100, observedMs: DAY })

    const res = await updateInventoryMissCounter(db, {
      sourceRecordId: recordId,
      sourceId,
      board,
      configVersion: CONFIG,
    })

    expect(res).toMatchObject({ net: 'advance', persisted: true, closed: false, reviewed: false })
    const row = await counterRow(recordId, board)
    expect(row).toBeDefined()
    expect(Number(row?.['consecutive_misses'])).toBe(1)
    expect((await recordState(recordId)).availability).not.toBe('CLOSED')
  })

  it('close: three absent runs >=24h apart mark the record CLOSED and enqueue its opportunity, atomically', async () => {
    const sourceId = await newSource()
    const recordId = await newRecord()
    const cycleId = await newCycle()
    const oppId = await newOpportunity()
    await linkRecord(recordId, oppId)
    const board = boardFor(sourceId)
    await addRun({ sourceId, cycleId, received: 100, observedMs: 0 })
    await addRun({ sourceId, cycleId, received: 100, observedMs: DAY / 2 })
    await addRun({ sourceId, cycleId, received: 100, observedMs: DAY + 1 })

    const res = await updateInventoryMissCounter(db, {
      sourceRecordId: recordId,
      sourceId,
      board,
      configVersion: CONFIG,
    })

    expect(res).toMatchObject({ net: 'close', persisted: true, closed: true })
    expect(Number((await counterRow(recordId, board))?.['consecutive_misses'])).toBe(3)
    const state = await recordState(recordId)
    expect(state.availability).toBe('CLOSED')
    expect(state.evidence['kind']).toBe('INVENTORY_MISSING')
    const dirty = await dirtyForOpp(oppId)
    expect(dirty).toHaveLength(1)
    expect(Number(dirty[0]['target_version'])).toBe(1)
  })

  it('close atomicity: a failed record write rolls back the counter and the enqueue', async () => {
    const sourceId = await newSource()
    const recordId = await newRecord()
    const cycleId = await newCycle()
    const oppId = await newOpportunity()
    await linkRecord(recordId, oppId)
    const board = boardFor(sourceId)
    await addRun({ sourceId, cycleId, received: 100, observedMs: 0 })
    await addRun({ sourceId, cycleId, received: 100, observedMs: DAY / 2 })
    await addRun({ sourceId, cycleId, received: 100, observedMs: DAY + 1 })

    await expect(
      session.withPrivilegeWithdrawn('UPDATE', 'job_source_records', () =>
        updateInventoryMissCounter(db, {
          sourceRecordId: recordId,
          sourceId,
          board,
          configVersion: CONFIG,
        }),
      ),
    ).rejects.toThrow()

    expect(await counterRow(recordId, board)).toBeUndefined()
    expect((await recordState(recordId)).availability).not.toBe('CLOSED')
    expect(await dirtyForOpp(oppId)).toHaveLength(0)
  })

  it('reset: a present run UPDATEs the row in place, keeping the baseline and advancing the watermark, never deleting', async () => {
    const sourceId = await newSource()
    const recordId = await newRecord()
    const cycleId = await newCycle()
    const board = boardFor(sourceId)
    await insertCounter(recordId, board, { consecutive_misses: 2, last_inventory_size: 100 })
    const revisionId = await newRevision(recordId)
    const presentRunId = await addRun({ sourceId, cycleId, received: 90, observedMs: 2 * DAY })
    await addMembership(presentRunId, recordId, revisionId)

    const res = await updateInventoryMissCounter(db, {
      sourceRecordId: recordId,
      sourceId,
      board,
      configVersion: CONFIG,
    })

    expect(res.net).toBe('reset')
    const row = await counterRow(recordId, board)
    expect(row).toBeDefined() // never deleted
    expect(Number(row?.['consecutive_misses'])).toBe(0)
    expect(Number(row?.['last_inventory_size'])).toBe(100) // baseline kept
    expect(String(row?.['last_miss_run_id'])).toBe(presentRunId) // watermark advanced
  })

  it('review: a >50% inventory drop reviews without writing a counter row', async () => {
    const sourceId = await newSource()
    const recordId = await newRecord()
    const cycleId = await newCycle()
    const board = boardFor(sourceId)
    // Prior healthy inventory sizes seed the drop-guard baseline (100); the record is present there.
    const revisionId = await newRevision(recordId)
    const healthy = await addRun({ sourceId, cycleId, received: 100, observedMs: 0 })
    await addMembership(healthy, recordId, revisionId)
    await addRun({ sourceId, cycleId, received: 40, observedMs: DAY }) // collapsed, record absent

    const res = await updateInventoryMissCounter(db, {
      sourceRecordId: recordId,
      sourceId,
      board,
      configVersion: CONFIG,
    })

    expect(res).toMatchObject({ net: 'review', persisted: false, reviewed: true, closed: false })
    expect(await counterRow(recordId, board)).toBeUndefined()
    expect((await recordState(recordId)).availability).not.toBe('CLOSED')
  })

  it('unchanged: a present-only run writes nothing', async () => {
    const sourceId = await newSource()
    const recordId = await newRecord()
    const cycleId = await newCycle()
    const board = boardFor(sourceId)
    const revisionId = await newRevision(recordId)
    const runId = await addRun({ sourceId, cycleId, received: 100, observedMs: DAY })
    await addMembership(runId, recordId, revisionId)

    const res = await updateInventoryMissCounter(db, {
      sourceRecordId: recordId,
      sourceId,
      board,
      configVersion: CONFIG,
    })

    expect(res).toMatchObject({ net: 'unchanged', persisted: false, closed: false })
    expect(await counterRow(recordId, board)).toBeUndefined()
  })

  it('idempotent: re-running the close over the same runs does not double-advance or double-enqueue', async () => {
    const sourceId = await newSource()
    const recordId = await newRecord()
    const cycleId = await newCycle()
    const oppId = await newOpportunity()
    await linkRecord(recordId, oppId)
    const board = boardFor(sourceId)
    await addRun({ sourceId, cycleId, received: 100, observedMs: 0 })
    await addRun({ sourceId, cycleId, received: 100, observedMs: DAY / 2 })
    await addRun({ sourceId, cycleId, received: 100, observedMs: DAY + 1 })
    const input = { sourceRecordId: recordId, sourceId, board, configVersion: CONFIG }

    const first = await updateInventoryMissCounter(db, input)
    const second = await updateInventoryMissCounter(db, input)

    expect(first.net).toBe('close')
    expect(second.net).toBe('unchanged')
    expect(Number((await counterRow(recordId, board))?.['consecutive_misses'])).toBe(3)
    expect(await dirtyForOpp(oppId)).toHaveLength(1)
    expect((await recordState(recordId)).availability).toBe('CLOSED')
  })

  it('config change: a run under a new configVersion opens a new row and leaves the old chain untouched', async () => {
    const sourceId = await newSource()
    const recordId = await newRecord()
    const cycleId = await newCycle()
    const board = boardFor(sourceId)
    // An existing chain under configVersion 1.
    await insertCounter(recordId, board, { config_version: 1, consecutive_misses: 2 })
    // A run under configVersion 2 (a different observation regime).
    await addRun({ sourceId, cycleId, received: 100, observedMs: DAY, configVersion: 2 })

    const res = await updateInventoryMissCounter(db, {
      sourceRecordId: recordId,
      sourceId,
      board,
      configVersion: 2,
    })

    expect(res.net).toBe('advance')
    const { rows } = await q(
      `SELECT config_version, consecutive_misses FROM job_source_record_inventory_misses
        WHERE source_record_id = $1 AND board = $2 ORDER BY config_version`,
      [recordId, board],
    )
    expect(rows).toHaveLength(2)
    expect(Number(rows[0].consecutive_misses)).toBe(2) // config 1 untouched
    expect(Number(rows[1].consecutive_misses)).toBe(1) // config 2 fresh chain
  })
})
