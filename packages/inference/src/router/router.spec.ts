import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  answer,
  config,
  countingCap,
  deps,
  GEMINI,
  GOOD,
  GROQ,
  hostOf,
  LOCAL,
  REQ,
  scriptedFetch,
  type Reply,
} from './__test-helpers__/router-harness'
import type { FetchLike } from '../http/bounded-request'
import {
  createRouter,
  createRouterExtractionAdapter,
  pendingLocalQueues,
  type RouterEvent,
} from './router'
import { createMemoryRouteStatePort, createOwnCapPort, type RouteStatePort } from './state'

const NOON = Date.parse('2026-11-04T12:00:00Z')
const byHost = (sent: { host: string }[]) => sent.map((s) => s.host)
const ofType = <K extends RouterEvent['type']>(events: RouterEvent[], type: K) =>
  events.filter((e): e is Extract<RouterEvent, { type: K }> => e.type === type)

describe('router: answers and the floor', () => {
  it('a hosted OK answers without touching the floor, with usage', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([GROQ, LOCAL]), d).run(REQ)
    expect(r).toEqual({ ok: true, data: { title: 'Engineer' }, usage: { totalTokens: 10 } })
    expect(byHost(f.sent)).toEqual([hostOf.groq])
    expect(ofType(d.events, 'CALL')).toEqual([
      { type: 'CALL', code: 'OK', floorAnswered: false, latencyMs: expect.any(Number) },
    ])
    expect(ofType(d.events, 'FELL_TO_LOCAL')).toEqual([])
  })

  it('a local-only config sends no hosted request and falls with plan small', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { ownCap: undefined })
    const r = await createRouter(config([LOCAL]), d).run(REQ)
    expect(r.ok).toBe(true)
    expect(byHost(f.sent)).toEqual([hostOf.local])
    expect(ofType(d.events, 'FELL_TO_LOCAL')).toEqual([
      { type: 'FELL_TO_LOCAL', plan: 'small', reasons: [] },
    ])
    expect(ofType(d.events, 'CALL')[0]).toMatchObject({ code: 'OK', floorAnswered: true })
  })

  it('every hosted route failing hands back to the floor with the (route, code) list', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.local ? GOOD : { status: 500, body: '' }))
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([GROQ, GEMINI, LOCAL]), d).run(REQ)
    expect(r.ok).toBe(true)
    expect(byHost(f.sent)).toEqual([hostOf.groq, hostOf.gemini, hostOf.local])
    expect(ofType(d.events, 'FELL_TO_LOCAL')).toEqual([
      {
        type: 'FELL_TO_LOCAL',
        plan: 'full-then-small',
        reasons: [
          { route: 'groq', code: 'TRANSPORT' },
          { route: 'gemini', code: 'TRANSPORT' },
        ],
      },
    ])
    expect(ofType(d.events, 'CALL')[0]).toMatchObject({ floorAnswered: true })
  })

  it.each([
    ['a local 500', { status: 500, body: '' }, 'PROVIDER_ERROR'],
    ['a local non-JSON answer twice', answer('not json'), 'INVALID_OUTPUT'],
    ['a local empty answer', answer(''), 'INVALID_OUTPUT'],
    ['a local 401', { status: 401, body: '' }, 'PROVIDER_ERROR'],
    ['a local 429', { status: 429, body: '' }, 'PROVIDER_ERROR'],
  ] as [string, Reply, string][])(
    'floor failure on %s returns the floor code %s',
    async (_l, reply, code) => {
      const f = scriptedFetch((s) => (s.host === hostOf.local ? reply : { status: 500, body: '' }))
      const r = await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl)).run(REQ)
      expect(r).toEqual({ ok: false, code, usage: { localMs: 0 } })
    },
  )

  it('a correction retry on the floor is its own request and can succeed', async () => {
    const f = scriptedFetch((_s, n) => (n === 1 ? answer('{"nope":1}') : GOOD))
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl, { ownCap: undefined })).run(REQ)
    expect(r).toEqual({ ok: true, data: { title: 'Engineer' }, usage: { totalTokens: 20, localMs: 0 } })
    expect(f.sent).toHaveLength(2)
    expect(JSON.stringify(f.sent[1]!.body.messages)).toContain('Your previous answer was rejected.')
  })

  it('a strict null reaches the caller as an absent field', async () => {
    const f = scriptedFetch(() => answer({ title: 'Engineer', salary: null }))
    const r = await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl)).run(REQ)
    expect(r).toMatchObject({ ok: true, data: { title: 'Engineer' } })
    expect(r.ok && 'salary' in r.data).toBe(false)
  })

  it('the hosted request carries the strict schema, the route model and max_tokens; the local one too', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.local ? GOOD : { status: 500, body: '' }))
    await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl)).run(REQ)
    const [hosted, local] = f.sent
    expect(hosted!.model).toBe('openai/gpt-oss-120b')
    expect(hosted!.body.max_tokens).toBe(800)
    expect(hosted!.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        strict: true,
        schema: { additionalProperties: false, required: ['title', 'salary'] },
      },
    })
    expect(local!.model).toBe('qwen2.5:3b')
    expect(local!.body.max_tokens).toBe(500)
    expect(local!.body.temperature).toBe(0)
  })

  it('json_object and none routes send their own structured-output mode', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.local ? GOOD : { status: 500, body: '' }))
    const groq = { ...GROQ, structuredOutput: 'json_object' }
    const local = { ...LOCAL, structuredOutput: 'none' }
    await createRouter(config([groq, local]), deps(f.fetchImpl)).run(REQ)
    expect(f.sent[0]!.body.response_format).toEqual({ type: 'json_object' })
    expect(f.sent[1]!.body).not.toHaveProperty('response_format')
  })

  it('a schema JSON Schema cannot express falls back to json_object', async () => {
    const f = scriptedFetch(() => answer({ title: 'x' }))
    const schema = z.object({ title: z.string() }).transform((v) => v.title.length)
    const r = await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl)).run({
      input: 'p',
      schema,
    })
    expect(r).toMatchObject({ ok: true, data: 1 })
    expect(f.sent[0]!.body.response_format).toEqual({ type: 'json_object' })
  })

  it('the managed list supersedes the pinned list', async () => {
    const f = scriptedFetch(() => GOOD)
    await createRouter(
      config([GROQ, LOCAL]),
      deps(f.fetchImpl, {
        managedModels: async () => ['openai/gpt-oss-20b'],
      }),
    ).run(REQ)
    expect(f.sent[0]!.model).toBe('openai/gpt-oss-20b')
  })
})

