import { createHash, randomUUID } from 'node:crypto'
import type { JobSourceType } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import {
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  handleOf,
  specCheckpoint,
  specRegistry,
} from '../../test/ledger-fixtures'
import { cleanupStore } from '../../test/record-store-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { SourceObservation } from '../normalize/observation'
import {
  DETAIL_FETCH,
  DirtyWorkFencedError,
  dirtyConsumerOf,
  enqueueDirty,
} from '../ownership/dirty-work.store'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import type {
  CollectionContext,
  DetailOutcome,
  ReportingJobSourceProvider,
  ValidatedSourceConfig,
} from '../providers/reporting-provider'
import { runDetailTail } from '../runtime/detail-tail'
import { saveObservationPage } from '../store/source-record.store'
import {
  DETAIL_GONE_BOARD_UNCONFIRMED,
  DETAIL_GONE_CLOSE_REASON,
  DETAIL_GONE_UNCONTRACTED,
  closeRecordByDetailGone,
  detailTailPortFactory,
} from './detail-gone-closure'

/**
 * r5 Task 4.6 S8g — the 404/410 detail-closure path against a real Postgres, as `crm_app`. The
 * provider is a stub (no request leaves the machine); the flag-ON port (`detailTailPortFactory(true)`)
 * runs through the U10 tail exactly as the run worker would call it. Proves the Decision-2 named
 * outcomes at the closure grain: Greenhouse 404 GONE -> CLOSED + DETAIL_GONE + an AVAILABILITY-
 * partition owner row; FAILED -> no closure; a board without a tested contract never closes; an
 * already-CLOSED record and a replayed handle change nothing (CR-M-2); a board this run did not
 * observe alive (deleted / renamed: its list fails and every posting 404s) closes nothing (SR-M-1).
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `s8g-${TAG}`
/** The boards: a live Greenhouse board, an aggregator, and a Greenhouse board whose list died. */
type Board = 'GH' | 'AGG' | 'DEAD'
const GH: Board = 'GH'
const AGG: Board = 'AGG'
const DEAD: Board = 'DEAD'
const TYPE: Record<Board, JobSourceType> = {
  GH: 'GREENHOUSE_ATS',
  AGG: 'REMOTIVE_API',
  DEAD: 'GREENHOUSE_ATS',
}
const NS: Record<Board, string> = {
  GH: `${PREFIX}-gh`,
  AGG: `${PREFIX}-agg`,
  DEAD: `${PREFIX}-dead`,
}

const ctx = {} as CollectionContext
const config = {} as unknown as ValidatedSourceConfig

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
const runs = new Map<Board, RunHandle>()

function observation(board: Board, nativeId: string): SourceObservation {
  const type = TYPE[board]
  const namespace = NS[board]
  return {
    identity: {
      provider: type,
      namespace,
      nativeId,
      identityKey: JSON.stringify(['v1', 'NATIVE_ID', type, namespace, nativeId]),
      identityKind: 'NATIVE_ID',
    },
    sourcePostingUrl: `https://fixture.test/jobs/${nativeId}`,
    applicationUrl: null,
    originalFields: {} as SourceObservation['originalFields'],
    normalized: {
      title: 'Senior Go Engineer',
      companyName: `Acme ${TAG}`,
      companyNameNormalized: `acme ${TAG}`,
      location: 'Remote',
      descriptionMd: '',
      publishedAt: null,
      dates: [],
      tags: ['go'],
    },
    evidence: [],
    adapterVersion: 'greenhouse-2',
    normalizerVersion: 'n1',
    contentHash: createHash('sha256').update(`${PREFIX}-${board}-${nativeId}`).digest('hex'),
  }
}

/** A list-only record backing one opportunity, with a pending DETAIL_FETCH row. */
async function seed(board: Board, nativeId: string): Promise<{ recordId: string; oppId: string }> {
  const run = runs.get(board) as RunHandle
  const [saved] = await saveObservationPage(db, run, {
    observations: [observation(board, nativeId)],
    checkpoint: specCheckpoint(1),
  })
  const recordId = saved?.recordId as string
  await enqueueDirty(db, 'SOURCE_RECORD', recordId, 1, DETAIL_FETCH)
  const { rows } = await session.admin.query(
    `INSERT INTO job_opportunities (title, title_key) VALUES ($1, $1) RETURNING id`,
    [`${PREFIX}-${nativeId}`],
  )
  const oppId = rows[0].id as string
  await session.admin.query(
    `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version) VALUES ($1, $2, 1)`,
    [recordId, oppId],
  )
  return { recordId, oppId }
}

