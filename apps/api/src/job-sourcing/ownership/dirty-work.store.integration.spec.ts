import { randomUUID } from 'node:crypto'
import type { JobDirtyWorkEntityKind } from '@crm/shared'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  claimDetailFetchForSource,
  claimDirtyBatch,
  type ClaimOptions,
  completeDirty,
  currentDerivedVersion,
  DETAIL_FETCH,
  DirtyWorkFencedError,
  enqueueDerivedDirty,
  enqueueDirty,
  failDirty,
  recoverExpiredDirty,
} from './dirty-work.store'

/**
 * r5 Task 4.6 S3 — the dirty-work claim store against a real Postgres, connected as `crm_app` (the
 * grants the API runs under). Fixtures and read-backs go through the migration role.
 *
 * ISOLATION (CR-M-1): the database is shared, so other rows may be PENDING or expired-CLAIMED.
 * Every spec row carries `REASON` and is dated in the year 2000 (`created_at`, and
 * `lease_expires_at` when a lease must be expired), so it sorts ahead of any real queue row. Every
 * claim asks for exactly the number of spec rows expected and asserts each returned row is one of
 * them; recovery runs with `batchSize: 1` against a lease dated 2000. A foreign row is therefore
 * never claimed, recovered or counted. `afterEach` removes the spec's rows.
 */
const TAG = randomUUID().slice(0, 8)
const REASON = `s3spec-${TAG}`
const PAST = '2000-01-01T00:00:00Z'

let session: CrmAppSession
let app: SqlExecutor
let cycleId: string

interface SeedOptions {
  readonly kind?: JobDirtyWorkEntityKind
  readonly reason?: string
  /** Days before `PAST`: a larger value sorts earlier. */
  readonly daysEarlier?: number
}

/** `n` PENDING rows dated just after `PAST` (in insertion order), returning their ids. */
async function seed(n: number, o: SeedOptions = {}): Promise<string[]> {
  const { rows } = await session.admin.query(
    `INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason, created_at)
     SELECT $1, gen_random_uuid(), 1, $2,
            $3::timestamptz - make_interval(days => $4) + i * interval '1 millisecond'
       FROM generate_series(1, $5) AS i
     RETURNING id`,
    [o.kind ?? 'OPPORTUNITY', o.reason ?? REASON, PAST, o.daysEarlier ?? 0, n],
  )
  return rows.map((r: { id: string }) => r.id)
}

/** Date the spec's PENDING rows (made through `enqueueDirty`) at `PAST`, so they sort first. */
async function ageMine(): Promise<void> {
  await session.admin.query(
    `UPDATE job_dirty_work SET created_at = $1 WHERE reason LIKE $2 AND status = 'PENDING'`,
    [PAST, `${REASON}%`],
  )
}

/** Expire one claimed row's lease at `PAST`, ahead of any other expired lease. */
async function expireLease(id: string): Promise<void> {
  await session.admin.query(`UPDATE job_dirty_work SET lease_expires_at = $1 WHERE id = $2`, [
    PAST,
    id,
  ])
}

async function row(id: string) {
  const { rows } = await session.admin.query(
    `SELECT status, retry_count, last_error_code, fencing_epoch, completed_at, claim_owner, cycle_id
       FROM job_dirty_work WHERE id = $1`,
    [id],
  )
  return rows[0] as {
    status: string
    retry_count: number
    last_error_code: string | null
    fencing_epoch: string
    completed_at: Date | null
    claim_owner: string | null
    cycle_id: string | null
  }
}

async function opportunity(): Promise<string> {
  const { rows } = await session.admin.query(
    `INSERT INTO job_opportunities (title, title_key) VALUES ($1, $1) RETURNING id`,
    [`s3 spec ${TAG}`],
  )
  return String(rows[0].id)
}

/** Claims exactly `n` rows, every one of them this spec's (anything else fails the test). */
async function claimMine(
  owner: string,
  n: number,
  o: Omit<ClaimOptions, 'owner' | 'batchSize'> = {},
  ex: SqlExecutor = app,
) {
  const got = await claimDirtyBatch(ex, { owner, batchSize: n, ...o })
  expect(got.map((w) => w.reason.startsWith(REASON))).toEqual(got.map(() => true))
  return got
}

