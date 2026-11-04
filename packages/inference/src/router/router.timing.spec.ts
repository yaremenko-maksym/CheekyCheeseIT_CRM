import { describe, expect, it } from 'vitest'
import {
  answer,
  config,
  countingCap,
  deps,
  GOOD,
  GROQ,
  hostOf,
  LOCAL,
  REQ,
  scriptedFetch,
  type Reply,
} from './__test-helpers__/router-harness'
import {
  createRouter,
  createRouterExtractionAdapter,
  pendingLocalQueues,
  type RouterEvent,
} from './router'
import { createOwnCapPort, EMPTY_ROUTE_STATE, type RouteStatePort } from './state'

/** Real timers and the real abortable sleep: these specs measure wall time in tens of milliseconds. */
const realSleep = { sleep: undefined }
const ofType = <K extends RouterEvent['type']>(events: RouterEvent[], type: K) =>
  events.filter((e): e is Extract<RouterEvent, { type: K }> => e.type === type)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const abortAfter = (ms: number): AbortSignal => {
  const c = new AbortController()
  setTimeout(() => c.abort(), ms)
  return c.signal
}

describe('router stopping (§5.5): abort', () => {
  it('an abort before the call sends nothing, is not a timeout and does not fall to local', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, realSleep)
    const r = await createRouter(config([GROQ, LOCAL]), d).run(REQ, AbortSignal.abort())
    expect(r).toEqual({ ok: false, code: 'ABORTED' })
    expect(f.sent).toHaveLength(0)
    expect(ofType(d.events, 'FELL_TO_LOCAL')).toEqual([])
    expect(ofType(d.events, 'CALL')).toEqual([
      { type: 'CALL', code: 'ABORTED', floorAnswered: false, latencyMs: expect.any(Number) },
    ])
  })

  it('an abort cancels a hosted request in flight, sends nothing more and keeps its unit spent (CR-M-1)', async () => {
    const cap = countingCap()
    const f = scriptedFetch(() => 'hang')
    const d = deps(f.fetchImpl, { ...realSleep, ownCap: cap })
    const r = await createRouter(config([GROQ, LOCAL]), d).run(REQ, abortAfter(20))
    expect(r).toEqual({ ok: false, code: 'ABORTED' })
    await wait(50)
    expect(f.sent.map((s) => s.host)).toEqual([hostOf.groq])
    expect(cap.reserved).toEqual(['groq'])
    expect(cap.released).toEqual([])
    expect(ofType(d.events, 'ATTEMPT').map((e) => e.code)).toEqual(['ABORTED'])
  })

  it('an abort wakes a BUSY backoff sleep and sends no retry', async () => {
    const f = scriptedFetch((): Reply => ({ status: 503, body: '' }))
    const d = deps(f.fetchImpl, realSleep)
    const started = Date.now()
    const r = await createRouter(config([GROQ, LOCAL]), d).run(REQ, abortAfter(20))
    expect(r).toEqual({ ok: false, code: 'ABORTED' })
    expect(Date.now() - started).toBeLessThan(2_000)
    await wait(50)
    expect(f.sent).toHaveLength(1)
  })

  it('an abort wakes a minimum-gap sleep and gives the reserved unit back', async () => {
    const cap = countingCap()
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { ...realSleep, ownCap: cap })
    const router = createRouter(config([{ ...GROQ, minGapMs: 10_000 }, LOCAL]), d)
    await router.run(REQ)
    const r = await router.run(REQ, abortAfter(20))
    expect(r).toEqual({ ok: false, code: 'ABORTED' })
    expect(f.sent).toHaveLength(1)
    expect(cap.reserved).toEqual(['groq', 'groq'])
    expect(cap.released).toEqual(['groq'])
  })

  it('an abort during a step that sends nothing ends the call without the floor', async () => {
    const c = new AbortController()
    const cap = countingCap()
    cap.reserve = async () => {
      c.abort()
      return null
    }
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { ...realSleep, ownCap: cap })
    const r = await createRouter(config([GROQ, LOCAL]), d).run(REQ, c.signal)
    expect(r).toEqual({ ok: false, code: 'ABORTED' })
    expect(f.sent).toHaveLength(0)
    expect(ofType(d.events, 'FELL_TO_LOCAL')).toEqual([])
    expect(ofType(d.events, 'CALL')).toEqual([
      { type: 'CALL', code: 'ABORTED', floorAnswered: false, latencyMs: expect.any(Number) },
    ])
  })

  it('an abort while queued behind another local request sends nothing', async () => {
    const f = scriptedFetch((): Reply => ({ ...(GOOD as Exclude<Reply, string>), delayMs: 100 }))
    const router = createRouter(config([LOCAL]), deps(f.fetchImpl, realSleep))
    const first = router.run(REQ)
    const second = await router.run(REQ, abortAfter(20))
    expect(second).toEqual({ ok: false, code: 'ABORTED' })
    expect(await first).toMatchObject({ ok: true })
    expect(f.sent).toHaveLength(1)
  })

  it('the minimum gap is slept for real without a signal', async () => {
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(
      config([{ ...GROQ, minGapMs: 60 }, LOCAL]),
      deps(f.fetchImpl, realSleep),
    )
    await router.run(REQ)
    const started = Date.now()
    expect(await router.run(REQ)).toMatchObject({ ok: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
  })

  it('an abort cancels the floor request in flight', async () => {
    const f = scriptedFetch(() => 'hang')
    const d = deps(f.fetchImpl, realSleep)
    const r = await createRouter(config([LOCAL]), d).run(REQ, abortAfter(20))
    expect(r).toEqual({ ok: false, code: 'ABORTED' })
    await wait(50)
    expect(f.sent).toHaveLength(1)
  })
})

