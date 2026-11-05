import { describe, expect, it } from 'vitest'
import { fakeFs } from './__test-helpers__/fake-fs'
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
import { BUSY_BACKOFF_MS, createRouter, type RouterEvent } from './router'
import {
  createFileRouteStatePort,
  createMemoryRouteStatePort,
  createOwnCapPort,
  isProviderBlocked,
  isRetired,
  isSpent,
  markAuth,
  markRetired,
  markSpent,
  EMPTY_ROUTE_STATE,
} from './state'

import { GEMINI_FIXTURES, GEMINI_MODEL } from '../internal/__fixtures__/gemini.fixtures'
import { GROQ_FIXTURES, GROQ_MODEL } from '../internal/__fixtures__/groq.fixtures'
import { BODY_MARKER, type ProviderFixture } from '../internal/__fixtures__/provider-fixture'

const NOON = Date.parse('2026-11-04T12:00:00Z')
const TODAY = '2026-11-04'
const FAIL: Reply = { status: 500, body: '' }
const groqError = (type = 'invalid_request_error') =>
  JSON.stringify({ error: { message: 'BODY', type } })
/** A 5.4c-1 provider fixture as a scripted reply: the router sees the cited provider formats. */
const fromFixture = (fx: ProviderFixture): Reply => ({
  status: fx.status,
  body: fx.body,
  ...(fx.headers !== undefined && { headers: fx.headers }),
})
const fixture = (list: ProviderFixture[], name: string): ProviderFixture =>
  list.find((f) => f.name === name)!
const geminiPerDay = fromFixture(fixture(GEMINI_FIXTURES, '429 per-day quota id'))
const notFound = (model: string): Reply => ({
  status: 404,
  body: JSON.stringify({ error: { message: `The model ${model} does not exist`, code: 'x' } }),
})
const sentTo = (sent: { host: string; model: string }[]) => sent.map((s) => `${s.host} ${s.model}`)
const ofType = <K extends RouterEvent['type']>(events: RouterEvent[], type: K) =>
  events.filter((e): e is Extract<RouterEvent, { type: K }> => e.type === type)
const at = (ms: number) => () => ms

/** Codes whose own-cap unit is given back (§5.1 unit table). */
const RELEASING = new Set(['AUTH', 'CREDIT', 'RETIRED'])

describe.each([
  ['groq', GROQ_FIXTURES, GROQ, GROQ_MODEL],
  ['gemini', GEMINI_FIXTURES, GEMINI, GEMINI_MODEL],
] as const)(
  'router over the %s provider fixtures (§5.1, SPEC-L-3)',
  (p, fixtures, route, model) => {
    it.each(fixtures.filter((fx) => !fx.expected.ok).map((fx) => [fx.name, fx] as const))(
      '%s: attempt code, HTTP status and unit',
      async (_name, fx) => {
        const cap = countingCap()
        let n = 0
        const f = scriptedFetch((s) =>
          s.host === hostOf.local ? GOOD : ++n === 1 ? fromFixture(fx) : FAIL,
        )
        const d = deps(f.fetchImpl, { ownCap: cap, now: at(NOON) })
        const r = await createRouter(config([{ ...route, models: [model] }, LOCAL]), d).run(REQ)
        expect(r).toMatchObject({ ok: true })
        expect(ofType(d.events, 'ATTEMPT')[0]).toMatchObject({
          route: p,
          model,
          code: fx.expected.code,
          status: fx.status,
        })
        expect(cap.released).toHaveLength(RELEASING.has(fx.expected.code) ? 1 : 0)
        expect(JSON.stringify(d.events)).not.toContain(BODY_MARKER)
      },
    )
  },
)

