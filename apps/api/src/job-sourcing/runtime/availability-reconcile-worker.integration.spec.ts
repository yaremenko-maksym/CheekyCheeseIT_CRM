import { randomUUID } from 'node:crypto'
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
import { INVENTORY_CLOSE_REASON } from '../availability/inventory-counter-updater'
import { enqueueDirty } from '../ownership/dirty-work.store'
import { type RecomputeSteps, RecomputeWorker } from './recompute-worker'
import { createAvailabilityReconcileSteps } from './availability-reconcile-worker'

/**
 * r5 Task 4.6 S8d — the availability reconciliation worker against a real Postgres, as `crm_app`.
 * It proves the DB-persistence paths the mutation gate cannot cover (Stryker skips integration
 * specs): the S8c updater is reached from a SOURCE_RECORD dirty row, and an OPPORTUNITY dirty row
 * re-derives availability + bumps revision while leaving matches alone.
 *
 * ISOLATION (mirrors the S4a worker spec): every row the worker may claim is scoped to this spec's
 * namespace; `pin` dates the spec's PENDING rows in 2000 so they sort first, `runMine` claims
 * exactly that many and asserts every claimed id is the spec's.
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
const TAG = randomUUID().slice(0, 8)
const NAMESPACE = `s8d-${TAG}-ns`

let session: CrmAppSession
let db: ReturnType<typeof drizzle<typeof schema>>
let senior: string

const q = (text: string, params: unknown[] = []) => session.admin.query(text, params)
const tag = () => randomUUID().slice(0, 12)
const board = `GREENHOUSE_ATS:${NAMESPACE}`

/** The spec's dirty rows: records in its namespace and the opportunities they link to. */
const MINE = `entity_id IN (SELECT id FROM job_source_records WHERE namespace = '${NAMESPACE}')
  OR entity_id IN (SELECT s.opportunity_id FROM job_opportunity_sources s
                     JOIN job_source_records r ON r.id = s.source_record_id
                    WHERE r.namespace = '${NAMESPACE}')`

async function newSource(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_sources (type, namespace, config, config_version)
     VALUES ('GREENHOUSE_ATS', $1, jsonb_build_object('ns', $1::text), ${CONFIG}) RETURNING id`,
    [NAMESPACE],
  )
  return String(rows[0].id)
}

async function newRecord(availability = 'UNKNOWN'): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, availability)
     VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3::job_availability) RETURNING id`,
    [NAMESPACE, `key-${tag()}`, availability],
  )
  return String(rows[0].id)
}

async function newCycle(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
    [`s8d-${tag()}`],
  )
  return String(rows[0].id)
}

async function addAbsentRun(sourceId: string, cycleId: string, observedMs: number): Promise<void> {
  const started = new Date(observedMs - 60_000).toISOString()
  const ended = new Date(observedMs).toISOString()
  await q(
    `INSERT INTO job_collection_runs
       (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger, coverage, outcome,
        received, created, started_at, ended_at, account_key)
     VALUES ($1, $2, $3, ${CONFIG}, 'v1', 'SCHEDULED', 'FULL_INVENTORY', 'SUCCEEDED',
             100, 100, $4::timestamptz, $5::timestamptz, $6)`,
    [sourceId, cycleId, `attempt-${tag()}`, started, ended, `acct-${tag()}`],
  )
}

