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
  gate,
  legacyCounts,
  observation,
  storeCounts,
  untilBlocked,
} from '../../test/record-store-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ageRun, ageSource } from '../../test/run-aging'
import { JobRunLedger, writePageProgress } from '../ownership/job-run-ledger'
import { RunFencedError, assertOwned } from '../ownership/run-ownership'
import { LockContentionError } from './lock-order'
import {
  MAX_OBSERVATIONS_PER_PAGE,
  saveObservation,
  saveObservationPage,
  saveObservations,
  writePageCheckpoint,
} from './source-record.store'

/**
 * r5 Task 4.5 — the observation store against real Postgres, as `crm_app` (so the staged
 * relations' grants are exercised too). AC 1, 2, 4, 5, 6, 10; fix round 1: CR-M-2 (latest follows
 * the most recent observation), CR-M-3 (two contents in one page), SR-M-1 (self-fencing
 * checkpoint), SR-M-4 (page cap, runtime re-parse), CR-M-7 (contention exhaustion on a real lock).
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

async function dirtyVersions(namespace: string): Promise<number[]> {
  const { rows } = await session.admin.query(
    `SELECT d.target_version::int AS v FROM job_dirty_work d
       JOIN job_source_records r ON r.id = d.entity_id
      WHERE r.namespace = $1 AND d.entity_kind = 'SOURCE_RECORD' ORDER BY 1`,
    [namespace],
  )
  return rows.map((r) => r.v as number)
}

async function sourceOf(runId: string): Promise<string> {
  const { rows } = await session.admin.query(
    `SELECT source_id FROM job_collection_runs WHERE id = $1`,
    [runId],
  )
  return rows[0].source_id as string
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
    const saved = results.flat()
    expect(saved).toHaveLength(8)
    const counts = await storeCounts(session.admin, namespace)
    expect(counts).toMatchObject({ records: 1, revisions: 2, memberships: 8 })
    expect(new Set(saved.map((r) => r.recordId)).size).toBe(1)
    expect(saved.filter((r) => r.createdRecord)).toHaveLength(1)
    expect(saved.filter((r) => r.createdRevision)).toHaveLength(2)
    // One dirty version per pointer move, versions 1..n with no repeat.
    const versions = await dirtyVersions(namespace)
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1))
    expect(versions.length).toBe(saved.filter((r) => r.advanced).length)
    // The latest is the content of the run that started last (the most recent observation).
    const { rows } = await session.admin.query(
      `SELECT id FROM job_collection_runs WHERE id = ANY($1::uuid[]) ORDER BY started_at DESC, id DESC LIMIT 1`,
      [handles.map((h) => h.runId)],
    )
    const last = handles.findIndex((h) => h.runId === rows[0].id)
    const lastRevision = saved[last]?.revisionId
    expect(await latestOf(namespace)).toBe(lastRevision)
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

  it('AC 4 / CR-M-2: latest follows the most recent observation; an older one never regresses it', async () => {
    const namespace = ns()
    const older = await run() // claimed first: its observations are older
    const newer = await run()
    const [b] = await saveObservationPage(db, newer, {
      observations: [obs(namespace, 'late', 'B')],
      checkpoint: specCheckpoint(1),
    })
    // A slow run that started earlier commits content A afterwards: stored, pointer kept at B.
    const [lateA] = await saveObservationPage(db, older, {
      observations: [obs(namespace, 'late', 'A')],
      checkpoint: specCheckpoint(1),
    })
    expect(lateA).toMatchObject({ createdRevision: true, advanced: false })
    expect(await latestOf(namespace)).toBe(b?.revisionId)
    // The newer run now observes A, then B again: A -> B -> A -> B, each a pointer move.
    const [a] = await saveObservationPage(db, newer, {
      observations: [obs(namespace, 'late', 'A')],
      checkpoint: specCheckpoint(2),
    })
    expect(a).toMatchObject({
      revisionId: lateA?.revisionId,
      createdRevision: false,
      advanced: true,
    })
    expect(await latestOf(namespace)).toBe(lateA?.revisionId)
    const [b2] = await saveObservationPage(db, newer, {
      observations: [obs(namespace, 'late', 'B')],
      checkpoint: specCheckpoint(3),
    })
    expect(b2?.advanced).toBe(true)
    expect(await latestOf(namespace)).toBe(b?.revisionId)
    // The same content again moves nothing and enqueues nothing.
    const [same] = await saveObservationPage(db, newer, {
      observations: [obs(namespace, 'late', 'B')],
      checkpoint: specCheckpoint(4),
    })
    expect(same?.advanced).toBe(false)
    expect(await dirtyVersions(namespace)).toEqual([1, 2, 3])
    expect(await storeCounts(session.admin, namespace)).toMatchObject({ records: 1, revisions: 2 })
  })

  it('CR-M-3 / R2-CR-M-2: A, B, A in one page writes all three and ends on A', async () => {
    const namespace = ns()
    const h = await run()
    const page = {
      observations: [
        obs(namespace, 'd1', 'first'),
        obs(namespace, 'd1', 'second'),
        obs(namespace, 'd1', 'first'),
      ],
      checkpoint: specCheckpoint(1),
    }
    const saved = await saveObservationPage(db, h, page)
    expect(saved.map((s) => [s.superseded, s.advanced, s.createdRevision])).toEqual([
      [true, true, true],
      [true, true, true],
      [false, true, false],
    ])
    expect(saved[2]?.revisionId).toBe(saved[0]?.revisionId)
    expect(await latestOf(namespace)).toBe(saved[0]?.revisionId)
    expect(await dirtyVersions(namespace)).toEqual([1, 2, 3])
    expect(await storeCounts(session.admin, namespace)).toMatchObject({ records: 1, revisions: 2 })
    const r = (await fx.runs(await sourceOf(h.runId)))[0]
    expect(r).toMatchObject({ received: 3, created: 1, unchanged: 0, duplicates: 2 })
  })

  it('R2-CR-M-1: an older run that waited behind a newer one reads the head the newer one wrote', async () => {
    const namespace = ns()
    const seed = await run()
    await saveObservationPage(db, seed, {
      observations: [obs(namespace, 'w', 'C')],
      checkpoint: specCheckpoint(1),
    })
    const older = await run()
    const newer = await run()
    const hold = gate()
    const written = gate()
    // The newer run writes B and keeps its transaction (and the record lock) open.
    const newerTx = db.transaction(async (tx) => {
      const saved = await saveObservations(tx, newer, [obs(namespace, 'w', 'B')])
      written.open()
      await hold.wait
      return saved
    })
    await written.wait
    // The older run's page now waits on the record lock.
    const olderPage = saveObservationPage(db, older, {
      observations: [obs(namespace, 'w', 'A')],
      checkpoint: specCheckpoint(1),
    })
    await untilBlocked(session.admin)
    hold.open()
    const [[b], [a]] = [await newerTx, await olderPage]
    expect(b?.advanced).toBe(true)
    // After the wait the older run saw the NEWER head: A is stored and the pointer stays on B.
    expect(a).toMatchObject({ createdRevision: true, advanced: false })
    expect(await latestOf(namespace)).toBe(b?.revisionId)
    expect(await dirtyVersions(namespace)).toEqual([1, 2])
  })

  it('R2-CR-M-1: two concurrent first observations of a new record both succeed', async () => {
    const namespace = ns()
    const [first, second] = [await run(), await run()]
    const hold = gate()
    const written = gate()
    const firstTx = db.transaction(async (tx) => {
      const saved = await saveObservations(tx, first, [obs(namespace, 'n', 'X')])
      written.open()
      await hold.wait
      return saved
    })
    await written.wait
    const secondPage = saveObservationPage(db, second, {
      observations: [obs(namespace, 'n', 'Y')],
      checkpoint: specCheckpoint(1),
    })
    await untilBlocked(session.admin)
    hold.open()
    const [[x], [y]] = [await firstTx, await secondPage]
    expect(x?.recordId).toBe(y?.recordId)
    expect([x?.createdRecord, y?.createdRecord]).toEqual([true, false])
    // The second run started later: its observation is the latest, versions 1 then 2.
    expect(await latestOf(namespace)).toBe(y?.revisionId)
    expect(await dirtyVersions(namespace)).toEqual([1, 2])
    const { rows } = await session.admin.query(
      `SELECT count(*)::int AS n FROM job_source_record_heads h JOIN job_source_records r ON r.id = h.source_record_id WHERE r.namespace = $1`,
      [namespace],
    )
    expect(rows[0].n).toBe(1)
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

  it('AC 6 / SR-M-1: a fenced run writes nothing — through the page, one observation, or the checkpoint alone', async () => {
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
    const page = { observations: [obs(namespace, 'f3')], checkpoint: specCheckpoint(9) }

    for (const attempt of [
      () =>
        saveObservationPage(db, stale, {
          ...page,
          observations: [obs(namespace, 'f3'), obs(namespace, 'f1', 'B')],
        }),
      () => db.transaction((tx) => saveObservation(tx, stale, obs(namespace, 'f4'))),
      () => db.transaction((tx) => writePageCheckpoint(tx, stale, page, [])),
      // The ledger's writer refuses a stale handle even when handed the successor's OwnedRun.
      () =>
        db.transaction(async (tx) =>
          writePageProgress(tx, stale, await assertOwned(tx, successor), {
            checkpoint: specCheckpoint(9),
            received: 0,
            unique: 0,
            created: 0,
          }),
        ),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(RunFencedError)
    }
    expect(await storeCounts(session.admin, namespace)).toEqual(before)
    expect(await fx.runs(source)).toEqual(runsBefore)
    expect(before).toMatchObject({ records: 2, memberships: 2 })
  })

  it('SR-M-4: refuses an oversized page and a malformed observation, writing nothing', async () => {
    const namespace = ns()
    const h = await run()
    const big = Array.from({ length: MAX_OBSERVATIONS_PER_PAGE + 1 }, (_, i) =>
      obs(namespace, `b${i}`),
    )
    await expect(
      saveObservationPage(db, h, { observations: big, checkpoint: specCheckpoint(1) }),
    ).rejects.toThrow(
      new RangeError(
        `saveObservations: ${big.length} observations, at most ${MAX_OBSERVATIONS_PER_PAGE}`,
      ),
    )
    const bad = { ...obs(namespace, 'm1'), contentHash: 'not-a-hash' }
    await expect(
      saveObservationPage(db, h, {
        observations: [obs(namespace, 'm0'), bad],
        checkpoint: specCheckpoint(1),
      }),
    ).rejects.toThrow()
    expect((await storeCounts(session.admin, namespace)).records).toBe(0)
  })

  it('CR-M-7: a lock held past every attempt ends in a typed LockContentionError (55P03)', async () => {
    const namespace = ns()
    const h = await run()
    const [first] = await saveObservationPage(db, h, {
      observations: [obs(namespace, 'x1')],
      checkpoint: specCheckpoint(1),
    })
    const holder = await session.admin.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(`SELECT 1 FROM job_source_records WHERE id = $1 FOR UPDATE`, [
        first?.recordId,
      ])
      const err = await saveObservationPage(
        db,
        h,
        { observations: [obs(namespace, 'x1', 'v2')], checkpoint: specCheckpoint(2) },
        { lockTimeoutMs: 100 },
      ).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LockContentionError)
      expect(err).toMatchObject({ sqlstate: '55P03', attempts: 3 })
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    expect((await storeCounts(session.admin, namespace)).revisions).toBe(1)
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
