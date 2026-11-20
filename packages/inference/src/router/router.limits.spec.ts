import { describe, expect, it } from 'vitest'
import {
  answer,
  config,
  countingCap,
  deps,
  GEMINI,
  GOOD,
  GROQ,
  hostOf,
  OPENROUTER,
  REQ,
  scriptedFetch,
  type Reply,
} from './__test-helpers__/router-harness'
import type { HostedProvider } from './config'
import { createRouter, createRouterExtractionAdapter, type RouterEvent } from './router'
import {
  createMemoryRouteStatePort,
  createOwnCapPort,
  EMPTY_ROUTE_STATE,
  markAuth,
  markCredit,
  markFlagRejected,
  markProviderSpent,
  markRetired,
  markSpent,
  providerDay,
  type OwnCapPort,
  type RouteState,
  type RouteStatePort,
} from './state'
import { GEMINI_FIXTURES } from '../internal/__fixtures__/gemini.fixtures'

/**
 * The all-limit-blocked outcome (ADR Amendment 2026-11-08 H.2), one case per row of its truth
 * table. Groq answers by host; Gemini is driven the same way. Every route is "available" unless the
 * row disables it with `AUTH`.
 */
const NOON = Date.parse('2026-11-04T12:00:00Z')
const now = () => NOON
const day = (p: HostedProvider) => providerDay(p, NOON)
const ofType = <K extends RouterEvent['type']>(events: RouterEvent[], type: K) =>
  events.filter((e): e is Extract<RouterEvent, { type: K }> => e.type === type)

const SPENT: Reply = {
  status: 429,
  body: '',
  headers: { 'x-ratelimit-remaining-requests': '0' },
}
const GEMINI_SPENT: Reply = (() => {
  const fx = GEMINI_FIXTURES.find((f) => f.name === '429 per-day quota id')!
  return {
    status: fx.status,
    body: fx.body,
    ...(fx.headers !== undefined && { headers: fx.headers }),
  }
})()
const BUSY: Reply = { status: 503, body: '' }
const FAIL: Reply = { status: 500, body: '' }
const CREDIT: Reply = { status: 402, body: '' }
const UNAUTHORIZED: Reply = { status: 401, body: '' }
const notFound = (model: string): Reply => ({
  status: 404,
  body: JSON.stringify({ error: { message: `The model ${model} does not exist`, code: 'x' } }),
})

type State = (s: RouteState) => RouteState
const spentAll =
  (route: { provider: HostedProvider; models: string[] }): State =>
  (s) =>
    route.models.reduce((acc, m) => markSpent(route.provider, m, day(route.provider))(acc), s)
const credit =
  (p: HostedProvider): State =>
  (s) =>
    markCredit(p, day(p))(s)
const auth =
  (p: HostedProvider): State =>
  (s) =>
    markAuth(p)(s)
const stateOf = (...changes: State[]) =>
  createMemoryRouteStatePort(changes.reduce((s, c) => c(s), EMPTY_ROUTE_STATE))

/** An own cap that refuses one provider and grants the others. */
function capRefusing(refused: HostedProvider[]): OwnCapPort & { reserved: string[] } {
  const base = countingCap()
  return {
    ...base,
    reserve: async (p, limit) => (refused.includes(p) ? null : base.reserve(p, limit)),
  }
}

/** Groq's script answers per host: `groq` for Groq's requests, `gemini` for Gemini's. */
function run(opts: {
  groq?: (model: string) => Reply
  gemini?: (model: string) => Reply
  state?: State[]
  cap?: OwnCapPort
  routes?: unknown[]
  extra?: object
}) {
  const f = scriptedFetch((s) =>
    s.host === hostOf.groq
      ? (opts.groq ?? (() => GOOD))(s.model)
      : (opts.gemini ?? (() => GOOD))(s.model),
  )
  const d = deps(f.fetchImpl, {
    now,
    routeState: stateOf(...(opts.state ?? [])),
    ...(opts.cap !== undefined && { ownCap: opts.cap }),
  })
  const router = createRouter(config(opts.routes ?? [GROQ, GEMINI], opts.extra), d)
  return { f, d, run: () => router.run(REQ) }
}

