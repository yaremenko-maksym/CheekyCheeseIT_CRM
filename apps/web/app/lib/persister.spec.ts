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
  type CapturedOptions = { storage: StorageAdapter; key: string; throttleTime?: number }

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
import { PERSIST_KEY, persister } from './persister'

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
