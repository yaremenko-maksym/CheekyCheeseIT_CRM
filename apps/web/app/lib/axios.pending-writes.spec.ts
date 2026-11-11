import { describe, expect, it, vi } from 'vitest'
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { api, pendingWriteCount } from './axios'

// A request-scoped adapter: resolves/rejects only when the test says so.
function deferredAdapter() {
  let settle: ((ok: boolean) => void) | null = null
  const adapter: AxiosAdapter = (config: InternalAxiosRequestConfig) =>
    new Promise<AxiosResponse>((resolve, reject) => {
      settle = (ok) => {
        const res = { data: {}, status: ok ? 200 : 500, statusText: '', headers: {}, config }
        if (ok) resolve(res)
        else reject(Object.assign(new Error('boom'), { config, response: res }))
      }
    })
  return { adapter, started: () => settle !== null, settle: (ok: boolean) => settle?.(ok) }
}

describe('pendingWriteCount (task-ios-file-input-freeze)', () => {
  it('counts a POST while it is in flight and releases it on success', async () => {
    const d = deferredAdapter()
    const req = api.post('/documents', {}, { adapter: d.adapter })
    await vi.waitFor(() => expect(pendingWriteCount()).toBe(1))
    d.settle(true)
    await req
    expect(pendingWriteCount()).toBe(0)
  })

  it('releases a failed write too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = deferredAdapter()
    const req = api.patch('/x', {}, { adapter: d.adapter })
    await vi.waitFor(() => expect(pendingWriteCount()).toBe(1))
    d.settle(false)
    await expect(req).rejects.toThrow()
    expect(pendingWriteCount()).toBe(0)
  })

  it('does not count a GET', async () => {
    const d = deferredAdapter()
    const req = api.get('/x', { adapter: d.adapter })
    await vi.waitFor(() => expect(d.started()).toBe(true))
    expect(pendingWriteCount()).toBe(0)
    d.settle(true)
    await req
  })
})
