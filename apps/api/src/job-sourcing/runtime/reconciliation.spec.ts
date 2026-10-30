import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const enqueue = vi.fn()
const roster = vi.fn()
vi.mock('../ownership/dirty-work.store', () => ({
  enqueueDirty: (...a: unknown[]) => enqueue(...a),
}))
vi.mock('./recompute-inputs', () => ({
  MATCH_RULE_VERSION: 'RULE-1',
  loadRoster: (...a: unknown[]) => roster(...a),
}))

import {
  RECONCILE_MAX_DRAIN_BATCHES,
  RECONCILE_PAGE_SIZE,
  RECONCILE_PERIOD_HOURS,
  RECONCILE_GAVE_UP_IDS_MAX,
  RECONCILE_MAX_FAILED_PERIODS,
  enqueueReason,
  hasGivenUp,
  isStale,
  periodBucket,
  reconcileOnce,
  reconcileReason,
} from './reconciliation'

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const live = new Map([
  [S1, { profile: 'p1', exclusion: 'e1' }],
  [S2, { profile: 'p2', exclusion: 'e2' }],
])
const m = (seniorId: string, profile: string, exclusion: string, rule = 'RULE-1') => ({
  seniorId,
  profile,
  exclusion,
  rule,
})
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tuple = (x: ReturnType<typeof m>) => [x.seniorId, x.profile, x.exclusion, x.rule]

/** A db whose page queries return the given pages in order. */
function dbOf(...pages: Record<string, unknown>[][]) {
  const queue = [...pages]
  const execute = vi.fn(async (_q: unknown) => ({ rows: queue.shift() ?? [] }))
  return { execute }
}
const opp = (n: number, matches: unknown = [], revision = 3, dirty: unknown = []) => ({
  id: id(n),
  revision,
  matches,
  dirty,
})

beforeEach(() => {
  enqueue.mockReset()
  enqueue.mockResolvedValue({ inserted: true })
  roster.mockReset()
  roster.mockResolvedValue({ versions: live })
})

describe('isStale', () => {
  it('matching versions are fresh', () => {
    expect(isStale([m(S1, 'p1', 'e1'), m(S2, 'p2', 'e2')], live)).toBe(false)
  })
  it('no rows is stale', () => expect(isStale([], live)).toBe(true))
  it('a changed profile, exclusion or rule version is stale', () => {
    expect(isStale([m(S1, 'OLD', 'e1')], live)).toBe(true)
    expect(isStale([m(S1, 'p1', 'OLD')], live)).toBe(true)
    expect(isStale([m(S1, 'p1', 'e1', 'RULE-0')], live)).toBe(true)
  })
  it('a row of a senior the roster no longer has is stale', () => {
    expect(isStale([m('99999999-9999-4999-8999-999999999999', 'p', 'e')], live)).toBe(true)
  })
})

describe('reconcileReason', () => {
  it('is bounded, stable and sensitive to both the roster and the stored state', () => {
    const base = reconcileReason(live, [m(S1, 'OLD', 'e1')])
    expect(base).toMatch(/^RECONCILE:[0-9a-f]{16}:[0-9a-f]{16}$/)
    expect(reconcileReason(live, [m(S1, 'OLD', 'e1')])).toBe(base)
    expect(reconcileReason(live, [m(S1, 'OLD2', 'e1')])).not.toBe(base)
    expect(
      reconcileReason(new Map([[S1, { profile: 'x', exclusion: 'e1' }]]), [m(S1, 'OLD', 'e1')]),
    ).not.toBe(base)
  })
  it('does not depend on row order', () => {
    expect(reconcileReason(live, [m(S1, 'a', 'b'), m(S2, 'c', 'd')])).toBe(
      reconcileReason(live, [m(S2, 'c', 'd'), m(S1, 'a', 'b')]),
    )
  })
})

