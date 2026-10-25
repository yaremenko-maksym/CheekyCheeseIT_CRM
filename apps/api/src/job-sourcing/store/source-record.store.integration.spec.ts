import { randomUUID } from 'node:crypto'
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
import {
  cleanupStore,
  legacyCounts,
  observation,
  storeCounts,
} from '../../test/record-store-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ageRun, ageSource } from '../../test/run-aging'
import { JobRunLedger } from '../ownership/job-run-ledger'
import { RunFencedError } from '../ownership/run-ownership'
import {
  saveObservation,
  saveObservationPage,
  saveObservations,
  writePageCheckpoint,
} from './source-record.store'

/**
 * r5 Task 4.5 — the observation store against real Postgres, as `crm_app` (so the staged
 * relations' grants are exercised too). AC 1, 2, 4, 5, 6, 10.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `t3spec-${TAG}`
const HOUR = 3_600_000

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger
let db: ReturnType<typeof drizzle<typeof schema>>
let legacyBefore: { suggestions: number; postings: number }
let nsSeq = 0

const ns = () => `${PREFIX}-${(nsSeq += 1)}`
const obs = (namespace: string, nativeId: string, version = 'v1') =>
  observation({ namespace, nativeId, version, tag: TAG })

async function run() {
  return handleOf(await kit.claimOne(await kit.reporting()))
}

async function latestOf(namespace: string): Promise<string | null> {
  const { rows } = await session.admin.query(
    `SELECT latest_revision_id FROM job_source_records WHERE namespace = $1`,
    [namespace],
  )
  return rows[0]?.latest_revision_id ?? null
}

describe.skipIf(!hasDatabaseUrl())('source-record store (Task 4.5, real Postgres)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 12 })
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    db = drizzle(session.pool, { schema })
    ledger = new JobRunLedger(db, specRegistry(['REMOTIVE_API']), catalog)
    const { rows: users } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'T4.5 spec', 'ADMIN') RETURNING id`,
      [`t45-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, users[0].id as string)
    legacyBefore = await legacyCounts(session.admin)
  }, 120_000)

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

  it('AC 1: N=8 parallel transactions on one native id -> one record, one revision per content hash', async () => {
    const namespace = ns()
    const handles = await Promise.all(Array.from({ length: 8 }, () => run()))
    const results = await Promise.all(
      handles.map((h, i) =>
        saveObservationPage(db, h, {
          observations: [obs(namespace, 'same', i % 2 === 0 ? 'A' : 'B')],
          checkpoint: specCheckpoint(1),
        }),
      ),
    )
    expect(results.flat()).toHaveLength(8)
    const counts = await storeCounts(session.admin, namespace)
    expect(counts).toMatchObject({ records: 1, revisions: 2, memberships: 8 })
    expect(new Set(results.flat().map((r) => r.recordId)).size).toBe(1)
    expect(results.flat().filter((r) => r.createdRecord)).toHaveLength(1)
    expect(results.flat().filter((r) => r.createdRevision)).toHaveLength(2)
    // Dirty work only where the pointer advanced: the first arrival of each content (record
    // lock serializes them, so the second content always arrives later), never per transaction.
    expect(counts.dirty).toBe(2)
  })

  it('AC 2: two discovery configs observing one native job -> one record, two memberships', async () => {
    const namespace = ns()
    const [a, b] = [await run(), await run()]
    await saveObservationPage(db, a, {
      observations: [obs(namespace, 'j1')],
      checkpoint: specCheckpoint(1),
    })
    await saveObservationPage(db, b, {
      observations: [obs(namespace, 'j1')],
      checkpoint: specCheckpoint(1),
    })
    expect(await storeCounts(session.admin, namespace)).toMatchObject({
      records: 1,
      revisions: 1,
      memberships: 2,
      dirty: 1,
    })
    const { rows } = await session.admin.query(
      `SELECT count(DISTINCT run_id)::int AS runs FROM job_run_records m
         JOIN job_source_records r ON r.id = m.source_record_id WHERE r.namespace = $1`,
      [namespace],
    )
    expect(rows[0].runs).toBe(2)
  })

  it('AC 4: an older revision arriving after a newer one is stored and never regresses the pointer', async () => {
    const namespace = ns()
    const h = await run()
    const [older] = await saveObservationPage(db, h, {
      observations: [obs(namespace, 'late', 'A')],
      checkpoint: specCheckpoint(1),
    })
    const [newer] = await saveObservationPage(db, h, {
      observations: [obs(namespace, 'late', 'B')],
      checkpoint: specCheckpoint(2),
    })
    expect(newer?.advanced).toBe(true)
    expect(await latestOf(namespace)).toBe(newer?.revisionId)
    // A revision with an EARLIER arrival than the latest one (planted with an explicit, lower
    // `received_seq`, as a late write from a slow replica would have) — stored, pointer kept.
    const recordId = newer?.recordId as string
    await session.admin.query(
      `INSERT INTO job_source_record_revisions
         (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity, received_seq)
       OVERRIDING SYSTEM VALUE
       VALUES ($1, 'remotive_api-1', 'n1', $2, '{"title":"x"}', '{}', $3)`,
      [recordId, 'c'.repeat(64), (older?.receivedSeq as number) - 1_000_000],
    )
    const lateObs = { ...obs(namespace, 'late', 'C'), contentHash: 'c'.repeat(64) }
    const [late] = await saveObservationPage(db, h, {
      observations: [lateObs],
      checkpoint: specCheckpoint(3),
    })
    expect(late?.advanced).toBe(false)
    expect(late?.createdRevision).toBe(false)
    // The re-observed older content too: stored once, pointer kept.
    const [again] = await saveObservationPage(db, h, {
      observations: [obs(namespace, 'late', 'A')],
      checkpoint: specCheckpoint(4),
    })
    expect(again?.revisionId).toBe(older?.revisionId)
    expect(again?.advanced).toBe(false)
    expect(await latestOf(namespace)).toBe(newer?.revisionId)
    expect(await storeCounts(session.admin, namespace)).toMatchObject({
      records: 1,
      revisions: 3,
      memberships: 1,
      dirty: 2,
    })
  })

  it('AC 5: a crash between the revision insert and the checkpoint rolls both back; the retry after commit is idempotent', async () => {
    const namespace = ns()
    const h = await run()
    const page = {
      observations: [obs(namespace, 'c1'), obs(namespace, 'c2')],
      checkpoint: specCheckpoint(7),
    }
    const before = (await fx.runs(await sourceOf(h.runId)))[0]
    await expect(
      db.transaction(async (tx) => {
        const saved = await saveObservations(tx, h, page.observations)
        expect(saved).toHaveLength(2)
        throw new Error('injected crash before the checkpoint')
      }),
    ).rejects.toThrow('injected crash')
    await expect(
      db.transaction(async (tx) => {
        const saved = await saveObservations(tx, h, page.observations)
        await writePageCheckpoint(tx, h, page, saved)
        throw new Error('injected crash after the checkpoint')
      }),
    ).rejects.toThrow('injected crash')
    expect(await storeCounts(session.admin, namespace)).toMatchObject({
      records: 0,
      revisions: 0,
      memberships: 0,
      dirty: 0,
    })
    expect((await fx.runs(await sourceOf(h.runId)))[0]?.checkpoint).toEqual(before?.checkpoint)

    await saveObservationPage(db, h, page)
    await saveObservationPage(db, h, page)
    expect(await storeCounts(session.admin, namespace)).toMatchObject({
      records: 2,
      revisions: 2,
      memberships: 2,
      dirty: 2,
    })
    const after = (await fx.runs(await sourceOf(h.runId)))[0]
    expect(after?.checkpoint).toMatchObject({ position: { page: 7 } })
    expect(after?.received).toBe(4)
    expect(after?.created).toBe(2)
    expect(after?.unchanged).toBe(2)
  })

  it('AC 6: a fenced run writes nothing, and its successor`s pages stay intact', async () => {
    const namespace = ns()
    const source = await kit.reporting()
    const stale = handleOf(await kit.claimOne(source))
    await saveObservationPage(db, stale, {
      observations: [obs(namespace, 'f1')],
      checkpoint: specCheckpoint(1),
    })
    await ageRun(session.admin, stale.runId, 10 * 60_000)
    expect(await ledger.recoverExpired()).toBeGreaterThanOrEqual(1)
    await ageSource(session.admin, source, 48 * HOUR)
    const successor = handleOf(await kit.claimOne(source))
    await saveObservationPage(db, successor, {
      observations: [obs(namespace, 'f2')],
      checkpoint: specCheckpoint(2),
    })
    const before = await storeCounts(session.admin, namespace)
    const runsBefore = await fx.runs(source)

    for (const attempt of [
      () =>
        saveObservationPage(db, stale, {
          observations: [obs(namespace, 'f3'), obs(namespace, 'f1', 'B')],
          checkpoint: specCheckpoint(9),
        }),
      () => db.transaction((tx) => saveObservation(tx, stale, obs(namespace, 'f4'))),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(RunFencedError)
    }
    expect(await storeCounts(session.admin, namespace)).toEqual(before)
    expect(await fx.runs(source)).toEqual(runsBefore)
    expect(before).toMatchObject({ records: 2, memberships: 2 })
  })

  it('refuses an observation of another source type, writing nothing', async () => {
    const namespace = ns()
    const h = await run()
    const foreign = observation({ namespace, nativeId: 'x', provider: 'JSEARCH_API', tag: TAG })
    await expect(db.transaction((tx) => saveObservation(tx, h, foreign))).rejects.toBeInstanceOf(
      RangeError,
    )
    await expect(
      saveObservationPage(db, h, { observations: [foreign], checkpoint: specCheckpoint(1) }),
    ).rejects.toBeInstanceOf(RangeError)
    expect((await storeCounts(session.admin, namespace)).records).toBe(0)
  })

  it('AC 10: created no legacy suggestion or posting', async () => {
    expect(await legacyCounts(session.admin)).toEqual(legacyBefore)
  })
})

async function sourceOf(runId: string): Promise<string> {
  const { rows } = await session.admin.query(
    `SELECT source_id FROM job_collection_runs WHERE id = $1`,
    [runId],
  )
  return rows[0].source_id as string
}
