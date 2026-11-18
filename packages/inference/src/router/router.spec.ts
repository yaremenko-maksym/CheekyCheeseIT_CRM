import { describe, expect, it } from 'vitest'
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
  REQ,
  scriptedFetch,
  type Reply,
} from './__test-helpers__/router-harness'
import { createRouter, createRouterExtractionAdapter, modelSizeB, type RouterEvent } from './router'
import { createMemoryRouteStatePort, createOwnCapPort, type RouteStatePort } from './state'

const NOON = Date.parse('2026-11-04T12:00:00Z')
const byHost = (sent: { host: string }[]) => sent.map((s) => s.host)
const ofType = <K extends RouterEvent['type']>(events: RouterEvent[], type: K) =>
  events.filter((e): e is Extract<RouterEvent, { type: K }> => e.type === type)

describe('router: answers and the end of the cascade (hosted-only, H.1/H.2)', () => {
  it('a hosted OK answers with usage and one CALL event', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([GROQ]), d).run(REQ)
    expect(r).toEqual({ ok: true, data: { title: 'Engineer' }, usage: { totalTokens: 10 } })
    expect(byHost(f.sent)).toEqual([hostOf.groq])
    expect(ofType(d.events, 'CALL')).toEqual([
      { type: 'CALL', code: 'OK', latencyMs: expect.any(Number) },
    ])
  })

  it('a failed route hands over to the next hosted route, never to a local runtime', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.gemini ? GOOD : { status: 500, body: '' }))
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([GROQ, GEMINI]), d).run(REQ)
    expect(r.ok).toBe(true)
    expect(byHost(f.sent)).toEqual([hostOf.groq, hostOf.gemini])
    // An answered call emits no EXHAUSTED: the event belongs to a call no route answered.
    expect(ofType(d.events, 'EXHAUSTED')).toEqual([])
  })

  it('a call no hosted route answered emits one EXHAUSTED with every route reason, then CALL', async () => {
    const f = scriptedFetch(() => ({ status: 500, body: '' }))
    const d = deps(f.fetchImpl)
    await createRouter(config([GROQ, GEMINI]), d).run(REQ)
    expect(d.events.filter((e) => e.type === 'EXHAUSTED' || e.type === 'CALL')).toEqual([
      {
        type: 'EXHAUSTED',
        reasons: [
          { route: 'groq', code: 'TRANSPORT' },
          { route: 'gemini', code: 'TRANSPORT' },
        ],
      },
      { type: 'CALL', code: 'PROVIDER_ERROR', latencyMs: expect.any(Number) },
    ])
  })

  const INVALID = answer('not json')
  const FAIL: Reply = { status: 500, body: '' }
  it.each([
    ['every route a 500', () => FAIL, 'PROVIDER_ERROR'],
    ['every model a non-JSON answer twice', () => INVALID, 'INVALID_OUTPUT'],
    ['every model an empty answer', () => answer(''), 'INVALID_OUTPUT'],
    [
      'one route invalid, one a 500',
      (s: { host: string }) => (s.host === hostOf.groq ? INVALID : FAIL),
      'PROVIDER_ERROR',
    ],
    ['every route a 401', () => ({ status: 401, body: '' }), 'PROVIDER_ERROR'],
    ['every route a 429', () => ({ status: 429, body: '' }), 'PROVIDER_ERROR'],
  ] as [string, (s: { host: string }) => Reply, string][])(
    'no hosted answer on %s ends the call with %s and no usage',
    async (_l, script, code) => {
      const f = scriptedFetch(script)
      const d = deps(f.fetchImpl)
      const r = await createRouter(config([GROQ, GEMINI]), d).run(REQ)
      expect(r).toEqual({ ok: false, code })
      expect(ofType(d.events, 'CALL')).toEqual([
        { type: 'CALL', code, latencyMs: expect.any(Number) },
      ])
    },
  )

  it.each(['', '   '])(
    'an empty answer %j is INVALID_OUTPUT at once on that model: no correction retry (ADR 6.1)',
    async (empty) => {
      const f = scriptedFetch(() => answer(empty))
      const groq = { ...GROQ, models: ['openai/gpt-oss-120b'] }
      const r = await createRouter(config([groq]), deps(f.fetchImpl)).run(REQ)
      expect(r).toEqual({ ok: false, code: 'INVALID_OUTPUT' })
      expect(f.sent).toHaveLength(1)
    },
  )

  it('every route skipped by the fit filter is PROVIDER_ERROR and sends nothing', async () => {
    const f = scriptedFetch(() => GOOD)
    const small = { ...GROQ, contextTokens: 1_000 }
    const r = await createRouter(config([small]), deps(f.fetchImpl)).run({
      ...REQ,
      input: 'x'.repeat(40_000),
    })
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toHaveLength(0)
  })

  it('a correction retry on a hosted model is its own request and can succeed', async () => {
    const f = scriptedFetch((_s, n) => (n === 1 ? answer('{"nope":1}') : GOOD))
    const r = await createRouter(config([GROQ]), deps(f.fetchImpl)).run(REQ)
    expect(r).toEqual({ ok: true, data: { title: 'Engineer' }, usage: { totalTokens: 20 } })
    expect(f.sent).toHaveLength(2)
    expect(JSON.stringify(f.sent[1]!.body.messages)).toContain('Your previous answer was rejected.')
  })

  it('a strict null reaches the caller as an absent field', async () => {
    const f = scriptedFetch(() => answer({ title: 'Engineer', salary: null }))
    const r = await createRouter(config([GROQ]), deps(f.fetchImpl)).run(REQ)
    expect(r).toMatchObject({ ok: true, data: { title: 'Engineer' } })
    expect(r.ok && 'salary' in r.data).toBe(false)
  })

  it('the hosted request carries the strict schema, the route model, max_tokens and 0.1', async () => {
    const f = scriptedFetch(() => GOOD)
    await createRouter(config([GROQ]), deps(f.fetchImpl)).run(REQ)
    const [hosted] = f.sent
    expect(hosted!.model).toBe('openai/gpt-oss-120b')
    expect(hosted!.body.max_tokens).toBe(800)
    expect(hosted!.body.temperature).toBe(0.1)
    expect(hosted!.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        strict: true,
        schema: { additionalProperties: false, required: ['title', 'salary'] },
      },
    })
  })

  it('json_object and none routes send their own structured-output mode', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.gemini ? GOOD : { status: 500, body: '' }))
    const groq = { ...GROQ, structuredOutput: 'json_object' }
    const gemini = { ...GEMINI, structuredOutput: 'none' }
    await createRouter(config([groq, gemini]), deps(f.fetchImpl)).run(REQ)
    expect(f.sent[0]!.body.response_format).toEqual({ type: 'json_object' })
    expect(f.sent[1]!.body).not.toHaveProperty('response_format')
  })

  it('a schema JSON Schema cannot express falls back to json_object', async () => {
    const f = scriptedFetch(() => answer({ title: 'x' }))
    const schema = z.object({ title: z.string() }).transform((v) => v.title.length)
    const r = await createRouter(config([GROQ]), deps(f.fetchImpl)).run({
      input: 'p',
      schema,
    })
    expect(r).toMatchObject({ ok: true, data: 1 })
    expect(f.sent[0]!.body.response_format).toEqual({ type: 'json_object' })
  })

  it('the managed list supersedes the pinned list', async () => {
    const f = scriptedFetch(() => GOOD)
    await createRouter(
      config([GROQ]),
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
    const port = createRouterExtractionAdapter(config([GROQ]), deps(f.fetchImpl))
    expect(await port.extract(REQ)).toEqual({
      ok: true,
      data: { title: 'Engineer' },
      usage: { totalTokens: 10 },
    })
    const refused = createRouterExtractionAdapter(config([]), deps(f.fetchImpl))
    expect(await refused.extract(REQ)).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
  })

  it('the request signal stops the call, publicly TIMEOUT, with nothing sent (§5.5 item 3)', async () => {
    const f = scriptedFetch(() => GOOD)
    const port = createRouterExtractionAdapter(config([GROQ]), deps(f.fetchImpl))
    const r = await port.extract({ ...REQ, signal: AbortSignal.abort() })
    expect(r).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(f.sent).toHaveLength(0)
  })

  it('an abort during a hosted request leaves the port as TIMEOUT', async () => {
    const stop = new AbortController()
    const f = scriptedFetch(() => {
      stop.abort()
      return 'hang'
    })
    const port = createRouterExtractionAdapter(config([GROQ]), deps(f.fetchImpl))
    expect(await port.extract({ ...REQ, signal: stop.signal })).toEqual({
      ok: false,
      code: 'TIMEOUT',
    })
    expect(f.sent).toHaveLength(1)
  })
})