describe('reconcileOnce', () => {
  it('AC1: enqueues mismatching and row-less opportunities once each, not matching ones', async () => {
    const fresh = [tuple(m(S1, 'p1', 'e1'))]
    const db = dbOf([opp(1, fresh), opp(2, [tuple(m(S1, 'OLD', 'e1'))], 7), opp(3, [])])
    const r = await reconcileOnce(db)
    expect(r).toMatchObject({
      scanned: 3,
      stale: 2,
      enqueued: 2,
      failed: 0,
      pages: 1,
      cursor: null,
    })
    expect(enqueue.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      ['OPPORTUNITY', id(2), 7],
      ['OPPORTUNITY', id(3), 3],
    ])
    expect(String(enqueue.mock.calls[0]?.[4])).toMatch(/^RECONCILE:/)
  })

  it('AC3: an already-present row (inserted:false) is not counted as enqueued', async () => {
    enqueue.mockResolvedValue({ inserted: false })
    const r = await reconcileOnce(dbOf([opp(1)]))
    expect(r).toMatchObject({ scanned: 1, stale: 1, enqueued: 0 })
  })

  it('AC4: pages by the page size and continues across pages', async () => {
    const db = dbOf([opp(1), opp(2)], [opp(3), opp(4)], [opp(5)])
    const r = await reconcileOnce(db, { pageSize: 2 })
    expect(r).toMatchObject({ scanned: 5, enqueued: 5, pages: 3, cursor: null })
    expect(db.execute).toHaveBeenCalledTimes(3)
  })

  it('AC4: stops at maxPages and returns a cursor that resumes the sweep', async () => {
    const db = dbOf([opp(1), opp(2)], [opp(3), opp(4)])
    const r = await reconcileOnce(db, { pageSize: 2, maxPages: 2 })
    expect(r).toMatchObject({ scanned: 4, pages: 2, cursor: id(4) })
  })

  it('a page of exactly pageSize rows is followed by one more query', async () => {
    const db = dbOf([opp(1), opp(2)], [])
    const r = await reconcileOnce(db, { pageSize: 2 })
    expect(r).toMatchObject({ scanned: 2, pages: 2, cursor: null })
  })

  it('AC5: one opportunity with unreadable data is counted and the sweep goes on', async () => {
    const db = dbOf([opp(1, 'garbage'), opp(2, [['short']]), opp(3)])
    const r = await reconcileOnce(db)
    expect(r).toMatchObject({ scanned: 3, stale: 1, enqueued: 1, failed: 2 })
  })

  it('AC5: a RangeError from enqueue is that opportunity only', async () => {
    enqueue.mockRejectedValueOnce(new RangeError('bad'))
    const r = await reconcileOnce(dbOf([opp(1), opp(2)]))
    expect(r).toMatchObject({ stale: 2, enqueued: 1, failed: 1 })
  })

  it('AC5: an infrastructure error aborts the sweep', async () => {
    enqueue.mockRejectedValueOnce(new Error('connection lost'))
    await expect(reconcileOnce(dbOf([opp(1), opp(2)]))).rejects.toThrow('connection lost')
    const down = { execute: vi.fn().mockRejectedValue(new Error('db down')) }
    roster.mockResolvedValue({ versions: live })
    await expect(reconcileOnce(down)).rejects.toThrow('db down')
  })

  it('rejects a page size below 1', async () => {
    await expect(reconcileOnce(dbOf(), { pageSize: 0 })).rejects.toThrow(RangeError)
  })
})

const rendered = (q: unknown) => new PgDialect().sqlToQuery(q as never)

describe('the page query', () => {
  it('starts from the nil uuid, orders by id, and limits to the page size', async () => {
    const db = dbOf([])
    await reconcileOnce(db, { pageSize: 7 })
    const q = rendered(db.execute.mock.calls[0]?.[0])
    expect(q.params).toEqual(['00000000-0000-0000-0000-000000000000', 7])
    expect(q.sql).toContain('FROM job_opportunities o')
    expect(q.sql).toContain('job_opportunity_matches')
    expect(q.sql).toContain('ORDER BY o.id')
  })

  it('resumes after the given cursor, then after the last id of each page', async () => {
    const db = dbOf([opp(1), opp(2)], [])
    await reconcileOnce(db, { pageSize: 2, cursor: id(99) })
    expect(rendered(db.execute.mock.calls[0]?.[0]).params).toEqual([id(99), 2])
    expect(rendered(db.execute.mock.calls[1]?.[0]).params).toEqual([id(2), 2])
  })

  it('adds no id filter by default and scopes to onlyIds when given', async () => {
    const all = dbOf([])
    await reconcileOnce(all)
    const unscoped = rendered(all.execute.mock.calls[0]?.[0]).sql
    expect(unscoped).not.toContain('jsonb_array_elements_text')
    expect(unscoped).toContain('WHERE o.id > $1::uuid  ORDER BY o.id LIMIT $2')
    const scoped = dbOf([])
    await reconcileOnce(scoped, { onlyIds: [id(5), id(6)] })
    const q = rendered(scoped.execute.mock.calls[0]?.[0])
    expect(q.sql).toContain('o.id IN (SELECT jsonb_array_elements_text($2::jsonb)::uuid)')
    expect(q.params).toEqual([
      '00000000-0000-0000-0000-000000000000',
      JSON.stringify([id(5), id(6)]),
      200,
    ])
  })

  it('accepts a page size of exactly 1', async () => {
    await expect(reconcileOnce(dbOf([]), { pageSize: 1 })).resolves.toMatchObject({ pages: 1 })
  })
})

