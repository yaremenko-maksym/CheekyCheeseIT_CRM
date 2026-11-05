import { describe, expect, it, vi } from 'vitest'
import {
  boundedRequest,
  boundedRequestToExtractionWorker,
  boundedRequestToLocalRuntime,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  EXTRACTION_WORKER_HOST,
  LOCAL_MODEL_RUNTIME_HOST,
  type FetchLike,
} from './bounded-request'

const okFetch: FetchLike = async () => ({ status: 200, body: null, text: async () => 'hello' })
const base = { url: 'https://api.test/x', timeoutMs: 1000, maxBytes: 1000 }

function streamOf(chunks: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]))
      else controller.close()
    },
    cancel() {
      onCancel?.()
    },
  })
}

describe('boundedRequest', () => {
  it('exposes defaults', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(60000)
    expect(DEFAULT_MAX_BYTES).toBe(2 * 1024 * 1024)
  })

  it('returns ok text on 200', async () => {
    expect(await boundedRequest({ ...base, fetchImpl: okFetch })).toEqual({
      kind: 'ok',
      status: 200,
      text: 'hello',
    })
  })

  it('reads a streamed body', async () => {
    const f: FetchLike = async () => ({
      status: 200,
      body: streamOf(['he', 'llo']),
      text: async () => 'unused',
    })
    expect(await boundedRequest({ ...base, fetchImpl: f })).toEqual({
      kind: 'ok',
      status: 200,
      text: 'hello',
    })
  })

  it('maps 429 to rate_limited', async () => {
    const f: FetchLike = async () => ({ status: 429, body: null, text: async () => '' })
    expect(await boundedRequest({ ...base, fetchImpl: f })).toEqual({
      kind: 'rate_limited',
      status: 429,
    })
  })

  it('maps an aborted/slow call to timeout', async () => {
    const f: FetchLike = (_u, init) =>
      new Promise((_res, rej) =>
        init?.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))),
      )
    expect((await boundedRequest({ ...base, timeoutMs: 5, fetchImpl: f })).kind).toBe('timeout')
  })

  it('maps a body that never completes to timeout', async () => {
    const f: FetchLike = async (_u, init) => ({
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('x', 'AbortError')),
          )
        },
      }),
      text: async () => '',
    })
    expect((await boundedRequest({ ...base, timeoutMs: 5, fetchImpl: f })).kind).toBe('timeout')
  })

  it('maps a thrown fetch to transport', async () => {
    const f: FetchLike = async () => {
      throw new Error('boom')
    }
    expect(await boundedRequest({ ...base, fetchImpl: f })).toEqual({ kind: 'transport' })
  })

  it('rejects http unless loopback is allowed and host is loopback', async () => {
    const httpUrl = 'http://api.test/x'
    expect((await boundedRequest({ ...base, url: httpUrl, fetchImpl: okFetch })).kind).toBe(
      'transport',
    )
    expect(
      (await boundedRequest({ ...base, url: httpUrl, allowLoopbackHttp: true, fetchImpl: okFetch }))
        .kind,
    ).toBe('transport')
    expect(
      (await boundedRequest({ ...base, url: 'http://localhost:11434/x', fetchImpl: okFetch })).kind,
    ).toBe('transport')
    for (const url of ['http://localhost:11434/x', 'http://127.0.0.1:1/x', 'http://[::1]:1/x']) {
      expect(
        (await boundedRequest({ ...base, url, allowLoopbackHttp: true, fetchImpl: okFetch })).kind,
      ).toBe('ok')
    }
  })

  it('rejects other schemes and malformed urls without calling fetch', async () => {
    let called = false
    const f: FetchLike = async () => {
      called = true
      return { status: 200, body: null, text: async () => '' }
    }
    expect((await boundedRequest({ ...base, url: 'ftp://x/y', fetchImpl: f })).kind).toBe(
      'transport',
    )
    expect((await boundedRequest({ ...base, url: 'not a url', fetchImpl: f })).kind).toBe(
      'transport',
    )
    expect(called).toBe(false)
  })

  it('returns transport with status and bounded body text on non-2xx', async () => {
    const f: FetchLike = async () => ({
      status: 404,
      body: null,
      text: async () => 'No endpoints found for model x',
    })
    expect(await boundedRequest({ ...base, fetchImpl: f })).toEqual({
      kind: 'transport',
      status: 404,
      text: 'No endpoints found for model x',
    })
  })

  it('bounds the error body too (status kept, oversize text dropped)', async () => {
    const f: FetchLike = async () => ({
      status: 500,
      body: streamOf(['x'.repeat(2000)]),
      text: async () => '',
    })
    expect(await boundedRequest({ ...base, fetchImpl: f })).toStrictEqual({
      kind: 'transport',
      status: 500,
    })
  })

  it('aborts and returns transport when a streamed body exceeds maxBytes', async () => {
    let cancelled = false
    const f: FetchLike = async () => ({
      status: 200,
      body: streamOf(['a'.repeat(600), 'b'.repeat(600), 'c'.repeat(600)], () => {
        cancelled = true
      }),
      text: async () => '',
    })
    const r = await boundedRequest({ ...base, maxBytes: 1000, fetchImpl: f })
    expect(r.kind).toBe('transport')
    expect(cancelled).toBe(true)
  })

  it('counts bytes, not characters', async () => {
    const f: FetchLike = async () => ({
      status: 200,
      body: streamOf(['é'.repeat(600)]), // 1200 bytes
      text: async () => '',
    })
    expect((await boundedRequest({ ...base, maxBytes: 1000, fetchImpl: f })).kind).toBe('transport')
  })

  it('passes method, headers, body and a signal to fetch', async () => {
    let seen: Parameters<FetchLike>[1]
    const f: FetchLike = async (_u, init) => {
      seen = init
      return { status: 200, body: null, text: async () => '' }
    }
    await boundedRequest({ ...base, method: 'POST', headers: { a: 'b' }, body: '{}', fetchImpl: f })
    expect(seen?.method).toBe('POST')
    expect(seen?.headers).toEqual({ a: 'b' })
    expect(seen?.body).toBe('{}')
    expect(seen?.signal).toBeInstanceOf(AbortSignal)
  })
})

