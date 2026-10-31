import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { ClaimedDirtyWork } from '../ownership/dirty-work.store'
import type { SqlExecutor } from '../scheduling/host-state'
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

/** Current derived version `current`; `opps` as the page; every insert recorded. */
function scripted(current: number, opps: { id: string; revision: number }[]) {
  const seen: Seen[] = []
  const inserts: unknown[][] = []
  const tx: SqlExecutor = {
    execute: (q: SQL) => {
      const r = dialect.sqlToQuery(q)
      seen.push(r)
      if (r.sql.includes('coalesce(max(target_version), 0)'))
        return Promise.resolve({ rows: [{ v: current }] })
      if (r.sql.includes('FROM job_opportunities')) return Promise.resolve({ rows: opps })
      if (r.sql.includes('INSERT INTO job_dirty_work')) {
        inserts.push(r.params.slice(0, 4))
        return Promise.resolve({ rows: [{ id: 'x' }] })
      }
      if (r.sql.includes('UPDATE job_dirty_work'))
        return Promise.resolve({ rows: [{ status: 'DONE' }] })
      return Promise.resolve({ rows: [] })
    },
  }
  return { tx, seen, inserts }
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
})

describe('fanOutDirty', () => {
  it('a stale row completes without reading or enqueueing anything', async () => {
    const { tx, seen, inserts } = scripted(4, [{ id: opp(1), revision: 1 }])
    await expect(fanOutDirty(tx, work())).resolves.toEqual({
      outcome: 'DONE',
      enqueued: 0,
      skipped: 0,
      continued: false,
    })
    expect(inserts).toEqual([])
    expect(seen.some((s) => s.sql.includes('FROM job_opportunities'))).toBe(false)
  })

  it('a partial page enqueues every opportunity at its revision under fanout:<root>', async () => {
    const { tx, inserts, seen } = scripted(3, [
      { id: opp(1), revision: 2 },
      { id: opp(2), revision: 9 },
    ])
    await expect(fanOutDirty(tx, work())).resolves.toMatchObject({ enqueued: 2, continued: false })
    expect(inserts).toEqual([
      ['OPPORTUNITY', opp(1), 2, `fanout:${ROW}`],
      ['OPPORTUNITY', opp(2), 9, `fanout:${ROW}`],
    ])
    const page = seen.find((s) => s.sql.includes('FROM job_opportunities'))!
    expect(page.sql).toContain('ORDER BY id LIMIT')
    expect(page.params).toEqual([NIL, FANOUT_PAGE_SIZE])
  })

  it('AC 5: a full page continues from its last id at the SAME version, then completes', async () => {
    const page = [1, 2, 3].map((i) => ({ id: opp(i), revision: 1 }))
    const { tx, inserts } = scripted(3, page)
    await expect(fanOutDirty(tx, work(), { pageSize: 3 })).resolves.toMatchObject({
      enqueued: 3,
      continued: true,
      outcome: 'DONE',
    })
    expect(inserts.at(-1)).toEqual(['SENIOR', SENIOR, 3, `fanout:${ROW}:${opp(3)}`])
  })

  it('a continuation resumes after its cursor and keeps the root reason', async () => {
    const { tx, inserts, seen } = scripted(3, [{ id: opp(5), revision: 4 }])
    await fanOutDirty(tx, work({ id: 'cont', reason: `fanout:${ROW}:${opp(4)}` }))
    expect(inserts).toEqual([['OPPORTUNITY', opp(5), 4, `fanout:${ROW}`]])
    expect(seen.find((s) => s.sql.includes('FROM job_opportunities'))!.params[0]).toBe(opp(4))
  })

  it('AC 5: one opportunity with an impossible revision is skipped; the pass goes on', async () => {
    const { tx, inserts } = scripted(3, [
      { id: opp(1), revision: 0 },
      { id: opp(2), revision: 1 },
    ])
    await expect(fanOutDirty(tx, work())).resolves.toMatchObject({ enqueued: 1, skipped: 1 })
    expect(inserts).toEqual([['OPPORTUNITY', opp(2), 1, `fanout:${ROW}`]])
  })

  it('a duplicate (re-run pass) counts as not enqueued', async () => {
    const { tx } = scripted(3, [{ id: opp(1), revision: 1 }])
    const dup: SqlExecutor = {
      execute: async (q: SQL) => {
        const r = dialect.sqlToQuery(q)
        if (r.sql.includes('INSERT INTO job_dirty_work')) return { rows: [] }
        return tx.execute(q)
      },
    }
    await expect(fanOutDirty(dup, work())).resolves.toMatchObject({ enqueued: 0, skipped: 0 })
  })

  it('a non-validation error aborts the pass (the transaction rolls back)', async () => {
    const boom: SqlExecutor = {
      execute: async (q: SQL) => {
        const r = dialect.sqlToQuery(q)
        if (r.sql.includes('coalesce')) return { rows: [{ v: 3 }] }
        if (r.sql.includes('FROM job_opportunities')) return { rows: [{ id: opp(1), revision: 1 }] }
        throw new Error('connection lost')
      },
    }
    await expect(fanOutDirty(boom, work())).rejects.toThrow('connection lost')
  })

  it('scopes the page to onlyIds when given', async () => {
    const { tx, seen } = scripted(3, [])
    await fanOutDirty(tx, work(), { onlyIds: [opp(1)] })
    const page = seen.find((s) => s.sql.includes('FROM job_opportunities'))!
    expect(page.sql).toContain('AND id = ANY(')
    expect(page.params).toContain(FANOUT_PAGE_SIZE)
  })
})