describe('isStale across rows and reason across orders', () => {
  it('one stale row among fresh ones makes the opportunity stale', () => {
    expect(isStale([m(S1, 'p1', 'e1'), m(S2, 'OLD', 'e2')], live)).toBe(true)
    expect(isStale([m(S1, 'OLD', 'e1'), m(S2, 'p2', 'e2')], live)).toBe(true)
  })
  it('the reason does not depend on the roster insertion order', () => {
    const swapped = new Map([...live].reverse())
    expect(reconcileReason(swapped, [])).toBe(reconcileReason(live, []))
  })
})

describe('reconcileReason sensitivity at equal roster size', () => {
  const roster = (profile: string, exclusion: string, id = S1) =>
    new Map([
      [id, { profile, exclusion }],
      [S2, { profile: 'p2', exclusion: 'e2' }],
    ])
  it('changes with any senior id, profile or exclusion version', () => {
    const base = reconcileReason(live, [])
    expect(reconcileReason(roster('p1', 'e1'), [])).toBe(base)
    expect(reconcileReason(roster('X', 'e1'), [])).not.toBe(base)
    expect(reconcileReason(roster('p1', 'X'), [])).not.toBe(base)
    expect(reconcileReason(roster('p1', 'e1', S1.replace('1', '3')), [])).not.toBe(base)
  })
})

describe('reconcileReason pinned value', () => {
  it('is the first 16 hex chars of sha256 over the sorted JSON (literals computed outside the code)', () => {
    // sha256('[]') starts 4f53cda18c2baa0c; the roster half is sha256 of the sorted key list.
    expect(reconcileReason(live, [])).toBe('RECONCILE:5c0bf4154b6695e7:4f53cda18c2baa0c')
  })
})

const BASE = 'RECONCILE:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb'
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)

describe('enqueueReason (SR-M-1 deduplication and retry)', () => {
  it('enqueues under the base reason when the opportunity has no dirty row', () => {
    expect(enqueueReason([], BASE, NOW)).toBe(BASE)
  })
  it('skips while a PENDING or CLAIMED row exists, whatever its reason', () => {
    expect(enqueueReason([{ status: 'PENDING', reason: 'REVISION' }], BASE, NOW)).toBeNull()
    expect(enqueueReason([{ status: 'CLAIMED', reason: BASE }], BASE, NOW)).toBeNull()
  })
  it('skips when the lineage already has a DONE row (also the zero-match-rows verdict)', () => {
    expect(enqueueReason([{ status: 'DONE', reason: BASE }], BASE, NOW)).toBeNull()
    expect(
      enqueueReason(
        [
          { status: 'FAILED', reason: BASE },
          { status: 'DONE', reason: `${BASE}:abc` },
        ],
        BASE,
        NOW,
      ),
    ).toBeNull()
  })
  it('ignores a DONE row of another reason', () => {
    expect(enqueueReason([{ status: 'DONE', reason: 'REVISION' }], BASE, NOW)).toBe(BASE)
    expect(enqueueReason([{ status: 'DONE', reason: `${BASE}X` }], BASE, NOW)).toBe(BASE)
  })
  it('retries a FAILED or DEFERRED row under a fresh per-period key', () => {
    expect(enqueueReason([{ status: 'FAILED', reason: BASE }], BASE, NOW)).toBe(
      `${BASE}:${periodBucket(NOW)}`,
    )
    expect(enqueueReason([{ status: 'DEFERRED', reason: BASE }], BASE, NOW)).toBe(
      `${BASE}:${periodBucket(NOW)}`,
    )
  })
  it('the retry key changes every period, not within one, and stays within 100 characters', () => {
    const failed = [{ status: 'FAILED', reason: BASE }]
    const six = 6 * 3_600_000
    expect(periodBucket(NOW)).toBe(Math.floor(NOW / six).toString(36))
    expect(periodBucket(NOW + 1)).toBe(periodBucket(NOW))
    expect(periodBucket(NOW + six)).not.toBe(periodBucket(NOW))
    expect((enqueueReason(failed, BASE, NOW) as string).length).toBeLessThanOrEqual(100)
  })
})

