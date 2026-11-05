import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ExtractionRequest } from '../contracts/extraction'
import type { FetchLike } from '../http/bounded-request'
import { createExtractionWorkerAdapter, type ExtractionWorkerReply } from './extraction-worker'

const SECRET = 'SECRET-MARKER-0123456789abcdef-0123456789'
const schema = z.object({ title: z.string() }).strict()
const HEALTH = { modelListStale: false, failedJobs: [] }

type Sent = { url: string; init: Parameters<FetchLike>[1] }

function fakeFetch(
  respond: (sent: Sent) => Promise<{ status: number; text: string }> | never,
): FetchLike & { sent: Sent[] } {
  const sent: Sent[] = []
  const f = async (url: string, init?: Parameters<FetchLike>[1]) => {
    const s = { url, init }
    sent.push(s)
    const r = await respond(s)
    return { status: r.status, body: null, text: async () => r.text }
  }
  return Object.assign(f, { sent })
}

const reply = (result: unknown, extra: object = {}) => ({
  status: 200,
  text: JSON.stringify({
    result,
    events: [{ type: 'CALL', code: 'OK' }],
    health: HEALTH,
    ...extra,
  }),
})

function setup(fetchImpl: FetchLike) {
  const replies: ExtractionWorkerReply[] = []
  const port = createExtractionWorkerAdapter({
    baseUrl: 'http://crm-extraction-worker:3100',
    secret: SECRET,
    tableVersion: 'tv-1',
    timeoutMs: 1000,
    onReply: (r) => replies.push(r),
    fetchImpl,
  })
  return { port, replies }
}

const request = (extra: Partial<ExtractionRequest<{ title: string }>> = {}) => ({
  input: 'page text',
  instruction: 'caller instruction never crosses',
  schema,
  ...extra,
})

describe('extraction-worker adapter — what crosses', () => {
  it('sends only the input and the table version, with the secret as a bearer', async () => {
    const f = fakeFetch(async () =>
      reply({ ok: true, data: { title: 't' }, usage: { totalTokens: 3 } }),
    )
    const { port, replies } = setup(f)
    const r = await port.extract(request())
    expect(r).toEqual({ ok: true, data: { title: 't' }, usage: { totalTokens: 3 } })
    expect(f.sent).toHaveLength(1)
    const sent = f.sent[0]!
    expect(sent.url).toBe('http://crm-extraction-worker:3100/extract')
    expect(sent.init?.method).toBe('POST')
    expect(sent.init?.headers).toEqual({
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/json',
    })
    expect(JSON.parse(sent.init?.body ?? '')).toEqual({ input: 'page text', tableVersion: 'tv-1' })
    expect(replies).toEqual([{ events: [{ type: 'CALL', code: 'OK' }], health: HEALTH }])
  })

  it('an answer without usage passes through without usage', async () => {
    const { port } = setup(fakeFetch(async () => reply({ ok: true, data: { title: 't' } })))
    expect(await port.extract(request())).toEqual({ ok: true, data: { title: 't' } })
  })

  it('a worker failure code passes through with its usage', async () => {
    const f = fakeFetch(async () =>
      reply({ ok: false, code: 'INVALID_OUTPUT', usage: { localMs: 4 } }),
    )
    const { port, replies } = setup(f)
    expect(await port.extract(request())).toEqual({
      ok: false,
      code: 'INVALID_OUTPUT',
      usage: { localMs: 4 },
    })
    expect(replies).toHaveLength(1)
  })

  it('a worker failure code without usage passes through bare', async () => {
    const { port } = setup(fakeFetch(async () => reply({ ok: false, code: 'RATE_LIMITED' })))
    expect(await port.extract(request())).toEqual({ ok: false, code: 'RATE_LIMITED' })
  })

  it('raised health flags reach the caller', async () => {
    const health = { modelListStale: true, failedJobs: ['daily', 'chain'] }
    const { port, replies } = setup(
      fakeFetch(async () => reply({ ok: false, code: 'TIMEOUT' }, { health })),
    )
    await port.extract(request())
    expect(replies[0]?.health).toEqual(health)
  })
})

