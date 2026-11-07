import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type ClientRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFileRouteStatePort,
  type ExtractionPort,
  type ExtractionRequest,
  type ExtractionResult,
  type RouteStatePort,
  type RouterEvent,
} from '@crm/inference'
import { afterEach, describe, expect, it } from 'vitest'
import { EXTRACTION_SYSTEM_PROMPT } from '../job-sourcing/structuring/prompt-envelope'
import { modelReplySchema } from '../job-sourcing/structuring/extraction-result-guard'
import { EXTRACTION_TABLE_VERSION } from './link-contract'
import { MAX_WORKER_INPUT_CHARS } from './schema'
import { buildExtractionWorker, type WorkerLogLine } from './server'

const SECRET = 'SECRET-MARKER-0123456789abcdef-0123456789'
const INPUT_MARKER = 'INPUT-MARKER-page-text'
const MODEL_MARKER = 'MODEL-MARKER-answer-text'

type Fake = ExtractionPort & {
  calls: ExtractionRequest<unknown>[]
  onEvent: (e: RouterEvent) => void
}

const OK_REPLY = {
  extractionVersion: 'v',
  records: [
    {
      externalId: null,
      title: MODEL_MARKER,
      company: null,
      location: null,
      remote: null,
      employmentType: null,
      salary: null,
      description: null,
      postedAt: null,
      postingUrl: null,
      applyUrl: null,
      evidence: [],
      uncertainty: 0.5,
    },
  ],
}

function fakePort(
  answer?: (req: ExtractionRequest<unknown>) => Promise<ExtractionResult<unknown>>,
): Fake {
  const fake: Fake = {
    calls: [],
    onEvent: () => undefined,
    async extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> {
      fake.calls.push(req as ExtractionRequest<unknown>)
      fake.onEvent({ type: 'CALL', code: 'OK', floorAnswered: false, latencyMs: 5 })
      const r = answer
        ? await answer(req as ExtractionRequest<unknown>)
        : { ok: true as const, data: OK_REPLY, usage: { totalTokens: 7 } }
      return r as ExtractionResult<T>
    },
  }
  return fake
}

async function stateFile(doc?: unknown): Promise<RouteStatePort> {
  const path = join(mkdtempSync(join(tmpdir(), 'xw-state-')), 'route-state.json')
  if (doc !== undefined) writeFileSync(path, JSON.stringify(doc))
  return createFileRouteStatePort({ path, now: Date.now, onEvent: () => undefined })
}

async function setup(opts: { extract?: Fake; preflight?: Fake; routeState?: RouteStatePort } = {}) {
  const extract = opts.extract ?? fakePort()
  const preflight = opts.preflight ?? fakePort()
  const routeState = opts.routeState ?? (await stateFile())
  const logs: WorkerLogLine[] = []
  const app = buildExtractionWorker({
    secret: SECRET,
    routeState,
    log: (l) => logs.push(l),
    buildPorts: (onEvent) => {
      extract.onEvent = onEvent
      preflight.onEvent = onEvent
      return { extract, preflight }
    },
  })
  return { app, extract, preflight, routeState, logs }
}

const auth = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }
const body = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    input: `page ${INPUT_MARKER}`,
    tableVersion: EXTRACTION_TABLE_VERSION,
    ...extra,
  })

let open: { close(): Promise<unknown> }[] = []
afterEach(async () => {
  await Promise.all(open.map((a) => a.close()))
  open = []
})

function track<T extends { close(): Promise<unknown> }>(a: T): T {
  open.push(a)
  return a
}