describe('router cascade: per-code actions (§5.1)', () => {
  it('SPENT_DAY (Groq remaining-requests 0) spends the model, tries the next model, and skips it on the next call', async () => {
    const f = scriptedFetch((s) =>
      s.model === 'openai/gpt-oss-120b'
        ? {
            status: 429,
            body: groqError('rate_limit'),
            headers: { 'x-ratelimit-remaining-requests': '0' },
          }
        : GOOD,
    )
    const d = deps(f.fetchImpl, { now: at(NOON) })
    const router = createRouter(config([GROQ, LOCAL]), d)
    expect((await router.run(REQ)).ok).toBe(true)
    expect(isSpent(d.routeState.snapshot(), 'groq', 'openai/gpt-oss-120b', TODAY)).toBe(true)
    await router.run(REQ)
    expect(sentTo(f.sent)).toEqual([
      `${hostOf.groq} openai/gpt-oss-120b`,
      `${hostOf.groq} openai/gpt-oss-20b`,
      `${hostOf.groq} openai/gpt-oss-20b`,
    ])
  })

  it('a spent model is open again on the next provider day', async () => {
    const routeState = createMemoryRouteStatePort(
      markSpent('groq', 'openai/gpt-oss-120b', TODAY)(EMPTY_ROUTE_STATE),
    )
    const f = scriptedFetch(() => GOOD)
    await createRouter(
      config([GROQ, LOCAL]),
      deps(f.fetchImpl, { routeState, now: at(NOON + 86_400_000) }),
    ).run(REQ)
    expect(f.sent[0]!.model).toBe('openai/gpt-oss-120b')
  })

  it('a Gemini per-day QuotaFailure spends the model', async () => {
    const f = scriptedFetch((s) => (s.model === 'gemini-2.5-flash' ? geminiPerDay : GOOD))
    const d = deps(f.fetchImpl, { now: at(NOON) })
    await createRouter(config([GEMINI, LOCAL]), d).run(REQ)
    expect(isSpent(d.routeState.snapshot(), 'gemini', 'gemini-2.5-flash', TODAY)).toBe(true)
  })

  it('RETIRED (404 naming the model) moves to the next model at once and is skipped later', async () => {
    const f = scriptedFetch((s) => (s.model === 'openai/gpt-oss-120b' ? notFound(s.model) : GOOD))
    const d = deps(f.fetchImpl)
    const router = createRouter(config([GROQ, LOCAL]), d)
    await router.run(REQ)
    await router.run(REQ)
    expect(sentTo(f.sent)).toEqual([
      `${hostOf.groq} openai/gpt-oss-120b`,
      `${hostOf.groq} openai/gpt-oss-20b`,
      `${hostOf.groq} openai/gpt-oss-20b`,
    ])
    expect(ofType(d.events, 'RETIRED')).toEqual([
      { type: 'RETIRED', route: 'groq', model: 'openai/gpt-oss-120b' },
    ])
  })

  it('a bare 404 is TRANSPORT: the next route, nothing retired', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.groq ? { status: 404, body: '' } : GOOD))
    const d = deps(f.fetchImpl)
    await createRouter(config([GROQ, LOCAL]), d).run(REQ)
    expect(sentTo(f.sent)).toEqual([
      `${hostOf.groq} openai/gpt-oss-120b`,
      `${hostOf.local} qwen2.5:3b`,
    ])
    expect(d.routeState.snapshot().retired).toEqual([])
  })

  it('a retirement persists across a restart (file adapter reloaded)', async () => {
    const fs = fakeFs()
    const path = '/data/route-state.json'
    const f = scriptedFetch((s) => (s.model === 'openai/gpt-oss-120b' ? notFound(s.model) : GOOD))
    const first = await createFileRouteStatePort({ path, fs, now: at(NOON), onEvent: () => {} })
    await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl, { routeState: first })).run(REQ)
    const reloaded = await createFileRouteStatePort({ path, fs, now: at(NOON), onEvent: () => {} })
    const f2 = scriptedFetch(() => GOOD)
    await createRouter(config([GROQ, LOCAL]), deps(f2.fetchImpl, { routeState: reloaded })).run(REQ)
    expect(f2.sent.map((s) => s.model)).toEqual(['openai/gpt-oss-20b'])
  })

  it('a hand-retired pinned model is skipped from the first call', async () => {
    const routeState = createMemoryRouteStatePort(
      markRetired('groq', 'openai/gpt-oss-120b', NOON)(EMPTY_ROUTE_STATE),
    )
    const f = scriptedFetch(() => GOOD)
    await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl, { routeState })).run(REQ)
    expect(f.sent[0]!.model).toBe('openai/gpt-oss-20b')
  })

  it.each([
    ['401', { status: 401, body: groqError() }],
    ['403 with the documented envelope', { status: 403, body: groqError('permission_error') }],
  ] as [string, Reply][])(
    'AUTH (%s) disables the provider persistently, emits once, and moves to the next route',
    async (_l, reply) => {
      const f = scriptedFetch((s) => (s.host === hostOf.groq ? reply : GOOD))
      const d = deps(f.fetchImpl)
      const router = createRouter(config([GROQ, GEMINI, LOCAL]), d)
      await router.run(REQ)
      await router.run(REQ)
      await router.run(REQ)
      expect(sentTo(f.sent).filter((s) => s.startsWith(hostOf.groq))).toEqual([
        `${hostOf.groq} openai/gpt-oss-120b`,
      ])
      expect(isProviderBlocked(d.routeState.snapshot(), 'groq', TODAY)).toBe(true)
      expect(ofType(d.events, 'PROVIDER_DISABLED')).toEqual([
        { type: 'PROVIDER_DISABLED', route: 'groq', code: 'AUTH' },
      ])
    },
  )

  it('a persisted AUTH bit sends nothing to that provider after a restart and emits once', async () => {
    const routeState = createMemoryRouteStatePort(markAuth('groq')(EMPTY_ROUTE_STATE))
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { routeState })
    const router = createRouter(config([GROQ, LOCAL]), d)
    await router.run(REQ)
    await router.run(REQ)
    expect(sentTo(f.sent)).toEqual([`${hostOf.local} qwen2.5:3b`, `${hostOf.local} qwen2.5:3b`])
    expect(ofType(d.events, 'PROVIDER_DISABLED')).toHaveLength(1)
    expect(ofType(d.events, 'FELL_TO_LOCAL')[0]).toMatchObject({
      plan: 'small',
      reasons: [{ route: 'groq', code: 'AUTH' }],
    })
  })

  it.each([
    ['HTML', '<html>Forbidden</html>'],
    ['empty', ''],
    ['foreign JSON', JSON.stringify({ message: 'no' })],
  ])('a 403 with a %s body is TRANSPORT and persists nothing', async (_l, body) => {
    const f = scriptedFetch((s) => (s.host === hostOf.groq ? { status: 403, body } : GOOD))
    const d = deps(f.fetchImpl)
    await createRouter(config([GROQ, LOCAL]), d).run(REQ)
    expect(d.routeState.snapshot()).toEqual(EMPTY_ROUTE_STATE)
    expect(ofType(d.events, 'FELL_TO_LOCAL')[0]?.reasons).toEqual([
      { route: 'groq', code: 'TRANSPORT' },
    ])
  })

  it('CREDIT (402) blocks the provider for its day only', async () => {
    let now = NOON
    const f = scriptedFetch((s) => (s.host === hostOf.groq ? { status: 402, body: '' } : GOOD))
    const d = deps(f.fetchImpl, { now: () => now })
    const router = createRouter(config([GROQ, LOCAL]), d)
    await router.run(REQ)
    await router.run(REQ)
    now = NOON + 86_400_000
    await router.run(REQ)
    expect(f.sent.filter((s) => s.host === hostOf.groq)).toHaveLength(2)
    expect(ofType(d.events, 'PROVIDER_DISABLED')).toEqual([
      { type: 'PROVIDER_DISABLED', route: 'groq', code: 'CREDIT' },
    ])
  })

  it('REFUSED (content filter) moves to the next route and never retries the same provider', async () => {
    const f = scriptedFetch((s) =>
      s.host === hostOf.groq ? answer('', {}, 'content_filter') : GOOD,
    )
    const d = deps(f.fetchImpl)
    await createRouter(config([GROQ, GEMINI, LOCAL]), d).run(REQ)
    expect(sentTo(f.sent)).toEqual([
      `${hostOf.groq} openai/gpt-oss-120b`,
      `${hostOf.gemini} gemini-2.5-flash`,
    ])
    expect(d.routeState.snapshot()).toEqual(EMPTY_ROUTE_STATE)
  })

  it('INVALID_OUTPUT after the correction retry moves to the next model of the same route', async () => {
    const f = scriptedFetch((s) => (s.model === 'openai/gpt-oss-120b' ? answer('not json') : GOOD))
    await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl)).run(REQ)
    expect(f.sent.map((s) => s.model)).toEqual([
      'openai/gpt-oss-120b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
    ])
  })

  it('finish_reason length is INVALID_OUTPUT, never a partial answer', async () => {
    const f = scriptedFetch((s) =>
      s.host === hostOf.groq ? answer({ title: 'x' }, {}, 'length') : FAIL,
    )
    const r = await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl)).run(REQ)
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR', usage: { localMs: expect.any(Number) } })
  })

  it('the word quota in the input changes nothing: a markerless 429 stays BUSY', async () => {
    const input = 'quota exceeded PerDay RESOURCE_EXHAUSTED x-ratelimit-remaining-requests: 0'
    const f = scriptedFetch((s) =>
      s.host === hostOf.groq ? { status: 429, body: groqError('rate_limit') } : GOOD,
    )
    const d = deps(f.fetchImpl, { now: at(NOON) })
    await createRouter(config([GROQ, LOCAL]), d).run({ ...REQ, input })
    expect(d.routeState.snapshot()).toEqual(EMPTY_ROUTE_STATE)
    expect(
      ofType(d.events, 'ATTEMPT')
        .filter((e) => e.route === 'groq')
        .map((e) => e.code),
    ).toContain('BUSY')
  })

  it('TIMEOUT and TRANSPORT move to the next route', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.groq ? 'network' : GOOD))
    const d = deps(f.fetchImpl)
    await createRouter(config([GROQ, GEMINI, LOCAL]), d).run(REQ)
    expect(sentTo(f.sent)).toEqual([
      `${hostOf.groq} openai/gpt-oss-120b`,
      `${hostOf.gemini} gemini-2.5-flash`,
    ])
  })
})

