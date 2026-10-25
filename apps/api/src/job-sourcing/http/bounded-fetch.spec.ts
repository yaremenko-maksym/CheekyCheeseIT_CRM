import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetThrottleForTests,
  boundedFetchText,
  DEFAULT_MAX_BYTES,
  MAX_RESPONSE_BYTES_CEILING,
  transportOptionsFor,
} from './bounded-fetch'
import {
  SourceBlockedError,
  SourceHttpStatusError,
  SourcePayloadTooLargeError,
  SourceRateLimitedError,
} from './source-errors'

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

const redirect = (status: number, location: string | null) =>
  new Response('', { status, headers: location === null ? {} : { location } })

describe('boundedFetchText — manual redirects (SR-H-1 / CR-M-1)', () => {
  const two = ['api.example.test', 'cdn.example.test']

  it('calls fetch exactly once when the redirect target is a foreign host', async () => {
    const f = vi.fn().mockResolvedValueOnce(redirect(302, 'https://evil.test/steal'))
    vi.stubGlobal('fetch', f)
    await expect(
      boundedFetchText('https://api.example.test/x', {
        allowedHosts: hosts,
        minGapMs: 0,
        headers: { 'x-api-key': 'secret' },
      }),
    ).rejects.toThrow(/not allowed/)
    expect(f).toHaveBeenCalledTimes(1)
    expect((f.mock.calls[0][1] as RequestInit).redirect).toBe('manual')
  })
  it('refuses a redirect downgrade to http before any request', async () => {
    const f = vi.fn().mockResolvedValueOnce(redirect(301, 'http://api.example.test/y'))
    vi.stubGlobal('fetch', f)
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: hosts, minGapMs: 0 }),
    ).rejects.toThrow(/not allowed/)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('follows a same-host relative redirect and keeps headers and body on 307', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(redirect(307, '/y'))
      .mockResolvedValueOnce(resp('done', { status: 200, url: 'https://api.example.test/y' }))
    vi.stubGlobal('fetch', f)
    await expect(
      boundedFetchText('https://api.example.test/x', {
        allowedHosts: hosts,
        minGapMs: 0,
        method: 'POST',
        body: '{"q":1}',
        headers: { 'x-api-key': 'secret' },
      }),
    ).resolves.toBe('done')
    expect(f.mock.calls[1][0]).toBe('https://api.example.test/y')
    const init = f.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"q":1}')
    expect(init.headers).toMatchObject({ 'x-api-key': 'secret' })
  })
  it('follows a redirect to another allow-listed host WITHOUT custom headers or body', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(redirect(307, 'https://cdn.example.test/z'))
      .mockResolvedValueOnce(resp('done', { status: 200, url: 'https://cdn.example.test/z' }))
    vi.stubGlobal('fetch', f)
    await expect(
      boundedFetchText('https://api.example.test/x', {
        allowedHosts: two,
        minGapMs: 0,
        method: 'POST',
        body: '{"q":1}',
        headers: { 'x-api-key': 'secret', 'x-rapidapi-key': 'secret2' },
      }),
    ).resolves.toBe('done')
    const init = f.mock.calls[1][1] as RequestInit
    expect(init.headers).toEqual({ 'user-agent': expect.stringContaining('CheekyCheeseIT-CRM') })
    expect(init.body).toBeUndefined()
    expect(init.method).toBe('GET')
  })
  it('downgrades POST to GET without body on a 303 to the same host', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(redirect(303, '/r'))
      .mockResolvedValueOnce(resp('ok', { status: 200, url: 'https://api.example.test/r' }))
    vi.stubGlobal('fetch', f)
    await boundedFetchText('https://api.example.test/x', {
      allowedHosts: hosts,
      minGapMs: 0,
      method: 'POST',
      body: 'b',
    })
    const init = f.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
  })
  it('allows at most 3 redirects', async () => {
    const f = vi.fn().mockImplementation(async () => redirect(302, '/loop'))
    vi.stubGlobal('fetch', f)
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: hosts, minGapMs: 0 }),
    ).rejects.toThrow(/too many redirects/)
    expect(f).toHaveBeenCalledTimes(4)
  })
  it('follows exactly 3 redirects', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, '/1'))
      .mockResolvedValueOnce(redirect(302, '/2'))
      .mockResolvedValueOnce(redirect(302, '/3'))
      .mockResolvedValueOnce(resp('end', { status: 200, url: 'https://api.example.test/3' }))
    vi.stubGlobal('fetch', f)
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: hosts, minGapMs: 0 }),
    ).resolves.toBe('end')
  })
  it('cancels the body of a redirect response', async () => {
    const r = redirect(302, '/y')
    const cancel = vi.spyOn(r.body as ReadableStream, 'cancel')
    const f = vi
      .fn()
      .mockResolvedValueOnce(r)
      .mockResolvedValueOnce(resp('ok', { status: 200, url: 'https://api.example.test/y' }))
    vi.stubGlobal('fetch', f)
    await boundedFetchText('https://api.example.test/x', { allowedHosts: hosts, minGapMs: 0 })
    expect(cancel).toHaveBeenCalled()
  })
  it('fails on a redirect without a Location header', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(redirect(302, null)))
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: hosts, minGapMs: 0 }),
    ).rejects.toThrow(/redirect without location/)
  })
})