describe('LIMITS_EXHAUSTED: every available route limit-blocked (H.2 rows 1–3)', () => {
  it.each<[string, Parameters<typeof run>[0]]>([
    ['own cap on both (CAP)', { cap: capRefusing(['groq', 'gemini']) }],
    ['SPENT_DAY in this call on both', { groq: () => SPENT, gemini: () => GEMINI_SPENT }],
    ['a spent entry in state on both', { state: [spentAll(GROQ), spentAll(GEMINI)] }],
    ['the CREDIT bit in state on both', { state: [credit('groq'), credit('gemini')] }],
    [
      'CREDIT in this call on one, spent in state on the other',
      { groq: () => CREDIT, state: [spentAll(GEMINI)] },
    ],
    [
      'a mix: CAP, then SPENT_DAY in this call',
      { cap: capRefusing(['groq']), gemini: () => GEMINI_SPENT },
    ],
  ])('%s → LIMITS_EXHAUSTED', async (_l, opts) => {
    const { d, run: go } = run(opts)
    expect(await go()).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
    expect(ofType(d.events, 'CALL')).toEqual([
      { type: 'CALL', code: 'LIMITS_EXHAUSTED', latencyMs: expect.any(Number) },
    ])
  })

  it('Groq spent model by model in this call (two models) is limit-blocked', async () => {
    const { f, run: go } = run({ groq: () => SPENT, routes: [GROQ] })
    expect(await go()).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
    expect(f.sent.map((s) => s.model)).toEqual(GROQ.models)
  })

  it('one model spent in state, the other spent in this call, is limit-blocked', async () => {
    const { f, run: go } = run({
      groq: () => SPENT,
      routes: [GROQ],
      state: [(s) => markSpent('groq', GROQ.models[0]!, day('groq'))(s)],
    })
    expect(await go()).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
    expect(f.sent.map((s) => s.model)).toEqual([GROQ.models[1]])
  })

  it('a retired model is not one the route could try: spent + retired is limit-blocked (A1)', async () => {
    const { run: go } = run({
      routes: [GROQ],
      state: [
        (s) => markSpent('groq', GROQ.models[0]!, day('groq'))(s),
        (s) => markRetired('groq', GROQ.models[1]!, NOON)(s),
      ],
    })
    expect(await go()).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
  })

  it('an all-spent route skipped before the cascade reports SPENT_DAY, not NO_MODEL', async () => {
    const { d, run: go } = run({ state: [spentAll(GROQ), spentAll(GEMINI)] })
    await go()
    expect(ofType(d.events, 'EXHAUSTED')).toEqual([
      {
        type: 'EXHAUSTED',
        reasons: [
          { route: 'groq', code: 'SPENT_DAY' },
          { route: 'gemini', code: 'SPENT_DAY' },
        ],
      },
    ])
  })

  it('the EXHAUSTED event carries one reason per ended route attempt: route and code only', async () => {
    const { d, run: go } = run({ cap: capRefusing(['groq']), gemini: () => GEMINI_SPENT })
    await go()
    const [exhausted] = ofType(d.events, 'EXHAUSTED')
    expect(exhausted).toEqual({
      type: 'EXHAUSTED',
      reasons: [
        { route: 'groq', code: 'CAP' },
        { route: 'gemini', code: 'SPENT_DAY' },
        { route: 'gemini', code: 'SPENT_DAY' },
      ],
    })
    for (const r of exhausted!.reasons) expect(Object.keys(r).sort()).toEqual(['code', 'route'])
  })
})

