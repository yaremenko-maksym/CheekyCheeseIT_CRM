/**
 * Unit tests for persister.ts
 *
 * Verifies:
 * - PERSIST_KEY constant equals 'crm-query-cache' (must stay in sync with
 *   use-logout.ts → idbDel('crm-query-cache') — security contract).
 * - persister is the instance returned by createAsyncStoragePersister.
 * - The idb-keyval adapter methods are wired correctly.
 *
 * We cannot test actual IndexedDB writes (happy-dom IDB is incomplete),
 * so we verify the constant contract and the adapter wiring via mocks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted state — runs before vi.mock() factories.
// vi.hoisted() is the only way to share mutable state between the factory
// closure and the test body without hitting temporal dead zone issues.
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  type StorageAdapter = {
    getItem: (k: string) => Promise<unknown>
    setItem: (k: string, v: string) => Promise<unknown>
    removeItem: (k: string) => Promise<unknown>
  }
  type CapturedOptions = {
    storage: StorageAdapter
    key: string
    throttleTime?: number
    serialize?: (client: unknown) => string
  }

  return {
    capturedOptionsRef: { current: undefined as CapturedOptions | undefined },
    // QA-H-3 (PR #646 fix-round 4): real stub functions, not an opaque
    // `{ __brand }` marker — persister.ts now wraps ONLY `restoreClient`
    // (see its own doc), so `persistClient`/`removeClient` must be REAL
    // functions for the "delegates to the base instance" tests below to
    // mean anything, and `restoreClient` must be controllable per-test
    // (`mockResolvedValueOnce`) for the staleness-marking tests.
    mockPersisterInstance: {
      persistClient: vi.fn().mockResolvedValue(undefined),
      restoreClient: vi.fn().mockResolvedValue(undefined),
      removeClient: vi.fn().mockResolvedValue(undefined),
    },
    mockGet: vi.fn().mockResolvedValue(undefined),
    mockSet: vi.fn().mockResolvedValue(undefined),
    mockDel: vi.fn().mockResolvedValue(undefined),
  }
})

// ---------------------------------------------------------------------------
// Mock idb-keyval — happy-dom does not have a working IndexedDB
// ---------------------------------------------------------------------------
vi.mock('idb-keyval', () => ({
  get: (k: string) => (hoisted.mockGet as (k: string) => unknown)(k),
  set: (k: string, v: string) => (hoisted.mockSet as (k: string, v: string) => unknown)(k, v),
  del: (k: string) => (hoisted.mockDel as (k: string) => unknown)(k),
}))

// ---------------------------------------------------------------------------
// Mock @tanstack/query-async-storage-persister — capture the options
// ---------------------------------------------------------------------------
vi.mock('@tanstack/query-async-storage-persister', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createAsyncStoragePersister: (opts: any) => {
    hoisted.capturedOptionsRef.current = opts
    return hoisted.mockPersisterInstance
  },
}))

// ---------------------------------------------------------------------------
// Import AFTER mocks — module evaluation now runs with the mocks in place
// ---------------------------------------------------------------------------
import {
  PERSIST_KEY,
  persister,
  stripSensitiveFields,
  SENSITIVE_PERSISTED_FIELDS,
  markStrippedQueries,
} from './persister'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('persister — PERSIST_KEY contract', () => {
  it('PERSIST_KEY is exactly "crm-query-cache"', () => {
    // This value MUST match idbDel('crm-query-cache') in use-logout.ts.
    // Changing this constant without updating use-logout.ts causes a security
    // leak: stale user data survives logout on shared devices.
    expect(PERSIST_KEY).toBe('crm-query-cache')
  })

  it('createAsyncStoragePersister was called with key = PERSIST_KEY', () => {
    expect(hoisted.capturedOptionsRef.current?.key).toBe('crm-query-cache')
  })

  it('QA-H-3 (PR #646 fix-round 4): persistClient/removeClient delegate to the instance returned by createAsyncStoragePersister — persister is no longer that SAME object, only a wrapper around it (restoreClient is wrapped, see below)', () => {
    expect(persister.persistClient).toBe(hoisted.mockPersisterInstance.persistClient)
    expect(persister.removeClient).toBe(hoisted.mockPersisterInstance.removeClient)
    expect(persister.restoreClient).not.toBe(hoisted.mockPersisterInstance.restoreClient)
    expect(typeof persister.restoreClient).toBe('function')
  })
})

describe('persister — idb-keyval storage adapter wiring', () => {
  beforeEach(() => {
    hoisted.mockGet.mockClear()
    hoisted.mockSet.mockClear()
    hoisted.mockDel.mockClear()
  })

  it('storage object has getItem, setItem, removeItem functions', () => {
    const storage = hoisted.capturedOptionsRef.current?.storage
    expect(typeof storage?.getItem).toBe('function')
    expect(typeof storage?.setItem).toBe('function')
    expect(typeof storage?.removeItem).toBe('function')
  })

  it('storage.getItem delegates to idb-keyval get()', async () => {
    await hoisted.capturedOptionsRef.current?.storage.getItem('crm-query-cache')
    expect(hoisted.mockGet).toHaveBeenCalledWith('crm-query-cache')
  })

  it('storage.setItem delegates to idb-keyval set()', async () => {
    await hoisted.capturedOptionsRef.current?.storage.setItem('crm-query-cache', '{"data":"test"}')
    expect(hoisted.mockSet).toHaveBeenCalledWith('crm-query-cache', '{"data":"test"}')
  })

  it('storage.removeItem delegates to idb-keyval del()', async () => {
    await hoisted.capturedOptionsRef.current?.storage.removeItem('crm-query-cache')
    expect(hoisted.mockDel).toHaveBeenCalledWith('crm-query-cache')
  })
})

// SR-M-1 (PR #646 fix-round 1): rejectionReason (up to 500 chars of why
// someone declined a project's money terms) was reaching IndexedDB via the
// 'projects' persisted key, which the allow-list's own comment promises is
// "non-PII reference data". These tests pin the field-level strip that
// keeps that promise true without dropping the whole 'projects' key.
describe('persister — stripSensitiveFields (SR-M-1)', () => {
  it('drops rejectionReason from a single object (findOne-shaped query data)', () => {
    const input = { id: 'p1', status: 'REJECTED', rejectionReason: 'Нет бюджета на Q3' }
    const result = stripSensitiveFields(input) as Record<string, unknown>
    expect(result.id).toBe('p1')
    expect(result.status).toBe('REJECTED')
    expect('rejectionReason' in result).toBe(false)
  })

  it('drops rejectionReason from every element of an array (findAll-shaped query data)', () => {
    const input = [
      { id: 'p1', status: 'REJECTED', rejectionReason: 'Нет бюджета' },
      { id: 'p2', status: 'ACTIVE', rejectionReason: null },
    ]
    const result = stripSensitiveFields(input) as Array<Record<string, unknown>>
    expect(result).toHaveLength(2)
    expect(result.every((p) => !('rejectionReason' in p))).toBe(true)
    expect(result[0]?.id).toBe('p1')
    expect(result[1]?.id).toBe('p2')
  })

  it('strips at ANY depth — nested inside the PersistedClient shape a real query cache has', () => {
    const persistedClient = {
      timestamp: 1,
      buster: 'v1',
      clientState: {
        queries: [
          {
            queryKey: ['projects', { archived: 'active' }],
            state: {
              data: [{ id: 'p1', status: 'REJECTED', rejectionReason: 'Секретная причина' }],
            },
          },
        ],
        mutations: [],
      },
    }
    const result = JSON.parse(JSON.stringify(stripSensitiveFields(persistedClient)))
    const serializedWhole = JSON.stringify(result)
    expect(serializedWhole).not.toContain('Секретная причина')
    expect(serializedWhole).not.toContain('rejectionReason')
    // Everything else survives — this is a strip, not a wipe.
    expect(result.clientState.queries[0].state.data[0].id).toBe('p1')
    expect(result.clientState.queries[0].state.data[0].status).toBe('REJECTED')
  })

  it('leaves non-object, non-array values (string/number/boolean/null) untouched', () => {
    expect(stripSensitiveFields('plain string')).toBe('plain string')
    expect(stripSensitiveFields(42)).toBe(42)
    expect(stripSensitiveFields(null)).toBeNull()
    expect(stripSensitiveFields(true)).toBe(true)
  })

  it('the field name lives in ONE place (SENSITIVE_PERSISTED_FIELDS) — this test documents the SR-M-2 extension point, it does not itself fix SR-M-2', () => {
    expect(SENSITIVE_PERSISTED_FIELDS.has('rejectionReason')).toBe(true)
    // SR-M-2 (out of scope for this PR): members[].email, rate, share
    // percentages, notesGeneral are NOT yet in this set — this assertion
    // documents the current (incomplete, on purpose here) state so a
    // future PR closing SR-M-2 has to consciously change this line, not
    // silently regress it.
    expect(SENSITIVE_PERSISTED_FIELDS.size).toBe(1)
  })
})

describe('persister — serialize option is wired to strip sensitive fields before JSON.stringify (SR-M-1)', () => {
  it('createAsyncStoragePersister was called with a serialize function', () => {
    expect(typeof hoisted.capturedOptionsRef.current?.serialize).toBe('function')
  })

  it('the wired serialize function strips rejectionReason and returns a JSON string', () => {
    const serialize = hoisted.capturedOptionsRef.current?.serialize
    if (!serialize) throw new Error('serialize was not captured')
    const output = serialize({
      clientState: {
        queries: [
          {
            queryKey: ['projects'],
            state: { data: [{ id: 'p1', rejectionReason: 'должно исчезнуть' }] },
          },
        ],
      },
    })
    expect(typeof output).toBe('string')
    expect(output).not.toContain('должно исчезнуть')
    expect(output).not.toContain('rejectionReason')
    expect(JSON.parse(output).clientState.queries[0].state.data[0].id).toBe('p1')
  })
})

// QA-H-3 (PR #646 fix-round 4, HIGH — manual-qa repro). A query the strip
// above actually redacted something from must be marked (`meta.strippedAt`)
// at write time — the read-time half (`persister — restoreClient forces
// dataUpdatedAt=0...` below) turns that mark into an unconditional refetch
// on the query's next mount. Without the mark, a restored (redacted)
// snapshot renders as if it were a normal fresh fetch for a full
// `staleTime` window (60s, query-client.ts) — see persister.ts's own doc on
// `stripQuery` for the full mechanism.
describe('persister — serialize marks queries it actually redacted (QA-H-3)', () => {
  function serializeFn(client: unknown): string {
    const serialize = hoisted.capturedOptionsRef.current?.serialize
    if (!serialize) throw new Error('serialize was not captured')
    return serialize(client)
  }

  it('a query with rejectionReason gets meta.strippedAt set to a number', () => {
    const output = serializeFn({
      clientState: {
        queries: [
          {
            queryKey: ['projects'],
            state: { data: [{ id: 'p1', rejectionReason: 'секрет' }] },
          },
        ],
      },
    })
    const query = JSON.parse(output).clientState.queries[0]
    expect(typeof query.meta.strippedAt).toBe('number')
  })

  it('a query with NOTHING to strip (SENIOR/DROP never receive rejectionReason at all — SR-M-5) gets no meta.strippedAt mark', () => {
    const output = serializeFn({
      clientState: {
        queries: [
          {
            queryKey: ['projects'],
            state: { data: [{ id: 'p1', status: 'ACTIVE' }] },
          },
        ],
      },
    })
    const query = JSON.parse(output).clientState.queries[0]
    expect(query.meta).toBeUndefined()
  })

  it('marks each query independently — a redacted query and a clean query in the SAME client only mark the redacted one', () => {
    const output = serializeFn({
      clientState: {
        queries: [
          { queryKey: ['projects', 'p1'], state: { data: { id: 'p1', rejectionReason: 'x' } } },
          { queryKey: ['projects', 'p2'], state: { data: { id: 'p2', status: 'ACTIVE' } } },
        ],
      },
    })
    const [redacted, clean] = JSON.parse(output).clientState.queries
    expect(typeof redacted.meta.strippedAt).toBe('number')
    expect(clean.meta).toBeUndefined()
  })

  it('preserves an existing meta bag on the query instead of replacing it', () => {
    const output = serializeFn({
      clientState: {
        queries: [
          {
            queryKey: ['projects'],
            state: { data: [{ id: 'p1', rejectionReason: 'секрет' }] },
            meta: { someOtherFlag: true },
          },
        ],
      },
    })
    const query = JSON.parse(output).clientState.queries[0]
    expect(query.meta.someOtherFlag).toBe(true)
    expect(typeof query.meta.strippedAt).toBe('number')
  })
})

describe('persister — restoreClient forces dataUpdatedAt=0 on meta.strippedAt-marked queries (QA-H-3)', () => {
  it('a query with meta.strippedAt gets state.dataUpdatedAt forced to 0', async () => {
    hoisted.mockPersisterInstance.restoreClient.mockResolvedValueOnce({
      timestamp: Date.now(),
      buster: 'v1',
      clientState: {
        queries: [
          {
            queryKey: ['projects'],
            state: { data: [{ id: 'p1' }], dataUpdatedAt: Date.now() },
            meta: { strippedAt: Date.now() - 5000 },
          },
        ],
        mutations: [],
      },
    })

    const restored = (await persister.restoreClient()) as {
      clientState: { queries: Array<{ state: { dataUpdatedAt: number } }> }
    }
    expect(restored.clientState.queries[0]?.state.dataUpdatedAt).toBe(0)
  })

  it('a query with NO meta.strippedAt keeps its real dataUpdatedAt untouched', async () => {
    const originalUpdatedAt = Date.now() - 1000
    hoisted.mockPersisterInstance.restoreClient.mockResolvedValueOnce({
      timestamp: Date.now(),
      buster: 'v1',
      clientState: {
        queries: [
          {
            queryKey: ['projects'],
            state: { data: [{ id: 'p1' }], dataUpdatedAt: originalUpdatedAt },
          },
        ],
        mutations: [],
      },
    })

    const restored = (await persister.restoreClient()) as {
      clientState: { queries: Array<{ state: { dataUpdatedAt: number } }> }
    }
    expect(restored.clientState.queries[0]?.state.dataUpdatedAt).toBe(originalUpdatedAt)
  })

  it('mixed client: only the marked query is forced stale, the clean one is untouched', async () => {
    const cleanUpdatedAt = Date.now() - 2000
    hoisted.mockPersisterInstance.restoreClient.mockResolvedValueOnce({
      timestamp: Date.now(),
      buster: 'v1',
      clientState: {
        queries: [
          {
            queryKey: ['projects', 'p1'],
            state: { data: { id: 'p1' }, dataUpdatedAt: Date.now() },
            meta: { strippedAt: Date.now() },
          },
          {
            queryKey: ['projects', 'p2'],
            state: { data: { id: 'p2' }, dataUpdatedAt: cleanUpdatedAt },
          },
        ],
        mutations: [],
      },
    })

    const restored = (await persister.restoreClient()) as {
      clientState: { queries: Array<{ state: { dataUpdatedAt: number } }> }
    }
    expect(restored.clientState.queries[0]?.state.dataUpdatedAt).toBe(0)
    expect(restored.clientState.queries[1]?.state.dataUpdatedAt).toBe(cleanUpdatedAt)
  })

  it('nothing persisted yet (restoreClient resolves undefined) passes through as undefined, not a crash', async () => {
    hoisted.mockPersisterInstance.restoreClient.mockResolvedValueOnce(undefined)
    await expect(persister.restoreClient()).resolves.toBeUndefined()
  })
})

// Mutation-gate closure (PR #646 fix-round 4). Every function QA-H-3 added
// (stripQuery, markStrippedQueries, serialize's own wrapper,
// forceRefetchOfStrippedQueries) opens with a `=== null || typeof !==
// 'object'` guard — defensive against a shape a REAL TanStack Query
// PersistedClient never actually produces (a well-formed client always has
// an object clientState with an array queries), but one a CORRUPTED write
// could (a crashed tab's partial IndexedDB write, a schema left over from an
// older app version). Each test below exercises exactly one guard with a
// value that violates it: with the guard removed or inverted, the malformed
// value either crashes on a property access `null`/`undefined` cannot have,
// or serializes to a visibly wrong shape — either way, something this exact
// test notices went missing or changed, rather than a suppression asserting
// (unverified) that the branch cannot be observed.
describe('persister — defensive guards for malformed/legacy persisted shapes (QA-H-3, mutation-gate closure)', () => {
  function serializeFn(client: unknown): string {
    const serialize = hoisted.capturedOptionsRef.current?.serialize
    if (!serialize) throw new Error('serialize was not captured')
    return serialize(client)
  }

  it('serialize: a client that is null or a non-object primitive falls back to the pre-QA-H-3 stripSensitiveFields(client) path unchanged', () => {
    expect(serializeFn(null)).toBe(JSON.stringify(null))
    expect(serializeFn(42)).toBe(JSON.stringify(42))
  })

  it('markStrippedQueries: a clientState that is null or a non-object primitive passes through unchanged, not coerced to "{}"', () => {
    expect(JSON.parse(serializeFn({ clientState: null })).clientState).toBeNull()
    expect(JSON.parse(serializeFn({ clientState: 42 })).clientState).toBe(42)
  })

  it('stripQuery: a queries-array entry that is null or a non-object primitive passes through unchanged, not crashed or coerced', () => {
    const output = serializeFn({
      clientState: {
        queries: [
          null,
          42,
          { queryKey: ['projects'], state: { data: { id: 'p1', rejectionReason: 'секрет' } } },
        ],
      },
    })
    const queries = JSON.parse(output).clientState.queries
    expect(queries[0]).toBeNull()
    expect(queries[1]).toBe(42)
    // The one well-formed entry alongside the two malformed ones still gets
    // its real work done — the guard must not swallow the whole array.
    expect(typeof queries[2].meta.strippedAt).toBe('number')
  })

  it('markStrippedQueries: a REAL populated mutations array is preserved (with its own sensitive fields stripped), not silently dropped', () => {
    const output = serializeFn({
      clientState: {
        queries: [],
        mutations: [
          {
            mutationKey: ['rejectProjectDraft'],
            state: { data: { id: 'p1', rejectionReason: 'нет бюджета на Q3' } },
          },
        ],
      },
    })
    const mutations = JSON.parse(output).clientState.mutations
    expect(mutations).toHaveLength(1)
    expect(mutations[0].state.data.rejectionReason).toBeUndefined()
    expect(mutations[0].mutationKey).toEqual(['rejectProjectDraft'])
  })

  it("markStrippedQueries: a clientState with no mutations key at all does not grow one out of thin air (via serialize's string output)", () => {
    const output = serializeFn({ clientState: { queries: [] } })
    expect('mutations' in JSON.parse(output).clientState).toBe(false)
  })

  // Calls markStrippedQueries DIRECTLY (not through serialize + JSON.parse)
  // on purpose: `JSON.stringify` drops an `undefined`-valued property
  // unconditionally, so "no mutations key at all" and "a mutations key set
  // to undefined" are INDISTINGUISHABLE through the test above alone — a
  // mutant that turns the conditional spread into an unconditional one
  // (`cs.mutations !== undefined && {...}` → always truthy) would still
  // pass it, because `{ mutations: stripSensitiveFields(undefined) }` is
  // `{ mutations: undefined }`, which stringifies identically to `{}`. The
  // `in` operator, unlike JSON.stringify, DOES see the difference — this is
  // what actually closes the mutation-gate finding at that line, not a
  // suppression (see markStrippedQueries's own doc for why it is exported).
  it('markStrippedQueries (direct call, pre-stringify): a clientState with no mutations key at all produces a result with NO mutations key — not one explicitly set to undefined', () => {
    const result = markStrippedQueries({ queries: [] }) as Record<string, unknown>
    expect('mutations' in result).toBe(false)
  })

  it('forceRefetchOfStrippedQueries: restoreClient resolving null (library types only ever promise undefined, but the guard exists) passes through as null, not a crash', async () => {
    hoisted.mockPersisterInstance.restoreClient.mockResolvedValueOnce(null as unknown as undefined)
    await expect(persister.restoreClient()).resolves.toBeNull()
  })

  it('forceRefetchOfStrippedQueries: a restored client with no clientState at all does not crash (optional chaining, not a direct property read)', async () => {
    const clientWithoutState = { timestamp: Date.now(), buster: 'v1' }
    hoisted.mockPersisterInstance.restoreClient.mockResolvedValueOnce(
      clientWithoutState as unknown as undefined,
    )
    await expect(persister.restoreClient()).resolves.toEqual(clientWithoutState)
  })

  it('forceRefetchOfStrippedQueries: a restored client whose clientState.queries is not an array passes through unchanged (Array.isArray guard, not just falsy-check)', async () => {
    const clientWithBadQueries = {
      timestamp: Date.now(),
      buster: 'v1',
      clientState: { queries: null, mutations: [] },
    }
    hoisted.mockPersisterInstance.restoreClient.mockResolvedValueOnce(
      clientWithBadQueries as unknown as undefined,
    )
    await expect(persister.restoreClient()).resolves.toEqual(clientWithBadQueries)
  })
})