/** The withdrawn local route as a stale config still carries it (Amendment 2026-11-08). */
const STALE_LOCAL = {
  provider: 'local',
  baseUrl: 'http://crm-model-runtime:11434/v1',
  model: 'qwen2.5:3b',
  contextTokens: 32_000,
  structuredOutput: 'json_schema',
  timeoutMs: 5_000,
  maxAnswerTokens: 500,
}

describe('router: refused configs send nothing', () => {
  it.each([
    ['a hosted route without an OwnCapPort', config([GROQ]), { ownCap: undefined }],
    ['a stale local route after the hosted ones', config([GROQ, STALE_LOCAL]), {}],
    ['a stale local-only config', config([STALE_LOCAL]), { ownCap: undefined }],
    ['a stale floorBudgetMs', config([GROQ], { floorBudgetMs: 60_000 }), {}],
    ['no route at all', config([]), {}],
    ['a foreign provider', config([{ ...GROQ, provider: 'mistral' }]), {}],
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
      ...config([GROQ]),
      get routes(): never {
        throw new TypeError('https://u:SENTINEL_URL@[x')
      },
    }
    const router = createRouter(hostile, d)
    expect(await router.run(REQ)).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(f.sent).toHaveLength(0)
    expect(d.events).toEqual([{ type: 'CONFIG_REFUSED' }])
  })

  it('a stale local route with a key and an unparsable URL builds a refused router (SR-H-65)', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl)
    const cfg = config([
      GROQ,
      { ...STALE_LOCAL, apiKey: 'k', baseUrl: 'https://u:SENTINEL_URL@[x' },
    ])
    expect(await createRouter(cfg, d).run(REQ)).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(JSON.stringify(d.events)).not.toContain('SENTINEL_URL')
    expect(d.events).toEqual([{ type: 'CONFIG_REFUSED' }])
  })

  it('a missing onEvent consumer refuses the router', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { onEvent: undefined as never })
    expect(await createRouter(config([GROQ]), d).run(REQ)).toEqual({
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
    expect(await createRouter(config([GROQ]), d).run(REQ)).toMatchObject({ ok: true })
  })
})