describe('router: the ExtractionPort adapter', () => {
  it('passes a router result through unchanged', async () => {
    const f = scriptedFetch(() => GOOD)
    const port = createRouterExtractionAdapter(config([LOCAL]), deps(f.fetchImpl))
    expect(await port.extract(REQ)).toEqual({
      ok: true,
      data: { title: 'Engineer' },
      usage: { totalTokens: 10, localMs: 0 },
    })
    const refused = createRouterExtractionAdapter(config([]), deps(f.fetchImpl))
    expect(await refused.extract(REQ)).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
  })
})

describe('router: refused configs send nothing', () => {
  it.each([
    ['a hosted route without an OwnCapPort', config([GROQ, LOCAL]), { ownCap: undefined }],
    [
      'an invalid local URL',
      config([GROQ, { ...LOCAL, baseUrl: 'http://169.254.169.254/v1' }]),
      {},
    ],
    ['no local route', config([GROQ]), {}],
    ['a foreign provider', config([{ ...GROQ, provider: 'openrouter' }, LOCAL]), {}],
    [
      'a local timeout of 300 s',
      config([{ ...LOCAL, timeoutMs: 300_000 }], { floorBudgetMs: 400_000 }),
      {},
    ],
  ])('%s: NOT_CONFIGURED, zero requests, one CONFIG_REFUSED', async (_l, cfg, extra) => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, extra)
    const router = createRouter(cfg, d)
    expect(await router.run(REQ)).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(await router.run(REQ)).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(f.sent).toHaveLength(0)
    expect(d.events).toEqual([{ type: 'CONFIG_REFUSED' }])
  })

  it('a config read that throws is refused, and no event carries the thrown text (SR-H-65)', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl)
    const hostile = {
      ...config([LOCAL]),
      get routes(): never {
        throw new TypeError('https://u:SENTINEL_URL@[x')
      },
    }
    const router = createRouter(hostile, d)
    expect(await router.run(REQ)).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(f.sent).toHaveLength(0)
    expect(d.events).toEqual([{ type: 'CONFIG_REFUSED' }])
  })

  it('a key with an unparsable local URL builds a refused router (SR-H-65)', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl)
    const cfg = config([{ ...LOCAL, apiKey: 'k', baseUrl: 'https://u:SENTINEL_URL@[x' }])
    expect(await createRouter(cfg, d).run(REQ)).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(JSON.stringify(d.events)).not.toContain('SENTINEL_URL')
    expect(d.events).toEqual([{ type: 'CONFIG_REFUSED' }])
  })

  it('a missing onEvent consumer refuses the router', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { onEvent: undefined as never })
    expect(await createRouter(config([LOCAL]), d).run(REQ)).toEqual({
      ok: false,
      code: 'NOT_CONFIGURED',
    })
    expect(f.sent).toHaveLength(0)
  })

  it('a throwing onEvent consumer does not break the call', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, {
      onEvent: () => {
        throw new Error('consumer')
      },
    })
    expect(await createRouter(config([GROQ, LOCAL]), d).run(REQ)).toMatchObject({ ok: true })
  })
})

