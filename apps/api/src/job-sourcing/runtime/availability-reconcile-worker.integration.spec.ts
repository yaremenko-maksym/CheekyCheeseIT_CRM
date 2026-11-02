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
import {
  createAvailabilityReconcileSteps,
  resolveInventoryInput,
} from './availability-reconcile-worker'

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
  'manual',
  '2026-11-01_job_source_record_inventory_misses.sql',
)
const BACKFILL_SQL = join(
  __dirname,
  '..',
  '..',
  '..',
  'drizzle',
  'manual',
  '2026-11-02_job_source_records_source_id.sql',
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

// `distinct` makes a source its own identity: GREENHOUSE_ATS allows one source per (type, namespace)
// (uq_job_sources_inventory_type_namespace), so several sources in one namespace must be a
// non-inventory type (JSEARCH_API) told apart by config (uq_job_sources_type_config).
async function newSource(distinct?: string): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_sources (type, namespace, config, config_version)
     VALUES ($2, $1, jsonb_build_object('ns', $1::text, 'd', $3::text), ${CONFIG}) RETURNING id`,
    [NAMESPACE, distinct ? 'JSEARCH_API' : 'GREENHOUSE_ATS', distinct ?? ''],
  )
  return String(rows[0].id)
}

async function newRecord(
  availability = 'UNKNOWN',
  sourceId: string | null = null,
): Promise<string> {
  // SR-H-2: a record resolves to its source through source_id. SOURCE_RECORD-path tests pass the
  // creating source; a record left without one (orphan) is the fail-closed case.
  const { rows } = await q(
    `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, availability, source_id)
     VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3::job_availability, $4::uuid) RETURNING id`,
    [NAMESPACE, `key-${tag()}`, availability, sourceId],
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
    const recordId = await newRecord('UNKNOWN', sourceId)
    const cycleId = await newCycle()
    await addAbsentRun(sourceId, cycleId, DAY)
    await enqueueRecord(recordId)

    await runMine()

    expect(Number((await counterRow(recordId))?.['consecutive_misses'])).toBe(1)
  })

  it('AC1: three absent FULL_INVENTORY runs close the record and enqueue its opportunity', async () => {
    const sourceId = await newSource()
    const recordId = await newRecord('UNKNOWN', sourceId)
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

  it('CR-M-2: running the worker twice over the same rows does not double-apply (idempotent)', async () => {
    const sourceId = await newSource()
    const recordId = await newRecord('UNKNOWN', sourceId)
    const oppId = await newOpportunity()
    await link(recordId, oppId)
    const cycleId = await newCycle()
    await addAbsentRun(sourceId, cycleId, 0)
    await addAbsentRun(sourceId, cycleId, DAY / 2)
    await addAbsentRun(sourceId, cycleId, DAY + 1)
    await enqueueRecord(recordId)

    await runMine()
    await runMine() // a second sweep over whatever is still pending

    // The S8c updater ran exactly once: the counter is at 3, not 6; the record stays CLOSED.
    expect(Number((await counterRow(recordId))?.['consecutive_misses'])).toBe(3)
    const { rows } = await q(`SELECT availability FROM job_source_records WHERE id = $1`, [
      recordId,
    ])
    expect(String(rows[0].availability)).toBe('CLOSED')
    // The close-path enqueued its owning opportunity exactly once (ON CONFLICT dedup, no duplicate).
    const { rows: dw } = await q(
      `SELECT count(*)::int AS n FROM job_dirty_work
        WHERE entity_kind = 'OPPORTUNITY' AND entity_id = $1 AND reason = $2`,
      [oppId, INVENTORY_CLOSE_REASON],
    )
    expect(Number(dw[0].n)).toBe(1)
  })

  it('AC5: a per-row failure does not abort the batch — an orphan record is skipped, a good opp proceeds', async () => {
    const orphan = await newRecord() // NULL source_id — the fail-closed case
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

  // ── SR-H-2 (PR #1227): explicit source_id, no arbitrary pick ──────────────────────────────────
  it('SR-H-2: resolves via source_id to the CORRECT source when two share (type, namespace)', async () => {
    // Two global sources sharing (JSEARCH_API, NAMESPACE), differing only by config_version — the
    // exact shape (three JSearch namespace='' queries) that made the old (type, namespace) JOIN pick
    // an arbitrary source (`ORDER BY s.id LIMIT 1`, i.e. the LOWER uuid). JSEARCH_API is a
    // non-inventory type, so SR-M-4's unique index does not apply.
    const { rows: s1 } = await q(
      `INSERT INTO job_sources (type, namespace, config, config_version)
       VALUES ('JSEARCH_API', $1, jsonb_build_object('q', 'one'), 4) RETURNING id`,
      [NAMESPACE],
    )
    const { rows: s2 } = await q(
      `INSERT INTO job_sources (type, namespace, config, config_version)
       VALUES ('JSEARCH_API', $1, jsonb_build_object('q', 'two'), 7) RETURNING id`,
      [NAMESPACE],
    )
    // CR-M-2: point the record DETERMINISTICALLY at the GREATER-uuid source — the one the old
    // arbitrary `ORDER BY s.id LIMIT 1` (lower uuid) would NOT pick. Canonical-lowercase uuids sort
    // identically as JS strings and as Postgres `uuid`, so this is stable. Reverting the resolver to
    // that JOIN then resolves to the wrong source (and its config_version), failing this test on
    // EVERY run — not only the ~half where the greater uuid happened to be inserted second.
    const srcLow = { id: String(s1[0].id), config: 4 }
    const srcHigh = { id: String(s2[0].id), config: 7 }
    const target = srcLow.id > srcHigh.id ? srcLow : srcHigh // greater uuid = NOT the arbitrary pick
    const arbitraryPick = srcLow.id > srcHigh.id ? srcHigh : srcLow
    expect(target.id).not.toBe(arbitraryPick.id) // two distinct sources really exist
    expect(target.config).not.toBe(arbitraryPick.config) // a wrong pick => a wrong config_version

    const { rows: rec } = await q(
      `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, source_id)
       VALUES ('JSEARCH_API', $1, 'NATIVE_ID', $2, $3::uuid) RETURNING id`,
      [NAMESPACE, `key-${tag()}`, target.id],
    )
    const recordId = String(rec[0].id)

    const input = await resolveInventoryInput(db, recordId)

    // The record points at the greater-uuid source, so the resolve returns exactly it — never the
    // arbitrary (lower-uuid) source nor its config_version.
    expect(input).toEqual({
      sourceRecordId: recordId,
      sourceId: target.id,
      board: `JSEARCH_API:${NAMESPACE}`,
      configVersion: target.config,
    })
  })

  it('SR-H-2: a NULL source_id record resolves to null (fail closed)', async () => {
    const orphan = await newRecord() // default: NULL source_id
    expect(await resolveInventoryInput(db, orphan)).toBeNull()
  })

  it('SR-H-2: the backfill picks the earliest observing run, breaking ties on run.id (CR-M-3/SPEC-L-3)', async () => {
    const cycleId = await newCycle()
    // A SUCCEEDED run of `sourceId` that observed `recordId` at `startedAt` (run + revision + link).
    const observe = async (
      sourceId: string,
      recordId: string,
      startedAt: Date,
      explicitRunId?: string,
    ): Promise<string> => {
      const { rows: run } = await q(
        `INSERT INTO job_collection_runs
           (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger, coverage, outcome,
            received, created, started_at, ended_at, account_key, id)
         VALUES ($1, $2, $3, ${CONFIG}, 'v1', 'SCHEDULED', 'FULL_INVENTORY', 'SUCCEEDED',
                 1, 1, $4::timestamptz, $4::timestamptz, $5, COALESCE($6::uuid, gen_random_uuid()))
         RETURNING id`,
        [
          sourceId,
          cycleId,
          `attempt-${tag()}`,
          startedAt.toISOString(),
          `acct-${tag()}`,
          explicitRunId ?? null,
        ],
      )
      const runId = String(run[0].id)
      const { rows: revn } = await q(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity)
         VALUES ($1, 'v1', 'v1', md5(random()::text) || md5(random()::text), '{}'::jsonb, '{}'::jsonb) RETURNING id`,
        [recordId],
      )
      await q(
        `INSERT INTO job_run_records (run_id, source_record_id, revision_id) VALUES ($1, $2, $3)`,
        [runId, recordId, String(revn[0].id)],
      )
      return runId
    }

    // Record A: observed by a LATER run of `srcLate` and an EARLIER run of `srcEarly`. The backfill's
    // `ORDER BY run.started_at` must pick srcEarly — a removed/DESC-flipped order would pick srcLate.
    const srcEarly = await newSource('early')
    const srcLate = await newSource('late')
    const recA = await newRecord('UNKNOWN', null) // pre-backfill: source_id is NULL
    await observe(srcLate, recA, new Date('2026-01-02T00:00:00.000Z'))
    await observe(srcEarly, recA, new Date('2026-01-01T00:00:00.000Z'))

    // Record B: two runs with the SAME started_at from two sources. `ORDER BY run.started_at, run.id`
    // breaks the tie on the LOWER run.id. Fixed ids, HIGH-id run inserted FIRST: a dropped `, run.id`
    // falls back to physical insertion order and picks srcHigh, so that mutant dies deterministically.
    const LOW_RUN_ID = '00000000-0000-4000-8000-00000000d0a1'
    const HIGH_RUN_ID = 'ffffffff-ffff-4fff-8fff-fffffffffd0a'
    const srcHigh = await newSource('b-high')
    const srcLow = await newSource('b-low')
    const recB = await newRecord('UNKNOWN', null)
    const sameTs = new Date('2026-03-01T00:00:00.000Z')
    await observe(srcHigh, recB, sameTs, HIGH_RUN_ID)
    await observe(srcLow, recB, sameTs, LOW_RUN_ID)

    // Apply the promoted migration (idempotent ADD COLUMN / FK / index + the backfill UPDATE).
    await session.admin.query(readFileSync(BACKFILL_SQL, 'utf8'))

    const sourceOf = async (recordId: string): Promise<string> => {
      const { rows } = await q(`SELECT source_id FROM job_source_records WHERE id = $1`, [recordId])
      return String(rows[0].source_id)
    }
    expect(await sourceOf(recA)).toBe(srcEarly) // earliest started_at wins, never srcLate
    expect(await sourceOf(recB)).toBe(srcLow) // equal started_at => lower run.id breaks the tie
  })
})
