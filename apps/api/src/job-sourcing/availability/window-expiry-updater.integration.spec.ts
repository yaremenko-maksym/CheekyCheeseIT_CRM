import { createHash, randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../../database/schema'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import {
  WINDOW_EXPIRE_REASON,
  expireWindowRecord,
  readLatestWindowRun,
} from './window-expiry-updater'

/**
 * r5 Task 4.6 S8e — the WINDOW expiry adapter against a real Postgres, as `crm_app`. REMOTIVE_API is
 * the provider with a 24 h freshness allowance. The path writes NO counter row, so the staged
 * `job_source_record_inventory_misses` table is neither needed nor applied here.
 * Every test creates its own fixtures and removes them in `afterEach`.
 */
const HOUR = 3_600_000
const CONFIG = 1
const NOW = Date.parse('2026-11-01T12:00:00.000Z')

let session: CrmAppSession
let db: ReturnType<typeof drizzle<typeof schema>>

const sources: string[] = []
const records: string[] = []
const opps: string[] = []
const cycles: string[] = []

const q = (text: string, params: unknown[] = []) => session.admin.query(text, params)
const tag = () => randomUUID().slice(0, 12)

async function seed(opts: {
  type?: string
  lastSeenHoursAgo: number
  availability?: string
}): Promise<{ sourceId: string; recordId: string; board: string; cycleId: string }> {
  const type = opts.type ?? 'REMOTIVE_API'
  const ns = `ns-${tag()}`
  const s = await q(
    `INSERT INTO job_sources (type, namespace, config, config_version)
     VALUES ($1::job_source_type, $2, jsonb_build_object('tag', $2::text), ${CONFIG}) RETURNING id`,
    [type, ns],
  )
  const sourceId = String(s.rows[0].id)
  sources.push(sourceId)
  const r = await q(
    `INSERT INTO job_source_records
       (source_type, namespace, identity_kind, identity_key, last_observed_at, availability)
     VALUES ($1::job_source_type, $2, 'NATIVE_ID', $3, $4::timestamptz, $5::job_availability) RETURNING id`,
    [
      type,
      ns,
      `key-${tag()}`,
      new Date(NOW - opts.lastSeenHoursAgo * HOUR).toISOString(),
      opts.availability ?? 'OPEN',
    ],
  )
  const recordId = String(r.rows[0].id)
  records.push(recordId)
  const c = await q(
    `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
    [`s8e-${tag()}`],
  )
  const cycleId = String(c.rows[0].id)
  cycles.push(cycleId)
  return { sourceId, recordId, board: `${type}:${ns}`, cycleId }
}

async function addRun(
  sourceId: string,
  cycleId: string,
  coverage: string,
  outcome = 'SUCCEEDED',
): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_collection_runs
       (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger, coverage, outcome,
        received, created, started_at, ended_at, account_key)
     VALUES ($1, $2, $3, ${CONFIG}, 'v1', 'SCHEDULED', $4::job_collection_coverage,
             $5::job_collection_outcome, 10, 10, $6::timestamptz, $7::timestamptz, $8) RETURNING id`,
    [
      sourceId,
      cycleId,
      `attempt-${tag()}`,
      coverage,
      outcome,
      new Date(NOW - 60_000).toISOString(),
      new Date(NOW).toISOString(),
      `acct-${tag()}`,
    ],
  )
  return String(rows[0].id)
}

async function linkOpp(recordId: string): Promise<string> {
  const o = await q(
    `INSERT INTO job_opportunities (title, title_key) VALUES ($1, $1) RETURNING id`,
    [`s8e-${tag()}`],
  )
  const oppId = String(o.rows[0].id)
  opps.push(oppId)
  await q(
    `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version) VALUES ($1, $2, 1)`,
    [recordId, oppId],
  )
  return oppId
}

async function state(recordId: string) {
  const { rows } = await q(
    `SELECT availability, availability_evidence FROM job_source_records WHERE id = $1`,
    [recordId],
  )
  return { availability: String(rows[0].availability), evidence: rows[0].availability_evidence }
}

