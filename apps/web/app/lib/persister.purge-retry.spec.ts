/**
 * 1340-SR-L-r2-2 (PII): a purge whose IndexedDB delete fails (a 401, logout, impersonation) must not
 * leave the persisted copy on disk until the next purge. The next boot retries the delete, and
 * restores nothing from the copy that was meant to be gone. Each "boot" is a fresh module instance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { delMock, getMock } = vi.hoisted(() => ({
  delMock: vi.fn((_key?: string) => Promise.resolve()),
  getMock: vi.fn((_key?: string): Promise<unknown> => Promise.resolve(undefined)),
}))
vi.mock('idb-keyval', () => ({ del: delMock, get: getMock, set: vi.fn(() => Promise.resolve()) }))

const STORED = JSON.stringify({
  timestamp: Date.now(),
  buster: '',
  owner: 'user-a',
  clientState: {
    queries: [{ queryKey: ['me'], queryHash: '["me"]', state: { data: { id: 'user-a' } } }],
    mutations: [],
  },
})

const boot = async () => {
  vi.resetModules()
  return import('./persister')
}

beforeEach(() => {
  localStorage.clear()
  delMock.mockReset()
  delMock.mockResolvedValue(undefined)
  getMock.mockReset()
  getMock.mockResolvedValue(STORED)
})
afterEach(() => localStorage.clear())

describe('persister — a failed purge is retried on the next boot (1340-SR-L-r2-2)', () => {
  it('delete rejects -> the next boot deletes the copy and restores none of it', async () => {
    delMock.mockRejectedValueOnce(new DOMException('quota', 'UnknownError'))
    const first = await boot()
    await first.purgePersistedBeforeReload()
    expect(delMock).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('crm-query-cache-purge-pending')).toBe('1')

    const second = await boot()
    expect(await second.persister.restoreClient()).toBeUndefined()
    expect(delMock).toHaveBeenCalledTimes(2)
    expect(delMock).toHaveBeenLastCalledWith(second.PERSIST_KEY)
    expect(second.takeRestoredCacheOwner()).toBeUndefined()
    expect(localStorage.getItem('crm-query-cache-purge-pending')).toBeNull()

    // retried successfully: the boot after that restores normally, with no further delete
    const third = await boot()
    expect(await third.persister.restoreClient()).toBeDefined()
    expect(delMock).toHaveBeenCalledTimes(2)
    expect(third.takeRestoredCacheOwner()).toBe('user-a')
  })

  it('delete throws synchronously -> the next boot still retries', async () => {
    delMock.mockImplementationOnce(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    await (await boot()).purgePersistedBeforeReload()

    const next = await boot()
    expect(await next.persister.restoreClient()).toBeUndefined()
    expect(delMock).toHaveBeenCalledTimes(2)
  })

  it('the retry fails too -> the boot after that retries again', async () => {
    delMock.mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('retry'))
    await (await boot()).purgePersistedBeforeReload()
    expect(await (await boot()).persister.restoreClient()).toBeUndefined()

    expect(await (await boot()).persister.restoreClient()).toBeUndefined()
    expect(delMock).toHaveBeenCalledTimes(3)
  })

  it('control: a purge whose delete succeeded leaves nothing for the next boot to retry', async () => {
    await (await boot()).purgePersistedBeforeReload()
    expect(localStorage.getItem('crm-query-cache-purge-pending')).toBeNull()
    const next = await boot()
    expect(await next.persister.restoreClient()).toBeDefined()
    expect(delMock).toHaveBeenCalledTimes(1)
  })

  it('storage that refuses localStorage keeps the purge best-effort: the next boot restores (owner check decides)', async () => {
    const blocked = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation(blocked)
    const read = vi.spyOn(localStorage, 'getItem').mockImplementation(blocked)
    try {
      delMock.mockRejectedValueOnce(new Error('first'))
      await expect((await boot()).purgePersistedBeforeReload()).resolves.toBeUndefined()
      const next = await boot()
      expect(await next.persister.restoreClient()).toBeDefined()
      expect(next.takeRestoredCacheOwner()).toBe('user-a')
    } finally {
      set.mockRestore()
      read.mockRestore()
    }
  })
})