describe('boundedFetchText — URL hardening (SR-M-2)', () => {
  it.each([
    ['userinfo', 'https://user:pass@api.example.test/x'],
    ['userinfo-only user', 'https://user@api.example.test/x'],
    ['@ bypass', 'https://api.example.test@evil.test/x'],
    ['@ bypass reversed', 'https://evil.test@api.example.test/x'],
    ['non-default port', 'https://api.example.test:8443/x'],
    ['trailing dot', 'https://api.example.test./x'],
    ['upper-case host', 'https://API.EXAMPLE.TEST/x'],
  ])('refuses %s before the network', async (_name, url) => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(boundedFetchText(url, { allowedHosts: hosts, minGapMs: 0 })).rejects.toThrow(
      /not allowed/,
    )
    expect(f).not.toHaveBeenCalled()
  })
  it('refuses even the explicit default port (authority must equal the host exactly)', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(
      boundedFetchText('https://api.example.test:443/x', { allowedHosts: hosts, minGapMs: 0 }),
    ).rejects.toThrow(/not allowed/)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('boundedFetchText — allowedHosts validation (SR-M-1)', () => {
  it.each([
    'localhost',
    'redis',
    '127.0.0.1',
    '10.0.0.5',
    '[::1]',
    'foo.local',
    'db.internal',
    'api.example.test:8443',
    'https://api.example.test',
    'api.example.test/path',
    'API.example.test',
    'api.example.test.',
    '*.example.test',
    '-bad.example.test',
    'a..b.test',
    '',
    'sub.localhost',
  ])('rejects the allowedHosts entry %j as a config error without network', async (entry) => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: [entry], minGapMs: 0 }),
    ).rejects.toThrow(/invalid allowedHosts/)
    expect(f).not.toHaveBeenCalled()
  })
  it('rejects an empty allow-list', async () => {
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: [] }),
    ).rejects.toThrow(/invalid allowedHosts/)
  })
  it('accepts ordinary DNS hosts', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(resp('ok', { status: 200, url: 'https://muse-api.example.com/x' })),
    )
    await expect(
      boundedFetchText('https://muse-api.example.com/x', {
        allowedHosts: ['muse-api.example.com', 'jooble.org'],
        minGapMs: 0,
      }),
    ).resolves.toBe('ok')
  })
})

