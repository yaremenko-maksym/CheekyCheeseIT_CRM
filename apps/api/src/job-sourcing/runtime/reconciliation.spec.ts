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
  RECONCILE_PAGE_SIZE,
  RECONCILE_PERIOD_HOURS,
  isStale,
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
  const execute = vi.fn(async () => ({ rows: queue.shift() ?? [] }))
  return { execute }
}
const opp = (n: number, matches: unknown = [], revision = 3) => ({
  id: id(n),
  revision,
  matches,
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

describe('constants', () => {
  it('pins MP-05 batch and the SR-M-2 period', () => {
    expect(RECONCILE_PAGE_SIZE).toBe(200)
    expect(RECONCILE_PERIOD_HOURS).toBe(6)
  })
})
