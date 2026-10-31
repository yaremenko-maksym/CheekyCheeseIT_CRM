import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { ClaimedDirtyWork } from '../ownership/dirty-work.store'
import type { SqlExecutor } from '../scheduling/host-state'
import type { MeterDb } from '../metering/account-meter.store'
import { createRecomputeSteps } from './recompute-worker'
import { FANOUT_PAGE_SIZE, fanOutDirty, fanoutCursor } from './roster-fanout'

/** r5 Task 4.6 S5 — the fan-out pass against a scripted executor (real DB: the integration spec). */
const dialect = new PgDialect()
const ROW = '0b6a6f6e-8f43-4c55-9c4a-6c3f3e1f2a10'
const SENIOR = '7d9b0d1c-2e5f-4a8b-9c6d-1e2f3a4b5c6d'
const NIL = '00000000-0000-0000-0000-000000000000'
const opp = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

const work = (over: Partial<ClaimedDirtyWork> = {}): ClaimedDirtyWork => ({
  id: ROW,
  owner: 'w',
  fencingEpoch: 1,
  entityKind: 'SENIOR',
  entityId: SENIOR,
  targetVersion: 3,
  reason: 'senior.archive',
  retryCount: 0,
  ...over,
})

interface Seen {
  readonly sql: string
  readonly params: unknown[]
}

interface Page {
  readonly paged: number
  readonly invalid?: number
  readonly enqueued?: number
  readonly last?: string
}

/** Current derived version `current`; the page statement answers `page`; inserts recorded. */
function scripted(current: number, page: Page) {
  const seen: Seen[] = []
  const inserts: unknown[][] = []
  const tx: SqlExecutor = {
    execute: (q: SQL) => {
      const r = dialect.sqlToQuery(q)
      seen.push(r)
      if (r.sql.includes('coalesce(max(target_version), 0)'))
        return Promise.resolve({ rows: [{ v: current }] })
      if (r.sql.includes('WITH page AS'))
        return Promise.resolve({
          rows: [{ invalid: 0, enqueued: page.paged, last: null, ...page }],
        })
      if (r.sql.includes('INSERT INTO job_dirty_work')) {
        inserts.push(r.params.slice(0, 4))
        return Promise.resolve({ rows: [{ id: 'x' }] })
      }
      if (r.sql.includes('UPDATE job_dirty_work'))
        return Promise.resolve({ rows: [{ status: 'DONE' }] })
      return Promise.resolve({ rows: [] })
    },
  }
  const page_ = () => seen.find((q) => q.sql.includes('WITH page AS'))
  return { tx, seen, inserts, page: page_ }
}

describe('fanoutCursor', () => {
  it('a producer row starts at the first opportunity, rooted at itself', () => {
    expect(fanoutCursor({ id: ROW, reason: 'senior.team' })).toEqual({ root: ROW, after: NIL })
  })

  it('a continuation carries its root and cursor', () => {
    expect(fanoutCursor({ id: 'other', reason: `fanout:${ROW}:${opp(7)}` })).toEqual({
      root: ROW,
      after: opp(7),
    })
  })

  it('a malformed fanout reason restarts from the row itself', () => {
    expect(fanoutCursor({ id: ROW, reason: 'fanout:only-root' })).toEqual({ root: ROW, after: NIL })
  })

  it('a three-part reason that is not a fanout continuation starts from the row itself', () => {
    expect(fanoutCursor({ id: ROW, reason: `other:${ROW}:${opp(1)}` })).toEqual({
      root: ROW,
      after: NIL,
    })
  })
})