describe('router: rotation and fit filter (§5.2)', () => {
  it('rotates the first rotatable route across successive calls', async () => {
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(config([GROQ, GEMINI]), deps(f.fetchImpl))
    for (let i = 0; i < 4; i++) await router.run(REQ)
    expect(byHost(f.sent)).toEqual([hostOf.groq, hostOf.gemini, hostOf.groq, hostOf.gemini])
  })

  it('a non-rotatable route is never first', async () => {
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(config([{ ...GEMINI, rotate: false }, GROQ]), deps(f.fetchImpl))
    for (let i = 0; i < 3; i++) await router.run(REQ)
    expect(byHost(f.sent)).toEqual([hostOf.groq, hostOf.groq, hostOf.groq])
  })

  it('a non-rotatable route still serves as a fallback, after the rotation pick', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.groq ? { status: 500, body: '' } : GOOD))
    const r = await createRouter(
      config([{ ...GEMINI, rotate: false }, GROQ]),
      deps(f.fetchImpl),
    ).run(REQ)
    expect(r.ok).toBe(true)
    expect(byHost(f.sent)).toEqual([hostOf.groq, hostOf.gemini])
  })

  it('only non-rotatable routes keep their configured order', async () => {
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(
      config([
        { ...GEMINI, rotate: false },
        { ...GROQ, rotate: false },
      ]),
      deps(f.fetchImpl),
    )
    await router.run(REQ)
    await router.run(REQ)
    expect(byHost(f.sent)).toEqual([hostOf.gemini, hostOf.gemini])
  })

  it('the fit filter drops a small-context route and keeps the next hosted route', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl)
    const small = { ...GROQ, contextTokens: 1_000 }
    const r = await createRouter(config([small, GEMINI]), d).run({
      ...REQ,
      input: 'x'.repeat(3_000),
    })
    expect(r.ok).toBe(true)
    expect(byHost(f.sent)).toEqual([hostOf.gemini])
  })

  it('a route that fits exactly is kept', async () => {
    const f = scriptedFetch(() => GOOD)
    // 32 overhead + 800 answer + ceil((instruction + input + 535) / 2) tokens
    const inputChars = 1000
    const instruction = 'i'.repeat(465)
    const groq = { ...GROQ, contextTokens: 32 + 800 + (465 + inputChars + 535) / 2 }
    await createRouter(config([groq]), deps(f.fetchImpl)).run({
      ...REQ,
      input: 'x'.repeat(inputChars),
      instruction,
    })
    expect(byHost(f.sent)).toEqual([hostOf.groq])
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
    expect(await createRouter(config([GROQ]), d).run(REQ)).toMatchObject({ ok: true })
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
    const r = await createRouter(
      config([{ ...GROQ, timeoutMs: 20 }], { hostedBudgetMs: 20 }),
      d,
    ).run(REQ)
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
    const router = createRouter(config([GROQ]), d)
    const before = timers()
    await router.run(REQ)
    await new Promise((resolve) => setImmediate(resolve))
    expect(timers()).toBe(before)
  })

  it('a hosted budget spent before the first request reserves nothing, sends nothing, PROVIDER_ERROR', async () => {
    const cap = countingCap()
    const f = scriptedFetch(() => GOOD)
    let reads = 0
    // The call starts at noon; every later read is past the 5 s budget.
    const now = () => (reads++ === 0 ? NOON : NOON + 10_000)
    const d = deps(f.fetchImpl, { ownCap: cap, now })
    const r = await createRouter(config([GROQ], { hostedBudgetMs: 5_000 }), d).run(REQ)
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(cap.reserved).toEqual([])
    expect(f.sent).toEqual([])
  })
})