describe('router: rotation and fit filter (§5.2)', () => {
  it('rotates the first rotatable route across successive calls', async () => {
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(config([GROQ, GEMINI, LOCAL]), deps(f.fetchImpl))
    for (let i = 0; i < 4; i++) await router.run(REQ)
    expect(byHost(f.sent)).toEqual([hostOf.groq, hostOf.gemini, hostOf.groq, hostOf.gemini])
  })

  it('a non-rotatable route is never first', async () => {
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(
      config([{ ...GEMINI, rotate: false }, GROQ, LOCAL]),
      deps(f.fetchImpl),
    )
    for (let i = 0; i < 3; i++) await router.run(REQ)
    expect(byHost(f.sent)).toEqual([hostOf.groq, hostOf.groq, hostOf.groq])
  })

  it('a non-rotatable route still serves as a fallback, after the rotation pick', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.groq ? { status: 500, body: '' } : GOOD))
    const r = await createRouter(
      config([{ ...GEMINI, rotate: false }, GROQ, LOCAL]),
      deps(f.fetchImpl),
    ).run(REQ)
    expect(r.ok).toBe(true)
    expect(byHost(f.sent)).toEqual([hostOf.groq, hostOf.gemini])
  })

  it('only non-rotatable routes keep their configured order', async () => {
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(
      config([{ ...GEMINI, rotate: false }, { ...GROQ, rotate: false }, LOCAL]),
      deps(f.fetchImpl),
    )
    await router.run(REQ)
    await router.run(REQ)
    expect(byHost(f.sent)).toEqual([hostOf.gemini, hostOf.gemini])
  })

  it('the fit filter drops a small-context route and keeps the floor', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl)
    const small = { ...GROQ, contextTokens: 1_000 }
    const r = await createRouter(config([small, LOCAL]), d).run({
      ...REQ,
      input: 'x'.repeat(3_000),
    })
    expect(r.ok).toBe(true)
    expect(byHost(f.sent)).toEqual([hostOf.local])
    expect(ofType(d.events, 'FELL_TO_LOCAL')[0]).toMatchObject({
      plan: 'small',
      reasons: [{ route: 'groq', code: 'FIT' }],
    })
  })

  it('a route that fits exactly is kept', async () => {
    const f = scriptedFetch(() => GOOD)
    // 32 overhead + 800 answer + ceil((instruction + input + 535) / 2) tokens
    const inputChars = 1000
    const instruction = 'i'.repeat(465)
    const groq = { ...GROQ, contextTokens: 32 + 800 + (465 + inputChars + 535) / 2 }
    await createRouter(config([groq, LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      input: 'x'.repeat(inputChars),
      instruction,
    })
    expect(byHost(f.sent)).toEqual([hostOf.groq])
  })
})

