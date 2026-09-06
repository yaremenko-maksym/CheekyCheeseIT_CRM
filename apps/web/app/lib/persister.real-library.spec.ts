/**
 * SR-L-4 (PR #646 fix-round 2). `persister.spec.ts` mocks
 * `createAsyncStoragePersister` ITSELF to verify the `serialize` OPTION is
 * wired correctly — it never actually calls the real library's own
 * `persistClient`/`trySave`, so it cannot tell "the option is correct" from
 * "the option is actually invoked on a real write". A regression that moved
 * the strip to the wrong place, or that the library stopped calling
 * `serialize` at all (e.g. an upstream version bump changing the option
 * name), would leave that file green.
 *
 * This file mocks ONLY `idb-keyval` (the actual IndexedDB dependency, which
 * happy-dom cannot provide) and uses the REAL
 * `@tanstack/query-async-storage-persister` + the REAL exported `persister`
 * — same verification shape the security reviewer used to confirm the
 * finding this fix closes (round 2 security review, SR-L-4): call
 * `persister.persistClient(client)` and assert on what actually reached the
 * mocked `idb-keyval.set(...)`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGet = vi.fn().mockResolvedValue(undefined)
const mockSet = vi.fn().mockResolvedValue(undefined)
const mockDel = vi.fn().mockResolvedValue(undefined)

vi.mock('idb-keyval', () => ({
  get: (k: string) => mockGet(k),
  set: (k: string, v: string) => mockSet(k, v),
  del: (k: string) => mockDel(k),
}))

// Real library, real persister — no mock on '@tanstack/query-async-storage-persister' in this file.
import { persister, PERSIST_KEY } from './persister'

beforeEach(() => {
  mockGet.mockClear()
  mockSet.mockClear()
  mockDel.mockClear()
})

describe('persister — real library, content actually written to storage (SR-L-4)', () => {
  it('rejectionReason never reaches idb-keyval.set — findAll-shaped data (array of projects)', async () => {
    const client = {
      timestamp: Date.now(),
      buster: 'v1',
      clientState: {
        queries: [
          {
            queryKey: ['projects', { archived: 'active' }],
            queryHash: 'irrelevant',
            state: {
              status: 'success' as const,
              data: [
                {
                  id: 'p1',
                  status: 'REJECTED',
                  companyName: 'Acme',
                  rejectionReason: 'СЕКРЕТНАЯ ПРИЧИНА ОТКАЗА',
                },
              ],
              dataUpdatedAt: Date.now(),
              error: null,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              isInvalidated: false,
              status2: undefined,
            },
          },
        ],
        mutations: [],
      },
    }

    // @ts-expect-error — deliberately loose PersistedClient shape; only the
    // fields the strip walks and the fields this test asserts on matter.
    await persister.persistClient(client)

    expect(mockSet).toHaveBeenCalledTimes(1)
    const [key, written] = mockSet.mock.calls[0] as [string, string]
    expect(key).toBe(PERSIST_KEY)
    expect(written).not.toContain('rejectionReason')
    expect(written).not.toContain('СЕКРЕТНАЯ ПРИЧИНА ОТКАЗА')
    // Not a wipe — the rest of the row survives.
    expect(written).toContain('"companyName":"Acme"')
    expect(written).toContain('"status":"REJECTED"')
  })

  it('rejectionReason never reaches idb-keyval.set — findOne-shaped data (single project object)', async () => {
    const client = {
      timestamp: Date.now(),
      buster: 'v1',
      clientState: {
        queries: [
          {
            queryKey: ['projects', 'p1'],
            queryHash: 'irrelevant',
            state: {
              status: 'success' as const,
              data: {
                id: 'p1',
                status: 'REJECTED',
                companyName: 'Acme',
                rejectionReason: 'ДРУГАЯ СЕКРЕТНАЯ ПРИЧИНА',
              },
              dataUpdatedAt: Date.now(),
              error: null,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              isInvalidated: false,
            },
          },
        ],
        mutations: [],
      },
    }

    // @ts-expect-error — see the array-shaped test above for why this is loose on purpose.
    await persister.persistClient(client)

    const written = mockSet.mock.calls[0]?.[1] as string
    expect(written).not.toContain('rejectionReason')
    expect(written).not.toContain('ДРУГАЯ СЕКРЕТНАЯ ПРИЧИНА')
    expect(written).toContain('"companyName":"Acme"')
  })
})

/**
 * QA-H-3 (PR #646 fix-round 4, HIGH — manual-qa repro). Same "real library,
 * not a mock of it" rationale as the SR-L-4 tests above, extended end to
 * end: `persistClient` writes through the REAL serialize option, THEN
 * `restoreClient` reads that exact written string back through the REAL
 * deserialize (`JSON.parse`, unmodified) — a persist→restore ROUND TRIP,
 * not two tests that separately assert on each half in isolation. Proves
 * the write-time mark (`meta.strippedAt`) and the read-time force
 * (`dataUpdatedAt = 0`) actually connect through an IndexedDB-shaped string
 * in the middle, not just through two functions that happen to agree on an
 * in-memory object shape.
 */