function port(board: Board) {
  const run = runs.get(board) as RunHandle
  return detailTailPortFactory(true)({
    db,
    owner: `${PREFIX}-w`,
    source: { type: TYPE[board], namespace: NS[board] },
    handle: run,
    runId: run.runId,
    adapterVersion: 'greenhouse-2',
    configVersion: 1,
    now: () => new Date('2026-11-03T08:30:00Z'),
  })
}

const stub = (outcome: DetailOutcome): Pick<ReportingJobSourceProvider, 'collectDetail'> => ({
  collectDetail: async () => outcome,
})

async function tail(board: Board, outcome: DetailOutcome) {
  return runDetailTail(stub(outcome), config, ctx, port(board), 5)
}

async function record(recordId: string) {
  const { rows } = await session.admin.query(
    `SELECT availability::text AS availability, availability_evidence FROM job_source_records WHERE id = $1`,
    [recordId],
  )
  return rows[0] as { availability: string; availability_evidence: Record<string, unknown> }
}

async function detailRow(recordId: string) {
  const { rows } = await session.admin.query(
    `SELECT status, last_error_code FROM job_dirty_work WHERE entity_id = $1 AND reason = $2`,
    [recordId, DETAIL_FETCH],
  )
  return rows[0] as { status: string; last_error_code: string | null }
}

async function ownerRows(oppId: string) {
  const { rows } = await session.admin.query(
    `SELECT reason, status, target_version FROM job_dirty_work
      WHERE entity_kind = 'OPPORTUNITY' AND entity_id = $1`,
    [oppId],
  )
  // `target_version` is a bigint: pg hands it back as a string.
  return rows.map((r) => ({
    reason: String(r.reason),
    status: String(r.status),
    target_version: Number(r.target_version),
  }))
}