describe('extraction-worker adapter — every refused, failed or malformed reply is PROVIDER_ERROR', () => {
  const PROVIDER_ERROR = { ok: false, code: 'PROVIDER_ERROR' }
  it.each([
    ['401 refused', { status: 401, text: '{"error":"UNAUTHORIZED"}' }],
    ['409 version mismatch', { status: 409, text: '{"error":"TABLE_VERSION_MISMATCH"}' }],
    ['500', { status: 500, text: '{"error":"INTERNAL"}' }],
    [
      '500 with a well-formed reply body',
      { ...reply({ ok: true, data: { title: 't' } }), status: 500 },
    ],
    [
      '429 with a well-formed reply body',
      { ...reply({ ok: true, data: { title: 't' } }), status: 429 },
    ],
    ['not JSON', { status: 200, text: '{"result":' }],
    ['no result', { status: 200, text: JSON.stringify({ events: [], health: HEALTH }) }],
    ['data fails the caller schema', reply({ ok: true, data: { title: 1 } })],
    ['data has a foreign key', reply({ ok: true, data: { title: 't', x: 1 } })],
    ['negative usage', reply({ ok: true, data: { title: 't' }, usage: { totalTokens: -1 } })],
    ['foreign usage key', reply({ ok: true, data: { title: 't' }, usage: { cost: 1 } })],
    ['unknown failure code', reply({ ok: false, code: 'SOMETHING' })],
    [
      'no events',
      {
        status: 200,
        text: JSON.stringify({ result: { ok: false, code: 'TIMEOUT' }, health: HEALTH }),
      },
    ],
    ['an event without a type', reply({ ok: false, code: 'TIMEOUT' }, { events: [{}] })],
    [
      'too many events',
      reply({ ok: false, code: 'TIMEOUT' }, { events: Array(101).fill({ type: 'X' }) }),
    ],
    [
      'malformed health',
      reply({ ok: false, code: 'TIMEOUT' }, { health: { modelListStale: 'no' } }),
    ],
    [
      'a foreign health key',
      reply({ ok: false, code: 'TIMEOUT' }, { health: { ...HEALTH, x: 1 } }),
    ],
    [
      'an unknown failed job',
      reply({ ok: false, code: 'TIMEOUT' }, { health: { ...HEALTH, failedJobs: ['x'] } }),
    ],
    ['a foreign top-level key', reply({ ok: false, code: 'TIMEOUT' }, { echo: 'x' })],
  ])('%s', async (_name, response) => {
    const { port, replies } = setup(fakeFetch(async () => response))
    expect(await port.extract(request())).toEqual(PROVIDER_ERROR)
    expect(replies).toHaveLength(0)
  })

  it('a transport failure', async () => {
    const { port } = setup(
      fakeFetch(async () => {
        throw new Error(`down ${SECRET}`)
      }),
    )
    expect(await port.extract(request())).toEqual(PROVIDER_ERROR)
  })

  it('a timer timeout', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeFetch(
        (s) =>
          new Promise((_, reject) =>
            s.init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      )
      const { port } = setup(f)
      const pending = port.extract(request())
      await vi.advanceTimersByTimeAsync(1000)
      expect(await pending).toEqual(PROVIDER_ERROR)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a callback that throws does not turn an answer into a throw', async () => {
    const port = createExtractionWorkerAdapter({
      baseUrl: 'http://crm-extraction-worker:3100',
      secret: SECRET,
      tableVersion: 'tv-1',
      timeoutMs: 1000,
      onReply: () => {
        throw new Error('sink down')
      },
      fetchImpl: fakeFetch(async () => reply({ ok: true, data: { title: 't' } })),
    })
    expect(await port.extract(request())).toEqual({ ok: true, data: { title: 't' } })
  })

  it('a base URL outside the allow-policy sends nothing', async () => {
    const f = fakeFetch(async () => reply({ ok: true, data: { title: 't' } }))
    const port = createExtractionWorkerAdapter({
      baseUrl: 'http://example.test',
      secret: SECRET,
      tableVersion: 'tv-1',
      timeoutMs: 1000,
      onReply: () => undefined,
      fetchImpl: f,
    })
    expect(await port.extract(request())).toEqual(PROVIDER_ERROR)
    expect(f.sent).toHaveLength(0)
  })
})

describe('extraction-worker adapter — the abort signal closes the connection', () => {
  it('a caller abort aborts the request and answers TIMEOUT', async () => {
    let seen: AbortSignal | undefined
    const f = fakeFetch(
      (s) =>
        new Promise((_, reject) => {
          seen = s.init?.signal
          seen?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const { port } = setup(f)
    const controller = new AbortController()
    const pending = port.extract(request({ signal: controller.signal }))
    await vi.waitFor(() => expect(seen).toBeDefined())
    controller.abort()
    expect(await pending).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(seen?.aborted).toBe(true)
  })

  it('an already-aborted signal sends nothing', async () => {
    const f = fakeFetch(async () => reply({ ok: true, data: { title: 't' } }))
    const { port } = setup(f)
    const r = await port.extract(request({ signal: AbortSignal.abort() }))
    expect(r).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(f.sent).toHaveLength(0)
  })
})