describe('a transient route next to a spent one keeps today’s code (H.2 row 4)', () => {
  const groqSpent: State[] = [spentAll(GROQ)]
  const ONE_GEMINI = { ...GEMINI, models: ['gemini-2.5-flash'] }
  it.each<[string, Parameters<typeof run>[0], string]>([
    ['BUSY', { state: groqSpent, gemini: () => BUSY }, 'PROVIDER_ERROR'],
    [
      'TIMEOUT',
      { state: groqSpent, gemini: () => 'hang', routes: [GROQ, { ...ONE_GEMINI, timeoutMs: 20 }] },
      'PROVIDER_ERROR',
    ],
    ['TRANSPORT', { state: groqSpent, gemini: () => FAIL }, 'PROVIDER_ERROR'],
    ['INVALID_OUTPUT', { state: groqSpent, gemini: () => answer('not json') }, 'PROVIDER_ERROR'],
    [
      'REFUSED',
      { state: groqSpent, gemini: () => answer('', {}, 'content_filter') },
      'PROVIDER_ERROR',
    ],
    [
      'FIT',
      { state: groqSpent, routes: [GROQ, { ...GEMINI, contextTokens: 1 }] },
      'PROVIDER_ERROR',
    ],
    [
      'RETIRED with nothing left',
      { state: groqSpent, gemini: (m) => notFound(m) },
      'PROVIDER_ERROR',
    ],
    [
      'a model cooling down (BUSY earlier, not spent)',
      { groq: () => SPENT, gemini: () => BUSY, routes: [GROQ, ONE_GEMINI] },
      'PROVIDER_ERROR',
    ],
  ])('one spent + one %s → %s, never LIMITS_EXHAUSTED', async (_l, opts, code) => {
    const { run: go } = run(opts)
    expect(await go()).toEqual({ ok: false, code })
  })

  it('one spent + one BUDGET (the call’s own time ran out) is transient', async () => {
    let calls = 0
    // The first read starts the call; every later one is past the hosted budget, the same day.
    const clock = () => (calls++ === 0 ? NOON : NOON + 60_001)
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { now: clock, routeState: stateOf(spentAll(GROQ)) })
    const r = await createRouter(config([GROQ, GEMINI]), d).run(REQ)
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toEqual([])
    expect(ofType(d.events, 'EXHAUSTED')[0]?.reasons).toContainEqual({
      route: 'gemini',
      code: 'BUDGET',
    })
  })

  it('every model INVALID_OUTPUT next to a spent route stays PROVIDER_ERROR (not every attempt invalid)', async () => {
    const { run: go } = run({ groq: () => SPENT, gemini: () => answer('not json') })
    expect(await go()).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
  })

  it('a route spent on one model and busy on the other is not limit-blocked', async () => {
    const { run: go } = run({
      groq: (m) => (m === GROQ.models[0] ? BUSY : SPENT),
      routes: [GROQ],
    })
    expect(await go()).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
  })
})

describe('a model RETIRED in this call is not spent (R1, CR-M-3)', () => {
  const [M0] = GROQ.models as [string, string]
  it.each<[string, (m: string) => Reply, State[]]>([
    ['SPENT_DAY, then RETIRED', (m) => (m === M0 ? SPENT : notFound(m)), []],
    ['RETIRED, then SPENT_DAY', (m) => (m === M0 ? notFound(m) : SPENT), []],
    [
      'spent in state, the last model RETIRED',
      (m) => notFound(m),
      [(s) => markSpent('groq', M0, day('groq'))(s)],
    ],
  ])('%s: the call is transient; the next one is LIMITS_EXHAUSTED', async (_l, groq, state) => {
    const { f, run: go } = run({ groq, routes: [GROQ], state })
    expect(await go()).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    const sent = f.sent.length
    // The retired model is now retired in state, so it is no longer one the route could try.
    expect(await go()).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
    expect(f.sent).toHaveLength(sent)
  })
})

