import { describe, expect, it } from 'vitest'
import { geminiListing, NOON, refreshWorld } from './__test-helpers__/refresh-world'
import {
  answer,
  config,
  deps,
  GEMINI,
  GOOD,
  GROQ,
  hostOf,
  REQ,
  scriptedFetch,
  type Reply,
} from './__test-helpers__/router-harness'
import { GEMINI_PROBE_CAP, runDailyModelRefresh, runModelChainCheck } from './model-refresh'
import { createRouter, MIN_BUSY_BACKOFF_MS, VISION_RESERVE_REQUESTS } from './router'
import { createMemoryRouteStatePort, EMPTY_ROUTE_STATE, providerDay } from './state'

const IMAGES = ['iVBORw0KGgo=']
const sentTo = (sent: { host: string; model: string }[]) => sent.map((s) => `${s.host} ${s.model}`)
/** A clock the fake sleep moves forward, so a wait is seen by every later `now()`. */
const clock = (start = NOON) => {
  const c = { t: start }
  return {
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += ms
    },
    advance: (ms: number) => {
      c.t += ms
    },
  }
}

describe('router resilience: a TIMEOUT on an image call tries the next vision model (finding 1)', () => {
  const FAST = { ...GEMINI, timeoutMs: 50 }
  const hangFirst = scriptedFetch((s) => (s.model === 'gemini-2.5-flash' ? 'hang' : GOOD))

  it('an image call whose first Gemini model times out is answered by the second', async () => {
    const f = scriptedFetch((s) => (s.model === 'gemini-2.5-flash' ? 'hang' : GOOD))
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([FAST]), d).run({ ...REQ, images: IMAGES })
    expect(r.ok).toBe(true)
    expect(sentTo(f.sent)).toEqual([
      `${hostOf.gemini} gemini-2.5-flash`,
      `${hostOf.gemini} gemini-2.5-flash-lite`,
    ])
    expect(d.events.filter((e) => e.type === 'ATTEMPT').map((e) => e.code)).toEqual([
      'TIMEOUT',
      'OK',
    ])
  })

  it('a text call still leaves the route on a TIMEOUT', async () => {
    const r = await createRouter(config([FAST, GROQ]), deps(hangFirst.fetchImpl)).run(REQ)
    expect(r.ok).toBe(true)
    expect(sentTo(hangFirst.sent)).toEqual([
      `${hostOf.gemini} gemini-2.5-flash`,
      `${hostOf.groq} openai/gpt-oss-120b`,
    ])
  })
})

describe('router resilience: text calls keep a vision reserve (finding 2)', () => {
  const geminiUsed = (requests: number) =>
    createMemoryRouteStatePort({
      ...EMPTY_ROUTE_STATE,
      providers: [
        {
          provider: 'gemini',
          auth: false,
          ownCap: { day: providerDay('gemini', NOON), requests, tokens: 0 },
        },
      ],
    })
  const firstHost = async (requests: number, images?: string[]) => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { routeState: geminiUsed(requests), now: () => NOON })
    const r = await createRouter(config([GEMINI, GROQ]), d).run({
      ...REQ,
      ...(images !== undefined && { images }),
    })
    expect(r.ok).toBe(true)
    return { host: f.sent[0]?.host, events: d.events }
  }

  it('the reserve is 10 requests of the day', () => {
    expect(VISION_RESERVE_REQUESTS).toBe(10)
  })

  it('a text call skips the sole vision route with 10 requests left', async () => {
    // GEMINI's free limit is 1000 a day at a 100 % share: 990 used leaves 10.
    const { host, events } = await firstHost(990)
    expect(host).toBe(hostOf.groq)
    expect(events.some((e) => e.type === 'ATTEMPT' && e.route === 'gemini')).toBe(false)
  })

  it('a text call takes the sole vision route with 11 requests left', async () => {
    expect((await firstHost(989)).host).toBe(hostOf.gemini)
  })

  it('an image call still takes the vision route inside the reserve', async () => {
    expect((await firstHost(999, IMAGES)).host).toBe(hostOf.gemini)
  })

  it('a text call with nothing but the reserved route left ends LIMITS_EXHAUSTED, sending nothing', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { routeState: geminiUsed(995), now: () => NOON })
    const r = await createRouter(config([GEMINI]), d).run(REQ)
    expect(r).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
    expect(f.sent).toHaveLength(0)
    expect(d.events).toContainEqual({ type: 'EXHAUSTED', reasons: [{ route: 'gemini', code: 'CAP' }] })
  })

  it('with no vision route configured a text call uses every route as before', async () => {
    const f = scriptedFetch(() => GOOD)
    const state = createMemoryRouteStatePort({
      ...EMPTY_ROUTE_STATE,
      providers: [
        {
          provider: 'groq',
          auth: false,
          ownCap: { day: providerDay('groq', NOON), requests: 999, tokens: 0 },
        },
      ],
    })
    const r = await createRouter(
      config([GROQ]),
      deps(f.fetchImpl, { routeState: state, now: () => NOON }),
    ).run(REQ)
    expect(r.ok).toBe(true)
    expect(f.sent[0]?.host).toBe(hostOf.groq)
  })
})