describe('extraction worker — refusals reach no route', () => {
  it.each([
    ['no secret', {}],
    ['wrong secret, same length', { authorization: `Bearer ${SECRET.replace('S', 'X')}` }],
    ['wrong secret, other length', { authorization: 'Bearer short' }],
    ['no bearer scheme', { authorization: SECRET }],
  ])('%s: 401 with a fixed body', async (_name, headers) => {
    const { app, extract, logs } = await setup()
    track(app)
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: { 'content-type': 'application/json', ...headers },
      payload: body(),
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'UNAUTHORIZED' })
    expect(extract.calls).toHaveLength(0)
    expect(logs).toEqual([{ event: 'REFUSED', status: 401 }])
  })

  it('an unauthenticated preflight reaches no route', async () => {
    const { app, preflight } = await setup()
    track(app)
    const res = await app.inject({ method: 'POST', url: '/preflight' })
    expect(res.statusCode).toBe(401)
    expect(preflight.calls).toHaveLength(0)
  })

  it.each([
    ['a foreign field', body({ model: 'x' })],
    ['an instruction', body({ instruction: 'x' })],
    ['a missing tableVersion', JSON.stringify({ input: 'x' })],
    ['an empty input', body({ input: '' })],
    ['an over-cap input', body({ input: 'a'.repeat(MAX_WORKER_INPUT_CHARS + 1) })],
    ['a non-object', '[]'],
    ['bad JSON', `{"input": "${INPUT_MARKER}"`],
    [
      'a __proto__ key',
      `{"__proto__":{"x":1},"input":"x","tableVersion":"${EXTRACTION_TABLE_VERSION}"}`,
    ],
    [
      'a constructor.prototype key',
      `{"constructor":{"prototype":{"x":1}},"input":"x","tableVersion":"${EXTRACTION_TABLE_VERSION}"}`,
    ],
  ])('%s: 400, zero requests', async (_name, payload) => {
    const { app, extract, logs } = await setup()
    track(app)
    const res = await app.inject({ method: 'POST', url: '/extract', headers: auth, payload })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'BAD_REQUEST' })
    expect(extract.calls).toHaveLength(0)
    expect(JSON.stringify(logs)).not.toContain(INPUT_MARKER)
  })

  it('an input at the cap is accepted', async () => {
    const { app, extract } = await setup()
    track(app)
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: auth,
      payload: body({ input: 'a'.repeat(MAX_WORKER_INPUT_CHARS) }),
    })
    expect(res.statusCode).toBe(200)
    expect(extract.calls).toHaveLength(1)
  })

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    'content type %s: 415, zero requests',
    async (type) => {
      const { app, extract } = await setup()
      track(app)
      const res = await app.inject({
        method: 'POST',
        url: '/extract',
        headers: { ...auth, 'content-type': type },
        payload: body(),
      })
      expect(res.statusCode).toBe(415)
      expect(res.json()).toEqual({ error: 'UNSUPPORTED_MEDIA_TYPE' })
      expect(extract.calls).toHaveLength(0)
    },
  )

  it('a table version mismatch: 409, zero requests', async () => {
    const { app, extract } = await setup()
    track(app)
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: auth,
      payload: body({ tableVersion: 'other-image' }),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'TABLE_VERSION_MISMATCH' })
    expect(extract.calls).toHaveLength(0)
  })

  it.each([
    ['GET', '/extract'],
    ['PUT', '/extract'],
    ['GET', '/preflight'],
    ['POST', '/health'],
    ['POST', '/extract/x'],
  ] as const)('%s %s: 404, zero requests', async (method, url) => {
    const { app, extract, preflight } = await setup()
    track(app)
    const res = await app.inject({ method, url, headers: auth, payload: body() })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'NOT_FOUND' })
    expect(extract.calls).toHaveLength(0)
    expect(preflight.calls).toHaveLength(0)
  })

  it.each([
    ['a field', JSON.stringify({ x: 1 })],
    ['an array', '[]'],
  ])('preflight with %s: 400, zero requests', async (_name, payload) => {
    const { app, preflight } = await setup()
    track(app)
    const res = await app.inject({ method: 'POST', url: '/preflight', headers: auth, payload })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'BAD_REQUEST' })
    expect(preflight.calls).toHaveLength(0)
  })
})