describe('persister — real library, persist→restore round trip forces staleness on a redacted query (QA-H-3)', () => {
  it('a query rejectionReason was stripped from comes back from restoreClient with dataUpdatedAt === 0', async () => {
    const originalUpdatedAt = Date.now()
    const client = {
      timestamp: Date.now(),
      buster: 'v1',
      clientState: {
        queries: [
          {
            queryKey: ['projects', { archived: 'active' }],
            queryHash: 'irrelevant',
            state: {
              status: 'success' as const,
              data: [{ id: 'p1', status: 'REJECTED', rejectionReason: 'нет бюджета на Q3' }],
              dataUpdatedAt: originalUpdatedAt,
              error: null,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              isInvalidated: false,
            },
          },
        ],
        mutations: [],
      },
    }

    // @ts-expect-error — deliberately loose PersistedClient shape (see the tests above).
    await persister.persistClient(client)
    const written = mockSet.mock.calls[0]?.[1] as string
    mockGet.mockResolvedValueOnce(written)

    const restored = (await persister.restoreClient()) as {
      clientState: { queries: Array<{ state: { dataUpdatedAt: number; data: unknown } }> }
    }

    expect(restored.clientState.queries[0]?.state.dataUpdatedAt).toBe(0)
    // Confirms this really is the same restored query (rejectionReason
    // gone, everything else intact) — not an accidental pass-through of a
    // differently-shaped fixture that happened to satisfy the assertion above.
    expect(restored.clientState.queries[0]?.state.data).toEqual([{ id: 'p1', status: 'REJECTED' }])
  })

  it('a query nothing was stripped from keeps its ORIGINAL dataUpdatedAt after the same round trip — the control case (SENIOR/DROP never receive rejectionReason at all, SR-M-5)', async () => {
    const originalUpdatedAt = Date.now() - 30_000
    const client = {
      timestamp: Date.now(),
      buster: 'v1',
      clientState: {
        queries: [
          {
            queryKey: ['projects', { archived: 'active' }],
            queryHash: 'irrelevant',
            state: {
              status: 'success' as const,
              data: [{ id: 'p1', status: 'ACTIVE' }],
              dataUpdatedAt: originalUpdatedAt,
              error: null,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              isInvalidated: false,
            },
          },
        ],
        mutations: [],
      },
    }

    // @ts-expect-error — see the tests above.
    await persister.persistClient(client)
    const written = mockSet.mock.calls[0]?.[1] as string
    mockGet.mockResolvedValueOnce(written)

    const restored = (await persister.restoreClient()) as {
      clientState: { queries: Array<{ state: { dataUpdatedAt: number } }> }
    }
    expect(restored.clientState.queries[0]?.state.dataUpdatedAt).toBe(originalUpdatedAt)
  })
})

