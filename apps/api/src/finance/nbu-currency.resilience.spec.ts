import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import { NbuCurrencyService } from './nbu-currency.service'

/**
 * BIZ-10 resilience tests for NbuCurrencyService.getRates
 *
 * AC3 — NBU silent fallback:
 *   - Any hardcoded fallback (complete API failure OR per-field `??`) MUST log
 *     an error/warn and mark the result with `stale: true` so callers can detect it
 *   - fetch() must abort after a timeout (AbortController)
 *   - usdtUah must NOT unconditionally equal usdUah (though today they happen to be
 *     equal via the NBU peg); the peg should be explicit in code, not an accident
 *   - Last-known-good rates are cached in-memory and returned on next API failure
 *     instead of the blind hardcoded constant
 */

function makeService(): NbuCurrencyService {
  return new NbuCurrencyService()
}

function mockNbuResponse(rates: Array<{ cc: string; rate: number }>, ok = true, status = 200) {
  // @ts-expect-error — test stub for global fetch
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () =>
      Promise.resolve(
        rates.map((r) => ({
          r030: 0,
          txt: r.cc,
          rate: r.rate,
          cc: r.cc,
          exchangedate: '03.07.2026',
        })),
      ),
  })
}

function mockNbuEmpty() {
  // 200-OK with empty body → per-currency ?? fallback triggers
  // @ts-expect-error — test stub
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve([]), // no USD, no EUR rows
  })
}

function mockNbuNetworkError() {
  // @ts-expect-error — test stub
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
}

function mockNbuTimeout() {
  // @ts-expect-error — test stub
  globalThis.fetch = vi
    .fn()
    .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'))
}