describe('router resilience: a 429 backs off and cools the whole provider (finding 3)', () => {
  const tooMany = (headers: Record<string, string> = {}): Reply => ({
    status: 429,
    body: JSON.stringify({ error: { message: 'slow down', type: 'rate_limit' } }),
    headers,
  })

  it('the floor is 3 s, inside the one-wait backoff', () => {
    expect(MIN_BUSY_BACKOFF_MS).toBe(3_000)
  })

  it('retry-after 0 waits the floor, skips the sibling model, and another provider answers', async () => {
    const c = clock()
    const f = scriptedFetch((s) => (s.host === hostOf.groq ? tooMany({ 'retry-after': '0' }) : GOOD))
    const d = deps(f.fetchImpl, { now: c.now, sleep: c.sleep })
    const router = createRouter(config([GROQ, GEMINI]), d)
    expect((await router.run(REQ)).ok).toBe(true)
    expect(c.now() - NOON).toBe(3_000)
    expect(sentTo(f.sent)).toEqual([
      `${hostOf.groq} openai/gpt-oss-120b`,
      `${hostOf.groq} openai/gpt-oss-120b`,
      `${hostOf.gemini} gemini-2.5-flash`,
    ])

    // Inside the cool-down no Groq model is asked; once it ends, Groq is asked again.
    await router.run(REQ)
    expect(f.sent.at(-1)?.host).toBe(hostOf.gemini)
    expect(f.sent.filter((s) => s.host === hostOf.groq)).toHaveLength(2)
    c.advance(3_000)
    await router.run(REQ)
    expect(f.sent.filter((s) => s.host === hostOf.groq)).toHaveLength(4)
  })

  it('a long retry-after cools the provider without a wait: the sibling is not asked', async () => {
    const c = clock()
    const f = scriptedFetch((s) =>
      s.host === hostOf.groq ? tooMany({ 'retry-after': '20' }) : GOOD,
    )
    const d = deps(f.fetchImpl, { now: c.now, sleep: c.sleep })
    const router = createRouter(config([GROQ, GEMINI]), d)
    await router.run(REQ)
    expect(sentTo(f.sent)).toEqual([
      `${hostOf.groq} openai/gpt-oss-120b`,
      `${hostOf.gemini} gemini-2.5-flash`,
    ])
    c.advance(19_999)
    await router.run(REQ)
    expect(f.sent.filter((s) => s.host === hostOf.groq)).toHaveLength(1)
    c.advance(1)
    await router.run(REQ)
    expect(f.sent.filter((s) => s.host === hostOf.groq)).toHaveLength(2)
  })

  it('never waits the floor past the hosted budget', async () => {
    const c = clock()
    // Each request takes 2.5 s of the 5 s budget: the 3 s floor no longer fits after the first.
    const f = scriptedFetch((s) => {
      c.advance(2_500)
      return s.host === hostOf.groq ? tooMany({ 'retry-after': '0' }) : GOOD
    })
    const d = deps(f.fetchImpl, { now: c.now, sleep: c.sleep })
    const r = await createRouter(config([GROQ, GEMINI], { hostedBudgetMs: 5_000 }), d).run(REQ)
    expect(r.ok).toBe(true)
    expect(c.now() - NOON).toBe(5_000)
    expect(sentTo(f.sent)).toEqual([
      `${hostOf.groq} openai/gpt-oss-120b`,
      `${hostOf.gemini} gemini-2.5-flash`,
    ])
  })

  it('a 503 is no rate limit: the sibling model is still asked', async () => {
    const c = clock()
    const f = scriptedFetch((s) =>
      s.model === 'openai/gpt-oss-120b' ? { status: 503, body: '' } : GOOD,
    )
    const d = deps(f.fetchImpl, { now: c.now, sleep: c.sleep })
    expect((await createRouter(config([GROQ]), d).run(REQ)).ok).toBe(true)
    expect(f.sent.map((s) => s.model)).toEqual([
      'openai/gpt-oss-120b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
    ])
  })

  it('an image call keeps the floor too', async () => {
    const c = clock()
    const zeroDelay: Reply = {
      status: 429,
      body: JSON.stringify({
        error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' }] },
      }),
    }
    const f = scriptedFetch((_s, n) => (n === 1 ? zeroDelay : answer({ title: 'x' })))
    const d = deps(f.fetchImpl, { now: c.now, sleep: c.sleep })
    expect((await createRouter(config([GEMINI]), d).run({ ...REQ, images: IMAGES })).ok).toBe(true)
    expect(c.now() - NOON).toBe(3_000)
  })
})

describe('self-heal: Gemini liveness probes are capped at one a day (finding 4)', () => {
  const many = Array.from({ length: 8 }, (_, i) => `gemini-${i + 4}.0-flash`)
  const world = () =>
    refreshWorld({
      routes: [GEMINI, GROQ],
      listing: {
        gemini: geminiListing(
          ['gemini-2.5-flash', 'gemini-2.5-flash-lite', ...many].map(
            (id) => [id, 1_000_000] as const,
          ),
        ),
      },
    })
  const geminiChats = (w: ReturnType<typeof world>) =>
    w.chats().filter((s) => s.host === hostOf.gemini)

  it('the cap is one', () => {
    expect(GEMINI_PROBE_CAP).toBe(1)
  })

  it('the daily refresh sends one Gemini probe', async () => {
    const w = world()
    await runDailyModelRefresh(w.deps)
    expect(geminiChats(w)).toHaveLength(1)
  })

  it('the chain check sends one Gemini probe and still probes every Groq model in use', async () => {
    const w = world()
    await runModelChainCheck(w.deps)
    expect(geminiChats(w)).toHaveLength(1)
    expect(w.chats().filter((s) => s.host === hostOf.groq)).toHaveLength(2)
  })
})