describe.skipIf(!hasDatabaseUrl())('dirty-work claim store (r5 Task 4.6 S3)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    app = drizzle(session.pool)
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (String(rows[0].db) === 'crm_db') throw new Error('refusing to run against the live crm_db')
    const cycle = await session.admin.query(
      `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
      [REASON],
    )
    cycleId = String(cycle.rows[0].id)
  }, 120_000)

  afterEach(async () => {
    await session.admin.query(`DELETE FROM job_dirty_work WHERE reason LIKE $1`, [`${REASON}%`])
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      await session.admin.query(`DELETE FROM job_dirty_work WHERE reason LIKE $1`, [`${REASON}%`])
      await session.admin.query(`DELETE FROM job_collection_cycles WHERE id = $1`, [cycleId])
      await session.admin.query(`DELETE FROM job_opportunities WHERE title = $1`, [
        `s3 spec ${TAG}`,
      ])
    } finally {
      await session.close()
    }
  })

  it('AC 1: two connections claiming at once never receive the same row', async () => {
    const ids = await seed(50)
    const a: PoolClient = await session.pool.connect()
    const b: PoolClient = await session.pool.connect()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      // A holds its 30 rows locked (uncommitted) while B claims: SKIP LOCKED must pass them by.
      const fromA = await claimMine('claimer-a', 30, {}, drizzle(a))
      const fromB = await claimMine('claimer-b', 20, {}, drizzle(b))
      await a.query('COMMIT')
      await b.query('COMMIT')
      const idsA = fromA.map((w) => w.id)
      const idsB = fromB.map((w) => w.id)
      expect(idsA).toHaveLength(30)
      expect(idsB).toHaveLength(20)
      expect(idsA.filter((id) => idsB.includes(id))).toEqual([])
      expect(new Set([...idsA, ...idsB])).toEqual(new Set(ids))
      expect((await row(idsA[0]!)).claim_owner).toBe('claimer-a')
      expect((await row(idsB[0]!)).claim_owner).toBe('claimer-b')
    } finally {
      await a.query('ROLLBACK').catch(() => undefined)
      await b.query('ROLLBACK').catch(() => undefined)
      a.release()
      b.release()
    }
    // And four racing autocommit claimers over 40 fresh rows: disjoint, nothing lost.
    const more = await seed(40)
    const raced = await Promise.all([1, 2, 3, 4].map((n) => claimMine(`racer-${n}`, 10)))
    const got = raced.flat().map((w) => w.id)
    expect(got).toHaveLength(40)
    expect(new Set(got)).toEqual(new Set(more))
  })

  it('AC 2: an expired lease returns the row to PENDING and fences the old holder', async () => {
    const [id] = await seed(1)
    const [old] = await claimMine('holder-old', 1)
    expect(old!.id).toBe(id)
    await expireLease(id!)
    // Expired but not yet recovered: the holder is already refused.
    await expect(completeDirty(app, old!)).rejects.toBeInstanceOf(DirtyWorkFencedError)
    expect(await recoverExpiredDirty(app, { batchSize: 1 })).toEqual({ requeued: 1, failed: 0 })
    const back = await row(id!)
    expect(back.status).toBe('PENDING')
    expect(back.claim_owner).toBeNull()
    expect(back.last_error_code).toBe('LEASE_EXPIRED')
    expect(Number(back.fencing_epoch)).toBe(old!.fencingEpoch + 1)
    const [fresh] = await claimMine('holder-new', 1)
    expect(fresh!.id).toBe(id)
    expect(fresh!.fencingEpoch).toBe(old!.fencingEpoch + 2)
    // The old holder, same owner name or not, can neither complete nor fail the re-claimed row.
    await expect(completeDirty(app, old!)).rejects.toBeInstanceOf(DirtyWorkFencedError)
    await expect(failDirty(app, old!, 'HTTP_500')).rejects.toBeInstanceOf(DirtyWorkFencedError)
    await expect(completeDirty(app, { ...old!, owner: 'holder-new' })).rejects.toBeInstanceOf(
      DirtyWorkFencedError,
    )
    expect((await row(id!)).claim_owner).toBe('holder-new')
  })

  it('AC 3: a stale target version is DEFERRED, a current one DONE, a missing entity DEFERRED', async () => {
    const stale = await opportunity()
    const current = await opportunity()
    await enqueueDirty(app, 'OPPORTUNITY', stale, 1, REASON)
    await enqueueDirty(app, 'OPPORTUNITY', current, 1, REASON)
    await enqueueDirty(app, 'SOURCE_RECORD', randomUUID(), 1, REASON)
    await ageMine()
    await session.admin.query(`UPDATE job_opportunities SET revision = 2 WHERE id = $1`, [stale])
    const held = await claimMine('versions', 3)
    const by = (entityId: string) => held.find((w) => w.entityId === entityId)!
    expect(await completeDirty(app, by(stale))).toBe('DEFERRED')
    expect(await completeDirty(app, by(current))).toBe('DONE')
    const gone = held.find((w) => w.entityKind === 'SOURCE_RECORD')!
    expect(await completeDirty(app, gone)).toBe('DEFERRED')
    const s = await row(by(stale).id)
    expect([s.status, s.last_error_code, s.completed_at !== null]).toEqual([
      'DEFERRED',
      'VERSION_STALE',
      true,
    ])
    const c = await row(by(current).id)
    expect([c.status, c.last_error_code, c.claim_owner]).toEqual(['DONE', null, null])
    expect((await row(gone.id)).last_error_code).toBe('ENTITY_MISSING')
    // A finished row is not held any more: a second completion is refused.
    await expect(completeDirty(app, by(current))).rejects.toBeInstanceOf(DirtyWorkFencedError)
  })

  it('AC 4: failures retry until the budget, then FAILED with last_error_code — never again', async () => {
    const [id, next] = await seed(2)
    const outcomes: string[] = []
    for (let i = 0; i < 3; i += 1) {
      // The failed row keeps its (earliest) created_at, so it is claimed first again.
      const [w] = await claimMine(`retry-${i}`, 1)
      expect(w!.id).toBe(id)
      outcomes.push(await failDirty(app, w!, 'HTTP_503', { maxAttempts: 3 }))
    }
    expect(outcomes).toEqual(['RETRY', 'RETRY', 'FAILED'])
    const r = await row(id!)
    expect([r.status, r.retry_count, r.last_error_code, r.completed_at !== null]).toEqual([
      'FAILED',
      3,
      'HTTP_503',
      true,
    ])
    // The FAILED row is passed over: the next claim gets the other spec row.
    const [after] = await claimMine('after-failed', 1)
    expect(after!.id).toBe(next)
    // An expired lease spends an attempt too: a worker-killing row cannot loop forever.
    await expireLease(next!)
    expect(await recoverExpiredDirty(app, { batchSize: 1, maxAttempts: 1 })).toEqual({
      requeued: 0,
      failed: 1,
    })
    const cr = await row(next!)
    expect([cr.status, cr.last_error_code, cr.retry_count]).toEqual(['FAILED', 'LEASE_EXPIRED', 1])
  })

  it('AC 5: a duplicate enqueue is a no-op (no 23505), distinct version or reason inserts', async () => {
    const entity = randomUUID()
    const c = await session.pool.connect()
    try {
      await c.query('BEGIN')
      const tx = drizzle(c)
      expect(await enqueueDirty(tx, 'OPPORTUNITY', entity, 1, REASON)).toEqual({ inserted: true })
      expect(await enqueueDirty(tx, 'OPPORTUNITY', entity, 1, REASON)).toEqual({ inserted: false })
      // The transaction is still usable: the duplicate did not abort it.
      expect(await enqueueDirty(tx, 'OPPORTUNITY', entity, 2, REASON)).toEqual({ inserted: true })
      expect(await enqueueDirty(tx, 'OPPORTUNITY', entity, 1, `${REASON}-b`)).toEqual({
        inserted: true,
      })
      await c.query('COMMIT')
    } finally {
      await c.query('ROLLBACK').catch(() => undefined)
      c.release()
    }
    const { rows } = await session.admin.query(
      `SELECT target_version::int AS v, reason FROM job_dirty_work WHERE entity_id = $1 ORDER BY 1, 2`,
      [entity],
    )
    expect(rows).toEqual([
      { v: 1, reason: REASON },
      { v: 1, reason: `${REASON}-b` },
      { v: 2, reason: REASON },
    ])
  })

  it('AC 6: a claim takes at most batchSize rows', async () => {
    const ids = await seed(5)
    const got = await claimMine('batch', 2)
    expect(got).toHaveLength(2)
    expect(got.every((w) => ids.includes(w.id))).toBe(true)
  })

  it('CR-M-2 / S5: the derived kinds are claimed by default; kinds narrow the claim', async () => {
    // The SENIOR row is the oldest of all: since S5 it has a version source and is claimed first.
    const [senior] = await seed(1, { kind: 'SENIOR', daysEarlier: 365 })
    const [opp] = await seed(1)
    const [rec] = await seed(1, { kind: 'SOURCE_RECORD', daysEarlier: 1 })
    const [narrowed] = await claimMine('kinds-opp', 1, { kinds: ['OPPORTUNITY'] })
    expect(narrowed!.id).toBe(opp)
    const [first] = await claimMine('kinds-default', 1)
    expect(first!.id).toBe(senior)
    const r = await row(rec!)
    expect([r.status, r.claim_owner]).toEqual(['PENDING', null])
  })

  it('S5 AC 2/3: derived versions increase per entity; only the newest row completes DONE', async () => {
    const entity = randomUUID()
    // Same-transaction, same-timestamp writes, a delete and a restore: versions still climb.
    const versions = await app.transaction(async (tx) => {
      const out: number[] = []
      for (const reason of ['create', 'delete', 'restore', 'create'])
        out.push(
          (await enqueueDerivedDirty(tx, 'EXCLUSION', entity, `${REASON}:${reason}`)).version,
        )
      return out
    })
    expect(versions).toEqual([1, 2, 3, 4])
    expect(await currentDerivedVersion(app, 'EXCLUSION', entity)).toBe(4)
    await ageMine()
    const got = await claimMine('derived', 4, { kinds: ['EXCLUSION'] })
    const outcomes = new Map<number, string>()
    for (const w of got) outcomes.set(w.targetVersion, await completeDirty(app, w))
    expect([...outcomes].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 'DEFERRED'],
      [2, 'DEFERRED'],
      [3, 'DEFERRED'],
      [4, 'DONE'],
    ])
    const { rows } = await session.admin.query(
      `SELECT target_version::int AS v, last_error_code FROM job_dirty_work
        WHERE entity_id = $1 ORDER BY 1`,
      [entity],
    )
    expect(rows.map((r) => r.last_error_code)).toEqual([
      'VERSION_STALE',
      'VERSION_STALE',
      'VERSION_STALE',
      null,
    ])
  })

  it('S5: concurrent producers of one entity get distinct versions (advisory lock)', async () => {
    const entity = randomUUID()
    const run = () =>
      app.transaction(async (tx) => {
        const r = await enqueueDerivedDirty(tx, 'SENIOR', entity, `${REASON}:same`)
        // Hold the lock a little, so the other producer must wait for this commit.
        await tx.execute(sql`SELECT pg_sleep(0.05)`)
        return r
      })
    const results = await Promise.all([run(), run(), run()])
    expect(results.map((r) => r.version).sort()).toEqual([1, 2, 3])
    expect(results.every((r) => r.inserted)).toBe(true)
  })

  it('S5 AC 1: a rolled-back producer leaves no derived row', async () => {
    const entity = randomUUID()
    await expect(
      app.transaction(async (tx) => {
        await enqueueDerivedDirty(tx, 'PROJECT_CLIENT', entity, `${REASON}:rollback`)
        throw new Error('the write failed')
      }),
    ).rejects.toThrow('the write failed')
    expect(await currentDerivedVersion(app, 'PROJECT_CLIENT', entity)).toBe(0)
  })

  it('CR-M-3: enqueueDirty records the cycle id; a duplicate keeps the first row', async () => {
    const entity = randomUUID()
    expect(await enqueueDirty(app, 'SOURCE_RECORD', entity, 1, REASON, cycleId)).toEqual({
      inserted: true,
    })
    expect(await enqueueDirty(app, 'SOURCE_RECORD', entity, 1, REASON)).toEqual({
      inserted: false,
    })
    expect(await enqueueDirty(app, 'SOURCE_RECORD', entity, 2, REASON)).toEqual({
      inserted: true,
    })
    const { rows } = await session.admin.query(
      `SELECT target_version::int AS v, cycle_id FROM job_dirty_work WHERE entity_id = $1 ORDER BY 1`,
      [entity],
    )
    expect(rows).toEqual([
      { v: 1, cycle_id: cycleId },
      { v: 2, cycle_id: null },
    ])
  })

  /**
   * SFS U10 (ADR 6a, change #1/#4): a detail-fetch claim is filtered to the run's own source
   * (`source_type` + `namespace`), and the `(kind, entity, version, reason)` unique key makes a
   * second enqueue of the same record version a no-op — the detail is fetched once.
   */
  it("U10: claims only the source's pending DETAIL_FETCH rows, and enqueues once per version", async () => {
    const ns = `u10-${TAG}`
    const otherNs = `u10-other-${TAG}`
    // A source record of ours, and one of another namespace (same type) that must be excluded.
    const rec = async (namespace: string): Promise<string> => {
      const { rows } = await session.admin.query(
        `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
         VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2) RETURNING id`,
        [namespace, `${namespace}:${randomUUID()}`],
      )
      return String(rows[0].id)
    }
    const mine = await rec(ns)
    const other = await rec(otherNs)
    try {
      // Fetch once: the second enqueue of version 1 is a no-op.
      expect(await enqueueDirty(app, 'SOURCE_RECORD', mine, 1, DETAIL_FETCH)).toEqual({
        inserted: true,
      })
      expect(await enqueueDirty(app, 'SOURCE_RECORD', mine, 1, DETAIL_FETCH)).toEqual({
        inserted: false,
      })
      // A row for another source of the same type — must not be claimed by our source's run.
      await enqueueDirty(app, 'SOURCE_RECORD', other, 1, DETAIL_FETCH)

      const claimed = await claimDetailFetchForSource(app, {
        owner: 'u10-worker',
        source: { type: 'GREENHOUSE_ATS', namespace: ns },
        batchSize: 10,
      })
      expect(claimed).toHaveLength(1)
      expect(claimed[0]).toMatchObject({ entityId: mine, reason: DETAIL_FETCH, targetVersion: 1 })

      // The other source's row stays PENDING.
      const { rows: otherRows } = await session.admin.query(
        `SELECT status FROM job_dirty_work WHERE entity_id = $1`,
        [other],
      )
      expect(otherRows).toEqual([{ status: 'PENDING' }])
    } finally {
      await session.admin.query(`DELETE FROM job_dirty_work WHERE entity_id = ANY($1::uuid[])`, [
        [mine, other],
      ])
      await session.admin.query(`DELETE FROM job_source_records WHERE namespace = ANY($1)`, [
        [ns, otherNs],
      ])
    }
  })

  /**
   * SFS U10 (SPEC-L-1): the detail-fetch claim takes the oldest rows first and never more than
   * `batchSize`, so a run honours its per-type `detailPerRun` budget and drains the backlog fairly.
   */
  it('U10: claims oldest-first and stops at batchSize', async () => {
    const ns = `u10ord-${TAG}`
    const recAt = async (daysEarlier: number): Promise<string> => {
      const { rows } = await session.admin.query(
        `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
         VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2) RETURNING id`,
        [ns, `${ns}:${randomUUID()}`],
      )
      const id = String(rows[0].id)
      await enqueueDirty(app, 'SOURCE_RECORD', id, 1, DETAIL_FETCH)
      // Date the row deterministically so the three sort oldest-first, ahead of any real queue row.
      await session.admin.query(
        `UPDATE job_dirty_work SET created_at = $1::timestamptz - make_interval(days => $2)
          WHERE entity_id = $3`,
        [PAST, daysEarlier, id],
      )
      return id
    }
    // oldest, middle, newest
    const oldest = await recAt(3)
    const middle = await recAt(2)
    const newest = await recAt(1)
    try {
      const claimed = await claimDetailFetchForSource(app, {
        owner: 'u10-order',
        source: { type: 'GREENHOUSE_ATS', namespace: ns },
        batchSize: 2,
      })
      // Exactly batchSize rows, and the two oldest, in created_at order.
      expect(claimed.map((w) => w.entityId)).toEqual([oldest, middle])
      // The newest stays PENDING — it was beyond the budget.
      const { rows } = await session.admin.query(
        `SELECT status FROM job_dirty_work WHERE entity_id = $1`,
        [newest],
      )
      expect(rows).toEqual([{ status: 'PENDING' }])
    } finally {
      await session.admin.query(`DELETE FROM job_dirty_work WHERE entity_id = ANY($1::uuid[])`, [
        [oldest, middle, newest],
      ])
      await session.admin.query(`DELETE FROM job_source_records WHERE namespace = $1`, [ns])
    }
  })
})