/** A state store that applies every change to memory and never finishes writing it. */
function stuckStore(): RouteStatePort {
  let s = EMPTY_ROUTE_STATE
  return {
    snapshot: () => s,
    update: (change) => {
      s = change(s)
      return new Promise<boolean>(() => undefined)
    },
  }
}

describe('router stopping (§5.5): store writes inside the hosted budget (SR-L-70)', () => {
  it('a reservation stuck in the store ends the route as BUDGET within the hosted budget', async () => {
    const routeState = stuckStore()
    const ownCap = createOwnCapPort({ state: routeState, now: Date.now })
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { ...realSleep, routeState, ownCap })
    const started = Date.now()
    const r = await createRouter(config([GROQ, LOCAL], { hostedBudgetMs: 100 }), d).run(REQ)
    expect(r).toMatchObject({ ok: true })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(f.sent.map((s) => s.host)).toEqual([hostOf.local])
    expect(ofType(d.events, 'FELL_TO_LOCAL')[0]?.reasons).toEqual([
      { route: 'groq', code: 'BUDGET' },
    ])
  })

  it('a ledger write stuck in the store does not hold the call past the hosted budget', async () => {
    const routeState = stuckStore()
    const f = scriptedFetch((s) => (s.host === hostOf.local ? GOOD : { status: 401, body: '{}' }))
    const d = deps(f.fetchImpl, { ...realSleep, routeState })
    const started = Date.now()
    const r = await createRouter(config([GROQ, LOCAL], { hostedBudgetMs: 100 }), d).run(REQ)
    expect(r).toMatchObject({ ok: true })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(routeState.snapshot().providers).toEqual([{ provider: 'groq', auth: true }])
  })
})