describe.skipIf(!hasDatabaseUrl())('S8g detail-GONE closure against Postgres', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    db = drizzle(session.pool, { schema })
    const ledger = new JobRunLedger(db, specRegistry(['GREENHOUSE_ATS', 'REMOTIVE_API']), catalog)
    const { rows: admins } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'S8g admin', 'ADMIN') RETURNING id`,
      [`s8g-admin-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, admins[0].id as string)
    for (const board of [GH, AGG, DEAD])
      runs.set(
        board,
        handleOf(
          await kit.claimOne(await kit.reporting({ type: TYPE[board], namespace: NS[board] })),
        ),
      )
    // The live board's list answered: a sibling posting this run observed (no DETAIL_FETCH, no opp).
    await saveObservationPage(db, runs.get(GH) as RunHandle, {
      observations: [observation(GH, 'sibling-listed')],
      checkpoint: specCheckpoint(1),
    })
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      await cleanupStore(session.admin, PREFIX, TAG)
      await fx.cleanup()
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
    } finally {
      await session.close()
    }
  })

  it('Greenhouse 404 GONE: the record is CLOSED with DETAIL_GONE evidence, the row DONE, one AVAILABILITY owner row', async () => {
    const { recordId, oppId } = await seed(GH, 'gone-1')
    const { rows: before } = await session.admin.query(
      `SELECT revision FROM job_opportunities WHERE id = $1`,
      [oppId],
    )
    expect(await tail(GH, { kind: 'GONE' })).toMatchObject({ claimed: 1, gone: 1, failed: 0 })
    const r = await record(recordId)
    expect(r.availability).toBe('CLOSED')
    expect(r.availability_evidence).toMatchObject({
      kind: 'DETAIL_GONE',
      httpStatus: 404,
      adapterVersion: 'greenhouse-2',
      board: `GREENHOUSE_ATS:${NS[GH]}`,
      configVersion: 1,
      runId: runs.get(GH)?.runId,
    })
    expect((await detailRow(recordId)).status).toBe('DONE')
    const owners = await ownerRows(oppId)
    expect(owners).toEqual([
      { reason: DETAIL_GONE_CLOSE_REASON, status: 'PENDING', target_version: before[0].revision },
    ])
    expect(dirtyConsumerOf(owners[0]?.reason as string)).toBe('AVAILABILITY')
    // The closure itself never bumps the opportunity: the S8d consumer re-derives it (Decision 4).
    const { rows: after } = await session.admin.query(
      `SELECT revision, availability::text AS availability FROM job_opportunities WHERE id = $1`,
      [oppId],
    )
    expect(after[0].revision).toBe(before[0].revision)
  })

  it('CR-M-2 (a): an already-CLOSED record is not re-closed: evidence kept, no owner row, the row completes DONE', async () => {
    const { recordId, oppId } = await seed(GH, 'closed-1')
    const prior = { kind: 'INVENTORY_MISSING', marker: `${PREFIX}-prior` }
    await session.admin.query(
      `UPDATE job_source_records SET availability = 'CLOSED', availability_evidence = $2::jsonb WHERE id = $1`,
      [recordId, JSON.stringify(prior)],
    )
    // The writer itself answers "not closed" for a CLOSED record.
    const direct = await db.transaction((tx) =>
      closeRecordByDetailGone(tx, recordId, {
        kind: 'DETAIL_GONE',
        httpStatus: 404,
        adapterVersion: 'greenhouse-2',
        board: `GREENHOUSE_ATS:${NS[GH]}`,
        configVersion: 1,
        runId: (runs.get(GH) as RunHandle).runId,
        observedAt: '2026-11-03T08:30:00.000Z',
      }),
    )
    expect(direct).toBe(false)
    // And through the tail: the row still settles, nothing is queued, the evidence is untouched.
    expect(await tail(GH, { kind: 'GONE' })).toMatchObject({ claimed: 1 })
    expect(await record(recordId)).toEqual({ availability: 'CLOSED', availability_evidence: prior })
    expect(await ownerRows(oppId)).toEqual([])
    expect((await detailRow(recordId)).status).toBe('DONE')
  })

  it('CR-M-2 (b): replaying a completed handle is fenced and rolls back: nothing double-queued, state unchanged', async () => {
    const { recordId, oppId } = await seed(GH, 'replay-1')
    const p = port(GH)
    const claimed = await p.claim(5)
    expect(claimed.map((c) => c.recordId)).toEqual([recordId])
    const handle = claimed[0] as (typeof claimed)[number]
    await p.recordGone(handle)
    const closed = await record(recordId)
    const owners = await ownerRows(oppId)
    expect(closed.availability).toBe('CLOSED')
    expect(owners).toHaveLength(1)
    await expect(p.recordGone(handle)).rejects.toBeInstanceOf(DirtyWorkFencedError)
    expect(await record(recordId)).toEqual(closed)
    expect(await ownerRows(oppId)).toEqual(owners)
    expect((await detailRow(recordId)).status).toBe('DONE')
  })

  it('SR-M-1: a board whose list died (every posting 404s, this run observed none) closes nothing; rows retry', async () => {
    const seeded = [
      await seed(DEAD, 'dead-1'),
      await seed(DEAD, 'dead-2'),
      await seed(DEAD, 'dead-3'),
    ]
    // The run's list phase answered nothing (a deleted / renamed board: the list 404s or fails).
    await session.admin.query(`DELETE FROM job_run_records WHERE run_id = $1`, [
      (runs.get(DEAD) as RunHandle).runId,
    ])
    expect(await tail(DEAD, { kind: 'GONE' })).toMatchObject({ claimed: 3 })
    for (const { recordId, oppId } of seeded) {
      expect((await record(recordId)).availability).not.toBe('CLOSED')
      expect(await ownerRows(oppId)).toEqual([])
      expect(await detailRow(recordId)).toMatchObject({
        status: 'PENDING',
        last_error_code: DETAIL_GONE_BOARD_UNCONFIRMED,
      })
    }
  })

  it('Greenhouse FAILED (5xx / parse drift) is no answer: no transition, no owner row, an attempt counted', async () => {
    const { recordId, oppId } = await seed(GH, 'fail-1')
    expect(await tail(GH, { kind: 'FAILED', code: 'UPSTREAM', status: 503 })).toMatchObject({
      gone: 0,
    })
    expect((await record(recordId)).availability).not.toBe('CLOSED')
    expect(await ownerRows(oppId)).toEqual([])
    expect(await detailRow(recordId)).toMatchObject({
      status: 'PENDING',
      last_error_code: 'DETAIL_UPSTREAM',
    })
  })

  it('a board WITHOUT a tested GONE contract never closes: the row is FAILED, no owner row', async () => {
    const { recordId, oppId } = await seed(AGG, 'agg-gone-1')
    await tail(AGG, { kind: 'GONE' })
    expect((await record(recordId)).availability).not.toBe('CLOSED')
    expect(await ownerRows(oppId)).toEqual([])
    expect(await detailRow(recordId)).toMatchObject({
      status: 'FAILED',
      last_error_code: DETAIL_GONE_UNCONTRACTED,
    })
  })
})