describe('router cascade: BUSY (§5.1)', () => {
  const busy = (headers: Record<string, string> = {}): Reply => ({
    status: 429,
    body: groqError('rate_limit'),
    headers,
  })

  it('waits once with the backoff, then retries the same model', async () => {
    const f = scriptedFetch((_s, n) => (n === 1 ? busy() : GOOD))
    const d = deps(f.fetchImpl)
    expect((await createRouter(config([GROQ, LOCAL]), d).run(REQ)).ok).toBe(true)
    expect(d.sleeps).toEqual([BUSY_BACKOFF_MS])
    expect(f.sent.map((s) => s.model)).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-120b'])
  })

  it('a second BUSY on the same model never loops: next model', async () => {
    const f = scriptedFetch((s) =>
      s.model === 'openai/gpt-oss-120b' ? busy({ 'retry-after': '2' }) : GOOD,
    )
    const d = deps(f.fetchImpl)
    await createRouter(config([GROQ, LOCAL]), d).run(REQ)
    expect(d.sleeps).toEqual([2000])
    expect(f.sent.map((s) => s.model)).toEqual([
      'openai/gpt-oss-120b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
    ])
  })

  it('a retry-after longer than the backoff cools the model down without waiting, until it elapses', async () => {
    let now = NOON
    const f = scriptedFetch((s, n) =>
      s.model === 'openai/gpt-oss-120b' && n === 1 ? busy({ 'retry-after': '20' }) : GOOD,
    )
    const d = deps(f.fetchImpl, { now: () => now })
    // 20 s is above the 9 s backoff and inside the 60 s budget: a cool-down, never a wait.
    const router = createRouter(config([GROQ, LOCAL]), d)
    await router.run(REQ)
    await router.run(REQ)
    now += 20_000
    await router.run(REQ)
    expect(d.sleeps).toEqual([])
    expect(f.sent.map((s) => s.model)).toEqual([
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
    ])
  })

  it('two cool-downs at once: the expired one is tried again, the active one still blocks (CR-M-6)', async () => {
    let now = NOON
    let hosted = 0
    const f = scriptedFetch((s) => {
      if (s.host === hostOf.local) return GOOD
      hosted++
      if (hosted === 1) return busy({ 'retry-after': '20' }) // 120b cools for 20 s
      if (hosted === 2) return busy({ 'retry-after': '40' }) // 20b cools for 40 s
      return answer('nope') // 120b, tried again, gives no valid answer
    })
    const d = deps(f.fetchImpl, { now: () => now })
    const router = createRouter(config([GROQ, LOCAL]), d)
    await router.run(REQ)
    now += 20_000
    await router.run(REQ)
    expect(f.sent.filter((s) => s.host === hostOf.groq).map((s) => s.model)).toEqual([
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-120b',
    ])
    now += 20_000
    await router.run(REQ)
    expect(f.sent.filter((s) => s.host === hostOf.groq).at(-1)?.model).toBe('openai/gpt-oss-20b')
  })

  it('a cool-down ends at the provider day turn', async () => {
    let now = Date.parse('2026-11-04T23:59:00Z')
    const f = scriptedFetch((s, n) => (n === 1 ? busy({ 'retry-after': '3600' }) : GOOD))
    const router = createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl, { now: () => now }))
    await router.run(REQ)
    now = Date.parse('2026-11-05T00:00:30Z')
    await router.run(REQ)
    expect(f.sent.at(-1)!.model).toBe('openai/gpt-oss-120b')
  })

  it('an unparsable retry-after counts as absent: the backoff is used', async () => {
    const f = scriptedFetch((_s, n) => (n === 1 ? busy({ 'retry-after': 'soon' }) : GOOD))
    const d = deps(f.fetchImpl)
    await createRouter(config([GROQ, LOCAL]), d).run(REQ)
    expect(d.sleeps).toEqual([BUSY_BACKOFF_MS])
  })

  it('no wait when the hosted budget cannot hold it', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.groq ? busy() : GOOD))
    const d = deps(f.fetchImpl, { now: at(NOON) })
    await createRouter(config([GROQ, LOCAL], { hostedBudgetMs: BUSY_BACKOFF_MS }), d).run(REQ)
    expect(d.sleeps).toEqual([])
  })

  it('a 503 is BUSY', async () => {
    const f = scriptedFetch((_s, n) => (n === 1 ? { status: 503, body: '' } : GOOD))
    const d = deps(f.fetchImpl)
    await createRouter(config([GROQ, LOCAL]), d).run(REQ)
    expect(d.sleeps).toEqual([BUSY_BACKOFF_MS])
  })
})