const hangingFetch: FetchLike = (_u, init) =>
  new Promise((_res, rej) =>
    init?.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))),
  )

describe('boundedRequest caller signal (SR-L-38: an abort is not a timeout)', () => {
  it('cancels a request in flight and reports aborted, not a plain timeout', async () => {
    const ctrl = new AbortController()
    let seen: AbortSignal | undefined
    const f: FetchLike = (u, init) => {
      seen = init?.signal
      queueMicrotask(() => ctrl.abort())
      return hangingFetch(u, init)
    }
    expect(await boundedRequest({ ...base, signal: ctrl.signal, fetchImpl: f })).toEqual({
      kind: 'timeout',
      aborted: true,
    })
    expect(seen?.aborted).toBe(true)
  })

  it('sends nothing when the signal is already aborted', async () => {
    let called = false
    const f: FetchLike = async () => {
      called = true
      return { status: 200, body: null, text: async () => 'x' }
    }
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await boundedRequest({ ...base, signal: ctrl.signal, fetchImpl: f })).toEqual({
      kind: 'timeout',
      aborted: true,
    })
    expect(called).toBe(false)
  })

  it('reports an abort during the body read as aborted', async () => {
    const ctrl = new AbortController()
    const f: FetchLike = async () => ({
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start() {
          queueMicrotask(() => ctrl.abort())
        },
      }),
      text: async () => '',
    })
    expect(await boundedRequest({ ...base, signal: ctrl.signal, fetchImpl: f })).toEqual({
      kind: 'timeout',
      aborted: true,
    })
  })

  it('keeps the own timer a plain timeout while the caller signal stays open', async () => {
    const ctrl = new AbortController()
    expect(
      await boundedRequest({ ...base, timeoutMs: 5, signal: ctrl.signal, fetchImpl: hangingFetch }),
    ).toEqual({ kind: 'timeout' })
  })

  it('detaches its listener from the caller signal once settled', async () => {
    const ctrl = new AbortController()
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener')
    expect((await boundedRequest({ ...base, signal: ctrl.signal, fetchImpl: okFetch })).kind).toBe(
      'ok',
    )
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0]?.[0]).toBe('abort')
  })
})

