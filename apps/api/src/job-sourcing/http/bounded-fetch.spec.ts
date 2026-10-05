import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetThrottleForTests, boundedFetchText } from './bounded-fetch'
import { SourceBlockedError, SourceRateLimitedError } from './source-errors'

const hosts = ['api.example.test']
const resp = (body: string, init: ResponseInit & { url?: string } = {}) => {
  const r = new Response(body, init)
  if (init.url) Object.defineProperty(r, 'url', { value: init.url })
  return r
}

beforeEach(() => __resetThrottleForTests())
afterEach(() => vi.unstubAllGlobals())

describe('boundedFetchText', () => {
  it('refuses a host outside the allow-list without touching the network', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(boundedFetchText('https://evil.test/x', { allowedHosts: hosts })).rejects.toThrow(
      /not allowed/,
    )
    expect(f).not.toHaveBeenCalled()
  })
  it('refuses plain http', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(
      boundedFetchText('http://api.example.test/x', { allowedHosts: hosts }),
    ).rejects.toThrow(/not allowed/)
    expect(f).not.toHaveBeenCalled()
  })
  it('refuses an unparseable URL without touching the network', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(boundedFetchText('not a url', { allowedHosts: hosts })).rejects.toThrow(
      /not allowed/,
    )
    expect(f).not.toHaveBeenCalled()
  })
  it('maps 403 to SourceBlockedError and 429 to SourceRateLimitedError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(resp('', { status: 403, url: 'https://api.example.test/x' })),
    )
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: hosts, minGapMs: 0 }),
    ).rejects.toBeInstanceOf(SourceBlockedError)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(resp('', { status: 429, url: 'https://api.example.test/x' })),
    )
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: hosts, minGapMs: 0 }),
    ).rejects.toBeInstanceOf(SourceRateLimitedError)
  })
  it('carries host and status on the block / rate-limit errors', () => {
    const blocked = new SourceBlockedError('api.example.test', 403)
    expect(blocked.host).toBe('api.example.test')
    expect(blocked.status).toBe(403)
    expect(blocked.budgetExhausted).toBe(false)
    expect(new SourceRateLimitedError('api.example.test').budgetExhausted).toBe(false)
  })
  it('throws a plain error with host and status on other non-ok responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(resp('', { status: 500, url: 'https://api.example.test/x' })),
    )
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: hosts, minGapMs: 0 }),
    ).rejects.toThrow('api.example.test responded 500')
  })
  it('rejects when content-length already exceeds maxBytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        resp('x', {
          status: 200,
          url: 'https://api.example.test/x',
          headers: { 'content-length': '5000' },
        }),
      ),
    )
    await expect(
      boundedFetchText('https://api.example.test/x', {
        allowedHosts: hosts,
        maxBytes: 1000,
        minGapMs: 0,
      }),
    ).rejects.toThrow(/too large/)
  })
  it('aborts a body that exceeds maxBytes while streaming', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          resp('x'.repeat(5000), { status: 200, url: 'https://api.example.test/x' }),
        ),
    )
    await expect(
      boundedFetchText('https://api.example.test/x', {
        allowedHosts: hosts,
        maxBytes: 1000,
        minGapMs: 0,
      }),
    ).rejects.toThrow(/too large/)
  })
  it('rejects a redirect that ended on a foreign host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(resp('ok', { status: 200, url: 'https://evil.test/landed' })),
    )
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: hosts, minGapMs: 0 }),
    ).rejects.toThrow(/not allowed/)
  })
  it('returns the body on success and sends our User-Agent', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(resp('{"a":1}', { status: 200, url: 'https://api.example.test/x' }))
    vi.stubGlobal('fetch', f)
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: hosts, minGapMs: 0 }),
    ).resolves.toBe('{"a":1}')
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      'user-agent': expect.stringContaining('CheekyCheeseIT-CRM'),
    })
  })
  it('lets caller headers override the default User-Agent and passes method/body', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(resp('ok', { status: 200, url: 'https://api.example.test/x' }))
    vi.stubGlobal('fetch', f)
    await boundedFetchText('https://api.example.test/x', {
      allowedHosts: hosts,
      minGapMs: 0,
      method: 'POST',
      body: '{"q":1}',
      headers: { 'User-Agent': 'custom/1', accept: 'application/json' },
    })
    const init = f.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"q":1}')
    expect(init.headers).toEqual({ 'user-agent': 'custom/1', accept: 'application/json' })
  })
  it('spaces two requests to one host by minGapMs', async () => {
    vi.useFakeTimers()
    try {
      const f = vi
        .fn()
        .mockImplementation(async () =>
          resp('ok', { status: 200, url: 'https://api.example.test/x' }),
        )
      vi.stubGlobal('fetch', f)
      const p1 = boundedFetchText('https://api.example.test/x', {
        allowedHosts: hosts,
        minGapMs: 1000,
      })
      await vi.advanceTimersByTimeAsync(0)
      await p1
      const p2 = boundedFetchText('https://api.example.test/x', {
        allowedHosts: hosts,
        minGapMs: 1000,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(f).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      await p2
      expect(f).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
  it('spaces parallel requests to one host (slot reserved before waiting)', async () => {
    vi.useFakeTimers()
    try {
      const f = vi
        .fn()
        .mockImplementation(async () =>
          resp('ok', { status: 200, url: 'https://api.example.test/x' }),
        )
      vi.stubGlobal('fetch', f)
      const opts = { allowedHosts: hosts, minGapMs: 1000 }
      const all = Promise.all([
        boundedFetchText('https://api.example.test/x', opts),
        boundedFetchText('https://api.example.test/x', opts),
        boundedFetchText('https://api.example.test/x', opts),
      ])
      await vi.advanceTimersByTimeAsync(0)
      expect(f).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1000)
      await all
      expect(f).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not throttle across different hosts', async () => {
    const f = vi.fn().mockImplementation(async (u: string) => resp('ok', { status: 200, url: u }))
    vi.stubGlobal('fetch', f)
    const opts = { allowedHosts: ['a.test', 'b.test'], minGapMs: 60_000 }
    await boundedFetchText('https://a.test/x', opts)
    await boundedFetchText('https://b.test/x', opts)
    expect(f).toHaveBeenCalledTimes(2)
  })
})
