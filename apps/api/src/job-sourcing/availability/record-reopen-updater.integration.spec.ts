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
import { enqueueDirty } from '../ownership/dirty-work.store'
import { createAvailabilityReconcileSteps } from '../runtime/availability-reconcile-worker'
import { type RecomputeSteps, RecomputeWorker } from '../runtime/recompute-worker'
import { RECORD_REOPEN_REASON, reopenObservedRecord } from './record-reopen-updater'

/**
 * r5 Task 4.6 S8f — record reopen against a real Postgres, as `crm_app`. This is where the DB
 * persistence is proven (the mutation gate cannot cover it: Stryker skips integration specs):
 * the flip back to OPEN, the evidence, the one-transaction enqueue, the guard, and — through the
 * real S8d worker — that a close -> reopen cycle re-derives the opportunity and bumps its
 * `revision` while `job_opportunity_matches` stays byte-identical.
 *
 * ISOLATION (mirrors the S8d worker spec): every row is scoped to this spec's namespace; the
 * worker is run over exactly this spec's pending dirty rows.
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
const HOUR = 3_600_000
const DAY = 24 * HOUR
const CONFIG = 1
const TAG = randomUUID().slice(0, 8)
const NAMESPACE = `s8f-${TAG}-ns`
const BOARD = `GREENHOUSE_ATS:${NAMESPACE}`

let session: CrmAppSession
let db: ReturnType<typeof drizzle<typeof schema>>
let senior: string

const q = (text: string, params: unknown[] = []) => session.admin.query(text, params)
const tag = () => randomUUID().slice(0, 12)

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

/** A record at `availability`, closed/expired at `checkedAt` (the instant a run must follow). */
async function newRecord(availability: string, checkedAt: Date | null = null): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_source_records
       (source_type, namespace, identity_kind, identity_key, availability, availability_checked_at)
     VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3::job_availability, $4::timestamptz)
     RETURNING id`,
    [NAMESPACE, `key-${tag()}`, availability, checkedAt?.toISOString() ?? null],
  )
  return String(rows[0].id)
}

async function newCycle(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
    [`s8f-${tag()}`],
  )
  return String(rows[0].id)
}

async function addRun(
  sourceId: string,
  cycleId: string,
  endedMs: number,
  opts: { outcome?: string; coverage?: string; configVersion?: number } = {},
): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_collection_runs
       (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger, coverage, outcome,
        received, created, started_at, ended_at, account_key)
     VALUES ($1, $2, $3, $4, 'v1', 'SCHEDULED', $5::job_collection_coverage,
             $6::job_collection_outcome, 100, 100, $7::timestamptz, $8::timestamptz, $9) RETURNING id`,
    [
      sourceId,
      cycleId,
      `attempt-${tag()}`,
      opts.configVersion ?? CONFIG,
      opts.coverage ?? 'FULL_INVENTORY',
      opts.outcome ?? 'SUCCEEDED',
      new Date(endedMs - 60_000).toISOString(),
      new Date(endedMs).toISOString(),
      `acct-${tag()}`,
    ],
  )
  return String(rows[0].id)
}

/** The run LISTED the record (a `job_run_records` row, which needs a revision). */
async function list(runId: string, recordId: string): Promise<void> {
  const rev = await q(
    `INSERT INTO job_source_record_revisions
       (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity)
     VALUES ($1, 'v1', 'v1', $2, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
    [recordId, createHash('sha256').update(tag()).digest('hex')],
  )
  await q(
    `INSERT INTO job_run_records (run_id, source_record_id, revision_id) VALUES ($1, $2, $3)`,
    [runId, recordId, rev.rows[0].id],
  )
}

async function newOpportunity(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_opportunities (title, title_key) VALUES ($1, $1) RETURNING id`,
    [`s8f-${tag()}`],
  )
  return String(rows[0].id)
}

async function link(recordId: string, oppId: string): Promise<void> {
  await q(
    `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version) VALUES ($1, $2, '1')`,
    [recordId, oppId],
  )
}

async function recordRow(id: string) {
  const { rows } = await q(
    `SELECT availability::text AS availability, availability_evidence AS evidence,
            availability_checked_at AS checked_at
       FROM job_source_records WHERE id = $1`,
    [id],
  )
  return rows[0] as {
    availability: string
    evidence: Record<string, unknown>
    checked_at: Date | null
  }
}

async function oppRow(id: string): Promise<{ availability: string; revision: number }> {
  const { rows } = await q(`SELECT availability, revision FROM job_opportunities WHERE id = $1`, [
    id,
  ])
  return { availability: String(rows[0].availability), revision: Number(rows[0].revision) }
}