describe('router: the largest-model preference (R15)', () => {
  /** The hosted (host, model) pairs in the order first tried; a correction retry is the same pair. */
  const tried = (sent: { host: string; model: string }[]) => [
    ...new Set(sent.map((s) => `${s.host} ${s.model}`)),
  ]
  const BAD = answer('not json')
  // The hosted families are checked in: only Groq ids carry a size, Gemini ids carry none.
  const groq = { ...GROQ, models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'] }
  const gemini = { ...GEMINI, models: ['gemini-2.5-flash-lite', 'gemini-2.5-pro'] }
  const PAIRS = {
    big: `${hostOf.groq} openai/gpt-oss-120b`,
    small: `${hostOf.groq} openai/gpt-oss-20b`,
    lite: `${hostOf.gemini} gemini-2.5-flash-lite`,
    pro: `${hostOf.gemini} gemini-2.5-pro`,
  }

  it('largest preference never picks the smallest model when a larger one is healthy', async () => {
    const f = scriptedFetch(() => GOOD)
    // Gemini first in the config and in the rotation: the preference still goes to the 120b model.
    const router = createRouter(config([gemini, groq]), deps(f.fetchImpl))
    for (let i = 0; i < 2; i++) {
      const r = await router.run({ ...REQ, modelPreference: 'largest' })
      expect(r.ok).toBe(true)
    }
    expect(f.sent.map((s) => s.model)).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-120b'])
  })

  it('largest preference tries every healthy pair, sized ones first, unknown ones in their order', async () => {
    const f = scriptedFetch(() => BAD)
    const r = await createRouter(config([gemini, groq]), deps(f.fetchImpl)).run({
      ...REQ,
      modelPreference: 'largest',
    })
    expect(r).toEqual({ ok: false, code: 'INVALID_OUTPUT' })
    expect(tried(f.sent)).toEqual([PAIRS.big, PAIRS.small, PAIRS.lite, PAIRS.pro])
  })

  it("no preference keeps today's order", async () => {
    const f = scriptedFetch(() => BAD)
    const router = createRouter(config([groq, gemini]), deps(f.fetchImpl))
    await router.run(REQ)
    expect(tried(f.sent)).toEqual([PAIRS.small, PAIRS.big, PAIRS.lite, PAIRS.pro])
    f.sent.length = 0
    await router.run(REQ)
    expect(tried(f.sent)).toEqual([PAIRS.lite, PAIRS.pro, PAIRS.small, PAIRS.big])
  })

  it('a largest call does not advance the rotation of the next plain call', async () => {
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(config([gemini, groq]), deps(f.fetchImpl))
    await router.run({ ...REQ, modelPreference: 'largest' })
    await router.run(REQ)
    expect(byHost(f.sent)).toEqual([hostOf.groq, hostOf.gemini])
  })

  it("a route-level failure skips that route's remaining models in the flattened order", async () => {
    const f = scriptedFetch((s) =>
      s.model === 'openai/gpt-oss-120b' ? { status: 500, body: '' } : BAD,
    )
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([groq, gemini]), d).run({
      ...REQ,
      modelPreference: 'largest',
    })
    expect(tried(f.sent)).toEqual([PAIRS.big, PAIRS.lite, PAIRS.pro])
    // A transport failure among the invalid answers: the record is not proven at fault (H.2).
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
  })
})

describe('router: modelSizeB (R15)', () => {
  it.each([
    ['meta-llama/llama-3.3-70b-instruct', 70],
    ['70b', 70],
    ['QWEN2.5-1.5B', 1.5],
    ['mistralai/mixtral-8x7b-instruct', 56],
    ['qwen/qwen3-30b-a3b:free', 30],
    ['openai/gpt-oss-120b', 120],
    ['gemini-2.5-flash', undefined],
    ['model-a3b', undefined],
    ['model-3bit', undefined],
    ['', undefined],
  ] as [string, number | undefined][])('%s -> %s', (id, size) => {
    expect(modelSizeB(id)).toBe(size)
  })
})