describe('boundedRequest rate-limit details and oversize 2xx', () => {
  const headers = { get: (n: string) => (n === 'retry-after' ? '7' : null) }

  it('keeps the bounded 429 body and the headers only when asked', async () => {
    const f: FetchLike = async () => ({ status: 429, body: null, text: async () => '{}', headers })
    expect(
      await boundedRequest({ ...base, readRateLimitDetails: true, fetchImpl: f }),
    ).toStrictEqual({ kind: 'rate_limited', status: 429, text: '{}', headers })
    expect(await boundedRequest({ ...base, fetchImpl: f })).toStrictEqual({
      kind: 'rate_limited',
      status: 429,
    })
  })

  it('drops an oversize 429 body and absent headers', async () => {
    const f: FetchLike = async () => ({
      status: 429,
      body: streamOf(['x'.repeat(2000)]),
      text: async () => '',
    })
    expect(
      await boundedRequest({ ...base, readRateLimitDetails: true, fetchImpl: f }),
    ).toStrictEqual({ kind: 'rate_limited', status: 429 })
  })

  it('marks an oversize 2xx body as tooLarge', async () => {
    const f: FetchLike = async () => ({
      status: 200,
      body: streamOf(['x'.repeat(2000)]),
      text: async () => '',
    })
    expect(await boundedRequest({ ...base, fetchImpl: f })).toStrictEqual({
      kind: 'transport',
      status: 200,
      tooLarge: true,
    })
  })
})