describe('router cascade: Gemini re-route (§5.1 RETIRED on a 2xx)', () => {
  it('a 2xx naming another version is used and retires the requested id', async () => {
    const f = scriptedFetch(() =>
      answer({ title: 'Engineer' }, { model: 'models/gemini-3.0-flash' }),
    )
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([GEMINI, LOCAL]), d).run(REQ)
    expect(r).toMatchObject({ ok: true, data: { title: 'Engineer' } })
    expect(isRetired(d.routeState.snapshot(), 'gemini', 'gemini-2.5-flash')).toBe(true)
    expect(ofType(d.events, 'RETIRED')).toEqual([
      {
        type: 'RETIRED',
        route: 'gemini',
        model: 'gemini-2.5-flash',
        servedModel: 'gemini-3.0-flash',
      },
    ])
  })

  it.each(['gemini-2.5-flash-001', 'not a model', 'gemini-2.5-flash'])(
    'a response id %j retires nothing',
    async (served) => {
      const f = scriptedFetch(() => answer({ title: 'Engineer' }, { model: served }))
      const d = deps(f.fetchImpl)
      await createRouter(config([GEMINI, LOCAL]), d).run(REQ)
      expect(d.routeState.snapshot().retired).toEqual([])
    },
  )
})

describe('router cascade: own-cap units (§5.1 unit table)', () => {
  it.each([
    ['OK', GOOD, 0],
    ['BUSY', { status: 503, body: '' }, 0],
    ['SPENT_DAY', { status: 429, body: '', headers: { 'x-ratelimit-remaining-requests': '0' } }, 0],
    ['REFUSED', answer('', {}, 'content_filter'), 0],
    ['INVALID_OUTPUT', answer('', {}), 0],
    ['TRANSPORT with a response', FAIL, 0],
    ['AUTH', { status: 401, body: '' }, 1],
    ['CREDIT', { status: 402, body: '' }, 1],
    ['RETIRED after a 404', notFound('openai/gpt-oss-120b'), 1],
    ['TRANSPORT with no response', 'network', 1],
  ] as [string, Reply, number][])(
    '%s: released units %i for the first request',
    async (_l, reply, released) => {
      const cap = countingCap()
      const f = scriptedFetch((s, n) => (n === 1 ? reply : s.host === hostOf.local ? GOOD : FAIL))
      await createRouter(
        config([{ ...GROQ, models: ['openai/gpt-oss-120b'] }, LOCAL]),
        deps(f.fetchImpl, { ownCap: cap, sleep: async () => undefined }),
      ).run(REQ)
      expect(cap.released).toHaveLength(released)
      expect(cap.reserved.length).toBeGreaterThan(0)
    },
  )

  it('a Gemini re-route commits its unit', async () => {
    const cap = countingCap()
    const f = scriptedFetch(() => answer({ title: 'x' }, { model: 'gemini-3.0-flash' }))
    await createRouter(config([GEMINI, LOCAL]), deps(f.fetchImpl, { ownCap: cap })).run(REQ)
    expect(cap.reserved).toEqual(['gemini'])
    expect(cap.released).toEqual([])
  })

  it('the correction retry and a BUSY retry reserve their own units', async () => {
    const cap = countingCap()
    const replies: Reply[] = [{ status: 503, body: '' }, answer('nope'), GOOD]
    const f = scriptedFetch((_s, n) => replies[n - 1]!)
    await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl, { ownCap: cap })).run(REQ)
    expect(cap.reserved).toEqual(['groq', 'groq', 'groq'])
    expect(f.sent).toHaveLength(3)
  })

  it('a refused unit sends no request to that provider', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { ownCap: countingCap(false) })
    await createRouter(config([GROQ, GEMINI, LOCAL]), d).run(REQ)
    expect(sentTo(f.sent)).toEqual([`${hostOf.local} qwen2.5:3b`])
    expect(ofType(d.events, 'FELL_TO_LOCAL')[0]?.reasons).toEqual([
      { route: 'groq', code: 'CAP' },
      { route: 'gemini', code: 'CAP' },
    ])
  })

  it('the local floor reserves no unit', async () => {
    const cap = countingCap()
    const f = scriptedFetch(() => GOOD)
    await createRouter(config([LOCAL]), deps(f.fetchImpl, { ownCap: cap })).run(REQ)
    expect(cap.reserved).toEqual([])
  })

  it('answer tokens are added to the own cap', async () => {
    const cap = countingCap()
    const f = scriptedFetch(() => GOOD)
    await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl, { ownCap: cap })).run(REQ)
    expect(cap.tokens).toBe(10)
  })

  it('every reservation carries the route config free limit', async () => {
    const cap = countingCap()
    const f = scriptedFetch((_s, n) => (n === 1 ? answer('nope') : GOOD))
    const tokens = { ...GEMINI, freeLimit: { requestsPerDay: 1000, tokensPerDay: 250_000 } }
    await createRouter(config([tokens, LOCAL]), deps(f.fetchImpl, { ownCap: cap })).run(REQ)
    expect(cap.limits).toEqual([tokens.freeLimit, tokens.freeLimit])
  })

  it('the cap is 50 % of the config free limit, the only limit source (CR-M-2)', async () => {
    const routeState = createMemoryRouteStatePort()
    const ownCap = createOwnCapPort({ state: routeState, now: at(NOON) })
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(
      config([{ ...GROQ, freeLimit: { requestsPerDay: 4 } }, LOCAL]),
      deps(f.fetchImpl, { routeState, ownCap, now: at(NOON) }),
    )
    for (let i = 0; i < 4; i++) await router.run(REQ)
    expect(f.sent.filter((s) => s.host === hostOf.groq)).toHaveLength(2)
    expect(f.sent.filter((s) => s.host === hostOf.local)).toHaveLength(2)
  })
})

