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

  it('two writes in flight: one finishing keeps the user busy, both finishing frees them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = deferredAdapter()
    const bad = deferredAdapter()
    const a = api.post('/a', {}, { adapter: ok.adapter })
    const b = api.put('/b', {}, { adapter: bad.adapter })
    await vi.waitFor(() => expect(pendingWriteCount()).toBe(2))

    ok.settle(true)
    await a
    expect(pendingWriteCount()).toBe(1)

    bad.settle(false)
    await expect(b).rejects.toThrow()
    expect(pendingWriteCount()).toBe(0)
  })

  it('a write that fails first leaves the other one counted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = deferredAdapter()
    const second = deferredAdapter()
    const a = api.delete('/a', { adapter: first.adapter })
    const b = api.post('/b', {}, { adapter: second.adapter })
    await vi.waitFor(() => expect(pendingWriteCount()).toBe(2))

    first.settle(false)
    await expect(a).rejects.toThrow()
    expect(pendingWriteCount()).toBe(1)

    second.settle(true)
    await b
    expect(pendingWriteCount()).toBe(0)
  })

  it.each(['get', 'head', 'options'] as const)(
    'a %s finishing or failing never changes the write count',
    async (method) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const write = deferredAdapter()
      const w = api.post('/w', {}, { adapter: write.adapter })
      await vi.waitFor(() => expect(pendingWriteCount()).toBe(1))

      for (const ok of [true, false]) {
        const read = deferredAdapter()
        const r = api.request({ method, url: '/r', adapter: read.adapter })
        await vi.waitFor(() => expect(read.started()).toBe(true))
        expect(pendingWriteCount()).toBe(1)
        read.settle(ok)
        await r.catch(() => {})
        expect(pendingWriteCount()).toBe(1)
      }

      write.settle(true)
      await w
      expect(pendingWriteCount()).toBe(0)
    },
  )

  it('a write whose transformRequest throws (no config on the error) is not left counted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bare = new Error('Do not know how to serialize a BigInt')
    const req = api.post(
      '/x',
      { n: 1 },
      {
        transformRequest: [
          () => {
            throw bare
          },
        ],
      },
    )
    await expect(req).rejects.toBe(bare)
    expect(pendingWriteCount()).toBe(0)
  })

  it('a config-less failure next to a live write keeps that write counted until it settles', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const live = deferredAdapter()
    const a = api.post('/upload', {}, { adapter: live.adapter })
    await vi.waitFor(() => expect(pendingWriteCount()).toBe(1))

    const b = api.put(
      '/x',
      {},
      {
        transformRequest: [
          () => {
            throw new Error('circular')
          },
        ],
      },
    )
    await expect(b).rejects.toThrow()
    expect(pendingWriteCount()).toBe(1)

    live.settle(true)
    await a
    expect(pendingWriteCount()).toBe(0)
  })

  it('re-sending a config (a retry) counts that write once, not once per pass', async () => {
    const d = deferredAdapter()
    const first = api.post('/retry', {}, { adapter: d.adapter })
    await vi.waitFor(() => expect(pendingWriteCount()).toBe(1))
    d.settle(true)
    const { config } = await first

    const again = api.request(config) // config.adapter is already the counting wrapper
    await vi.waitFor(() => expect(d.started()).toBe(true))
    await vi.waitFor(() => expect(pendingWriteCount()).toBeGreaterThan(0))
    expect(pendingWriteCount()).toBe(1)
    d.settle(true)
    await again
    expect(pendingWriteCount()).toBe(0)
  })
})
