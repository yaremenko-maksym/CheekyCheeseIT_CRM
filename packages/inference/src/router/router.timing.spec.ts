import { describe, expect, it } from 'vitest'
import {
  answer,
  config,
  countingCap,
  deps,
  GOOD,
  GROQ,
  hostOf,
  REQ,
  scriptedFetch,
  type Reply,
} from './__test-helpers__/router-harness'
import { createRouter, type RouterEvent } from './router'
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
  it('an abort before the call sends nothing and is not a timeout', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, realSleep)
    const r = await createRouter(config([GROQ]), d).run(REQ, AbortSignal.abort())
    expect(r).toEqual({ ok: false, code: 'ABORTED' })
    expect(f.sent).toHaveLength(0)
    expect(ofType(d.events, 'CALL')).toEqual([
      { type: 'CALL', code: 'ABORTED', latencyMs: expect.any(Number) },
    ])
  })

  it('an abort cancels a hosted request in flight, sends nothing more and keeps its unit spent (CR-M-1)', async () => {
    const cap = countingCap()
    const f = scriptedFetch(() => 'hang')
    const d = deps(f.fetchImpl, { ...realSleep, ownCap: cap })
    const r = await createRouter(config([GROQ]), d).run(REQ, abortAfter(20))
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
    const r = await createRouter(config([GROQ]), d).run(REQ, abortAfter(20))
    expect(r).toEqual({ ok: false, code: 'ABORTED' })
    expect(Date.now() - started).toBeLessThan(2_000)
    await wait(50)
    expect(f.sent).toHaveLength(1)
  })

  it('an abort wakes a minimum-gap sleep and gives the reserved unit back', async () => {
    const cap = countingCap()
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { ...realSleep, ownCap: cap })
    const router = createRouter(config([{ ...GROQ, minGapMs: 10_000 }]), d)
    await router.run(REQ)
    const r = await router.run(REQ, abortAfter(20))
    expect(r).toEqual({ ok: false, code: 'ABORTED' })
    expect(f.sent).toHaveLength(1)
    expect(cap.reserved).toEqual(['groq', 'groq'])
    expect(cap.released).toEqual(['groq'])
  })

  it('an abort during a step that sends nothing ends the call as ABORTED', async () => {
    const c = new AbortController()
    const cap = countingCap()
    cap.reserve = async () => {
      c.abort()
      return null
    }
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { ...realSleep, ownCap: cap })
    const r = await createRouter(config([GROQ]), d).run(REQ, c.signal)
    expect(r).toEqual({ ok: false, code: 'ABORTED' })
    expect(f.sent).toHaveLength(0)
    expect(ofType(d.events, 'CALL')).toEqual([
      { type: 'CALL', code: 'ABORTED', latencyMs: expect.any(Number) },
    ])
  })

  it('the minimum gap is slept for real without a signal', async () => {
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(config([{ ...GROQ, minGapMs: 60 }]), deps(f.fetchImpl, realSleep))
    await router.run(REQ)
    const started = Date.now()
    expect(await router.run(REQ)).toMatchObject({ ok: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
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

/** A hosted route whose timeout fits a hosted budget of 100 ms (H.1: the budget holds one request). */
const QUICK = { ...GROQ, timeoutMs: 100 }

describe('router stopping (§5.5): store writes inside the hosted budget (SR-L-70)', () => {
  it('a reservation stuck in the store ends the route as BUDGET within the hosted budget', async () => {
    const routeState = stuckStore()
    const ownCap = createOwnCapPort({ state: routeState, now: Date.now })
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { ...realSleep, routeState, ownCap })
    const started = Date.now()
    const r = await createRouter(config([QUICK], { hostedBudgetMs: 100 }), d).run(REQ)
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(f.sent).toEqual([])
  })

  it('a ledger write stuck in the store does not hold the call past the hosted budget', async () => {
    const routeState = stuckStore()
    const f = scriptedFetch(() => ({ status: 401, body: '{}' }))
    const d = deps(f.fetchImpl, { ...realSleep, routeState })
    const started = Date.now()
    const r = await createRouter(config([QUICK], { hostedBudgetMs: 100 }), d).run(REQ)
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(routeState.snapshot().providers).toEqual([{ provider: 'groq', auth: true }])
  })
})

describe('router stopping (§5.5): the hosted budget is the ceiling (H.1)', () => {
  it('every hosted attempt hanging ends within the hosted budget as PROVIDER_ERROR', async () => {
    const f = scriptedFetch(() => 'hang')
    const d = deps(f.fetchImpl, realSleep)
    const started = Date.now()
    const r = await createRouter(config([QUICK], { hostedBudgetMs: 100 }), d).run(REQ)
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(ofType(d.events, 'ATTEMPT').map((e) => e.code)).toEqual(['TIMEOUT'])
  })

  it('the ceiling holds across routes: the second route gets only what is left', async () => {
    const f = scriptedFetch(() => 'hang')
    const gemini = { ...QUICK, provider: 'gemini' as const, models: ['gemini-2.5-flash'] }
    const started = Date.now()
    const r = await createRouter(
      config([QUICK, gemini], { hostedBudgetMs: 150 }),
      deps(f.fetchImpl, realSleep),
    ).run(REQ)
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toHaveLength(2)
    expect(Date.now() - started).toBeLessThan(150 + 1_000)
  })

  it('a hosted correction retry gets only what is left of the hosted budget, not a whole timeout', async () => {
    // The clock leaps during the first answer: the retry is left 50 ms of a 5 s route timeout.
    let clock = 0
    let n = 0
    const f = scriptedFetch((): Reply => {
      if (++n > 1) return 'hang'
      clock += 29_950
      return answer('nope')
    })
    const started = Date.now()
    const r = await createRouter(
      config([{ ...GROQ, models: ['openai/gpt-oss-120b'] }], { hostedBudgetMs: 30_000 }),
      deps(f.fetchImpl, { ...realSleep, now: () => clock }),
    ).run(REQ)
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toHaveLength(2)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('a hosted TIMEOUT keeps its own-cap unit spent (the request may have been counted)', async () => {
    const cap = countingCap()
    const f = scriptedFetch(() => 'hang')
    const d = deps(f.fetchImpl, { ...realSleep, ownCap: cap })
    await createRouter(config([{ ...GROQ, timeoutMs: 50 }]), d).run(REQ)
    expect(cap.reserved).toEqual(['groq'])
    expect(cap.released).toEqual([])
  })
})