describe('boundedFetchText — limits, timeout, defaults (SR-M-3 / CR-M-2)', () => {
  const ok = () => resp('ok', { status: 200, url: 'https://api.example.test/x' })

  it('rejects maxBytes / timeoutMs above the ceiling or non-positive', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    for (const bad of [
      { maxBytes: 10 * 1024 * 1024 + 1 },
      { maxBytes: 0 },
      { maxBytes: Number.NaN },
      { timeoutMs: 60_001 },
      { timeoutMs: 0 },
      { timeoutMs: -1 },
    ]) {
      await expect(
        boundedFetchText('https://api.example.test/x', {
          allowedHosts: hosts,
          minGapMs: 0,
          ...bad,
        }),
      ).rejects.toThrow(/invalid (maxBytes|timeoutMs)/)
    }
    expect(f).not.toHaveBeenCalled()
  })
  it('accepts the ceilings themselves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ok()),
    )
    await expect(
      boundedFetchText('https://api.example.test/x', {
        allowedHosts: hosts,
        minGapMs: 0,
        maxBytes: 10 * 1024 * 1024,
        timeoutMs: 60_000,
      }),
    ).resolves.toBe('ok')
  })
  it('aborts a hanging request at timeoutMs and clears the timer', async () => {
    vi.useFakeTimers()
    try {
      const clear = vi.spyOn(globalThis, 'clearTimeout')
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(
          (_u: string, init: RequestInit) =>
            new Promise((_res, rej) => {
              init.signal?.addEventListener('abort', () => rej(new Error('aborted')))
            }),
        ),
      )
      const p = boundedFetchText('https://api.example.test/x', {
        allowedHosts: hosts,
        minGapMs: 0,
        timeoutMs: 500,
      })
      const settled = p.then(
        () => null,
        (e: Error) => e.message,
      )
      await vi.advanceTimersByTimeAsync(499)
      expect(clear).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(await settled).toBe('aborted')
      expect(clear).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('uses a 15 s default timeout', async () => {
    vi.useFakeTimers()
    try {
      let aborted = false
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(
          (_u: string, init: RequestInit) =>
            new Promise((_res, rej) => {
              init.signal?.addEventListener('abort', () => {
                aborted = true
                rej(new Error('aborted'))
              })
            }),
        ),
      )
      const p = boundedFetchText('https://api.example.test/x', {
        allowedHosts: hosts,
        minGapMs: 0,
      })
      const settled = p.then(
        () => null,
        (e: Error) => e.message,
      )
      await vi.advanceTimersByTimeAsync(14_999)
      expect(aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(aborted).toBe(true)
      expect(await settled).toBe('aborted')
    } finally {
      vi.useRealTimers()
    }
  })
  it('uses a 2 MiB default size cap', async () => {
    const limit = 2 * 1024 * 1024
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          resp('x'.repeat(limit), { status: 200, url: 'https://api.example.test/x' }),
        )
        .mockResolvedValueOnce(
          resp('x'.repeat(limit + 1), { status: 200, url: 'https://api.example.test/x' }),
        ),
    )
    const o = { allowedHosts: hosts, minGapMs: 0 }
    await expect(boundedFetchText('https://api.example.test/x', o)).resolves.toHaveLength(limit)
    await expect(boundedFetchText('https://api.example.test/x', o)).rejects.toThrow(/too large/)
  })
  it('uses a 1 s default throttle gap', async () => {
    vi.useFakeTimers()
    try {
      const f = vi.fn().mockImplementation(async () => ok())
      vi.stubGlobal('fetch', f)
      const o = { allowedHosts: hosts }
      await boundedFetchText('https://api.example.test/x', o)
      const p2 = boundedFetchText('https://api.example.test/x', o)
      await vi.advanceTimersByTimeAsync(999)
      expect(f).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await p2
      expect(f).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
  it('falls back to the requested URL when response.url is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('ok', { status: 200 })))
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: hosts, minGapMs: 0 }),
    ).resolves.toBe('ok')
  })
  it('returns an empty string for a null body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })))
    await expect(
      boundedFetchText('https://api.example.test/x', { allowedHosts: hosts, minGapMs: 0 }),
    ).resolves.toBe('')
  })
})