describe('extraction worker — the request is the worker’s own', () => {
  it('builds the request from its own prompt, schema and table; only the input crosses', async () => {
    const { app, extract } = await setup()
    track(app)
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: auth,
      payload: body(),
    })
    expect(res.statusCode).toBe(200)
    expect(extract.calls).toHaveLength(1)
    const req = extract.calls[0]!
    expect(req.input).toBe(`page ${INPUT_MARKER}`)
    expect(req.instruction).toBe(EXTRACTION_SYSTEM_PROMPT)
    expect(req.schema).toBe(modelReplySchema)
    expect(req.smallDose?.groups.map((g) => g.name)).toEqual([
      'identity',
      'place',
      'terms',
      'description',
    ])
    expect(req.signal).toBeInstanceOf(AbortSignal)
    expect(Object.keys(req).sort()).toEqual([
      'input',
      'instruction',
      'schema',
      'signal',
      'smallDose',
    ])
  })

  it('replies with the answer, usage, the call’s events and clear health flags', async () => {
    const { app, logs } = await setup()
    track(app)
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: auth,
      payload: body(),
    })
    expect(res.json()).toEqual({
      result: { ok: true, data: OK_REPLY, usage: { totalTokens: 7 } },
      events: [{ type: 'CALL', code: 'OK', floorAnswered: false, latencyMs: 5 }],
      health: { modelListStale: false, failedJobs: [] },
    })
    expect(logs).toEqual([
      { event: 'ROUTER', type: 'CALL', code: 'OK', floorAnswered: false, latencyMs: 5 },
    ])
  })

  it('a router event outside any call is logged, not lost and not thrown', async () => {
    const { app, extract, logs } = await setup()
    track(app)
    const late = { type: 'CALL', code: 'OK', floorAnswered: false, latencyMs: 1 } as const
    expect(() => extract.onEvent(late)).not.toThrow()
    expect(logs).toEqual([{ event: 'ROUTER', ...late }])
  })

  it('passes a failure code and its usage through', async () => {
    const extract = fakePort(async () => ({ ok: false, code: 'TIMEOUT', usage: { localMs: 9 } }))
    const { app } = await setup({ extract })
    track(app)
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: auth,
      payload: body(),
    })
    expect(res.json().result).toEqual({ ok: false, code: 'TIMEOUT', usage: { localMs: 9 } })
  })

  it('events of one call do not leak into another', async () => {
    const { app } = await setup()
    track(app)
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/extract', headers: auth, payload: body() }),
      app.inject({ method: 'POST', url: '/extract', headers: auth, payload: body() }),
    ])
    expect(a.json().events).toHaveLength(1)
    expect(b.json().events).toHaveLength(1)
  })
})

describe('extraction worker — second strip', () => {
  it('a contact reaches the route stripped and raises an event with no text', async () => {
    const { app, extract, logs } = await setup()
    track(app)
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: auth,
      payload: body({ input: `${INPUT_MARKER} write to jane.doe@example.com` }),
    })
    expect(extract.calls[0]!.input).toBe(`${INPUT_MARKER} write to [contact]`)
    const events = res.json().events as { type: string }[]
    expect(events[0]).toEqual({ type: 'INPUT_CONTACTS_STRIPPED', count: 1 })
    expect(JSON.stringify(events)).not.toContain('jane')
    expect(logs).toContainEqual({ event: 'INPUT_CONTACTS_STRIPPED', count: 1 })
    expect(JSON.stringify(logs)).not.toContain('jane')
  })

  it('an honest input raises no strip event', async () => {
    const { app } = await setup()
    track(app)
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: auth,
      payload: body(),
    })
    expect((res.json().events as { type: string }[]).map((e) => e.type)).toEqual(['CALL'])
  })
})

