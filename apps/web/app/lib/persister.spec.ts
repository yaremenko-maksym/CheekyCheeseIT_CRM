/**
 * Unit tests for persister.ts
 *
 * Verifies:
 * - PERSIST_KEY constant equals 'crm-query-cache' (must stay in sync with
 *   use-logout.ts → idbDel('crm-query-cache') — security contract).
 * - persister is created (not null/undefined).
 * - The key exposed by createAsyncStoragePersister is stored under PERSIST_KEY.
 *
 * We cannot test actual IndexedDB writes here (happy-dom IDB support is
 * incomplete), so we test the contract — the key constant — and that the
 * persister object is properly instantiated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock idb-keyval — happy-dom does not have a working IndexedDB
// ---------------------------------------------------------------------------
vi.mock('idb-keyval', () => ({
  get: vi.fn().mockResolvedValue(undefined),
  set: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Mock @tanstack/query-async-storage-persister so we can inspect options
// ---------------------------------------------------------------------------
const mockPersisterInstance = { __brand: 'asyncStoragePersister' }
const createAsyncStoragePersisterMock = vi.fn(() => mockPersisterInstance)

vi.mock('@tanstack/query-async-storage-persister', () => ({
  createAsyncStoragePersister: createAsyncStoragePersisterMock,
}))

// ---------------------------------------------------------------------------
// Import AFTER mocks are set up
// ---------------------------------------------------------------------------
import { PERSIST_KEY, persister } from './persister'

describe('persister — PERSIST_KEY contract', () => {
  it('PERSIST_KEY is exactly "crm-query-cache"', () => {
    // This value MUST match idbDel('crm-query-cache') in use-logout.ts.
    // Changing this constant without updating use-logout.ts causes a security
    // leak: stale user data survives logout on shared devices.
    expect(PERSIST_KEY).toBe('crm-query-cache')
  })

  it('createAsyncStoragePersister is called with key = PERSIST_KEY', () => {
    expect(createAsyncStoragePersisterMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'crm-query-cache' }),
    )
  })

  it('persister is the instance returned by createAsyncStoragePersister', () => {
    expect(persister).toBe(mockPersisterInstance)
  })
})

describe('persister — idb-keyval storage adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes a storage adapter with getItem, setItem, removeItem', () => {
    const callArgs = createAsyncStoragePersisterMock.mock.calls[0]?.[0]
    expect(callArgs).toBeDefined()
    const { storage } = callArgs as { storage: Record<string, unknown> }
    expect(typeof storage.getItem).toBe('function')
    expect(typeof storage.setItem).toBe('function')
    expect(typeof storage.removeItem).toBe('function')
  })

  it('idb-keyval get is called via storage.getItem', async () => {
    const { get } = await import('idb-keyval')
    const callArgs = createAsyncStoragePersisterMock.mock.calls[0]?.[0]
    const { storage } = callArgs as {
      storage: { getItem: (k: string) => Promise<unknown> }
    }
    await storage.getItem('crm-query-cache')
    expect(get).toHaveBeenCalledWith('crm-query-cache')
  })

  it('idb-keyval set is called via storage.setItem', async () => {
    const { set } = await import('idb-keyval')
    const callArgs = createAsyncStoragePersisterMock.mock.calls[0]?.[0]
    const { storage } = callArgs as {
      storage: { setItem: (k: string, v: string) => Promise<unknown> }
    }
    await storage.setItem('crm-query-cache', '{"data":"test"}')
    expect(set).toHaveBeenCalledWith('crm-query-cache', '{"data":"test"}')
  })

  it('idb-keyval del is called via storage.removeItem', async () => {
    const { del } = await import('idb-keyval')
    const callArgs = createAsyncStoragePersisterMock.mock.calls[0]?.[0]
    const { storage } = callArgs as {
      storage: { removeItem: (k: string) => Promise<unknown> }
    }
    await storage.removeItem('crm-query-cache')
    expect(del).toHaveBeenCalledWith('crm-query-cache')
  })
})