async function reopenRows(
  oppId: string,
): Promise<{ target_version: number; cycle_id: string | null }[]> {
  const { rows } = await q(
    `SELECT target_version::int AS target_version, cycle_id FROM job_dirty_work
      WHERE entity_kind = 'OPPORTUNITY' AND entity_id = $1 AND reason = $2`,
    [oppId, 'RECORD_REOPENED'],
  )
  return rows as { target_version: number; cycle_id: string | null }[]
}

async function insertMatch(oppId: string, revision: number): Promise<void> {
  await q(
    `INSERT INTO job_opportunity_matches
       (opportunity_id, senior_id, opportunity_revision, senior_profile_version, exclusion_version,
        rule_version, outcome, evidence)
     VALUES ($1, $2, $3, 'pv1', 'ev1', 'RULE-1', 'LEAD', '{"why":"kept"}'::jsonb)`,
    [oppId, senior, revision],
  )
}

/** Every column of every match row of the opportunity, as text: the preservation oracle. */
async function matchSnapshot(oppId: string): Promise<string[]> {
  const { rows } = await q(
    `SELECT m::text AS t FROM job_opportunity_matches m WHERE opportunity_id = $1 ORDER BY id`,
    [oppId],
  )
  return rows.map((r) => String(r.t))
}

const input = (sourceId: string, recordId: string) => ({
  sourceRecordId: recordId,
  sourceId,
  board: BOARD,
  configVersion: CONFIG,
})

async function pending(): Promise<string[]> {
  const { rows } = await q(`SELECT id FROM job_dirty_work WHERE (${MINE})`)
  return rows.map((r) => String(r.id))
}

async function pin(): Promise<number> {
  const { rowCount } = await q(
    `UPDATE job_dirty_work SET created_at = '2000-01-01T00:00:00Z'::timestamptz + seq * interval '1 ms'
       FROM (SELECT id AS pid, row_number() OVER (ORDER BY entity_kind DESC, created_at, id) AS seq
               FROM job_dirty_work WHERE status = 'PENDING' AND (${MINE})) p
      WHERE id = p.pid`,
  )
  return rowCount ?? 0
}

function mySteps(): RecomputeSteps {
  const real = createAvailabilityReconcileSteps(db)
  return {
    ...real,
    async claim(owner, batchSize) {
      const claimed = await real.claim(owner, batchSize)
      const ids = new Set(await pending())
      for (const c of claimed) expect(ids.has(c.id)).toBe(true)
      return claimed
    },
  }
}

async function runMine() {
  const n = await pin()
  return new RecomputeWorker(mySteps(), {
    owner: `s8f-${TAG}`,
    batchSize: Math.max(n, 1),
  }).runOnce()
}

