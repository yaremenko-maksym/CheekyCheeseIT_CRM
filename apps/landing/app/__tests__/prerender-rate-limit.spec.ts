/**
 * Pure helpers exported from `scripts/prerender.mjs` — 2026-07-31 prod
 * outage RCA (build failed on apps/api's global ThrottlerModule 429ing the
 * prerender's own client-side requests once vacancy count grew). See that
 * script's "0. Rate-limit awareness" module doc for the full mechanism.
 *
 * `createRateLimiter` is a factory precisely so these tests can inject a
 * fake clock/sleep instead of waiting on real timers — no `vi.useFakeTimers`
 * needed, and no flakiness from real wall-clock waits.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createRateLimiter,
  estimateRequestWeight,
  LOCALES,
  rateLimitError,
} from '../../scripts/prerender.mjs'

describe('createRateLimiter', () => {
  /** Builds a limiter with a controllable fake clock/sleep for deterministic, instant tests. */
  function buildFakeLimiter({ windowMs, budget }: { windowMs: number; budget: number }) {
    let now = 0
    const sleepFn = vi.fn(async (ms: number) => {
      now += ms
    })
    const warnFn = vi.fn()
    const limiter = createRateLimiter({ windowMs, budget, sleepFn, warnFn, nowFn: () => now })
    return { limiter, sleepFn, warnFn, advance: (ms: number) => (now += ms) }
  }

  it('does not wait when the window has headroom for the requested weight', async () => {
    const { limiter, sleepFn } = buildFakeLimiter({ windowMs: 60_000, budget: 60 })
    limiter.record()
    limiter.record()
    await limiter.waitForBudget(5)
    expect(sleepFn).not.toHaveBeenCalled()
  })

  it('waits when recorded requests + weight would exceed the budget', async () => {
    const { limiter, sleepFn, warnFn } = buildFakeLimiter({ windowMs: 60_000, budget: 5 })
    for (let i = 0; i < 5; i++) limiter.record()
    await limiter.waitForBudget(1)
    expect(sleepFn).toHaveBeenCalledTimes(1)
    expect(warnFn).toHaveBeenCalledWith(expect.stringContaining('pacing:'))
  })

  it('prunes timestamps older than the window before deciding, so budget frees up after a real wait', async () => {
    const { limiter, sleepFn, advance } = buildFakeLimiter({ windowMs: 60_000, budget: 3 })
    limiter.record()
    limiter.record()
    limiter.record()
    // All 3 recorded requests are now 61s old — outside the window — so
    // there should be room again without any further waiting.
    advance(61_000)
    await limiter.waitForBudget(3)
    expect(sleepFn).not.toHaveBeenCalled()
  })

  it('prunes a request exactly windowMs old (the `<=` boundary the source pins) — not just requests strictly older than the window', async () => {
    const { limiter, sleepFn, advance } = buildFakeLimiter({ windowMs: 60_000, budget: 3 })
    limiter.record()
    limiter.record()
    limiter.record()
    // Exactly 60_000ms later — the boundary itself, not comfortably past it
    // (the 61_000 case above). pruneOlderThanWindow() uses `<=` specifically
    // so this age counts as "fully aged out" (see that function's doc).
    advance(60_000)
    await limiter.waitForBudget(3)
    expect(sleepFn).not.toHaveBeenCalled()
  })

  it('loops (re-checking the window) until enough old requests have aged out — not just a single wait', async () => {
    const { limiter, sleepFn } = buildFakeLimiter({ windowMs: 10_000, budget: 2 })
    limiter.record() // t=0
    limiter.record() // t=0
    // Budget is 2, already at 2 — needs at least one to age out of the
    // window before a 3rd fits. sleepFn advances the fake clock by however
    // long waitForBudget asks it to wait, so this converges without a real
    // timer and without an artificial iteration cap.
    await limiter.waitForBudget(1)
    expect(sleepFn.mock.calls.length).toBeGreaterThan(0)
  })

  it('never waits when weight is 0 regardless of budget (the 404-marker case)', async () => {
    const { limiter, sleepFn } = buildFakeLimiter({ windowMs: 60_000, budget: 1 })
    limiter.record()
    await limiter.waitForBudget(0)
    expect(sleepFn).not.toHaveBeenCalled()
  })
})

describe('estimateRequestWeight', () => {
  it('is 0 for the 404-marker capture (route === null) — no vacancy data fetched', () => {
    expect(estimateRequestWeight(null)).toBe(0)
  })

  it('is 1 for home/careers routes — one fetchVacancies() call each', () => {
    const homeRoute = {
      url: '/',
      file: 'index.html',
      path: '/',
      pageType: 'home' as const,
      hreflangExcludes: [],
      requireJsonLd: 'organization+website' as const,
    }
    const careersRoute = {
      ...homeRoute,
      url: '/careers',
      pageType: 'careers' as const,
      requireJsonLd: null,
    }
    expect(estimateRequestWeight(homeRoute)).toBe(1)
    expect(estimateRequestWeight(careersRoute)).toBe(1)
  })

  it('is 2 + (LOCALES.length - 1) for vacancy routes — fetchVacancy + fetchVacancies + one fetchVacancyHreflangExcludes() fetch per non-default locale (app/lib/api.ts)', () => {
    const vacancyRoute = {
      url: '/careers/a',
      file: 'careers/a/index.html',
      path: '/careers/a',
      pageType: 'vacancy' as const,
      hreflangExcludes: [],
      requireJsonLd: 'job-posting-breadcrumb' as const,
    }
    expect(estimateRequestWeight(vacancyRoute)).toBe(2 + (LOCALES.length - 1))
    expect(estimateRequestWeight(vacancyRoute)).toBe(6)
  })
})

describe('rateLimitError', () => {
  it('leads with the rate-limit headline instead of the misleading downstream symptom (AC1)', () => {
    const downstream = new Error('prerender: expected a non-empty ItemList JSON-LD on /careers')
    const err = rateLimitError(
      '/careers',
      ['http://127.0.0.1:4173/api/public/vacancies'],
      downstream,
    )
    expect(err.message).toMatch(/^prerender: rate limited \(HTTP 429\)/)
    expect(err.message).toContain('/careers')
    expect(err.message).toContain('http://127.0.0.1:4173/api/public/vacancies')
    // Still surfaces the original symptom for context, just not as the headline.
    expect(err.message).toContain('expected a non-empty ItemList JSON-LD')
  })

  it('handles a non-Error downstream value', () => {
    const err = rateLimitError('/', ['http://x/api/public/vacancies'], 'boom')
    expect(err.message).toContain('boom')
  })
})