describe('reconcileOnce with dirty history', () => {
  it('counts a stale opportunity already in flight as skipped, not enqueued', async () => {
    const r = await reconcileOnce(dbOf([opp(1, [], 3, [['PENDING', 'REVISION']]), opp(2)]))
    expect(r).toMatchObject({ stale: 2, enqueued: 1, skipped: 1 })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
  it('re-enqueues a FAILED one under the period key given by the clock', async () => {
    const failedRow = (reason: string) => [['FAILED', reason]]
    const first = await reconcileOnce(dbOf([opp(1)]), { now: () => NOW })
    const base = String(enqueue.mock.calls[0]?.[4])
    expect(first.enqueued).toBe(1)
    enqueue.mockClear()
    await reconcileOnce(dbOf([opp(1, [], 3, failedRow(base))]), { now: () => NOW })
    expect(enqueue.mock.calls[0]?.[4]).toBe(`${base}:${periodBucket(NOW)}`)
  })
  it('a dirty entry that is not a [status, reason] pair is that opportunity only', async () => {
    for (const bad of [['PENDING'], ['PENDING', 'r', 'extra'], 'PENDING']) {
      enqueue.mockClear()
      const r = await reconcileOnce(dbOf([opp(1, [], 3, [bad]), opp(2)]))
      expect(r).toMatchObject({ failed: 1, enqueued: 1 })
    }
  })

  it('an unreadable dirty column is that opportunity only', async () => {
    const r = await reconcileOnce(dbOf([opp(1, [], 3, 'garbage'), opp(2)]))
    expect(r).toMatchObject({ failed: 1, enqueued: 1 })
  })
})

describe('giving up on a poisoned opportunity (CR-M-4, SR-M-3)', () => {
  const failed = (reason: string) => ({ status: 'FAILED', reason })
  const lineage = (n: number) =>
    Array.from({ length: n }, (_, i) => failed(i === 0 ? BASE : `${BASE}:p${i}`))

  it('retries below the cap and stops at it', () => {
    expect(RECONCILE_MAX_FAILED_PERIODS).toBe(3)
    expect(enqueueReason(lineage(2), BASE, NOW)).toBe(`${BASE}:${periodBucket(NOW)}`)
    expect(hasGivenUp(lineage(2), BASE)).toBe(false)
    expect(enqueueReason(lineage(3), BASE, NOW)).toBeNull()
    expect(hasGivenUp(lineage(3), BASE)).toBe(true)
  })
  it('counts DEFERRED rows, and only rows of its own lineage', () => {
    const mixed = [failed(BASE), { status: 'DEFERRED', reason: `${BASE}:a` }, failed(`${BASE}:b`)]
    expect(hasGivenUp(mixed, BASE)).toBe(true)
    const other = [
      failed(BASE),
      failed('RECONCILE:other:digest'),
      failed('RECONCILE:other:digest:x'),
    ]
    expect(hasGivenUp(other, BASE)).toBe(false)
    expect(enqueueReason(other, BASE, NOW)).toBe(`${BASE}:${periodBucket(NOW)}`)
  })
  it('is not "given up" while a row is in flight or once one is DONE', () => {
    expect(hasGivenUp([...lineage(3), { status: 'PENDING', reason: 'REVISION' }], BASE)).toBe(false)
    expect(hasGivenUp([...lineage(3), { status: 'DONE', reason: `${BASE}:z` }], BASE)).toBe(false)
  })
  it('the report counts them and lists at most the id cap', async () => {
    // The reason of an opportunity with no rows is the same for all: read it from a probe sweep.
    const probe = dbOf([opp(1)])
    await reconcileOnce(probe)
    const base = String(enqueue.mock.calls[0]?.[4])
    enqueue.mockClear()
    const rows = Array.from({ length: RECONCILE_GAVE_UP_IDS_MAX + 3 }, (_, i) =>
      opp(i + 1, [], 3, [
        ['FAILED', base],
        ['FAILED', `${base}:a`],
        ['FAILED', `${base}:b`],
      ]),
    )
    const r = await reconcileOnce(dbOf(rows), { pageSize: 100 })
    expect(r.gaveUp).toBe(RECONCILE_GAVE_UP_IDS_MAX + 3)
    expect(r.gaveUpIds).toHaveLength(RECONCILE_GAVE_UP_IDS_MAX)
    expect(r.gaveUpIds[0]).toBe(id(1))
    expect(r).toMatchObject({ enqueued: 0, skipped: RECONCILE_GAVE_UP_IDS_MAX + 3 })
    expect(enqueue).not.toHaveBeenCalled()
  })
  it('an in-flight or repaired opportunity is skipped but not counted as given up', async () => {
    const r = await reconcileOnce(dbOf([opp(1, [], 3, [['PENDING', 'REVISION']])]))
    expect(r).toMatchObject({ skipped: 1, gaveUp: 0, gaveUpIds: [] })
  })
})

describe('constants', () => {
  it('pins MP-05 batch and the SR-M-2 period', () => {
    expect(RECONCILE_PAGE_SIZE).toBe(200)
    expect(RECONCILE_PERIOD_HOURS).toBe(6)
    expect(RECONCILE_MAX_DRAIN_BATCHES).toBe(10)
    expect(RECONCILE_GAVE_UP_IDS_MAX).toBe(20)
  })
})