describe('boundedFetchText — mutation-gate hardening', () => {
  const o = { allowedHosts: hosts, minGapMs: 0 }
  const U = 'https://api.example.test/x'
  const nullBody = (status: number, headers: Record<string, string> = {}) =>
    new Response(null, { status, headers })

  it('does not wait at all when the gap has elapsed exactly (wait === 0)', async () => {
    vi.useFakeTimers()
    try {
      const f = vi.fn().mockImplementation(async () => resp('ok', { status: 200, url: U }))
      vi.stubGlobal('fetch', f)
      const opts = { allowedHosts: hosts, minGapMs: 1000 }
      const p1 = boundedFetchText(U, opts)
      await vi.advanceTimersByTimeAsync(0)
      await p1
      await vi.advanceTimersByTimeAsync(1000)
      const p2 = boundedFetchText(U, opts)
      // flush microtasks only — a (mutated) setTimeout(…, 0) would not have fired
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(f).toHaveBeenCalledTimes(2)
      await p2
    } finally {
      vi.useRealTimers()
    }
  })

  it('reassembles a body delivered in several chunks, skipping empty reads', async () => {
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('ab'))
        c.enqueue(undefined as unknown as Uint8Array)
        c.enqueue(enc.encode('cd'))
        c.enqueue(enc.encode('ef'))
        c.close()
      },
    })
    const r = new Response(stream, { status: 200 })
    Object.defineProperty(r, 'url', { value: U })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(r))
    await expect(boundedFetchText(U, o)).resolves.toBe('abcdef')
  })

  it('releases the reader lock on success and on the size-cap error path', async () => {
    const mk = (chunks: Uint8Array[]) => {
      const releaseLock = vi.fn()
      const reads = [...chunks.map((value) => ({ done: false, value })), { done: true }]
      const reader = {
        read: vi.fn().mockImplementation(async () => reads.shift()),
        cancel: vi.fn(),
        releaseLock,
      }
      const fake = {
        status: 200,
        ok: true,
        url: U,
        headers: new Headers(),
        body: { getReader: () => reader, cancel: vi.fn() },
      } as unknown as Response
      return { fake, releaseLock, reader }
    }
    const a = mk([new TextEncoder().encode('hi')])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(a.fake))
    await expect(boundedFetchText(U, o)).resolves.toBe('hi')
    expect(a.releaseLock).toHaveBeenCalledTimes(1)

    const b = mk([new Uint8Array(50)])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(b.fake))
    await expect(boundedFetchText(U, { ...o, maxBytes: 10 })).rejects.toThrow(/too large/)
    expect(b.reader.cancel).toHaveBeenCalled()
    expect(b.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('sends GET without a body property by default', async () => {
    const f = vi.fn().mockResolvedValueOnce(resp('ok', { status: 200, url: U }))
    vi.stubGlobal('fetch', f)
    await boundedFetchText(U, o)
    const init = f.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('GET')
    expect(init).not.toHaveProperty('body')
  })

  it.each([301, 302])('turns POST into GET without body on a same-host %i', async (status) => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(redirect(status, '/r'))
      .mockResolvedValueOnce(resp('ok', { status: 200, url: 'https://api.example.test/r' }))
    vi.stubGlobal('fetch', f)
    await boundedFetchText(U, { ...o, method: 'POST', body: 'b', headers: { 'x-api-key': 'k' } })
    const init = f.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('GET')
    expect(init).not.toHaveProperty('body')
    // same host: credentials are still sent
    expect(init.headers).toMatchObject({ 'x-api-key': 'k' })
  })

  it('keeps POST and body on a same-host 308', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(redirect(308, '/r'))
      .mockResolvedValueOnce(resp('ok', { status: 200, url: 'https://api.example.test/r' }))
    vi.stubGlobal('fetch', f)
    await boundedFetchText(U, { ...o, method: 'POST', body: 'b' })
    const init = f.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe('b')
  })

  it('keeps GET on a same-host 301 and 302 for GET requests', async () => {
    for (const status of [301, 302]) {
      const f = vi
        .fn()
        .mockResolvedValueOnce(redirect(status, '/r'))
        .mockResolvedValueOnce(resp('ok', { status: 200, url: 'https://api.example.test/r' }))
      vi.stubGlobal('fetch', f)
      await boundedFetchText(U, o)
      expect((f.mock.calls[1][1] as RequestInit).method).toBe('GET')
    }
  })

  it('only rewrites the request on a 301/302 when it was a POST (a GET keeps what it carried)', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, '/r'))
      .mockResolvedValueOnce(resp('ok', { status: 200, url: 'https://api.example.test/r' }))
    vi.stubGlobal('fetch', f)
    await boundedFetchText(U, { ...o, method: 'GET', body: 'kept' })
    const init = f.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('GET')
    expect(init.body).toBe('kept')
  })

  it('turns a redirect Location that cannot be parsed into a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(redirect(302, 'https://[bad')))
    await expect(boundedFetchText(U, o)).rejects.toThrow('host not allowed')
  })

  it('refuses a URL with leading whitespace (scheme must be written literally)', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(boundedFetchText(` ${U}`, o)).rejects.toThrow(/not allowed/)
    expect(f).not.toHaveBeenCalled()
  })

  it('rejects an allowedHosts entry whose TLD is numeric even if other labels have letters', async () => {
    await expect(
      boundedFetchText(U, { allowedHosts: ['api.example.123'], minGapMs: 0 }),
    ).rejects.toThrow(/invalid allowedHosts/)
  })

  it('follows a redirect that has no body', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(nullBody(302, { location: '/r' }))
        .mockResolvedValueOnce(resp('ok', { status: 200, url: 'https://api.example.test/r' })),
    )
    await expect(boundedFetchText(U, o)).resolves.toBe('ok')
  })

  it('maps 403 / 429 / 500 / foreign-url / oversized responses even when the body is null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(nullBody(403)))
    await expect(boundedFetchText(U, o)).rejects.toBeInstanceOf(SourceBlockedError)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(nullBody(429)))
    await expect(boundedFetchText(U, o)).rejects.toBeInstanceOf(SourceRateLimitedError)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(nullBody(500)))
    await expect(boundedFetchText(U, o)).rejects.toThrow('api.example.test responded 500')
    const foreign = nullBody(200)
    Object.defineProperty(foreign, 'url', { value: 'https://evil.test/x' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(foreign))
    await expect(boundedFetchText(U, o)).rejects.toThrow('host not allowed')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(nullBody(200, { 'content-length': '999' })),
    )
    await expect(boundedFetchText(U, { ...o, maxBytes: 100 })).rejects.toThrow(/too large/)
  })

  it('accepts a declared content-length equal to maxBytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          resp('x', { status: 200, url: U, headers: { 'content-length': '1000' } }),
        ),
    )
    await expect(boundedFetchText(U, { ...o, maxBytes: 1000 })).resolves.toBe('x')
  })

  it('puts host, status and a stable name on the typed source errors', () => {
    const blocked = new SourceBlockedError('h.test', 403)
    expect(blocked.name).toBe('SourceBlockedError')
    expect(blocked.message).toContain('h.test')
    expect(blocked.message).toContain('403')
    const limited = new SourceRateLimitedError('h.test')
    expect(limited.name).toBe('SourceRateLimitedError')
    expect(limited.message).toContain('h.test')
    expect(limited.message).toContain('429')
  })
})

