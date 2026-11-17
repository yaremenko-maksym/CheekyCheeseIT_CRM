/**
 * A 401 from any API call: the interceptor sends the page to /login through logout's purge
 * (`purgePersistedBeforeReload`), so persisting stops before the delete and no save lands after it.
 */
import { describe, expect, it, vi } from 'vitest'
import settle from 'axios/unsafe/core/settle.js'
import { isAxiosError, type AxiosRequestConfig, type AxiosResponse } from 'axios'

const { delMock, setMock } = vi.hoisted(() => ({
  delMock: vi.fn((_key?: string) => Promise.resolve()),
  setMock: vi.fn((_key?: string, _value?: string) => Promise.resolve()),
}))
vi.mock('idb-keyval', () => ({ del: delMock, get: vi.fn(), set: setMock }))

import { api } from './axios'
import { PERSIST_KEY, persister } from './persister'

const unauthorized = (config: AxiosRequestConfig): Promise<AxiosResponse> =>
  new Promise((resolve, reject) => {
    settle(resolve, reject, {
      data: {},
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config,
      request: {},
    } as AxiosResponse)
  })

describe('axios.ts interceptor — 401', () => {
  it('stops persisting, deletes the persisted copy, then goes to /login', async () => {
    Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(api.get('/projects', { adapter: unauthorized })).rejects.toBeDefined()
    await vi.waitFor(() => expect(window.location.href).toBe('/login'))
    expect(delMock).toHaveBeenCalledWith(PERSIST_KEY)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60_000) // the persister's throttle is idle: a save runs at once
    try {
      const client = { timestamp: 1, buster: '', clientState: { queries: [], mutations: [] } }
      await persister.persistClient(client as Parameters<typeof persister.persistClient>[0])
      await vi.advanceTimersByTimeAsync(1000)
    } finally {
      vi.useRealTimers()
    }
    expect(setMock).not.toHaveBeenCalled()
  })

  // CR-H-1: idb-keyval opens IndexedDB synchronously, so a blocked storage throws before any promise
  it('still goes to /login when deleting the persisted copy throws synchronously', async () => {
    Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    delMock.mockImplementationOnce(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    // the caller gets the 401 itself, never the storage failure (1340-CR-L-r2-2)
    const rejected: unknown = await api.get('/projects', { adapter: unauthorized }).catch((e) => e)
    expect(isAxiosError(rejected)).toBe(true)
    expect(rejected).toMatchObject({ response: { status: 401 }, config: { url: '/projects' } })
    await vi.waitFor(() => expect(window.location.href).toBe('/login'))
  })
})