describe('the tally branches that decide a route’s end (CR-M-2)', () => {
  it('a model cooling down is one the route could still try: the rest spent is transient', async () => {
    const [M0] = GROQ.models as [string, string]
    let second = false
    const f = scriptedFetch((s) => {
      if (second) return SPENT
      return s.model === M0 ? BUSY : GOOD
    })
    const d = deps(f.fetchImpl, { now })
    const router = createRouter(config([GROQ]), d)
    // Call 1: M0 is busy twice, so it cools down; M1 answers.
    expect((await router.run(REQ)).ok).toBe(true)
    second = true
    // Call 2: M0 is still cooling down, M1 is spent: not every model it could try is spent.
    expect(await router.run(REQ)).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent.at(-1)?.model).toBe(GROQ.models[1])
  })

  it('an image call: a route with no vision-capable model is unavailable, so a spent vision route ends it LIMITS_EXHAUSTED', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { now, routeState: stateOf(spentAll(GEMINI)) })
    const r = await createRouter(config([GROQ, GEMINI]), d).run({ ...REQ, images: ['AAAA'] })
    expect(r).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
    expect(f.sent).toEqual([])
  })

  it('a text call: a route with no model to try is transient, not unavailable', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, {
      now,
      routeState: stateOf(spentAll(GEMINI)),
      managedModels: async (p, fallback) => (p === 'groq' ? [] : fallback),
    })
    expect(await createRouter(config([GROQ, GEMINI]), d).run(REQ)).toEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    })
  })
})

describe('a failed own-cap write is a fault, not a limit (R2, CR-M-4)', () => {
  /** A state port that applies every change to memory and reports each write as failed. */
  const failingWrites = (): RouteStatePort => {
    const mem = createMemoryRouteStatePort()
    return {
      snapshot: mem.snapshot,
      update: async (change) => {
        await mem.update(change)
        return false
      },
    }
  }

  it('sends nothing, leaves the counter unchanged and is not LIMITS_EXHAUSTED', async () => {
    const capState = failingWrites()
    const {
      d,
      f,
      run: go,
    } = run({
      cap: createOwnCapPort({ state: capState, now }),
      state: [spentAll(GEMINI)],
    })
    expect(await go()).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toEqual([])
    expect(capState.snapshot().providers.find((r) => r.provider === 'groq')?.ownCap?.requests).toBe(
      0,
    )
    expect(ofType(d.events, 'EXHAUSTED')[0]?.reasons).toEqual([
      { route: 'gemini', code: 'SPENT_DAY' },
      { route: 'groq', code: 'BUDGET' },
    ])
  })

  it('a full own cap stays CAP', async () => {
    const cap = createOwnCapPort({ state: createMemoryRouteStatePort(), now })
    await cap.reserve('groq', { requestsPerDay: 1 })
    const {
      d,
      f,
      run: go,
    } = run({
      cap,
      routes: [{ ...GROQ, freeLimit: { requestsPerDay: 1 } }, GEMINI],
      state: [spentAll(GEMINI)],
    })
    expect(await go()).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
    expect(f.sent).toEqual([])
    expect(ofType(d.events, 'EXHAUSTED')[0]?.reasons).toEqual([
      { route: 'gemini', code: 'SPENT_DAY' },
      { route: 'groq', code: 'CAP' },
    ])
  })
})

describe('AUTH, keys and config (H.2 rows 5–7)', () => {
  it('every available route AUTH-disabled in state → PROVIDER_ERROR, and a reason that is no limit', async () => {
    const { d, f, run: go } = run({ state: [auth('groq'), auth('gemini')] })
    expect(await go()).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toEqual([])
    expect(ofType(d.events, 'EXHAUSTED')[0]?.reasons).toEqual([
      { route: 'groq', code: 'AUTH' },
      { route: 'gemini', code: 'AUTH' },
    ])
  })

  it('every route AUTH-disabled in this call → PROVIDER_ERROR', async () => {
    const { run: go } = run({ groq: () => UNAUTHORIZED, gemini: () => UNAUTHORIZED })
    expect(await go()).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
  })

  it('an AUTH-disabled route is not available: next to a limit-blocked one the call is LIMITS_EXHAUSTED', async () => {
    const { run: go } = run({ state: [auth('groq'), spentAll(GEMINI)] })
    expect(await go()).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
  })

  it('a route disabled by AUTH in this call is not available either', async () => {
    const { run: go } = run({ groq: () => UNAUTHORIZED, state: [spentAll(GEMINI)] })
    expect(await go()).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
  })

  it('no route configured → NOT_CONFIGURED', async () => {
    const { f, run: go } = run({ routes: [] })
    expect(await go()).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(f.sent).toEqual([])
  })

  it('a route with no key cannot be configured: NOT_CONFIGURED, never LIMITS_EXHAUSTED (A1)', async () => {
    const { run: go } = run({ routes: [{ ...GROQ, apiKey: '' }], state: [spentAll(GROQ)] })
    expect(await go()).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
  })
})

