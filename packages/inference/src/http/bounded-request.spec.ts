import { describe, expect, it } from 'vitest'
import {
  boundedRequest,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
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
    expect(await boundedRequest({ ...base, fetchImpl: f })).toEqual({
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