describe('fanOutDirty', () => {
  it('a stale row completes without reading or enqueueing anything', async () => {
    const { tx, inserts, page } = scripted(4, { paged: 1 })
    await expect(fanOutDirty(tx, work())).resolves.toEqual({
      outcome: 'DONE',
      enqueued: 0,
      skipped: 0,
      continued: false,
    })
    expect(inserts).toEqual([])
    expect(page()).toBeUndefined()
  })

  it('one statement per page: ACTIVE + CLAIMED scope, PENDING dedupe, idempotent reason', async () => {
    const { tx, inserts, page } = scripted(3, { paged: 2, enqueued: 2 })
    await expect(fanOutDirty(tx, work())).resolves.toEqual({
      outcome: 'DONE',
      enqueued: 2,
      skipped: 0,
      continued: false,
    })
    expect(inserts).toEqual([]) // no per-opportunity statement, no continuation
    const sql = page()!.sql.replace(/\s+/g, ' ')
    expect(sql).toContain("o.availability IN ('OPEN', 'UNKNOWN')")
    expect(sql).toContain("a.opportunity_id = o.id AND a.state = 'TAKEN'")
    expect(sql).toContain("d.target_version = p.revision AND d.status = 'PENDING'")
    expect(sql).toContain('WHERE p.revision >= 1')
    expect(sql).toContain('ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING')
    expect(sql).not.toContain('jsonb_array_elements_text')
    expect(page()!.params).toEqual([NIL, FANOUT_PAGE_SIZE, `fanout:${ROW}`])
  })

  it('AC 5: a full page continues from its last id at the SAME version, then completes', async () => {
    const { tx, inserts } = scripted(3, { paged: 3, last: opp(3) })
    await expect(fanOutDirty(tx, work(), { pageSize: 3 })).resolves.toMatchObject({
      enqueued: 3,
      continued: true,
      outcome: 'DONE',
    })
    expect(inserts).toEqual([['SENIOR', SENIOR, 3, `fanout:${ROW}:${opp(3)}`]])
  })

  it('a continuation resumes after its cursor and keeps the root reason', async () => {
    const { tx, page } = scripted(3, { paged: 1 })
    await fanOutDirty(tx, work({ id: opp(99), reason: `fanout:${ROW}:${opp(4)}` }))
    expect(page()!.params).toEqual([opp(4), FANOUT_PAGE_SIZE, `fanout:${ROW}`])
  })

  it('AC 5: opportunities with an impossible revision are skipped and counted; the pass goes on', async () => {
    const { tx } = scripted(3, { paged: 2, invalid: 1, enqueued: 1 })
    await expect(fanOutDirty(tx, work())).resolves.toEqual({
      outcome: 'DONE',
      enqueued: 1,
      skipped: 1,
      continued: false,
    })
  })

  it('SR-M-2: already-pending or duplicate opportunities count as not enqueued', async () => {
    const { tx } = scripted(3, { paged: 2, enqueued: 0 })
    await expect(fanOutDirty(tx, work())).resolves.toMatchObject({ enqueued: 0, skipped: 0 })
  })

  it('AC 5: a database error aborts the pass (the transaction rolls back)', async () => {
    const { tx } = scripted(3, { paged: 1 })
    const boom: SqlExecutor = {
      execute: async (q: SQL) => {
        if (dialect.sqlToQuery(q).sql.includes('WITH page AS')) throw new Error('connection lost')
        return tx.execute(q)
      },
    }
    await expect(fanOutDirty(boom, work())).rejects.toThrow('connection lost')
  })

  it('scopes the page to onlyIds when given', async () => {
    const { tx, page } = scripted(3, { paged: 0 })
    await fanOutDirty(tx, work(), { onlyIds: [opp(1)] })
    expect(page()!.sql).toContain('AND o.id IN (SELECT jsonb_array_elements_text(')
    expect(page()!.params).toEqual([
      NIL,
      JSON.stringify([opp(1)]),
      FANOUT_PAGE_SIZE,
      `fanout:${ROW}`,
    ])
  })
})

describe('createRecomputeSteps routing (S5)', () => {
  it.each(['SENIOR', 'EXCLUSION', 'PROJECT_CLIENT'] as const)(
    'a %s row is fanned out, never recomputed as an opportunity',
    async (entityKind) => {
      const { tx, seen, page } = scripted(3, { paged: 1 })
      const db = { transaction: (cb: (t: SqlExecutor) => unknown) => cb(tx) } as unknown as MeterDb
      const steps = createRecomputeSteps(db, { onlyIds: [opp(1)] })
      await expect(
        steps.process(work({ entityKind }), { evaluationTime: new Date(0) }),
      ).resolves.toBe('DONE')
      expect(seen.some((q) => q.sql.includes('FOR NO KEY UPDATE'))).toBe(false)
      expect(page()!.params).toEqual([
        NIL,
        JSON.stringify([opp(1)]),
        FANOUT_PAGE_SIZE,
        `fanout:${ROW}`,
      ])
    },
  )
})