describe('an abort stays TIMEOUT (H.2 row 8)', () => {
  it('an abort after a spent route ends ABORTED in the router and TIMEOUT at the port', async () => {
    const controller = new AbortController()
    const f = scriptedFetch((s) => {
      if (s.host === hostOf.gemini) controller.abort()
      return s.host === hostOf.groq ? SPENT : 'hang'
    })
    const d = deps(f.fetchImpl, { now })
    const port = createRouterExtractionAdapter(config([GROQ, GEMINI]), d)
    expect(await port.extract({ ...REQ, signal: controller.signal })).toEqual({
      ok: false,
      code: 'TIMEOUT',
    })
    expect(ofType(d.events, 'EXHAUSTED')).toEqual([])
  })
})

describe('an image call (H.2 applied to vision)', () => {
  const PAGE = 'AAAA'
  it('every vision route limit-blocked → LIMITS_EXHAUSTED', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { now, routeState: stateOf(spentAll(GEMINI)) })
    const r = await createRouter(config([GEMINI]), d).run({ ...REQ, images: [PAGE] })
    expect(r).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
  })

  it('no vision-capable route configured stays NOT_CONFIGURED', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { now, routeState: stateOf(credit('groq')) })
    const r = await createRouter(config([{ ...GROQ, models: ['openai/gpt-oss-120b'] }]), d).run({
      ...REQ,
      images: [PAGE],
    })
    expect(r).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
  })
})

describe('OpenRouter rows (5.4c-H3): SPENT_DAY and CREDIT are limits, FLAG_REJECTED is not', () => {
  const OR_SPENT: Reply = {
    status: 429,
    body: JSON.stringify({
      error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' },
    }),
  }
  const OR_FLAG: Reply = {
    status: 404,
    body: JSON.stringify({
      error: { code: 404, message: 'No endpoints found matching your data policy' },
    }),
  }
  /** OpenRouter answers `openrouter`; Groq is spent in state, so only OpenRouter decides the row. */
  function runOr(openrouter: Reply, state: State[] = []) {
    const f = scriptedFetch((s) => (s.host === hostOf.openrouter ? openrouter : SPENT))
    const d = deps(f.fetchImpl, { now, routeState: stateOf(spentAll(GROQ), ...state) })
    return { f, d, go: () => createRouter(config([OPENROUTER, GROQ]), d).run(REQ) }
  }

  it.each<[string, Reply]>([
    ['SPENT_DAY in this call', OR_SPENT],
    ['CREDIT (402) in this call', CREDIT],
  ])('%s next to a spent Groq → LIMITS_EXHAUSTED', async (_l, r) => {
    expect(await runOr(r).go()).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
  })

  it.each<[string, State]>([
    [
      'the provider spent bit in state',
      (s) => markProviderSpent('openrouter', day('openrouter'))(s),
    ],
    ['the CREDIT bit in state', credit('openrouter')],
  ])('%s next to a spent Groq → LIMITS_EXHAUSTED, nothing sent', async (_l, st) => {
    const { f, go } = runOr(GOOD, [st])
    expect(await go()).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
    expect(f.sent).toEqual([])
  })

  it('FLAG_REJECTED in this call next to a spent Groq is not limit-blocked', async () => {
    expect(await runOr(OR_FLAG).go()).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
  })

  it('the FLAG_REJECTED bit in state next to a spent Groq is not limit-blocked', async () => {
    const { f, go } = runOr(GOOD, [(s) => markFlagRejected('openrouter', OPENROUTER.models[0]!)(s)])
    expect(await go()).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toEqual([])
  })
})