describe('extraction worker — health flags from the state file', () => {
  it('a flag already in the state file at start reaches the first reply', async () => {
    const routeState = await stateFile({
      version: 1,
      spent: [],
      retired: [],
      providers: [],
      failedJobs: ['chain'],
    })
    const { app } = await setup({ routeState })
    track(app)
    const res = await app.inject({ method: 'POST', url: '/preflight', headers: auth })
    expect(res.json().health).toEqual({ modelListStale: false, failedJobs: ['chain'] })
  })

  it('a flag set in the state reaches the next reply, extract and preflight alike', async () => {
    const { app, routeState } = await setup()
    track(app)
    await routeState.update((s) => ({
      ...s,
      modelListStale: [{ provider: 'groq', model: 'llama-x' }],
      failedJobs: ['daily'],
    }))
    const ex = await app.inject({ method: 'POST', url: '/extract', headers: auth, payload: body() })
    const pf = await app.inject({ method: 'POST', url: '/preflight', headers: auth })
    for (const res of [ex, pf]) {
      expect(res.json().health).toEqual({ modelListStale: true, failedJobs: ['daily'] })
    }
    await routeState.update((s) => ({ ...s, modelListStale: [], failedJobs: [] }))
    const clear = await app.inject({ method: 'POST', url: '/preflight', headers: auth })
    expect(clear.json().health).toEqual({ modelListStale: false, failedJobs: [] })
  })
})

describe('extraction worker — preflight', () => {
  it.each([
    ['no body', undefined, {}],
    ['an empty JSON object', '{}', { 'content-type': 'application/json' }],
  ])('%s: one fixed call; ok when it answered', async (_name, payload, headers) => {
    const preflight = fakePort(async () => ({ ok: true, data: { ok: true } }))
    const { app, extract } = await setup({ preflight })
    track(app)
    const res = await app.inject({
      method: 'POST',
      url: '/preflight',
      headers: { authorization: auth.authorization, ...headers },
      ...(payload !== undefined && { payload }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      ok: true,
      events: [{ type: 'CALL', code: 'OK', floorAnswered: false, latencyMs: 5 }],
      health: { modelListStale: false, failedJobs: [] },
    })
    expect(extract.calls).toHaveLength(0)
    expect(preflight.calls).toHaveLength(1)
    const req = preflight.calls[0]!
    expect(req.input).toBe('Reply with the JSON object {"ok": true} and nothing else.')
    expect(req.instruction).toBe('You are a health check. Answer exactly as asked.')
    expect(req.smallDose).toBeUndefined()
    expect(req.schema.safeParse({ ok: true }).success).toBe(true)
    expect(req.schema.safeParse({ ok: true, x: 1 }).success).toBe(false)
  })

  it('a failed preflight call replies ok: false', async () => {
    const preflight = fakePort(async () => ({ ok: false, code: 'PROVIDER_ERROR' }))
    const { app } = await setup({ preflight })
    track(app)
    const res = await app.inject({
      method: 'POST',
      url: '/preflight',
      headers: auth,
      payload: '{}',
    })
    expect(res.json().ok).toBe(false)
  })
})

describe('extraction worker — a thrown route never leaks', () => {
  it('a route that throws answers 500 with a fixed body and logs no text', async () => {
    const extract = fakePort(async () => {
      throw new Error(`boom ${SECRET} ${INPUT_MARKER}`)
    })
    const { app, logs } = await setup({ extract })
    track(app)
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: auth,
      payload: body(),
    })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'INTERNAL' })
    expect(JSON.stringify(logs)).not.toContain(SECRET)
    expect(JSON.stringify(logs)).not.toContain(INPUT_MARKER)
  })
})

/** One of every router event kind: a new kind fails typecheck here until the sink test covers it. */
const EVERY_EVENT: Record<RouterEvent['type'], RouterEvent> = {
  CONFIG_REFUSED: { type: 'CONFIG_REFUSED' },
  ATTEMPT: {
    type: 'ATTEMPT',
    route: 'groq',
    model: 'openai/gpt-oss-20b',
    code: 'RATE_LIMITED',
    inputChars: 120,
    latencyMs: 40,
    status: 429,
  },
  RETIRED: { type: 'RETIRED', route: 'gemini', model: 'gemini-2.0-flash' },
  PROVIDER_DISABLED: { type: 'PROVIDER_DISABLED', route: 'groq', code: 'AUTH' },
  FELL_TO_LOCAL: {
    type: 'FELL_TO_LOCAL',
    plan: 'full-then-small',
    reasons: [{ route: 'groq', code: 'RATE_LIMITED' }],
  },
  CALL: { type: 'CALL', code: 'OK', floorAnswered: true, latencyMs: 90 },
}