/**
 * SR-M-8 (PR #646 fix-round 5, MED — security review). Round 4's rewrite
 * (QA-H-3 above) narrowed WHAT gets walked before a write from "the whole
 * client" (round 2's plain `stripSensitiveFields(client)` call) down to
 * `query.state` + `clientState.mutations` — two fail-OPEN gaps followed
 * from that narrowing, both closed here:
 *
 *   1. `query.meta` was only ever WRITTEN by this file (the `strippedAt`
 *      mark) and never READ for stripping — a sensitive field placed
 *      there rode through `{ ...q, state }` untouched. Not exploitable
 *      TODAY (no `useQuery({ meta })` call in apps/web puts anything
 *      sensitive there, and `dehydrate()` never invents a `meta` value on
 *      its own) — this test pins the FAIL-CLOSED contract for the day one
 *      does, not today's reachability.
 *   2. `clientState.queries` that is not an array fails the
 *      `Array.isArray` guard — but because the override was a conditional
 *      SPREAD (`...cs, ...(Array.isArray(cs.queries) && {...})`) rather
 *      than a destructure-then-omit, the FALSE branch contributed nothing
 *      while `...cs` a few characters earlier had ALREADY put the
 *      original, unstripped `queries` value into the result. A shape a
 *      real `dehydrate()` never produces (see this file's own "defensive
 *      guards" doc below) but not provably impossible either — a crashed
 *      tab's partial write, a schema left over from an older app version.
 *
 * Same verification shape as SR-L-4/QA-H-3 above: real library, only
 * `idb-keyval` mocked, assert on the actual bytes reaching
 * `storage.setItem` — not persister.ts's `serialize` OPTION in isolation.
 */
describe('persister — real library, fail-closed strip (SR-M-8)', () => {
  it('a sensitive field placed in query.meta (not query.state) never reaches idb-keyval.set', async () => {
    const client = {
      timestamp: Date.now(),
      buster: 'v1',
      clientState: {
        queries: [
          {
            queryKey: ['projects', { archived: 'active' }],
            queryHash: 'irrelevant',
            state: {
              status: 'success' as const,
              data: [{ id: 'p1', status: 'ACTIVE', companyName: 'Acme' }],
              dataUpdatedAt: Date.now(),
              error: null,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              isInvalidated: false,
            },
            meta: { rejectionReason: 'СЕКРЕТ-В-META' },
          },
        ],
        mutations: [],
      },
    }

    // @ts-expect-error — deliberately loose PersistedClient shape (see the tests above).
    await persister.persistClient(client)

    const written = mockSet.mock.calls[0]?.[1] as string
    expect(written).not.toContain('СЕКРЕТ-В-META')
    expect(written).not.toContain('rejectionReason')
    // Not a wipe of the whole meta bag — only the sensitive key inside it
    // is gone, and the query is correctly marked (same contract as every
    // OTHER strippedAt case above, now also reachable via meta).
    expect(JSON.parse(written).clientState.queries[0].meta).toEqual({
      strippedAt: expect.any(Number),
    })
  })

  it('clientState.queries that is not an array is written WITHOUT a queries key at all (fail-closed) — never spread through raw and unstripped', async () => {
    const client = {
      timestamp: Date.now(),
      buster: 'v1',
      clientState: {
        queries: { rogue: { rejectionReason: 'СЕКРЕТ-В-QUERIES' } },
        mutations: [],
      },
    }

    // @ts-expect-error — deliberately loose PersistedClient shape (see the tests above).
    await persister.persistClient(client)

    const written = mockSet.mock.calls[0]?.[1] as string
    expect(written).not.toContain('СЕКРЕТ-В-QUERIES')
    expect('queries' in JSON.parse(written).clientState).toBe(false)
  })

  it('control case: a well-formed array of queries is unaffected by the fail-closed guard — still stripped and written normally', async () => {
    const client = {
      timestamp: Date.now(),
      buster: 'v1',
      clientState: {
        queries: [
          {
            queryKey: ['projects'],
            queryHash: 'irrelevant',
            state: {
              status: 'success' as const,
              data: [{ id: 'p1', status: 'ACTIVE' }],
              dataUpdatedAt: Date.now(),
              error: null,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              isInvalidated: false,
            },
          },
        ],
        mutations: [],
      },
    }

    // @ts-expect-error — deliberately loose PersistedClient shape (see the tests above).
    await persister.persistClient(client)

    const written = mockSet.mock.calls[0]?.[1] as string
    expect(JSON.parse(written).clientState.queries).toHaveLength(1)
    expect(JSON.parse(written).clientState.queries[0].state.data[0].id).toBe('p1')
  })
})
