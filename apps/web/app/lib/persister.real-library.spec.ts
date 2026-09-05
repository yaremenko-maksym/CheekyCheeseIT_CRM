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