describe('extraction worker — the mandatory event sink (ADR §5.3)', () => {
  it('every router event kind reaches the log and the reply; FELL_TO_LOCAL is not swallowed', async () => {
    const events = Object.values(EVERY_EVENT)
    const extract = fakePort(async () => {
      for (const e of events) extract.onEvent(e)
      return { ok: true, data: OK_REPLY, usage: { totalTokens: 7 } }
    })
    const { app, logs } = await setup({ extract })
    track(app)
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: auth,
      payload: body(),
    })
    const replied = res.json<{ events: RouterEvent[] }>().events
    for (const e of events) {
      expect(replied).toContainEqual(e)
      expect(logs).toContainEqual({ event: 'ROUTER', ...e })
    }
    expect(replied.map((e) => e.type)).toContain('FELL_TO_LOCAL')
  })
})

describe('extraction worker — no secret, input or model text in any log or event', () => {
  it('across refusals, calls and preflight', async () => {
    const { app, logs } = await setup()
    track(app)
    const replies = await Promise.all([
      app.inject({ method: 'POST', url: '/extract', headers: auth, payload: body() }),
      app.inject({ method: 'POST', url: '/preflight', headers: auth }),
      app.inject({
        method: 'POST',
        url: '/extract',
        headers: { authorization: `Bearer ${SECRET}x`, 'content-type': 'application/json' },
        payload: body(),
      }),
      app.inject({
        method: 'POST',
        url: '/extract',
        headers: auth,
        payload: body({ x: INPUT_MARKER }),
      }),
    ])
    expect(logs.length).toBeGreaterThan(0)
    const logged = JSON.stringify(logs)
    for (const marker of [SECRET, INPUT_MARKER, MODEL_MARKER]) expect(logged).not.toContain(marker)
    for (const r of replies) {
      expect(r.body).not.toContain(SECRET)
      expect(JSON.stringify(r.json().events ?? [])).not.toContain(INPUT_MARKER)
    }
  })
})

describe('extraction worker — a closed connection aborts the route call', () => {
  it('passes a signal that aborts when the client disconnects', async () => {
    let seen: AbortSignal | undefined
    let release!: () => void
    const reached = new Promise<void>((r) => (release = r))
    const extract = fakePort(
      (req) =>
        new Promise((resolve) => {
          seen = req.signal
          release()
          req.signal?.addEventListener('abort', () => resolve({ ok: false, code: 'TIMEOUT' }))
        }),
    )
    const { app } = await setup({ extract })
    track(app)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const { port } = app.server.address() as AddressInfo
    const client = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/extract',
      headers: auth,
    })
    client.on('error', () => undefined)
    client.end(body())
    await reached
    expect(seen?.aborted).toBe(false)
    const aborted = new Promise<void>((r) => seen!.addEventListener('abort', () => r()))
    client.destroy()
    await aborted
    expect(seen?.aborted).toBe(true)
  })

  it('a client gone before the route call starts: the signal is already aborted', async () => {
    let abortedAtEntry: boolean | undefined
    let release!: () => void
    const reached = new Promise<void>((r) => (release = r))
    const extract = fakePort(async (req) => {
      abortedAtEntry = req.signal?.aborted
      release()
      return { ok: false, code: 'TIMEOUT' }
    })
    const { app } = await setup({ extract })
    track(app)
    let client!: ClientRequest
    // Holds the request after its body was read until the connection is gone: the check/strip window.
    app.addHook('preHandler', async (_req, reply) => {
      const closed = once(reply.raw, 'close')
      client.destroy()
      await closed
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const { port } = app.server.address() as AddressInfo
    client = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/extract',
      headers: auth,
    })
    client.on('error', () => undefined)
    client.end(body())
    await reached
    expect(abortedAtEntry).toBe(true)
  })
})
