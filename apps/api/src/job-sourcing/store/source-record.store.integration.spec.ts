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
import { JobRunLedger, type SavedPage, writePageProgress } from '../ownership/job-run-ledger'
import { type RunHandle, RunFencedError, assertOwned } from '../ownership/run-ownership'
import { LockContentionError } from './lock-order'
import {
  MAX_OBSERVATIONS_PER_PAGE,
  chunkPage,
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

  /**
   * Task 4.6 AC 4 — CHARACTERIZATION, written against the ledger's `savePage` BEFORE the fold
   * (commit d12d27ca8 ran this table with a `ledger.savePage` row; it passed with these literals
   * and was then removed with that writer): the literals are what it put in the checkpoint
   * counters for this input. Input: one record already known (x), one exact repeat (a, A twice),
   * one record observed with two contents (a, A then B), one new record (b); the page is then
   * replayed in the same run. The worker's chunked write (here at a cap of 3: chunks x | a a a | b) adds up the same.
   */
  it.each([
    ['saveObservationPage', (h: RunHandle, p: SavedPage) => saveObservationPage(db, h, p)],
    [
      'chunked, at most 3 per chunk',
      async (h: RunHandle, p: SavedPage) => {
        for (const chunk of chunkPage(p, 3)) await saveObservationPage(db, h, chunk)
      },
    ],
  ] as const)('Task 4.6 AC 4: %s writes the pre-fold checkpoint counters', async (_, write) => {
    const namespace = ns()
    await write(await run(), {
      observations: [obs(namespace, 'x')],
      checkpoint: specCheckpoint(1),
    })
    const h = await run()
    const page = {
      observations: [
        obs(namespace, 'x'),
        obs(namespace, 'a', 'A'),
        obs(namespace, 'a', 'A'),
        obs(namespace, 'a', 'B'),
        obs(namespace, 'b'),
      ],
      checkpoint: specCheckpoint(3),
    }
    await write(h, page)
    const once = (await fx.runs(await sourceOf(h.runId)))[0]
    expect(once).toMatchObject({ received: 5, created: 2, unchanged: 1, duplicates: 2 })
    await write(h, page)
    const twice = (await fx.runs(await sourceOf(h.runId)))[0]
    expect(twice).toMatchObject({ received: 10, created: 2, unchanged: 4, duplicates: 4 })
    expect(twice?.checkpoint).toMatchObject({ position: { page: 3 } })
  })

  it('S8f: unchanged content of a CLOSED/EXPIRED record enqueues one RECORD_RELISTED row per run; an OPEN one none', async () => {
    const namespace = ns()
    const first = await run()
    await saveObservationPage(db, first, {
      observations: [obs(namespace, 'back', 'A')],
      checkpoint: specCheckpoint(1),
    })
    const relisted = async () => {
      const { rows } = await session.admin.query(
        `SELECT d.reason, d.target_version::int AS v FROM job_dirty_work d
           JOIN job_source_records r ON r.id = d.entity_id
          WHERE r.namespace = $1 AND d.entity_kind = 'SOURCE_RECORD' AND d.reason LIKE 'RECORD_RELISTED:%'
          ORDER BY d.reason`,
        [namespace],
      )
      return rows as { reason: string; v: number }[]
    }
    const second = await run()
    await saveObservationPage(db, second, {
      observations: [obs(namespace, 'back', 'A')],
      checkpoint: specCheckpoint(1),
    })
    expect(await relisted()).toEqual([]) // OPEN: nothing to reopen

    await session.admin.query(
      `UPDATE job_source_records SET availability = 'CLOSED' WHERE namespace = $1`,
      [namespace],
    )
    const third = await run()
    await saveObservationPage(db, third, {
      observations: [obs(namespace, 'back', 'A')],
      checkpoint: specCheckpoint(1),
    })
    // Same page content again in the same run: the per-run reason dedups.
    await saveObservationPage(db, third, {
      observations: [obs(namespace, 'back', 'A')],
      checkpoint: specCheckpoint(2),
    })
    expect(await relisted()).toEqual([{ reason: `RECORD_RELISTED:${third.runId}`, v: 1 }])

    await session.admin.query(
      `UPDATE job_source_records SET availability = 'EXPIRED' WHERE namespace = $1`,
      [namespace],
    )
    const fourth = await run()
    await saveObservationPage(db, fourth, {
      observations: [obs(namespace, 'back', 'A')],
      checkpoint: specCheckpoint(1),
    })
    expect((await relisted()).map((r) => r.reason)).toEqual(
      [`RECORD_RELISTED:${third.runId}`, `RECORD_RELISTED:${fourth.runId}`].sort(),
    )
  })

  it('CR-M-1: after a crash between chunks the successor replays the page; each run counts what it persisted', async () => {
    const namespace = ns()
    const source = await kit.reporting()
    const crashed = handleOf(await kit.claimOne(source))
    const page = {
      observations: [obs(namespace, 'r1'), obs(namespace, 'r2'), obs(namespace, 'r3')],
      checkpoint: specCheckpoint(1),
    }
    const [first] = chunkPage(page, 2)
    await saveObservationPage(db, crashed, first!)
    // The process dies here; recovery ends the run and a successor claims the source.
    await ageRun(session.admin, crashed.runId, 10 * 60_000)
    expect(await ledger.recoverExpired()).toBeGreaterThanOrEqual(1)
    await ageSource(session.admin, source, 48 * HOUR)
    const claim = await kit.claimOne(source)
    // The checkpoint never moved, so the successor starts from scratch and re-fetches the page.
    expect(claim.checkpoint).toBeNull()
    for (const chunk of chunkPage(page, 2)) await saveObservationPage(db, handleOf(claim), chunk)
    const [crashedRow, successorRow] = await fx.runs(source)
    // The documented limit: summed over both runs `received` is 5 for a 3-observation page.
    expect(crashedRow).toMatchObject({ received: 2, created: 2, unchanged: 0, duplicates: 0 })
    expect(successorRow).toMatchObject({ received: 3, created: 1, unchanged: 2, duplicates: 0 })
    expect(successorRow?.checkpoint).toMatchObject({ position: { page: 1 } })
    expect(await storeCounts(session.admin, namespace)).toMatchObject({
      records: 3,
      revisions: 3,
      memberships: 5,
    })
  })

  it('Task 4.6 AC 2 / AC 6: a crash between two chunks leaves the checkpoint where it was', async () => {
    const namespace = ns()
    const h = await run()
    await saveObservationPage(db, h, { observations: [], checkpoint: specCheckpoint(1) })
    const page = {
      observations: [obs(namespace, 'k1'), obs(namespace, 'k2'), obs(namespace, 'k3')],
      checkpoint: specCheckpoint(2),
    }
    const [first, last] = chunkPage(page, 2)
    expect(last?.checkpoint).toEqual(page.checkpoint)
    await saveObservationPage(db, h, first!)
    const between = (await fx.runs(await sourceOf(h.runId)))[0]
    expect(between?.checkpoint).toMatchObject({ position: { page: 1 } })
    expect(between).toMatchObject({ received: 2, created: 2 })
    // A crash here leaves checkpoint 1, so a successor re-fetches page 2; the last chunk moves it.
    await saveObservationPage(db, h, last!)
    const after = (await fx.runs(await sourceOf(h.runId)))[0]
    expect(after?.checkpoint).toMatchObject({ position: { page: 2 } })
    expect(after).toMatchObject({ received: 3, created: 3, unchanged: 0, duplicates: 0 })
  })

  it('R2-CR-M-1: a run that waited for the record lock reads the head committed meanwhile', async () => {
    const namespace = ns()
    const seed = await run()
    const [c] = await saveObservationPage(db, seed, {
      observations: [obs(namespace, 'w', 'C')],
      checkpoint: specCheckpoint(1),
    })
    const later = await run()
    // Another writer holds the record lock (a row lock only, so the INSERT ... DO NOTHING of the
    // waiting run does not wait: it reaches the locking statement and waits THERE).
    const holder = await session.admin.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(`SELECT 1 FROM job_source_records WHERE id = $1 FOR UPDATE`, [c?.recordId])
      const page = saveObservationPage(db, later, {
        observations: [obs(namespace, 'w', 'A')],
        checkpoint: specCheckpoint(1),
      })
      await untilBlocked(session.admin)
      // While it waits, the holder commits a head from an observation NEWER than this run.
      await holder.query(
        `UPDATE job_source_record_heads SET observed_at = clock_timestamp() + interval '1 day'
          WHERE source_record_id = $1`,
        [c?.recordId],
      )
      await holder.query('COMMIT')
      const [a] = await page
      // A head read inside the locking statement would be the pre-wait one and move the pointer.
      expect(a).toMatchObject({ createdRevision: true, advanced: false })
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    expect(await latestOf(namespace)).toBe(c?.revisionId)
    expect(await dirtyVersions(namespace)).toEqual([1])
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

  it('CR-M-1: a head insert that loses the race on the heads key re-reads the head and continues from it', async () => {
    const namespace = ns()
    const [c] = await saveObservationPage(db, await run(), {
      observations: [obs(namespace, 'race', 'C')],
      checkpoint: specCheckpoint(1),
    })
    // No head, so the next writer reads none and tries to insert one.
    await session.admin.query(`DELETE FROM job_source_record_heads WHERE source_record_id = $1`, [
      c?.recordId,
    ])
    const later = await run()
    // A writer outside the store holds an uncommitted head (an older observation at seq 5): the
    // store's head INSERT ... ON CONFLICT DO NOTHING waits on that key, then returns no row.
    const holder = await session.admin.connect()
    try {
      await holder.query('BEGIN')
      // Without FK triggers in this session only: the FK check's KEY SHARE on the record row would
      // otherwise block the store's FOR UPDATE, and the store would wait before reading the head.
      await holder.query(`SET LOCAL session_replication_role = replica`)
      await holder.query(
        `INSERT INTO job_source_record_heads (source_record_id, latest_revision_id, observed_at, observation_seq)
         VALUES ($1, $2, clock_timestamp() - interval '1 day', 5)`,
        [c?.recordId, c?.revisionId],
      )
      const page = saveObservationPage(db, later, {
        observations: [obs(namespace, 'race', 'A')],
        checkpoint: specCheckpoint(1),
      })
      await untilBlocked(session.admin)
      await holder.query('COMMIT')
      const [a] = await page
      expect(a).toMatchObject({ createdRevision: true, advanced: true })
      expect(await latestOf(namespace)).toBe(a?.revisionId)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    // The move continues from the re-read head (5 -> 6), not from a missing one (version 0).
    expect(await dirtyVersions(namespace)).toEqual([1, 6])
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
            newestPublishedAt: null,
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