describe('router: one local request in flight per runtime, across routers (SR-L-70)', () => {
  it('a call arriving after the first settled still queues behind the second, and the queue empties', async () => {
    const pending: (() => void)[] = []
    let sent = 0
    const fetchImpl: FetchLike = async () => {
      sent++
      await new Promise<void>((resolve) => pending.push(resolve))
      return {
        status: 200,
        body: null,
        text: async () => (GOOD as { body: string }).body,
        headers: { get: () => null },
      }
    }
    const a = createRouter(config([LOCAL]), deps(fetchImpl))
    const b = createRouterExtractionAdapter(config([LOCAL]), deps(fetchImpl))
    const first = a.run(REQ)
    const second = b.extract(REQ)
    await vi.waitFor(() => expect(sent).toBe(1))
    pending.shift()!()
    await first
    await vi.waitFor(() => expect(sent).toBe(2))
    const third = a.run(REQ)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(sent).toBe(2)
    pending.shift()!()
    await second
    await vi.waitFor(() => expect(sent).toBe(3))
    pending.shift()!()
    expect(await third).toMatchObject({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pendingLocalQueues()).toBe(0)
  })
})

describe('router: store writes are awaited inside the hosted budget (SR-L-70)', () => {
  /** A store that applies a change at once and finishes its write after `ms` of real time. */
  const slowStore = (ms: number): RouteStatePort => {
    const mem = createMemoryRouteStatePort()
    return {
      snapshot: mem.snapshot,
      update: (change) => {
        void mem.update(change)
        return new Promise((resolve) => setTimeout(() => resolve(true), ms))
      },
    }
  }

  it('a store slower than nothing but faster than the budget is waited for: the hosted answer is used', async () => {
    const routeState = slowStore(5)
    const ownCap = createOwnCapPort({ state: routeState, now: () => NOON })
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { routeState, ownCap, now: () => NOON })
    expect(await createRouter(config([GROQ, LOCAL]), d).run(REQ)).toMatchObject({ ok: true })
    expect(byHost(f.sent)).toEqual([hostOf.groq])
  })

  it('a token write outliving the budget: the call returns, memory already counts it, the write still lands (CR-L)', async () => {
    const mem = createMemoryRouteStatePort()
    const held: (() => void)[] = []
    let landed = 0
    const routeState: RouteStatePort = {
      snapshot: mem.snapshot,
      update: (change) => {
        void mem.update(change)
        // the reservation writes at once; every later write waits for the test to let it land
        if (mem.snapshot().providers[0]?.ownCap?.tokens === 0) return Promise.resolve(true)
        return new Promise((resolve) =>
          held.push(() => {
            landed++
            resolve(true)
          }),
        )
      },
    }
    const ownCap = createOwnCapPort({ state: routeState, now: () => NOON })
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { routeState, ownCap, now: () => NOON })
    const r = await createRouter(config([GROQ, LOCAL], { hostedBudgetMs: 20 }), d).run(REQ)
    expect(r).toMatchObject({ ok: true, usage: { totalTokens: 10 } })
    expect(byHost(f.sent)).toEqual([hostOf.groq])
    expect(mem.snapshot().providers[0]?.ownCap).toEqual({
      day: '2026-11-04',
      requests: 1,
      tokens: 10,
    })
    expect(landed).toBe(0)
    held.forEach((land) => land())
    expect(landed).toBe(1)
  })

  it('the budget timer is cancelled once a write finished: no timer outlives the call', async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { now: () => NOON })
    const router = createRouter(config([GROQ, LOCAL]), d)
    const before = timers()
    await router.run(REQ)
    await new Promise((resolve) => setImmediate(resolve))
    expect(timers()).toBe(before)
  })

  it('a hosted budget of zero reserves nothing and sends nothing hosted', async () => {
    const cap = countingCap()
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { ownCap: cap, now: () => NOON })
    await createRouter(config([GROQ, LOCAL], { hostedBudgetMs: 0 }), d).run(REQ)
    expect(cap.reserved).toEqual([])
    expect(byHost(f.sent)).toEqual([hostOf.local])
    expect(ofType(d.events, 'FELL_TO_LOCAL')[0]?.reasons).toEqual([
      { route: 'groq', code: 'BUDGET' },
    ])
  })
})