/**
 * Task 3.5b: the per-request byte cap (`FetchRequest.maxBytes`). A resource bound, so every case
 * comes in pairs - AT the cap accepted, one byte PAST it refused - on BOTH refusal paths (the
 * declared `content-length` and the streamed body), and every refusal is asserted to return
 * nothing. Sizes are literals.
 */
describe('a request-declared byte cap', () => {
  const U = 'https://api.example.test/x'
  const o = { allowedHosts: hosts, minGapMs: 0 }
  const stub = (body: string, headers: Record<string, string> = {}) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(resp(body, { status: 200, url: U, headers })),
    )
  const via = (request: Parameters<typeof transportOptionsFor>[0]) =>
    boundedFetchText(U, { ...o, ...transportOptionsFor(request) })

  it('the transport default is 2 MiB and the ceiling 10 MiB', () => {
    expect(DEFAULT_MAX_BYTES).toBe(2_097_152)
    expect(MAX_RESPONSE_BYTES_CEILING).toBe(10_485_760)
  })

  it('a body AT the declared cap (3000 of 3000) is accepted whole', async () => {
    stub('x'.repeat(3000))
    await expect(via({ url: U, maxBytes: 3000 })).resolves.toBe('x'.repeat(3000))
  })

  it('a body past the default but AT a larger declared cap is accepted whole (2 MiB + 1)', async () => {
    const size = DEFAULT_MAX_BYTES + 1
    stub('x'.repeat(size))
    expect((await via({ url: U, maxBytes: size })).length).toBe(2_097_153)
  })

  it('one byte PAST the declared cap (3001 of 3000) is refused as PAYLOAD_TOO_LARGE and nothing is returned', async () => {
    stub('x'.repeat(3001))
    const outcome = await via({ url: U, maxBytes: 3000 }).then(
      (text) => `returned ${text.length} bytes`,
      (e: unknown) => e,
    )
    expect(outcome).toBeInstanceOf(SourcePayloadTooLargeError)
    expect((outcome as SourcePayloadTooLargeError).maxBytes).toBe(3000)
    expect((outcome as SourcePayloadTooLargeError).host).toBe('api.example.test')
    expect((outcome as Error).message).toBe(
      'api.example.test response too large: exceeded 3000 bytes',
    )
  })

  it('a declared content-length AT the cap passes the pre-check; one PAST it is refused', async () => {
    stub('x', { 'content-length': '3000' })
    await expect(via({ url: U, maxBytes: 3000 })).resolves.toBe('x')
    stub('x', { 'content-length': '3001' })
    const error = await via({ url: U, maxBytes: 3000 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SourcePayloadTooLargeError)
    expect((error as Error).message).toBe(
      'api.example.test response too large: content-length 3001 > 3000',
    )
  })

  it('a request that declares no cap is still bounded at 2 MiB: AT accepted, one byte PAST refused', async () => {
    stub('x'.repeat(DEFAULT_MAX_BYTES))
    expect((await via({ url: U })).length).toBe(2_097_152)
    stub('x'.repeat(DEFAULT_MAX_BYTES + 1))
    await expect(via({ url: U })).rejects.toBeInstanceOf(SourcePayloadTooLargeError)
  })

  it('a declared cap ABOVE the ceiling is refused before any request; the ceiling itself is accepted', async () => {
    const f = vi.fn().mockResolvedValue(resp('x', { status: 200, url: U }))
    vi.stubGlobal('fetch', f)
    await expect(via({ url: U, maxBytes: MAX_RESPONSE_BYTES_CEILING + 1 })).rejects.toThrow(
      'invalid maxBytes: 10485761 (must be 1..10485760)',
    )
    expect(f).not.toHaveBeenCalled()
    await expect(via({ url: U, maxBytes: MAX_RESPONSE_BYTES_CEILING })).resolves.toBe('x')
  })

  it('a body larger than the default but within a declared 8 MB cap is accepted (the Greenhouse case)', async () => {
    stub('x'.repeat(8_000_000))
    expect((await via({ url: U, maxBytes: 8_000_000 })).length).toBe(8_000_000)
  })
})