describe('router cascade: budget, gap and PROMPT_TOO_LARGE', () => {
  it('two overlapping calls claim separate gap slots before sending (CR-M-3)', async () => {
    const f = scriptedFetch((): Reply => ({ ...(GOOD as Exclude<Reply, string>), delayMs: 10 }))
    const d = deps(f.fetchImpl, { now: at(NOON) })
    const router = createRouter(config([{ ...GROQ, minGapMs: 3000 }, LOCAL]), d)
    await Promise.all([router.run(REQ), router.run(REQ)])
    expect(d.sleeps).toEqual([3000])
    expect(f.sent.filter((s) => s.host === hostOf.groq)).toHaveLength(2)
  })

  it('a gap slot at or past the hosted deadline is BUDGET and gives the unit back', async () => {
    const cap = countingCap()
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { now: at(NOON), ownCap: cap })
    const router = createRouter(
      config([{ ...GROQ, minGapMs: 5000 }, LOCAL], { hostedBudgetMs: 5000 }),
      d,
    )
    await router.run(REQ)
    await router.run(REQ)
    expect(cap.reserved).toEqual(['groq', 'groq'])
    expect(cap.released).toEqual(['groq'])
    expect(ofType(d.events, 'FELL_TO_LOCAL')[0]?.reasons).toEqual([
      { route: 'groq', code: 'BUDGET' },
    ])
    expect(d.sleeps).toEqual([])
  })

  it('the minimum gap is waited out between two requests to one provider', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { now: at(NOON) })
    const router = createRouter(config([{ ...GROQ, minGapMs: 3000 }, LOCAL]), d)
    await router.run(REQ)
    await router.run(REQ)
    expect(d.sleeps).toEqual([3000])
  })

  it('a gap that would overrun the hosted budget sends nothing and falls', async () => {
    const f = scriptedFetch(() => GOOD)
    const cap = countingCap()
    const d = deps(f.fetchImpl, { now: at(NOON), ownCap: cap })
    const router = createRouter(
      config([{ ...GROQ, minGapMs: 60_000 }, LOCAL], { hostedBudgetMs: 30_000 }),
      d,
    )
    await router.run(REQ)
    await router.run(REQ)
    expect(sentTo(f.sent)).toEqual([
      `${hostOf.groq} openai/gpt-oss-120b`,
      `${hostOf.local} qwen2.5:3b`,
    ])
    expect(cap.released).toEqual(['groq'])
    expect(ofType(d.events, 'FELL_TO_LOCAL')[0]?.reasons).toEqual([
      { route: 'groq', code: 'BUDGET' },
    ])
  })

  it('a spent hosted budget sends no hosted request', async () => {
    let now = NOON
    const f = scriptedFetch((s) => {
      now += 61_000
      return s.host === hostOf.local ? GOOD : FAIL
    })
    await createRouter(config([GROQ, GEMINI, LOCAL]), deps(f.fetchImpl, { now: () => now })).run(
      REQ,
    )
    expect(f.sent.map((s) => s.host)).toEqual([hostOf.groq, hostOf.local])
  })

  it('a zero hosted budget goes straight to the floor', async () => {
    const f = scriptedFetch(() => GOOD)
    await createRouter(
      config([GROQ, LOCAL], { hostedBudgetMs: 0 }),
      deps(f.fetchImpl, { now: at(NOON) }),
    ).run(REQ)
    expect(f.sent.map((s) => s.host)).toEqual([hostOf.local])
  })

  it('a prompt over the local window is PROMPT_TOO_LARGE: zero local requests, public INVALID_OUTPUT', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl)
    const local = { ...LOCAL, contextTokens: 1_000 }
    const r = await createRouter(config([local]), d).run({ ...REQ, input: 'x'.repeat(2_000) })
    expect(r).toEqual({ ok: false, code: 'INVALID_OUTPUT' })
    expect(f.sent).toHaveLength(0)
    expect(ofType(d.events, 'ATTEMPT')).toEqual([
      expect.objectContaining({ route: 'local', code: 'PROMPT_TOO_LARGE' }),
    ])
  })

  it('a floor whose budget is exactly spent sends nothing more and times out', async () => {
    let now = NOON
    const f = scriptedFetch(() => {
      now += 150_000
      return answer('nope')
    })
    const r = await createRouter(
      config([LOCAL], { floorBudgetMs: 150_000 }),
      deps(f.fetchImpl, { now: () => now }),
    ).run(REQ)
    expect(r).toEqual({ ok: false, code: 'TIMEOUT', usage: { localMs: 150_000 } })
    expect(f.sent).toHaveLength(1)
  })

  it('a gap that ends exactly at the hosted deadline sends nothing', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.local ? GOOD : FAIL))
    const d = deps(f.fetchImpl, { now: at(NOON) })
    const router = createRouter(
      config([{ ...GROQ, minGapMs: 3000 }, LOCAL], { hostedBudgetMs: 3000 }),
      d,
    )
    await router.run(REQ)
    await router.run(REQ)
    expect(d.sleeps).toEqual([])
    expect(f.sent.filter((s) => s.host === hostOf.groq)).toHaveLength(1)
  })

  it('a spent hosted budget is reported per route as BUDGET', async () => {
    let now = NOON
    const f = scriptedFetch((s) => {
      now += 61_000
      return s.host === hostOf.local ? GOOD : FAIL
    })
    const d = deps(f.fetchImpl, { now: () => now })
    await createRouter(config([GROQ, GEMINI, LOCAL]), d).run(REQ)
    expect(ofType(d.events, 'FELL_TO_LOCAL')[0]?.reasons).toEqual([
      { route: 'groq', code: 'TRANSPORT' },
      { route: 'gemini', code: 'BUDGET' },
    ])
  })
})

