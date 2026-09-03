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
    mockPersisterInstance: { __brand: 'asyncStoragePersister' as const },
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

  it('persister is the instance returned by createAsyncStoragePersister', () => {
    expect(persister).toBe(hoisted.mockPersisterInstance)
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
