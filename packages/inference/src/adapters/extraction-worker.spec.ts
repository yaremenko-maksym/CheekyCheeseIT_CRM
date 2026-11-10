import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ExtractionRequest } from '../contracts/extraction'
import type { FetchLike } from '../http/bounded-request'
import {
  createExtractionWorkerAdapter,
  createExtractionWorkerTransport,
  PREFLIGHT_TIMEOUT_MS,
  type ExtractionWorkerReply,
  type ExtractionWorkerRoute,
} from './extraction-worker'

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

  // ADR §5.4: each of these decides what happens to the record, so none may be flattened.
  it.each(['NOT_CONFIGURED', 'PROVIDER_ERROR', 'INVALID_OUTPUT', 'TIMEOUT'])(
    'a worker failure code %s passes through bare',
    async (code) => {
      const { port } = setup(fakeFetch(async () => reply({ ok: false, code })))
      expect(await port.extract(request())).toEqual({ ok: false, code })
    },
  )

  it('RATE_LIMITED, which §5.4 has no row for, is PROVIDER_ERROR and keeps its usage', async () => {
    const { port, replies } = setup(
      fakeFetch(async () => reply({ ok: false, code: 'RATE_LIMITED', usage: { localMs: 4 } })),
    )
    expect(await port.extract(request())).toEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
      usage: { localMs: 4 },
    })
    expect(replies).toHaveLength(1)
  })

  it.each([
    ['fails the caller schema', { title: 1 }],
    ['has a foreign key', { title: 't', x: 1 }],
  ])(
    'data that %s is PROVIDER_ERROR, its events and health still recorded',
    async (_name, data) => {
      const { port, replies } = setup(fakeFetch(async () => reply({ ok: true, data })))
      expect(await port.extract(request())).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
      expect(replies).toEqual([{ events: [{ type: 'CALL', code: 'OK' }], health: HEALTH }])
    },
  )

  it('raised health flags reach the caller', async () => {
    const health = { modelListStale: true, failedJobs: ['daily', 'chain'] }
    const { port, replies } = setup(
      fakeFetch(async () => reply({ ok: false, code: 'TIMEOUT' }, { health })),
    )
    await port.extract(request())
    expect(replies[0]?.health).toEqual(health)
  })
})

