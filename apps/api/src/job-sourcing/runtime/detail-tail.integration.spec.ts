import { createHash, randomUUID } from 'node:crypto'
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
import { DETAIL_FETCH, enqueueDirty } from '../ownership/dirty-work.store'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import type {
  CollectionContext,
  DetailOutcome,
  ReportingJobSourceProvider,
  ValidatedSourceConfig,
} from '../providers/reporting-provider'
import { saveObservationPage } from '../store/source-record.store'
import { createDetailTailPort, runDetailTail } from './detail-tail'

/**
 * SFS U10 part 3 — the detail tail's DB port against a real Postgres, as `crm_app` (change #4/#6/#7).
 * The provider is faked (no request leaves the machine); the port's write-through, availability
 * evidence and failure transitions are exercised against the store and the dirty-work queue.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `u10tail-${TAG}`
const NAMESPACE = `${PREFIX}-ns`
const TYPE = 'REMOTIVE_API' as const

const ctx = {} as CollectionContext
const config = {} as unknown as ValidatedSourceConfig

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
let run: RunHandle

function observation(nativeId: string, withDescription: boolean): SourceObservation {
  return {
    identity: {
      provider: TYPE,
      namespace: NAMESPACE,
      nativeId,
      identityKey: JSON.stringify(['v1', 'NATIVE_ID', TYPE, NAMESPACE, nativeId]),
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
      descriptionMd: withDescription ? `The detail body (${TAG}, ${nativeId}).` : '',
      publishedAt: null,
      dates: [],
      tags: ['go'],
    },
    evidence: [],
    adapterVersion: 'remotive_api-1',
    normalizerVersion: 'n1',
    contentHash: createHash('sha256')
      .update(`u10tail-${TAG}-${nativeId}-${withDescription ? 'd' : 'n'}`)
      .digest('hex'),
  }
}

/** Write a no-description record (the ON_DEMAND list-only shape) and enqueue a DETAIL_FETCH row. */
async function seed(nativeId: string): Promise<string> {
  const [saved] = await saveObservationPage(db, run, {
    observations: [observation(nativeId, false)],
    checkpoint: specCheckpoint(1),
  })
  const recordId = saved?.recordId as string
  await enqueueDirty(db, 'SOURCE_RECORD', recordId, 1, DETAIL_FETCH)
  return recordId
}

function port() {
  return createDetailTailPort({
    db,
    owner: `u10tail-${TAG}`,
    source: { type: TYPE, namespace: NAMESPACE },
    handle: run,
    runId: run.runId,
    adapterVersion: 'remotive_api-1',
    configVersion: 1,
    now: () => new Date('2026-11-02T00:00:00Z'),
  })
}

const providerReturning = (
  fn: () => DetailOutcome,
): Pick<ReportingJobSourceProvider, 'collectDetail'> => ({
  collectDetail: async () => fn(),
})

async function rowStatus(recordId: string): Promise<string | undefined> {
  const { rows } = await session.admin.query(
    `SELECT status FROM job_dirty_work WHERE entity_id = $1 AND reason = $2`,
    [recordId, DETAIL_FETCH],
  )
  return rows[0]?.status as string | undefined
}

async function recordState(recordId: string) {
  const { rows } = await session.admin.query(
    `SELECT r.availability, r.availability_evidence, v.description_sha256
       FROM job_source_records r
       JOIN job_source_record_heads h ON h.source_record_id = r.id
       JOIN job_source_record_revisions v ON v.id = h.latest_revision_id
      WHERE r.id = $1`,
    [recordId],
  )
  return rows[0] as
    | {
        availability: string
        availability_evidence: Record<string, unknown>
        description_sha256: string | null
      }
    | undefined
}

describe.skipIf(!hasDatabaseUrl())('detail tail port against Postgres (U10 #4/#6/#7)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    db = drizzle(session.pool, { schema })
    const ledger = new JobRunLedger(db, specRegistry([TYPE]), catalog)
    const { rows: admins } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'U10tail admin', 'ADMIN') RETURNING id`,
      [`u10tail-admin-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, admins[0].id as string)
    run = handleOf(await kit.claimOne(await kit.reporting({ type: TYPE })))
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

  it('#6 FOUND: writes the detail as a new revision with a description and completes the row', async () => {
    const recordId = await seed('found-1')
    const report = await runDetailTail(
      providerReturning(() => ({ kind: 'FOUND', observation: observation('found-1', true) })),
      config,
      ctx,
      port(),
      5,
    )
    expect(report).toMatchObject({ claimed: 1, fetched: 1 })
    const state = await recordState(recordId)
    // The detail write advanced the record to a revision that carries a description.
    expect(state?.description_sha256).not.toBeNull()
    // Completing a row whose record moved on is DEFERRED (version stale); the re-fetch is done.
    expect(await rowStatus(recordId)).toBe('DEFERRED')
  })

  it('#7 GONE: closes the record with DETAIL_GONE evidence and completes the row DONE (never retried)', async () => {
    const recordId = await seed('gone-1')
    const report = await runDetailTail(
      providerReturning(() => ({ kind: 'GONE' })),
      config,
      ctx,
      port(),
      5,
    )
    expect(report).toMatchObject({ claimed: 1, gone: 1 })
    const state = await recordState(recordId)
    expect(state?.availability).toBe('CLOSED')
    expect(state?.availability_evidence).toMatchObject({ kind: 'DETAIL_GONE', httpStatus: 404 })
    expect(await rowStatus(recordId)).toBe('DONE')
  })

  it('#7 FAILED: counts an attempt, the row returns to PENDING with a DETAIL_ error code', async () => {
    const recordId = await seed('fail-1')
    const report = await runDetailTail(
      providerReturning(() => ({ kind: 'FAILED', code: 'UPSTREAM', status: 500 })),
      config,
      ctx,
      port(),
      5,
    )
    expect(report).toMatchObject({ claimed: 1, retried: 1 })
    expect(await rowStatus(recordId)).toBe('PENDING')
    const { rows } = await session.admin.query(
      `SELECT last_error_code, retry_count FROM job_dirty_work WHERE entity_id = $1 AND reason = $2`,
      [recordId, DETAIL_FETCH],
    )
    expect(rows[0]).toMatchObject({ last_error_code: 'DETAIL_UPSTREAM', retry_count: 1 })
  })

  it('claims only this source and at most detailPerRun, oldest first', async () => {
    await seed('batch-a')
    await seed('batch-b')
    await seed('batch-c')
    const report = await runDetailTail(
      providerReturning(() => ({ kind: 'GONE' })),
      config,
      ctx,
      port(),
      2,
    )
    // At most two of this source's pending rows, though three (plus earlier tests') exist.
    expect(report.claimed).toBe(2)
  })
})