describe('router events: exact payloads', () => {
  it('ATTEMPT and CALL carry exact latencies and tokens', async () => {
    let now = NOON
    const f = scriptedFetch(() => {
      now += 100
      return GOOD
    })
    const d = deps(f.fetchImpl, { now: () => now })
    await createRouter(config([GROQ, LOCAL]), d).run(REQ)
    expect(d.events).toStrictEqual([
      {
        type: 'ATTEMPT',
        route: 'groq',
        model: 'openai/gpt-oss-120b',
        code: 'OK',
        inputChars: REQ.input.length,
        latencyMs: 100,
        status: 200,
        totalTokens: 10,
      },
      { type: 'CALL', code: 'OK', floorAnswered: false, latencyMs: 100 },
    ])
  })

  it('an answer without usage leaves usage, tokens and the cap untouched', async () => {
    const noUsage: Reply = {
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: '{"title":"x"}' }, finish_reason: 'stop' }],
      }),
    }
    const cap = countingCap()
    const f = scriptedFetch(() => noUsage)
    const d = deps(f.fetchImpl, { ownCap: cap })
    const r = await createRouter(config([GROQ, LOCAL]), d).run(REQ)
    expect(r).toStrictEqual({ ok: true, data: { title: 'x' } })
    expect(cap.tokens).toBe(0)
    expect(Object.keys(ofType(d.events, 'ATTEMPT')[0]!)).not.toContain('totalTokens')
  })

  it('a refusal carries its HTTP status and no tokens; a lost connection carries neither (SPEC-M-2)', async () => {
    const f = scriptedFetch((s, n) =>
      n === 1 ? { status: 401, body: '{}' } : s.host === hostOf.local ? 'network' : GOOD,
    )
    const d = deps(f.fetchImpl, { now: at(NOON) })
    await createRouter(config([GROQ, LOCAL]), d).run(REQ)
    const attempts = ofType(d.events, 'ATTEMPT')
    expect(attempts.map((e) => [e.route, e.code, e.status, e.totalTokens])).toEqual([
      ['groq', 'AUTH', 401, undefined],
      ['local', 'TRANSPORT', undefined, undefined],
    ])
    expect(Object.keys(attempts[1]!)).not.toContain('status')
  })

  it('a floor answer and a floor failure are reported as such, with the local route', async () => {
    const ok = scriptedFetch(() => GOOD)
    const d1 = deps(ok.fetchImpl, { now: at(NOON) })
    await createRouter(config([LOCAL]), d1).run(REQ)
    expect(ofType(d1.events, 'ATTEMPT')).toStrictEqual([
      {
        type: 'ATTEMPT',
        route: 'local',
        model: 'qwen2.5:3b',
        code: 'OK',
        inputChars: REQ.input.length,
        latencyMs: 0,
        status: 200,
        totalTokens: 10,
      },
    ])
    const bad = scriptedFetch(() => FAIL)
    const d2 = deps(bad.fetchImpl, { now: at(NOON) })
    await createRouter(config([LOCAL]), d2).run(REQ)
    expect(ofType(d2.events, 'CALL')).toStrictEqual([
      { type: 'CALL', code: 'PROVIDER_ERROR', floorAnswered: false, latencyMs: 0 },
    ])
  })

  it('a route whose every model is spent or retired is NO_MODEL and the plan is small', async () => {
    const routeState = createMemoryRouteStatePort(
      markRetired(
        'groq',
        'openai/gpt-oss-20b',
        NOON,
      )(markSpent('groq', 'openai/gpt-oss-120b', TODAY)(EMPTY_ROUTE_STATE)),
    )
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { routeState, now: at(NOON) })
    await createRouter(config([GROQ, LOCAL]), d).run(REQ)
    expect(f.sent.map((s) => s.host)).toEqual([hostOf.local])
    expect(ofType(d.events, 'FELL_TO_LOCAL')).toEqual([
      { type: 'FELL_TO_LOCAL', plan: 'small', reasons: [{ route: 'groq', code: 'NO_MODEL' }] },
    ])
  })

  it('a retired model that is not spent is still skipped', async () => {
    const routeState = createMemoryRouteStatePort(
      markRetired('groq', 'openai/gpt-oss-120b', NOON)(EMPTY_ROUTE_STATE),
    )
    const f = scriptedFetch(() => GOOD)
    await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl, { routeState })).run(REQ)
    expect(f.sent.map((s) => s.model)).toEqual(['openai/gpt-oss-20b'])
  })

  it('the hosted request carries the caller instruction and, on retry, the correction', async () => {
    const f = scriptedFetch((_s, n) => (n === 1 ? answer('nope') : GOOD))
    await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      instruction: 'fixed instruction',
    })
    const messages = f.sent.map((s) => s.body.messages as { role: string; content: string }[])
    expect(messages[0]![0]).toEqual({ role: 'system', content: 'fixed instruction' })
    expect(messages[0]).toHaveLength(2)
    expect(messages[1]![2]!.content).toMatch(/^Your previous answer was rejected\. /)
  })
})
