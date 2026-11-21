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

  // ADR §5.4: each of these decides what happens to the record, so none may be flattened.
  it.each(['NOT_CONFIGURED', 'PROVIDER_ERROR', 'INVALID_OUTPUT', 'TIMEOUT', 'LIMITS_EXHAUSTED'])(
    'a worker failure code %s passes through bare',
    async (code) => {
      const { port } = setup(fakeFetch(async () => reply({ ok: false, code })))
      expect(await port.extract(request())).toEqual({ ok: false, code })
    },
  )

  it('RATE_LIMITED, which §5.4 has no row for, is PROVIDER_ERROR', async () => {
    const { port, replies } = setup(
      fakeFetch(async () => reply({ ok: false, code: 'RATE_LIMITED' })),
    )
    expect(await port.extract(request())).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
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
    // H.6: localMs is withdrawn and a failure carries no usage at all.
    [
      'a failure carrying usage',
      reply({ ok: false, code: 'INVALID_OUTPUT', usage: { localMs: 4 } }),
    ],
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

describe('extraction-worker adapter — readiness preflight (ADR §5.3, H.3)', () => {
  const answer = (readiness: unknown, extra: object = {}) => ({
    status: 200,
    text: JSON.stringify({ readiness, events: [], health: HEALTH, ...extra }),
  })

  it('posts no body to /preflight with the same auth, and reports the readiness', async () => {
    const f = fakeFetch(async () => answer('READY'))
    const { port } = setup(f)
    expect(await port.preflight()).toEqual({ readiness: 'READY' })
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

  it.each(['READY', 'LIMITS_EXHAUSTED', 'NO_ROUTE'])('passes %s through', async (readiness) => {
    const { port } = setup(fakeFetch(async () => answer(readiness)))
    expect(await port.preflight()).toEqual({ readiness })
  })

  it('hands its events and health to onReply, whatever the readiness', async () => {
    const health = { modelListStale: true, failedJobs: ['chain'] }
    const f = fakeFetch(async () => answer('LIMITS_EXHAUSTED', { health }))
    const { port, replies } = setup(f)
    expect(await port.preflight()).toEqual({ readiness: 'LIMITS_EXHAUSTED' })
    expect(replies).toEqual([{ events: [], health }])
  })

  it.each([401, 403, 429, 500])('a %i is unreachable and carries its status', async (status) => {
    const { port } = setup(fakeFetch(async () => ({ status, text: 'a body that stays out' })))
    expect(await port.preflight()).toEqual({ readiness: 'UNREACHABLE', status })
  })

  it.each([
    [
      'a worker error',
      { status: 500, text: JSON.stringify({ readiness: 'READY', events: [], health: HEALTH }) },
    ],
    ['a non-JSON body', { status: 200, text: 'not json' }],
    ['an extract-shaped reply', reply({ ok: true, data: {} })],
    // Version skew (H.3): an H1 worker answers `{ ok }`, which this schema refuses.
    [
      'an H1 worker reply { ok: true }',
      { status: 200, text: JSON.stringify({ ok: true, events: [], health: HEALTH }) },
    ],
    [
      'an H1 worker reply { ok: false }',
      { status: 200, text: JSON.stringify({ ok: false, events: [], health: HEALTH }) },
    ],
    ['both keys', answer('READY', { ok: true })],
    ['an unknown readiness', answer('ALMOST')],
    ['a lower-case readiness', answer('ready')],
    ['a foreign field', answer('READY', { text: 'page' })],
    ['too many events', answer('READY', { events: Array(101).fill({ type: 'X' }) })],
  ])('%s is unreachable and records nothing', async (_name, res) => {
    const { port, replies } = setup(fakeFetch(async () => res))
    expect(await port.preflight()).toEqual({ readiness: 'UNREACHABLE', status: res.status })
    expect(replies).toEqual([])
  })

  it('a transport failure has no status, is unreachable and never throws', async () => {
    const { port } = setup(
      fakeFetch(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    await expect(port.preflight()).resolves.toStrictEqual({ readiness: 'UNREACHABLE' })
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
      fetchImpl: fakeFetch(async () => answer('READY')),
    })
    await expect(port.preflight()).resolves.toEqual({ readiness: 'READY' })
  })

  it('runs on its own bounded timeout of ten seconds, not the extract one', async () => {
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
      await vi.advanceTimersByTimeAsync(9_999)
      expect(f.sent[0]?.init?.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(answered).resolves.toStrictEqual({ readiness: 'UNREACHABLE' })
      expect(PREFLIGHT_TIMEOUT_MS).toBe(10_000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('version skew between an H1 and an H2 side fails closed (H.3)', () => {
  // The H1 envelopes as they shipped (5.4c-H1, PR #1381), pinned here: an H1 API parses with these.
  const H1_REPORT = {
    events: z.array(z.looseObject({ type: z.string() })).max(100),
    health: z
      .object({ modelListStale: z.boolean(), failedJobs: z.array(z.enum(['daily', 'chain'])) })
      .strict(),
  }
  const H1_PREFLIGHT = z.object({ ...H1_REPORT, ok: z.boolean() }).strict()
  const H1_CODES = ['NOT_CONFIGURED', 'PROVIDER_ERROR', 'INVALID_OUTPUT', 'RATE_LIMITED', 'TIMEOUT']
  const H1_EXTRACT = z
    .object({
      ...H1_REPORT,
      result: z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
        z.object({ ok: z.literal(false), code: z.enum(H1_CODES) }).strict(),
      ]),
    })
    .strict()

  it('an H1 API refuses an H2 readiness reply: its preflight is not reached (MODEL_UNREACHABLE)', () => {
    for (const readiness of ['READY', 'LIMITS_EXHAUSTED', 'NO_ROUTE']) {
      expect(H1_PREFLIGHT.safeParse({ readiness, events: [], health: HEALTH }).success).toBe(false)
    }
  })

  it('an H1 API refuses an H2 LIMITS_EXHAUSTED extract reply instead of misreading it', () => {
    const h2 = { result: { ok: false, code: 'LIMITS_EXHAUSTED' }, events: [], health: HEALTH }
    expect(H1_EXTRACT.safeParse(h2).success).toBe(false)
  })

  it('an H2 API refuses an H1 preflight reply: unreachable', async () => {
    const h1 = { status: 200, text: JSON.stringify({ ok: true, events: [], health: HEALTH }) }
    const { port } = setup(fakeFetch(async () => h1))
    expect(await port.preflight()).toEqual({ readiness: 'UNREACHABLE', status: 200 })
  })
})

describe('createExtractionWorkerTransport — route allow-list (SR-M-1)', () => {
  const BASE = 'http://crm-extraction-worker:3100'

  it.each([
    '/extract',
    '/preflight',
    '/resume-write',
    '/visual-check',
    '/classify-roles',
    '/resume-tailor',
  ] as const)('%s is sent to the worker with the secret', async (route) => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve({ status: 200, body: null, text: () => Promise.resolve('{}') }),
    )
    const post = createExtractionWorkerTransport({ baseUrl: BASE, secret: SECRET, fetchImpl })
    const res = await post(route, { body: '{}', timeoutMs: 1000 })
    expect(res.kind).toBe('ok')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(BASE + route)
    expect(fetchImpl.mock.calls[0]?.[1]?.headers?.authorization).toBe(`Bearer ${SECRET}`)
  })

  // Senior roles PR 3: the classify route is reachable, its look-alikes are not.
  it.each([
    '/admin',
    '/extract/../admin',
    '',
    '/EXTRACT',
    '//evil.example/x',
    '/classify-roles/',
    '/classify-role',
    '/resume-tailor/',
    '/resume-tailo',
  ])('route %j is refused without a request', async (route) => {
    const fetchImpl = vi.fn<FetchLike>()
    const post = createExtractionWorkerTransport({ baseUrl: BASE, secret: SECRET, fetchImpl })
    await expect(
      post(route as ExtractionWorkerRoute, { body: '{}', timeoutMs: 1000 }),
    ).resolves.toEqual({ kind: 'transport' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