describe('transportOptionsFor', () => {
  it('passes the cap through when declared, and nothing when not', () => {
    expect(transportOptionsFor({ url: 'https://a.test/x', maxBytes: 5 })).toEqual({ maxBytes: 5 })
    expect(Object.keys(transportOptionsFor({ url: 'https://a.test/x' }))).toEqual([])
  })

  it('carries method, headers (copied) and body as they were', () => {
    const headers = { accept: 'application/json' }
    const out = transportOptionsFor({
      url: 'https://a.test/x',
      method: 'POST',
      body: '{}',
      headers,
    })
    expect(out).toEqual({ method: 'POST', body: '{}', headers: { accept: 'application/json' } })
    expect(out.headers).not.toBe(headers)
  })
})

/**
 * Task 2.5 T6: the transport surfaces the HTTP status. A refusal (401 / 403 / 451, 429) is a typed
 * error carrying the raw `Retry-After`; any other non-2xx is a typed status error, so the context
 * can hand the status to the adapter (a detail 404 is an answer) instead of a network failure.
 */
describe('T6: typed statuses and Retry-After', () => {
  const U = 'https://api.example.test/x'
  const o = { allowedHosts: hosts, minGapMs: 0 }
  const answer = (status: number, headers: Record<string, string> = {}) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(resp('secret error body', { status, url: U, headers })),
    )
  const failure = () => boundedFetchText(U, o).catch((e: unknown) => e)

  it.each([401, 403, 451])(
    'HTTP %i is a SourceBlockedError carrying its status',
    async (status) => {
      answer(status)
      const error = await failure()
      expect(error).toBeInstanceOf(SourceBlockedError)
      expect((error as SourceBlockedError).status).toBe(status)
      expect((error as SourceBlockedError).host).toBe('api.example.test')
      expect((error as SourceBlockedError).retryAfter).toBeNull()
    },
  )

  it('a refusal carries the raw Retry-After, in delay and in HTTP-date form', async () => {
    answer(429, { 'retry-after': '7200' })
    expect(((await failure()) as SourceRateLimitedError).retryAfter).toBe('7200')
    answer(451, { 'retry-after': 'Wed, 28 Oct 2026 08:49:37 GMT' })
    expect(((await failure()) as SourceBlockedError).retryAfter).toBe(
      'Wed, 28 Oct 2026 08:49:37 GMT',
    )
    answer(429)
    expect(((await failure()) as SourceRateLimitedError).retryAfter).toBeNull()
  })

  it.each([400, 404, 410, 500, 503])(
    'HTTP %i is a SourceHttpStatusError with the status and no body',
    async (status) => {
      answer(status)
      const error = await failure()
      expect(error).toBeInstanceOf(SourceHttpStatusError)
      expect((error as SourceHttpStatusError).status).toBe(status)
      expect((error as SourceHttpStatusError).host).toBe('api.example.test')
      expect((error as Error).message).toBe(`api.example.test responded ${status}`)
      expect((error as Error).name).toBe('SourceHttpStatusError')
    },
  )

  it('a 2xx other than 200 is still a body, not a status error', async () => {
    answer(203)
    await expect(boundedFetchText(U, o)).resolves.toBe('secret error body')
  })
})