describe('extraction-worker adapter — images do not cross /extract', () => {
  it('a request with images is NOT_CONFIGURED and reaches no worker', async () => {
    const f = fakeFetch(async () => reply({ ok: true, data: { title: 't' } }))
    const { port } = setup(f)
    expect(await port.extract(request({ images: ['iVBORw0KGgo='] }))).toEqual({
      ok: false,
      code: 'NOT_CONFIGURED',
    })
    expect(f.sent).toHaveLength(0)
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

describe('extraction-worker adapter — preflight (ADR §5.3)', () => {
  const answer = (ok: unknown, extra: object = {}) => ({
    status: 200,
    text: JSON.stringify({ ok, events: [{ type: 'CALL', code: 'OK' }], health: HEALTH, ...extra }),
  })

  it('posts no body to /preflight with the same auth, and reports reached', async () => {
    const f = fakeFetch(async () => answer(true))
    const { port } = setup(f)
    expect(await port.preflight()).toEqual({ reached: true })
    expect(f.sent).toHaveLength(1)
    const sent = f.sent[0]!
    expect(sent.url).toBe('http://crm-extraction-worker:3100/preflight')
    expect(sent.init?.method).toBe('POST')
    expect(sent.init?.headers).toEqual({
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/json',
    })
    expect(sent.init?.body).toBeUndefined()
  })

  it('hands its events and health to onReply, whatever the model answered', async () => {
    const health = { modelListStale: true, failedJobs: ['chain'] }
    const f = fakeFetch(async () => answer(false, { health }))
    const { port, replies } = setup(f)
    expect(await port.preflight()).toEqual({ reached: false, status: 200 })
    expect(replies).toEqual([{ events: [{ type: 'CALL', code: 'OK' }], health }])
  })

  it.each([401, 403, 429, 500])('a %i is not reached and carries its status', async (status) => {
    const { port } = setup(fakeFetch(async () => ({ status, text: 'a body that stays out' })))
    expect(await port.preflight()).toEqual({ reached: false, status })
  })

  it.each([
    [
      'a worker error',
      { status: 500, text: JSON.stringify({ ok: true, events: [], health: HEALTH }) },
    ],
    ['a non-JSON body', { status: 200, text: 'not json' }],
    ['an extract-shaped reply', reply({ ok: true, data: {} })],
    ['a non-boolean ok', answer('true')],
    ['a foreign field', answer(true, { text: 'page' })],
    ['too many events', answer(true, { events: Array(101).fill({ type: 'X' }) })],
  ])('%s is not reached and records nothing', async (_name, res) => {
    const { port, replies } = setup(fakeFetch(async () => res))
    expect(await port.preflight()).toEqual({ reached: false, status: res.status })
    expect(replies).toEqual([])
  })

  it('a transport failure has no status, is not reached and never throws', async () => {
    const { port } = setup(
      fakeFetch(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    await expect(port.preflight()).resolves.toStrictEqual({ reached: false })
  })

  it('a throwing onReply does not change the answer', async () => {
    const port = createExtractionWorkerAdapter({
      baseUrl: 'http://crm-extraction-worker:3100',
      secret: SECRET,
      tableVersion: 'tv-1',
      timeoutMs: 1000,
      onReply: () => {
        throw new Error('sink')
      },
      fetchImpl: fakeFetch(async () => answer(true)),
    })
    await expect(port.preflight()).resolves.toEqual({ reached: true })
  })

  it('runs on its own bounded timeout of two minutes, not the extract one', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeFetch(
        (s) =>
          new Promise((_resolve, reject) => {
            s.init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      )
      const port = createExtractionWorkerAdapter({
        baseUrl: 'http://crm-extraction-worker:3100',
        secret: SECRET,
        tableVersion: 'tv-1',
        timeoutMs: 3_600_000,
        onReply: () => undefined,
        fetchImpl: f,
      })
      const answered = port.preflight()
      await vi.advanceTimersByTimeAsync(119_999)
      expect(f.sent[0]?.init?.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(answered).resolves.toStrictEqual({ reached: false })
      expect(PREFLIGHT_TIMEOUT_MS).toBe(120_000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createExtractionWorkerTransport — route allow-list (SR-M-1)', () => {
  const BASE = 'http://crm-extraction-worker:3100'

  it.each(['/extract', '/preflight', '/resume-write', '/visual-check'] as const)(
    '%s is sent to the worker with the secret',
    async (route) => {
      const fetchImpl = vi.fn<FetchLike>(() =>
        Promise.resolve({ status: 200, body: null, text: () => Promise.resolve('{}') }),
      )
      const post = createExtractionWorkerTransport({ baseUrl: BASE, secret: SECRET, fetchImpl })
      const res = await post(route, { body: '{}', timeoutMs: 1000 })
      expect(res.kind).toBe('ok')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(BASE + route)
      expect(fetchImpl.mock.calls[0]?.[1]?.headers?.authorization).toBe(`Bearer ${SECRET}`)
    },
  )

  it.each(['/admin', '/extract/../admin', '', '/EXTRACT', '//evil.example/x'])(
    'route %j is refused without a request',
    async (route) => {
      const fetchImpl = vi.fn<FetchLike>()
      const post = createExtractionWorkerTransport({ baseUrl: BASE, secret: SECRET, fetchImpl })
      await expect(
        post(route as ExtractionWorkerRoute, { body: '{}', timeoutMs: 1000 }),
      ).resolves.toEqual({ kind: 'transport' })
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )
})