describe.skipIf(!hasDatabaseUrl())('record reopen (r5 Task 4.6 S8f)', () => {
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
       VALUES ($1, 'S8f spec senior', 'SENIOR', ARRAY['Go']) RETURNING id`,
      [`s8f-senior-${TAG}@example.test`],
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
    await q(
      `DELETE FROM job_run_records WHERE source_record_id IN
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
      `DELETE FROM job_source_record_revisions WHERE source_record_id IN
         (SELECT id FROM job_source_records WHERE namespace = $1)`,
      [NAMESPACE],
    )
    await q(
      `DELETE FROM job_collection_runs WHERE source_id IN (SELECT id FROM job_sources WHERE namespace = $1)`,
      [NAMESPACE],
    )
    await q(`DELETE FROM job_source_records WHERE namespace = $1`, [NAMESPACE])
    await q(`DELETE FROM job_sources WHERE namespace = $1`, [NAMESPACE])
    await q(`DELETE FROM job_collection_cycles WHERE trigger_key LIKE 's8f-%'`)
  })

  afterAll(async () => {
    await session?.close()
  })

  it('pins the persisted dirty-work reason literal', () => {
    expect(RECORD_REOPEN_REASON).toBe('RECORD_REOPENED')
  })

  it.each(['CLOSED', 'EXPIRED'])(
    'AC1: a %s record listed by a later run is OPEN with OBSERVED_OPEN evidence, owner enqueued',
    async (availability) => {
      const sourceId = await newSource()
      const closedAt = new Date(Date.now() - DAY)
      const recordId = await newRecord(availability, closedAt)
      const oppId = await newOpportunity()
      await link(recordId, oppId)
      const cycleId = await newCycle()
      const runId = await addRun(sourceId, cycleId, Date.now() - HOUR)
      await list(runId, recordId)

      expect(await reopenObservedRecord(db, input(sourceId, recordId))).toEqual({ reopened: true })

      const row = await recordRow(recordId)
      expect(row.availability).toBe('OPEN')
      expect(row.evidence).toMatchObject({
        kind: 'OBSERVED_OPEN',
        basis: 'OBSERVED',
        runId,
        board: BOARD,
        configVersion: CONFIG,
      })
      expect(row.checked_at?.getTime()).toBeGreaterThan(closedAt.getTime())
      expect(await reopenRows(oppId)).toEqual([{ target_version: 1, cycle_id: cycleId }])
    },
  )

  it('AC1: no run listed it since it closed => stays CLOSED, nothing enqueued', async () => {
    const sourceId = await newSource()
    const cycleId = await newCycle()
    const recordId = await newRecord('CLOSED', new Date(Date.now() - HOUR))
    const oppId = await newOpportunity()
    await link(recordId, oppId)
    // Listed BEFORE it closed, and a later run that did not list it.
    const before = await addRun(sourceId, cycleId, Date.now() - DAY)
    await list(before, recordId)
    await addRun(sourceId, cycleId, Date.now() - 60_000)

    expect(await reopenObservedRecord(db, input(sourceId, recordId))).toEqual({ reopened: false })
    expect((await recordRow(recordId)).availability).toBe('CLOSED')
    expect(await reopenRows(oppId)).toEqual([])
  })

  it('AC1: a FAILED run, or another config version, is not an observation', async () => {
    const sourceId = await newSource()
    const cycleId = await newCycle()
    const recordId = await newRecord('CLOSED', new Date(Date.now() - DAY))
    const failed = await addRun(sourceId, cycleId, Date.now() - HOUR, { outcome: 'FAILED' })
    const other = await addRun(sourceId, cycleId, Date.now() - HOUR, { configVersion: 2 })
    await list(failed, recordId)
    await list(other, recordId)

    expect(await reopenObservedRecord(db, input(sourceId, recordId))).toEqual({ reopened: false })
    expect((await recordRow(recordId)).availability).toBe('CLOSED')
  })

  it('SR-M-1: a slow run that started before the close but ended after it does not reopen (no flap)', async () => {
    const sourceId = await newSource()
    const cycleId = await newCycle()
    const closedAt = new Date(Date.now() - HOUR)
    const recordId = await newRecord('CLOSED', closedAt)
    const oppId = await newOpportunity()
    await link(recordId, oppId)
    // Started 2h ago (before the close), ended 10 min ago (after it).
    const slow = await addRun(sourceId, cycleId, Date.now() - 600_000)
    await q(`UPDATE job_collection_runs SET started_at = $2::timestamptz WHERE id = $1`, [
      slow,
      new Date(Date.now() - 2 * HOUR).toISOString(),
    ])
    await list(slow, recordId)

    expect(await reopenObservedRecord(db, input(sourceId, recordId))).toEqual({ reopened: false })
    expect((await recordRow(recordId)).availability).toBe('CLOSED')
    expect(await reopenRows(oppId)).toEqual([])

    // A run that STARTED after the close does reopen it.
    const fresh = await addRun(sourceId, cycleId, Date.now())
    await list(fresh, recordId)
    expect(await reopenObservedRecord(db, input(sourceId, recordId))).toEqual({ reopened: true })
  })

  it('AC1: a PARTIAL-coverage run that lists the record reopens it (listed = observed open)', async () => {
    const sourceId = await newSource()
    const cycleId = await newCycle()
    const recordId = await newRecord('EXPIRED', new Date(Date.now() - DAY))
    const run = await addRun(sourceId, cycleId, Date.now() - HOUR, { coverage: 'PARTIAL' })
    await list(run, recordId)
    expect(await reopenObservedRecord(db, input(sourceId, recordId))).toEqual({ reopened: true })
  })

  it('AC5: idempotent — a second call rewrites nothing and enqueues nothing more', async () => {
    const sourceId = await newSource()
    const cycleId = await newCycle()
    const recordId = await newRecord('CLOSED', new Date(Date.now() - DAY))
    const oppId = await newOpportunity()
    await link(recordId, oppId)
    await list(await addRun(sourceId, cycleId, Date.now() - HOUR), recordId)

    expect(await reopenObservedRecord(db, input(sourceId, recordId))).toEqual({ reopened: true })
    const first = await recordRow(recordId)
    expect(await reopenObservedRecord(db, input(sourceId, recordId))).toEqual({ reopened: false })
    const second = await recordRow(recordId)
    expect(second.checked_at).toEqual(first.checked_at)
    expect(second.evidence).toEqual(first.evidence)
    expect(await reopenRows(oppId)).toHaveLength(1)
  })

  it('an already-OPEN record is never touched', async () => {
    const sourceId = await newSource()
    const cycleId = await newCycle()
    const recordId = await newRecord('OPEN')
    await list(await addRun(sourceId, cycleId, Date.now() - HOUR), recordId)
    expect(await reopenObservedRecord(db, input(sourceId, recordId))).toEqual({ reopened: false })
    expect((await recordRow(recordId)).evidence).toEqual({})
  })

  it('refuses a record that does not belong to the source, writing nothing', async () => {
    const sourceId = await newSource()
    const { rows } = await q(
      `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, availability)
       VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, 'CLOSED') RETURNING id`,
      [`${NAMESPACE}-other`, `key-${tag()}`],
    )
    const foreign = String(rows[0].id)
    try {
      await expect(reopenObservedRecord(db, input(sourceId, foreign))).rejects.toThrow(
        /does not belong/,
      )
      expect((await recordRow(foreign)).availability).toBe('CLOSED')
    } finally {
      await q(`DELETE FROM job_source_records WHERE id = $1`, [foreign])
    }
  })

  it('AC2/AC3: close -> reopen through the worker re-derives the opportunity, bumps revision, keeps matches byte-identical', async () => {
    const sourceId = await newSource()
    const cycleId = await newCycle()
    const recordId = await newRecord('OPEN')
    const oppId = await newOpportunity()
    await link(recordId, oppId)
    await q(`UPDATE job_opportunities SET availability = 'OPEN' WHERE id = $1`, [oppId])
    await insertMatch(oppId, 1)
    const preserved = await matchSnapshot(oppId)
    expect(preserved).toHaveLength(1)

    // Three absent FULL_INVENTORY runs a day apart close the record; the opportunity follows.
    await addRun(sourceId, cycleId, 0)
    await addRun(sourceId, cycleId, DAY / 2)
    await addRun(sourceId, cycleId, DAY + 1)
    await enqueueDirty(db, 'SOURCE_RECORD', recordId, 1, `S8F_CLOSE_${tag()}`)
    await runMine() // record -> CLOSED, opportunity enqueued
    await runMine() // opportunity -> CLOSED
    expect((await recordRow(recordId)).availability).toBe('CLOSED')
    expect(await oppRow(oppId)).toEqual({ availability: 'CLOSED', revision: 2 })
    expect(await matchSnapshot(oppId)).toEqual(preserved)

    // The posting is listed again by a later successful run.
    const back = await addRun(sourceId, cycleId, Date.now() + HOUR)
    await list(back, recordId)
    await enqueueDirty(db, 'SOURCE_RECORD', recordId, 2, `S8F_RELIST_${tag()}`)
    await runMine() // record -> OPEN (reopen first; the counter then resets, never re-closes)
    expect((await recordRow(recordId)).availability).toBe('OPEN')
    expect((await recordRow(recordId)).evidence).toMatchObject({
      kind: 'OBSERVED_OPEN',
      runId: back,
    })
    expect(await oppRow(oppId)).toEqual({ availability: 'CLOSED', revision: 2 }) // not yet re-derived
    expect(await reopenRows(oppId)).toEqual([{ target_version: 2, cycle_id: cycleId }])

    await runMine() // opportunity -> OPEN, revision bumped
    expect(await oppRow(oppId)).toEqual({ availability: 'OPEN', revision: 3 })
    // The SAME decisions, untouched: not cleared, not recomputed, not re-stamped.
    expect(await matchSnapshot(oppId)).toEqual(preserved)

    // A further sweep is a no-op: nothing flips, nothing bumps, nothing re-enqueues.
    await enqueueDirty(db, 'SOURCE_RECORD', recordId, 3, `S8F_AGAIN_${tag()}`)
    await runMine()
    expect((await recordRow(recordId)).availability).toBe('OPEN')
    expect(await oppRow(oppId)).toEqual({ availability: 'OPEN', revision: 3 })
    expect(await reopenRows(oppId)).toHaveLength(1)
    expect(await matchSnapshot(oppId)).toEqual(preserved)
  })

  it('AC1: an EXPIRED record listed by a later WINDOW run is reopened by the worker, not re-expired', async () => {
    const sourceId = await newSource()
    const cycleId = await newCycle()
    const recordId = await newRecord('EXPIRED', new Date(Date.now() - DAY))
    const oppId = await newOpportunity()
    await link(recordId, oppId)
    await q(`UPDATE job_opportunities SET availability = 'EXPIRED' WHERE id = $1`, [oppId])
    const run = await addRun(sourceId, cycleId, Date.now() - HOUR, { coverage: 'WINDOW' })
    await list(run, recordId)
    await enqueueDirty(db, 'SOURCE_RECORD', recordId, 1, `S8F_WIN_${tag()}`)

    await runMine()
    expect((await recordRow(recordId)).availability).toBe('OPEN')
    await runMine()
    expect(await oppRow(oppId)).toEqual({ availability: 'OPEN', revision: 2 })
  })
})