describe('AC3: NbuCurrencyService.getRates — stale detection & logging', () => {
  let svc: NbuCurrencyService
  // NestJS Logger writes to process.stdout/stderr — NOT through console.error/warn.
  // Spy on Logger.prototype.error and Logger.prototype.warn instead.
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>
  let loggerWarnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    svc = makeService()
    loggerErrorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    loggerWarnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('happy path — real rates returned, stale=false', async () => {
    mockNbuResponse([
      { cc: 'USD', rate: 41.2 },
      { cc: 'EUR', rate: 44.5 },
    ])

    const result = await svc.getRates()

    expect(parseFloat(result.usdUah)).toBeCloseTo(41.2, 4)
    expect(parseFloat(result.eurUah)).toBeCloseTo(44.5, 4)
    expect(result.stale).toBe(false)
    // owner addendum (2026-08): an exact-match, non-stale fetch is a REAL
    // dated source — rateDate equals the (requested) date, not omitted.
    expect(result.rateDate).toBe(result.date)
  })

  it('AC3: 200-OK with empty body → stale=true + error/warn logged', async () => {
    // Both today + prev-day calls return empty — fetch is called twice
    mockNbuEmpty()

    const result = await svc.getRates()

    // Must be marked stale — not silently returning hardcoded value
    expect(result.stale).toBe(true)
    // Must log error or warn — no silent fallback
    const logged = loggerErrorSpy.mock.calls.length > 0 || loggerWarnSpy.mock.calls.length > 0
    expect(logged).toBe(true)
  })

  it('AC3: network failure → stale=true + error logged', async () => {
    // Both attempts (today + prev-day) fail with network error
    mockNbuNetworkError()

    const result = await svc.getRates()

    expect(result.stale).toBe(true)
    expect(loggerErrorSpy.mock.calls.length + loggerWarnSpy.mock.calls.length).toBeGreaterThan(0)
  })

  it('AC3: fetch timeout → stale=true (not silent hardcode)', async () => {
    mockNbuTimeout()

    const result = await svc.getRates()

    expect(result.stale).toBe(true)
  })

  it('AC3: stale result returns cached last-known-good rates (not blind 41.5 constant)', async () => {
    // First call: successful with known rates
    mockNbuResponse([
      { cc: 'USD', rate: 39.8 },
      { cc: 'EUR', rate: 43.1 },
    ])
    const good = await svc.getRates()
    expect(good.stale).toBe(false)
    expect(parseFloat(good.usdUah)).toBeCloseTo(39.8, 4)

    // Second call: API fails
    mockNbuNetworkError()
    const stale = await svc.getRates()

    // Must return the cached 39.8, NOT the hardcoded 41.5
    expect(stale.stale).toBe(true)
    expect(parseFloat(stale.usdUah)).toBeCloseTo(39.8, 4)
    expect(parseFloat(stale.eurUah)).toBeCloseTo(43.1, 4)
  })

  it('AC3: usdtUah equals usdUah (USDT peg) but is set explicitly', async () => {
    mockNbuResponse([
      { cc: 'USD', rate: 42.0 },
      { cc: 'EUR', rate: 45.0 },
    ])

    const result = await svc.getRates()

    // USDT is pegged to USD — the values must be equal
    expect(result.usdtUah).toBe(result.usdUah)
    // Both must equal the real rate (not a hardcoded constant)
    expect(parseFloat(result.usdtUah)).toBeCloseTo(42.0, 4)
  })

  it('AC3: no cached rates on first failure → stale=true with safe hardcoded fallback but LOGGED', async () => {
    // Fresh service instance — no prior successful call
    mockNbuNetworkError()
    const fresh = makeService()

    const result = await fresh.getRates()

    // Can return hardcoded fallback AS LONG AS stale=true and it's logged
    expect(result.stale).toBe(true)
    // The fallback must have sensible, non-zero values for UAH pairs
    expect(parseFloat(result.usdUah)).toBeGreaterThan(0)
    expect(parseFloat(result.eurUah)).toBeGreaterThan(0)
    // Logging required
    const logged = loggerErrorSpy.mock.calls.length > 0 || loggerWarnSpy.mock.calls.length > 0
    expect(logged).toBe(true)
    // owner addendum (2026-08): a genuine outage (cache/hardcoded, no real
    // dated source at all) never claims a rateDate — this is exactly the
    // signal `PendingSettlementService`'s date-of-record resolution uses to
    // distinguish "refuse" from "accept a graceful, dated fallback".
    expect(result.rateDate).toBeUndefined()
  })
  it('MED: prev-day fallback result is cached — next failure uses cache not hardcoded', async () => {
    // Call 1: today fails (empty), prev-day succeeds with known rates.
    // Verifies that the prev-day success is stored in lastKnownGood so a
    // subsequent total failure returns the cached rate, not the hardcoded 41.5.
    let callCount = 0
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++
      const body: unknown =
        callCount === 1
          ? [] // today: empty → try prev-day
          : callCount === 2
            ? [
                { r030: 0, txt: 'USD', rate: 38.5, cc: 'USD', exchangedate: '02.07.2026' },
                { r030: 0, txt: 'EUR', rate: 42.0, cc: 'EUR', exchangedate: '02.07.2026' },
              ]
            : (() => {
                throw new Error('ECONNREFUSED')
              })() // subsequent: network down
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
    })

    const r1 = await svc.getRates()
    expect(r1.stale).toBe(true) // prev-day result = stale
    expect(parseFloat(r1.usdUah)).toBeCloseTo(38.5, 4)
    // owner addendum (2026-08): a prev-day fallback IS a real, dated source
    // (just not the exact requested day) — rateDate is set, and differs
    // from `date` (which still echoes the ORIGINALLY REQUESTED day, for
    // backward compat with every consumer that assumes date===requested).
    expect(r1.rateDate).toBeDefined()
    expect(r1.rateDate).not.toBe(r1.date)

    // Call 2: total network failure — must return cached 38.5, NOT hardcoded 41.5
    mockNbuNetworkError()
    const r2 = await svc.getRates()
    expect(r2.stale).toBe(true)
    expect(parseFloat(r2.usdUah)).toBeCloseTo(38.5, 4)
    expect(parseFloat(r2.eurUah)).toBeCloseTo(42.0, 4)
    // A cache-served result has no dated source either — same "genuine
    // outage" signal as the hardcoded-fallback case above.
    expect(r2.rateDate).toBeUndefined()
  })
})

describe('AC3: AbortController timeout on NBU fetch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetch carries an AbortController signal (10s timeout)', async () => {
    let capturedSignal: AbortSignal | null = null
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      capturedSignal = opts?.signal ?? null
      // Simulate slow response that resolves
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            { r030: 0, txt: 'USD', rate: 41.5, cc: 'USD', exchangedate: '03.07.2026' },
            { r030: 0, txt: 'EUR', rate: 44.8, cc: 'EUR', exchangedate: '03.07.2026' },
          ]),
      })
    })

    const svc = makeService()
    await svc.getRates()

    // The fetch call must carry an AbortSignal (timeout guard)
    expect(capturedSignal).not.toBeNull()
    expect(capturedSignal instanceof AbortSignal).toBe(true)
  })
})