async function dirtyCount(oppId: string): Promise<number> {
  const { rows } = await q(
    `SELECT count(*)::int AS n FROM job_dirty_work
      WHERE entity_kind = 'OPPORTUNITY' AND entity_id = $1 AND reason = $2`,
    [oppId, 'RECORD_WINDOW_EXPIRED'],
  )
  return Number(rows[0].n)
}

const run = async (
  f: { sourceId: string; recordId: string; board: string },
  runId = '',
  cycleId: string | null = null,
) =>
  expireWindowRecord(
    db,
    { sourceRecordId: f.recordId, sourceId: f.sourceId, board: f.board, configVersion: CONFIG },
    { runId, cycleId, observedAt: new Date(NOW).toISOString() },
  )

describe.skipIf(!hasDatabaseUrl())('window expiry updater (r5 Task 4.6 S8e)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    db = drizzle(session.pool, { schema })
  }, 120_000)

  afterEach(async () => {
    const o = opps.splice(0)
    const r = records.splice(0)
    const s = sources.splice(0)
    const c = cycles.splice(0)
    if (o.length > 0) await q(`DELETE FROM job_dirty_work WHERE entity_id = ANY($1::uuid[])`, [o])
    if (r.length > 0) {
      await q(`DELETE FROM job_run_records WHERE source_record_id = ANY($1::uuid[])`, [r])
      await q(`DELETE FROM job_opportunity_sources WHERE source_record_id = ANY($1::uuid[])`, [r])
      await q(`DELETE FROM job_source_records WHERE id = ANY($1::uuid[])`, [r])
    }
    if (s.length > 0) {
      await q(`DELETE FROM job_collection_runs WHERE source_id = ANY($1::uuid[])`, [s])
      await q(`DELETE FROM job_sources WHERE id = ANY($1::uuid[])`, [s])
    }
    if (o.length > 0) await q(`DELETE FROM job_opportunities WHERE id = ANY($1::uuid[])`, [o])
    if (c.length > 0) await q(`DELETE FROM job_collection_cycles WHERE id = ANY($1::uuid[])`, [c])
  })

  afterAll(async () => {
    await session?.close()
  })

  it('pins the persisted dirty-work reason literal', () => {
    expect(WINDOW_EXPIRE_REASON).toBe('RECORD_WINDOW_EXPIRED')
  })

  it('readLatestWindowRun: WINDOW latest run => run; FULL_INVENTORY latest => null', async () => {
    const w = await seed({ lastSeenHoursAgo: 1 })
    const runId = await addRun(w.sourceId, w.cycleId, 'WINDOW')
    const got = await readLatestWindowRun(db, { sourceId: w.sourceId, configVersion: CONFIG })
    expect(got).toMatchObject({ runId, observedAt: new Date(NOW).toISOString() })

    const f = await seed({ lastSeenHoursAgo: 1 })
    await addRun(f.sourceId, f.cycleId, 'FULL_INVENTORY')
    expect(
      await readLatestWindowRun(db, { sourceId: f.sourceId, configVersion: CONFIG }),
    ).toBeNull()

    const failed = await seed({ lastSeenHoursAgo: 1 })
    await addRun(failed.sourceId, failed.cycleId, 'WINDOW', 'FAILED')
    expect(
      await readLatestWindowRun(db, { sourceId: failed.sourceId, configVersion: CONFIG }),
    ).toBeNull()
  })

  it('stale record => EXPIRED with WINDOW_DROPPED evidence, opportunity enqueued, never CLOSED', async () => {
    const f = await seed({ lastSeenHoursAgo: 30 })
    const oppId = await linkOpp(f.recordId)
    const runId = await addRun(f.sourceId, f.cycleId, 'WINDOW')

    expect(await run(f, runId, f.cycleId)).toEqual({ expired: true })

    const st = await state(f.recordId)
    expect(st.availability).toBe('EXPIRED')
    expect(st.evidence).toMatchObject({ kind: 'WINDOW_DROPPED', runId, board: f.board })
    expect(await dirtyCount(oppId)).toBe(1)
    // The path writes no counter row at all (db:push creates the table; it must stay empty for us).
    const c = await q(
      `SELECT count(*)::int AS n FROM job_source_record_inventory_misses WHERE source_record_id = $1`,
      [f.recordId],
    )
    expect(Number(c.rows[0].n)).toBe(0)
  })

  it('record seen within the window stays OPEN and enqueues nothing', async () => {
    const f = await seed({ lastSeenHoursAgo: 2 })
    const oppId = await linkOpp(f.recordId)
    const runId = await addRun(f.sourceId, f.cycleId, 'WINDOW')

    expect(await run(f, runId)).toEqual({ expired: false })
    expect((await state(f.recordId)).availability).toBe('OPEN')
    expect(await dirtyCount(oppId)).toBe(0)
  })

  it('a record the window run listed is not expired even if its last-seen is stale', async () => {
    const f = await seed({ lastSeenHoursAgo: 40 })
    const runId = await addRun(f.sourceId, f.cycleId, 'WINDOW')
    const rev = await q(
      `INSERT INTO job_source_record_revisions
         (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity)
       VALUES ($1, 'v1', 'v1', $2, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [f.recordId, createHash('sha256').update(tag()).digest('hex')],
    )
    await q(
      `INSERT INTO job_run_records (run_id, source_record_id, revision_id) VALUES ($1, $2, $3)`,
      [runId, f.recordId, rev.rows[0].id],
    )
    expect(await run(f, runId)).toEqual({ expired: false })
    expect((await state(f.recordId)).availability).toBe('OPEN')
  })

  it('idempotent: a second run is a no-op with no duplicate evidence rewrite or enqueue', async () => {
    const f = await seed({ lastSeenHoursAgo: 30 })
    const oppId = await linkOpp(f.recordId)
    const runId = await addRun(f.sourceId, f.cycleId, 'WINDOW')
    expect(await run(f, runId, f.cycleId)).toEqual({ expired: true })
    const before = await q(`SELECT availability_checked_at FROM job_source_records WHERE id = $1`, [
      f.recordId,
    ])
    expect(await run(f, runId, f.cycleId)).toEqual({ expired: false })
    const after = await q(`SELECT availability_checked_at FROM job_source_records WHERE id = $1`, [
      f.recordId,
    ])
    expect(after.rows[0].availability_checked_at).toEqual(before.rows[0].availability_checked_at)
    expect(await dirtyCount(oppId)).toBe(1)
  })

  it('a CLOSED record is never downgraded to EXPIRED', async () => {
    const f = await seed({ lastSeenHoursAgo: 30, availability: 'CLOSED' })
    const runId = await addRun(f.sourceId, f.cycleId, 'WINDOW')
    expect(await run(f, runId)).toEqual({ expired: false })
    expect((await state(f.recordId)).availability).toBe('CLOSED')
  })

  it('a provider with no freshness allowance never expires', async () => {
    const f = await seed({ type: 'GREENHOUSE_ATS', lastSeenHoursAgo: 9999 })
    const runId = await addRun(f.sourceId, f.cycleId, 'WINDOW')
    expect(await run(f, runId)).toEqual({ expired: false })
    expect((await state(f.recordId)).availability).toBe('OPEN')
  })

  it('refuses a record that does not belong to the source (no write)', async () => {
    const a = await seed({ lastSeenHoursAgo: 30 })
    const b = await seed({ lastSeenHoursAgo: 30 })
    const runId = await addRun(a.sourceId, a.cycleId, 'WINDOW')
    await expect(run({ ...a, recordId: b.recordId }, runId)).rejects.toThrow(/does not belong/)
    expect((await state(b.recordId)).availability).toBe('OPEN')
  })
})
