import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  claimDirtyBatch,
  completeDirty,
  DirtyWorkFencedError,
  enqueueDirty,
  failDirty,
  recoverExpiredDirty,
} from './dirty-work.store'

/**
 * r5 Task 4.6 S3 — the dirty-work claim store against a real Postgres, connected as `crm_app` (the
 * grants the API runs under). Fixtures and read-backs go through the migration role. Every row this
 * spec writes carries `REASON`, and `afterAll` removes exactly those.
 */
const TAG = randomUUID().slice(0, 8)
const REASON = `s3spec-${TAG}`

let session: CrmAppSession
let app: SqlExecutor

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function seed(n: number, reason = REASON): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i += 1) {
    const { rows } = await session.admin.query(
      `INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason)
       VALUES ('OPPORTUNITY', $1, 1, $2) RETURNING id`,
      [randomUUID(), reason],
    )
    ids.push(String(rows[0].id))
  }
  return ids
}

async function row(id: string) {
  const { rows } = await session.admin.query(
    `SELECT status, retry_count, last_error_code, fencing_epoch, completed_at, claim_owner
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
  }
}

async function opportunity(): Promise<string> {
  const { rows } = await session.admin.query(
    `INSERT INTO job_opportunities (title, title_key) VALUES ($1, $1) RETURNING id`,
    [`s3 spec ${TAG}`],
  )
  return String(rows[0].id)
}

/** Claims everything PENDING of this spec, as one owner. */
async function claimMine(owner: string, leaseMs?: number) {
  const got = await claimDirtyBatch(app, { owner, batchSize: 1000, leaseMs })
  return got.filter((w) => w.reason === REASON)
}

describe.skipIf(!hasDatabaseUrl())('dirty-work claim store (r5 Task 4.6 S3)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    app = drizzle(session.pool)
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (String(rows[0].db) === 'crm_db') throw new Error('refusing to run against the live crm_db')
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await session.admin.query(`DELETE FROM job_dirty_work WHERE reason LIKE $1`, [`${REASON}%`])
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
      const fromA = await claimDirtyBatch(drizzle(a), { owner: 'claimer-a', batchSize: 30 })
      const fromB = await claimDirtyBatch(drizzle(b), { owner: 'claimer-b', batchSize: 1000 })
      await a.query('COMMIT')
      await b.query('COMMIT')
      const mineA = fromA.filter((w) => ids.includes(w.id)).map((w) => w.id)
      const mineB = fromB.filter((w) => ids.includes(w.id)).map((w) => w.id)
      expect(mineA).toHaveLength(30)
      expect(mineB).toHaveLength(20)
      expect(mineA.filter((id) => mineB.includes(id))).toEqual([])
      expect(new Set([...mineA, ...mineB])).toEqual(new Set(ids))
      expect((await row(mineA[0]!)).claim_owner).toBe('claimer-a')
      expect((await row(mineB[0]!)).claim_owner).toBe('claimer-b')
    } finally {
      await a.query('ROLLBACK').catch(() => undefined)
      await b.query('ROLLBACK').catch(() => undefined)
      a.release()
      b.release()
    }
    // And four racing autocommit claimers over fresh rows: still disjoint, nothing lost.
    const more = await seed(40, `${REASON}-race`)
    const raced = await Promise.all(
      [1, 2, 3, 4].map((n) => claimDirtyBatch(app, { owner: `racer-${n}`, batchSize: 15 })),
    )
    const got = raced
      .flat()
      .filter((w) => more.includes(w.id))
      .map((w) => w.id)
    expect(got).toHaveLength(40)
    expect(new Set(got).size).toBe(40)
  })

  it('AC 2: an expired lease returns the row to PENDING and fences the old holder', async () => {
    const [id] = await seed(1)
    const [old] = (await claimMine('holder-old', 1)).filter((w) => w.id === id)
    expect(old).toBeDefined()
    await sleep(20)
    // Expired but not yet recovered: the holder is already refused.
    await expect(completeDirty(app, old!)).rejects.toBeInstanceOf(DirtyWorkFencedError)
    const recovered = await recoverExpiredDirty(app)
    expect(recovered.requeued).toBeGreaterThanOrEqual(1)
    const back = await row(id!)
    expect(back.status).toBe('PENDING')
    expect(back.claim_owner).toBeNull()
    expect(back.last_error_code).toBe('LEASE_EXPIRED')
    expect(Number(back.fencing_epoch)).toBe(old!.fencingEpoch + 1)
    const [fresh] = (await claimMine('holder-new')).filter((w) => w.id === id)
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
    await session.admin.query(`UPDATE job_opportunities SET revision = 2 WHERE id = $1`, [stale])
    const held = await claimMine('versions')
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
    const [id] = await seed(1)
    const outcomes: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const [w] = (await claimMine(`retry-${i}`)).filter((x) => x.id === id)
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
    expect((await claimMine('after-failed')).some((w) => w.id === id)).toBe(false)
    // An expired lease spends an attempt too: a worker-killing row cannot loop forever.
    const [crash] = await seed(1)
    await claimMine('crasher', 1)
    await sleep(20)
    await recoverExpiredDirty(app, { maxAttempts: 1 })
    const cr = await row(crash!)
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
    await seed(5)
    const got = await claimDirtyBatch(app, { owner: 'batch', batchSize: 2 })
    expect(got).toHaveLength(2)
  })
})