describe('boundedRequestToExtractionWorker plain HTTP (ADR §2.4)', () => {
  const kindOf = async (send: typeof boundedRequest, url: string) =>
    (await send({ ...base, url, fetchImpl: okFetch })).kind

  it('names one constant host', () => {
    expect(EXTRACTION_WORKER_HOST).toBe('crm-extraction-worker')
  })

  it('reaches loopback or the worker host over HTTP, and HTTPS', async () => {
    for (const url of [
      'http://crm-extraction-worker:3100/extract',
      'http://localhost:3100/x',
      'http://127.0.0.1:3100/x',
      'https://elsewhere.test/x',
    ]) {
      expect(await kindOf(boundedRequestToExtractionWorker, url)).toBe('ok')
    }
  })

  it('refuses any other plain-HTTP host, including the model runtime', async () => {
    const fetchImpl = vi.fn(okFetch)
    for (const url of ['http://crm-model-runtime/x', 'http://example.test/x', 'ftp://localhost/x']) {
      const r = await boundedRequestToExtractionWorker({ ...base, url, fetchImpl })
      expect(r).toEqual({ kind: 'transport' })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('the public entry and the runtime entry never reach the worker host', async () => {
    const fetchImpl = vi.fn(okFetch)
    const url = 'http://crm-extraction-worker:3100/extract'
    for (const send of [boundedRequest, boundedRequestToLocalRuntime]) {
      expect(await send({ ...base, url, fetchImpl, allowLoopbackHttp: true })).toEqual({
        kind: 'transport',
      })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('boundedRequest local runtime plain HTTP (ADR §3.3)', () => {
  const run = async (url: string, opts: { local?: boolean; loopback?: boolean } = {}) =>
    (
      await (opts.local === true ? boundedRequestToLocalRuntime : boundedRequest)({
        ...base,
        url,
        ...(opts.loopback === true && { allowLoopbackHttp: true }),
        fetchImpl: okFetch,
      })
    ).kind

  it('public boundedRequest never reaches the runtime host, even with a stray flag (SR-M-64)', async () => {
    const fetchImpl = vi.fn(okFetch)
    const url = 'http://crm-model-runtime/x'
    expect(await boundedRequest({ ...base, url, fetchImpl })).toEqual({ kind: 'transport' })
    const stray = { ...base, url, fetchImpl, allowLocalRuntimeHttp: true } as never
    expect(await boundedRequest(stray)).toEqual({ kind: 'transport' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('public boundedRequest ignores a stray flag for loopback too (SR-M-64)', async () => {
    const fetchImpl = vi.fn(okFetch)
    const stray = { ...base, url: 'http://localhost/x', fetchImpl, allowLocalRuntimeHttp: true }
    expect(await boundedRequest(stray as never)).toEqual({ kind: 'transport' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('names one constant host', () => {
    expect(LOCAL_MODEL_RUNTIME_HOST).toBe('crm-model-runtime')
  })

  it('reaches only loopback or the constant host over HTTP', async () => {
    for (const url of [
      'http://crm-model-runtime:11434/v1/x',
      'http://localhost:11434/x',
      'http://127.0.0.1:8080/x',
      'http://[::1]:8080/x',
    ]) {
      expect(await run(url, { local: true })).toBe('ok')
    }
  })

  it('refuses private, link-local, IPv4-mapped and foreign hosts over HTTP', async () => {
    for (const url of [
      'http://10.0.0.5/x',
      'http://192.168.1.2/x',
      'http://172.16.0.1/x',
      'http://169.254.169.254/latest',
      'http://[fe80::1]/x',
      'http://[::ffff:127.0.0.1]/x',
      'http://127.0.0.2/x',
      'http://crm-model-runtime.example.com/x',
      'http://api.test/x',
    ]) {
      expect(await run(url, { local: true })).toBe('transport')
    }
  })

  it('does not widen allowLoopbackHttp to the constant host', async () => {
    expect(await run('http://crm-model-runtime:11434/x', { loopback: true })).toBe('transport')
    expect(await run('http://crm-model-runtime:11434/x')).toBe('transport')
  })
})

describe('boundedRequest body bounds and stream edges', () => {
  const fixed =
    (status: number, text: string): FetchLike =>
    async () => ({
      status,
      body: null,
      text: async () => text,
    })

  it('accepts a non-streamed body of exactly maxBytes and flags one byte more', async () => {
    expect(await boundedRequest({ ...base, maxBytes: 4, fetchImpl: fixed(200, 'abcd') })).toEqual({
      kind: 'ok',
      status: 200,
      text: 'abcd',
    })
    expect(
      await boundedRequest({ ...base, maxBytes: 4, fetchImpl: fixed(200, 'abcde') }),
    ).toStrictEqual({ kind: 'transport', status: 200, tooLarge: true })
  })

  it('accepts a streamed body of exactly maxBytes', async () => {
    const f: FetchLike = async () => ({
      status: 200,
      body: streamOf(['ab', 'cd']),
      text: async () => '',
    })
    expect((await boundedRequest({ ...base, maxBytes: 4, fetchImpl: f })).kind).toBe('ok')
  })

  it('decodes a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('é')
    let i = 0
    const f: FetchLike = async () => ({
      status: 200,
      body: new ReadableStream<Uint8Array>({
        pull(c) {
          if (i < bytes.length) c.enqueue(bytes.slice(i, ++i))
          else c.close()
        },
      }),
      text: async () => '',
    })
    expect(await boundedRequest({ ...base, fetchImpl: f })).toEqual({
      kind: 'ok',
      status: 200,
      text: 'é',
    })
  })

  it('keeps a streamed error body as text', async () => {
    const f: FetchLike = async () => ({
      status: 500,
      body: streamOf(['oops']),
      text: async () => '',
    })
    expect(await boundedRequest({ ...base, fetchImpl: f })).toEqual({
      kind: 'transport',
      status: 500,
      text: 'oops',
    })
  })

  it('treats 1xx and 300 as failure statuses', async () => {
    for (const status of [199, 300]) {
      expect((await boundedRequest({ ...base, fetchImpl: fixed(status, 'x') })).kind).toBe(
        'transport',
      )
    }
  })

  it('reads chunks that arrive later', async () => {
    const f: FetchLike = async () => ({
      status: 200,
      body: new ReadableStream<Uint8Array>({
        async pull(c) {
          await new Promise((r) => setTimeout(r, 1))
          c.enqueue(new TextEncoder().encode('late'))
          c.close()
        },
      }),
      text: async () => '',
    })
    expect(await boundedRequest({ ...base, fetchImpl: f })).toEqual({
      kind: 'ok',
      status: 200,
      text: 'late',
    })
  })

  it('stops and cancels a body that ignores the abort and never ends', async () => {
    let cancelled = false
    const f: FetchLike = async () => ({
      status: 200,
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        },
      }),
      text: async () => '',
    })
    expect(await boundedRequest({ ...base, timeoutMs: 5, fetchImpl: f })).toEqual({
      kind: 'timeout',
    })
    expect(cancelled).toBe(true)
  })

  it('stops reading when the timer fired before the response arrived', async () => {
    const f: FetchLike = () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({ status: 200, body: new ReadableStream<Uint8Array>(), text: async () => '' }),
          20,
        ),
      )
    expect(await boundedRequest({ ...base, timeoutMs: 5, fetchImpl: f })).toEqual({
      kind: 'timeout',
    })
  })

  it('sends only signal and redirect when no method, headers or body are given', async () => {
    let seen: Parameters<FetchLike>[1]
    const f: FetchLike = async (_u, init) => {
      seen = init
      return { status: 200, body: null, text: async () => '' }
    }
    await boundedRequest({ ...base, fetchImpl: f })
    expect(Object.keys(seen ?? {}).sort()).toEqual(['redirect', 'signal'])
  })

  it('refuses non-HTTP schemes to the constant host and loopback whatever the flags', async () => {
    for (const url of ['ftp://crm-model-runtime/x', 'ftp://localhost/x', 'ws://127.0.0.1/x']) {
      const r = await boundedRequestToLocalRuntime({
        ...base,
        url,
        allowLoopbackHttp: true,
        fetchImpl: okFetch,
      })
      expect(r.kind).toBe('transport')
    }
  })
})

describe('boundedRequest default transport (CO-L-6)', () => {
  it('calls the global fetch through a wrapper with the url and init', async () => {
    const calls: unknown[][] = []
    vi.stubGlobal('fetch', async (...args: unknown[]) => {
      calls.push(args)
      return { status: 200, body: null, text: async () => 'g' }
    })
    try {
      expect(await boundedRequest(base)).toEqual({ kind: 'ok', status: 200, text: 'g' })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.[0]).toBe(base.url)
      expect((calls[0]?.[1] as { redirect?: string }).redirect).toBe('error')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('boundedRequest redirects (SR-M-1)', () => {
  it('passes redirect: error to fetch', async () => {
    let seen: string | undefined
    const f: FetchLike = async (_url, init) => {
      seen = init?.redirect
      return { status: 200, body: null, text: async () => 'ok' }
    }
    await boundedRequest({ ...base, fetchImpl: f })
    expect(seen).toBe('error')
  })
  it('maps a redirect failure to transport', async () => {
    const f: FetchLike = async () => {
      throw new TypeError('fetch failed: redirect mode is set to error')
    }
    expect(await boundedRequest({ ...base, fetchImpl: f })).toEqual({ kind: 'transport' })
  })
})
