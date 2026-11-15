/**
 * A 401 from any API call: the interceptor sends the page to /login through logout's purge
 * (`purgePersistedBeforeReload`), so persisting stops before the delete and no save lands after it.
 */
import { describe, expect, it, vi } from 'vitest'
import settle from 'axios/unsafe/core/settle.js'
import type { AxiosRequestConfig, AxiosResponse } from 'axios'

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
})
