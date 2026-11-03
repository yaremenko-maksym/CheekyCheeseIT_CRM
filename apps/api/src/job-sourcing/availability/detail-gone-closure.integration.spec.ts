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
import { DETAIL_FETCH, dirtyConsumerOf, enqueueDirty } from '../ownership/dirty-work.store'
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
  DETAIL_GONE_CLOSE_REASON,
  DETAIL_GONE_UNCONTRACTED,
  detailTailPortFactory,
} from './detail-gone-closure'

/**
 * r5 Task 4.6 S8g — the 404/410 detail-closure path against a real Postgres, as `crm_app`. The
 * provider is a stub (no request leaves the machine); the flag-ON port (`detailTailPortFactory(true)`)
 * runs through the U10 tail exactly as the run worker would call it. Proves the Decision-2 named
 * outcomes at the closure grain: Greenhouse 404 GONE -> CLOSED + DETAIL_GONE + an AVAILABILITY-
 * partition owner row; FAILED / FOUND -> no closure; a board without a tested contract never closes.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `s8g-${TAG}`
const GH: JobSourceType = 'GREENHOUSE_ATS'
const AGG: JobSourceType = 'REMOTIVE_API'
const NS = { [GH]: `${PREFIX}-gh`, [AGG]: `${PREFIX}-agg` } as Record<JobSourceType, string>

const ctx = {} as CollectionContext
const config = {} as unknown as ValidatedSourceConfig

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
const runs = new Map<JobSourceType, RunHandle>()

function observation(type: JobSourceType, nativeId: string): SourceObservation {
  const namespace = NS[type]
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
    contentHash: createHash('sha256').update(`${PREFIX}-${type}-${nativeId}`).digest('hex'),
  }
}

/** A list-only record backing one opportunity, with a pending DETAIL_FETCH row. */
async function seed(
  type: JobSourceType,
  nativeId: string,
): Promise<{ recordId: string; oppId: string }> {
  const run = runs.get(type) as RunHandle
  const [saved] = await saveObservationPage(db, run, {
    observations: [observation(type, nativeId)],
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

function port(type: JobSourceType) {
  const run = runs.get(type) as RunHandle
  return detailTailPortFactory(true)({
    db,
    owner: `${PREFIX}-w`,
    source: { type, namespace: NS[type] },
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

async function tail(type: JobSourceType, outcome: DetailOutcome) {
  return runDetailTail(stub(outcome), config, ctx, port(type), 5)
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
    const ledger = new JobRunLedger(db, specRegistry([GH, AGG]), catalog)
    const { rows: admins } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'S8g admin', 'ADMIN') RETURNING id`,
      [`s8g-admin-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, admins[0].id as string)
    for (const type of [GH, AGG])
      runs.set(
        type,
        handleOf(await kit.claimOne(await kit.reporting({ type, namespace: NS[type] }))),
      )
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
      board: `${GH}:${NS[GH]}`,
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