describe('router stopping (§5.5): budgets and the ceiling', () => {
  it('the floor budget stays whole when every hosted attempt hangs', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.local ? GOOD : 'hang'))
    const d = deps(f.fetchImpl, realSleep)
    const started = Date.now()
    const r = await createRouter(
      config([GROQ, LOCAL], { hostedBudgetMs: 100, floorBudgetMs: 5_000 }),
      d,
    ).run(REQ)
    expect(r).toMatchObject({ ok: true })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(ofType(d.events, 'FELL_TO_LOCAL')[0]?.reasons).toEqual([
      { route: 'groq', code: 'TIMEOUT' },
    ])
  })

  it('the ceiling holds with every request hanging: the floor ends in TIMEOUT', async () => {
    const f = scriptedFetch(() => 'hang')
    const local = { ...LOCAL, timeoutMs: 200 }
    const started = Date.now()
    const r = await createRouter(
      config([GROQ, local], { hostedBudgetMs: 100, floorBudgetMs: 200 }),
      deps(f.fetchImpl, realSleep),
    ).run(REQ)
    expect(r).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(100 + 200 + 1_000)
  })

  it('a floor retry gets only what is left of the floor budget, not a whole timeout', async () => {
    let n = 0
    const f = scriptedFetch((): Reply =>
      ++n === 1 ? { ...(answer('nope') as Exclude<Reply, string>), delayMs: 600 } : 'hang',
    )
    const local = { ...LOCAL, timeoutMs: 1_000 }
    const started = Date.now()
    const r = await createRouter(
      config([local], { floorBudgetMs: 1_000 }),
      deps(f.fetchImpl, realSleep),
    ).run(REQ)
    expect(r).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(1_400)
  })

  it('a hosted TIMEOUT keeps its own-cap unit spent (the request may have been counted)', async () => {
    const cap = countingCap()
    const f = scriptedFetch((s) => (s.host === hostOf.local ? GOOD : 'hang'))
    const d = deps(f.fetchImpl, { ...realSleep, ownCap: cap })
    await createRouter(config([{ ...GROQ, timeoutMs: 50 }, LOCAL]), d).run(REQ)
    expect(cap.reserved).toEqual(['groq'])
    expect(cap.released).toEqual([])
  })
})

describe('router stopping (§5.5 item 5): one local request in flight', () => {
  it('two concurrent calls never have two local requests in flight', async () => {
    const f = scriptedFetch((): Reply => ({ ...(GOOD as Exclude<Reply, string>), delayMs: 30 }))
    const router = createRouter(config([LOCAL]), deps(f.fetchImpl, realSleep))
    const results = await Promise.all([router.run(REQ), router.run(REQ), router.run(REQ)])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(f.stats.peakLocalInFlight).toBe(1)
    expect(f.sent).toHaveLength(3)
  })

  it('two routers on one runtime share the queue; the queue empties after (SR-L-70)', async () => {
    const f = scriptedFetch((): Reply => ({ ...(GOOD as Exclude<Reply, string>), delayMs: 30 }))
    const a = createRouterExtractionAdapter(config([LOCAL]), deps(f.fetchImpl, realSleep))
    const b = createRouterExtractionAdapter(config([LOCAL]), deps(f.fetchImpl, realSleep))
    const results = await Promise.all([a.extract(REQ), b.extract(REQ), a.extract(REQ)])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(f.stats.peakLocalInFlight).toBe(1)
    await wait(0)
    expect(pendingLocalQueues()).toBe(0)
  })

  it('routers on two runtimes do not queue behind each other', async () => {
    const f = scriptedFetch((): Reply => ({ ...(GOOD as Exclude<Reply, string>), delayMs: 30 }))
    const other = { ...LOCAL, baseUrl: 'http://127.0.0.1:11434/v1' }
    const a = createRouter(config([LOCAL]), deps(f.fetchImpl, realSleep))
    const b = createRouter(config([other]), deps(f.fetchImpl, realSleep))
    await Promise.all([a.run(REQ), b.run(REQ)])
    expect(f.stats.peakInFlight).toBe(2)
  })

  it('an abandoned call still holds the local leaf until its request settles', async () => {
    let n = 0
    const f = scriptedFetch((): Reply => (++n === 1 ? 'hang' : GOOD))
    const local = { ...LOCAL, timeoutMs: 150 }
    const router = createRouter(
      config([local], { floorBudgetMs: 2_000 }),
      deps(f.fetchImpl, realSleep),
    )
    void router.run(REQ) // abandoned by its caller, still running
    await wait(10)
    const r = await router.run(REQ)
    expect(r).toMatchObject({ ok: true })
    expect(f.stats.peakLocalInFlight).toBe(1)
  })
})