async function newOpportunity(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_opportunities (title, title_key) VALUES ($1, $1) RETURNING id`,
    [`s8d-${tag()}`],
  )
  return String(rows[0].id)
}

async function link(recordId: string, oppId: string): Promise<void> {
  await q(
    `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version) VALUES ($1, $2, '1')`,
    [recordId, oppId],
  )
}

async function oppRow(id: string): Promise<{ availability: string; revision: number }> {
  const { rows } = await q(`SELECT availability, revision FROM job_opportunities WHERE id = $1`, [
    id,
  ])
  return { availability: String(rows[0].availability), revision: Number(rows[0].revision) }
}

async function counterRow(recordId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await q(
    `SELECT consecutive_misses FROM job_source_record_inventory_misses
      WHERE source_record_id = $1 AND board = $2 AND config_version = ${CONFIG}`,
    [recordId, board],
  )
  return rows[0]
}

async function insertMatch(oppId: string, revision: number): Promise<void> {
  await q(
    `INSERT INTO job_opportunity_matches
       (opportunity_id, senior_id, opportunity_revision, senior_profile_version, exclusion_version,
        rule_version, outcome)
     VALUES ($1, $2, $3, 'pv1', 'ev1', 'RULE-1', 'LEAD')`,
    [oppId, senior, revision],
  )
}

async function matchRevision(oppId: string): Promise<number | undefined> {
  const { rows } = await q(
    `SELECT opportunity_revision FROM job_opportunity_matches WHERE opportunity_id = $1`,
    [oppId],
  )
  return rows[0] === undefined ? undefined : Number(rows[0].opportunity_revision)
}

async function pending(): Promise<{ id: string; entity_kind: string; status: string }[]> {
  const { rows } = await q(
    `SELECT id, entity_kind, status FROM job_dirty_work WHERE (${MINE}) ORDER BY created_at, id`,
  )
  return rows as { id: string; entity_kind: string; status: string }[]
}

/** Date the spec's PENDING rows in 2000 (oldest first) and return how many there are. */
async function pin(): Promise<number> {
  const { rowCount } = await q(
    `UPDATE job_dirty_work SET created_at = '2000-01-01T00:00:00Z'::timestamptz + seq * interval '1 ms'
       FROM (SELECT id AS pid, row_number() OVER (ORDER BY entity_kind DESC, created_at, id) AS seq
               FROM job_dirty_work WHERE status = 'PENDING' AND (${MINE})) p
      WHERE id = p.pid`,
  )
  return rowCount ?? 0
}

/** The availability steps, with `claim` asserting it hands out only the spec's rows. */
function mySteps(): RecomputeSteps {
  const real = createAvailabilityReconcileSteps(db)
  return {
    ...real,
    async claim(owner, batchSize) {
      const claimed = await real.claim(owner, batchSize)
      const ids = new Set((await pending()).map((w) => w.id))
      for (const c of claimed) expect(ids.has(c.id)).toBe(true)
      return claimed
    },
  }
}

/** One worker run over exactly the spec's pending rows. */
async function runMine(): Promise<Awaited<ReturnType<RecomputeWorker['runOnce']>>> {
  const n = await pin()
  return new RecomputeWorker(mySteps(), {
    owner: `s8d-${TAG}`,
    batchSize: Math.max(n, 1),
  }).runOnce()
}

const enqueueOpp = (id: string, revision: number) =>
  enqueueDirty(db, 'OPPORTUNITY', id, revision, `AVAIL_OPP_${tag()}`)
const enqueueRecord = (id: string) => enqueueDirty(db, 'SOURCE_RECORD', id, 1, `AVAIL_REC_${tag()}`)

describe.skipIf(!hasDatabaseUrl())('availability reconciliation worker (r5 Task 4.6 S8d)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    db = drizzle(session.pool, { schema })
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
    const { rows: s } = await session.admin.query(
      `INSERT INTO users (email, display_name, role, tech_stack)
       VALUES ($1, 'S8d spec senior', 'SENIOR', ARRAY['Go']) RETURNING id`,
      [`s8d-senior-${TAG}@example.test`],
    )
    senior = s[0].id as string
  }, 120_000)

  afterEach(async () => {
    await q(`DELETE FROM job_dirty_work WHERE (${MINE})`)
    await q(
      `DELETE FROM job_opportunity_matches WHERE opportunity_id IN
         (SELECT s.opportunity_id FROM job_opportunity_sources s
            JOIN job_source_records r ON r.id = s.source_record_id WHERE r.namespace = $1)`,
      [NAMESPACE],
    )
    await q(
      `DELETE FROM job_source_record_inventory_misses WHERE source_record_id IN
         (SELECT id FROM job_source_records WHERE namespace = $1)`,
      [NAMESPACE],
    )
    const { rows: oppRows } = await q(
      `SELECT DISTINCT s.opportunity_id AS id FROM job_opportunity_sources s
         JOIN job_source_records r ON r.id = s.source_record_id WHERE r.namespace = $1`,
      [NAMESPACE],
    )
    await q(
      `DELETE FROM job_opportunity_sources WHERE source_record_id IN
         (SELECT id FROM job_source_records WHERE namespace = $1)`,
      [NAMESPACE],
    )
    const oppIds = oppRows.map((r) => String(r.id))
    if (oppIds.length > 0)
      await q(`DELETE FROM job_opportunities WHERE id = ANY($1::uuid[])`, [oppIds])
    await q(
      `DELETE FROM job_collection_runs WHERE source_id IN (SELECT id FROM job_sources WHERE namespace = $1)`,
      [NAMESPACE],
    )
    await q(`DELETE FROM job_source_records WHERE namespace = $1`, [NAMESPACE])
    await q(`DELETE FROM job_sources WHERE namespace = $1`, [NAMESPACE])
    await q(`DELETE FROM job_collection_cycles WHERE trigger_key LIKE 's8d-%'`)
  })

  afterAll(async () => {
    await session?.close()
  })

  it('AC1: a SOURCE_RECORD dirty row reaches the S8c updater and advances the counter', async () => {
    const sourceId = await newSource()
    const recordId = await newRecord()
    const cycleId = await newCycle()
    await addAbsentRun(sourceId, cycleId, DAY)
    await enqueueRecord(recordId)

    await runMine()

    expect(Number((await counterRow(recordId))?.['consecutive_misses'])).toBe(1)
  })

  it('AC1: three absent FULL_INVENTORY runs close the record and enqueue its opportunity', async () => {
    const sourceId = await newSource()
    const recordId = await newRecord()
    const oppId = await newOpportunity()
    await link(recordId, oppId)
    const cycleId = await newCycle()
    await addAbsentRun(sourceId, cycleId, 0)
    await addAbsentRun(sourceId, cycleId, DAY / 2)
    await addAbsentRun(sourceId, cycleId, DAY + 1)
    await enqueueRecord(recordId)

    await runMine()

    const { rows } = await q(`SELECT availability FROM job_source_records WHERE id = $1`, [
      recordId,
    ])
    expect(String(rows[0].availability)).toBe('CLOSED')
    expect(Number((await counterRow(recordId))?.['consecutive_misses'])).toBe(3)
    const owner = (await pending()).find(
      (w) => w.entity_kind === 'OPPORTUNITY' && w.status === 'PENDING',
    )
    expect(owner).toBeDefined()
    const { rows: dw } = await q(
      `SELECT reason FROM job_dirty_work WHERE entity_kind = 'OPPORTUNITY' AND entity_id = $1`,
      [oppId],
    )
    expect(dw.map((r) => String(r.reason))).toContain(INVENTORY_CLOSE_REASON)
  })

  it('AC2: an OPPORTUNITY dirty row re-derives CLOSED, bumps revision, leaves matches alone', async () => {
    const r1 = await newRecord('CLOSED')
    const r2 = await newRecord('CLOSED')
    const oppId = await newOpportunity()
    await link(r1, oppId)
    await link(r2, oppId)
    await insertMatch(oppId, 1)
    await enqueueOpp(oppId, 1)

    const report = await runMine()

    expect(report).toMatchObject({ claimed: 1, done: 1, failed: 0, fenced: 0 })
    expect(await oppRow(oppId)).toEqual({ availability: 'CLOSED', revision: 2 })
    // The stale match row persists as history — its recorded revision is untouched (not cleared).
    expect(await matchRevision(oppId)).toBe(1)
  })

  it('AC2: most-open keeps the opportunity OPEN when one active record is OPEN', async () => {
    const r1 = await newRecord('OPEN')
    const r2 = await newRecord('CLOSED')
    const oppId = await newOpportunity()
    await link(r1, oppId)
    await link(r2, oppId)
    await enqueueOpp(oppId, 1)

    await runMine()

    expect((await oppRow(oppId)).availability).toBe('OPEN')
  })

  it('AC6: a second sweep writes nothing new, and a duplicate enqueue is deduped', async () => {
    const r1 = await newRecord('CLOSED')
    const oppId = await newOpportunity()
    await link(r1, oppId)
    await enqueueOpp(oppId, 1)

    await runMine()
    const afterFirst = await oppRow(oppId)
    expect(afterFirst).toEqual({ availability: 'CLOSED', revision: 2 })

    // Re-enqueue at the NEW revision; the re-derivation is identical, so nothing is written.
    await enqueueOpp(oppId, 2)
    const second = await runMine()
    expect(second).toMatchObject({ failed: 0 })
    expect(await oppRow(oppId)).toEqual({ availability: 'CLOSED', revision: 2 })

    // The dirty-work dedup refuses a duplicate (kind, entity, version, reason).
    const dup = await enqueueDirty(db, 'OPPORTUNITY', oppId, 2, 'AVAIL_DUP')
    expect(dup.inserted).toBe(true)
    const dup2 = await enqueueDirty(db, 'OPPORTUNITY', oppId, 2, 'AVAIL_DUP')
    expect(dup2.inserted).toBe(false)
  })

  it('AC5: a per-row failure does not abort the batch — an orphan record is skipped, a good opp proceeds', async () => {
    const orphan = await newRecord() // no source row with this namespace yet
    const r1 = await newRecord('CLOSED')
    const oppId = await newOpportunity()
    await link(r1, oppId)
    await enqueueRecord(orphan)
    await enqueueOpp(oppId, 1)

    const report = await runMine()

    expect(report.claimed).toBe(2)
    expect(report.failed).toBe(0)
    expect((await oppRow(oppId)).availability).toBe('CLOSED')
  })
})
