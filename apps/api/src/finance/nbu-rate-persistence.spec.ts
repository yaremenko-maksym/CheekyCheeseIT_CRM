import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import { NbuCurrencyService } from './nbu-currency.service'
import type { NbuRateStore, PersistedNbuRate } from './nbu-rate-store'

/**
 * Manager-role plan PR 8 (design §4.6 currency): past NBU days are persisted once and never
 * re-fetched (AC1); a balance read prefetches the missing days in one batch, one NBU call per
 * distinct day and never per row (AC2); an outage or an unusable store degrades to a `stale`
 * result instead of throwing (AC3).
 *
 * The NBU stub answers by the DAY in the URL, in the `statdirectory` dialect, so an assertion on
 * which days were asked for is an assertion on behaviour, not on call order.
 */

const TODAY_ISO = '2026-11-20' // a Friday; Kyiv 11:00 at the pinned instant below
const PUBLISHED: Record<string, { usd: number; eur: number }> = {
  '20261110': { usd: 41.1, eur: 44.1 },
  '20261111': { usd: 41.2, eur: 44.2 },
  '20261112': { usd: 41.3, eur: 44.3 },
  '20261120': { usd: 41.9, eur: 44.9 },
}

let feedDown = false

function dayOf(url: string): string {
  const m = /date=(\d{8})/.exec(url) ?? /date=(\d{2})\.(\d{2})\.(\d{4})/.exec(url)
  if (!m) throw new Error(`unexpected NBU url ${url}`)
  return m.length === 2 ? m[1]! : `${m[3]}${m[2]}${m[1]}`
}

function installFeed(): void {
  // @ts-expect-error — test stub for global fetch
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    const day = dayOf(url)
    const rate = PUBLISHED[day]
    if (feedDown || !rate || !url.includes('statdirectory')) {
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve([]) })
    }
    const exchangedate = `${day.slice(6, 8)}.${day.slice(4, 6)}.${day.slice(0, 4)}`
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve([
          { r030: 840, cc: 'USD', rate: rate.usd, exchangedate },
          { r030: 978, cc: 'EUR', rate: rate.eur, exchangedate },
        ]),
    })
  })
}

/** Days NBU was asked for, across every source (one entry per HTTP call). */
function askedDays(): string[] {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([u]) =>
    dayOf(u as string),
  )
}

class FakeStore {
  rows = new Map<string, PersistedNbuRate>()
  findMany = vi.fn(async (days: readonly string[]) => {
    const out = new Map<string, PersistedNbuRate>()
    for (const d of days) {
      const r = this.rows.get(d)
      if (r) out.set(d, r)
    }
    return out
  })
  save = vi.fn(async (r: PersistedNbuRate) => {
    if (!this.rows.has(r.day)) this.rows.set(r.day, r)
  })
}

let store: FakeStore
let svc: NbuCurrencyService

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${TODAY_ISO}T09:00:00Z`))
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  feedDown = false
  installFeed()
  store = new FakeStore()
  svc = new NbuCurrencyService(store as unknown as NbuRateStore)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AC1 — a past day is fetched once and persisted', () => {
  it('persists an exact past-day hit and serves the second read without calling NBU', async () => {
    const first = await svc.getRates('20261110')
    expect(first).toEqual({
      usdUah: '41.1000',
      usdtUah: '41.1000',
      eurUah: '44.1000',
      date: '20261110',
      stale: false,
      rateDate: '20261110',
    })
    expect(store.rows.get('20261110')).toEqual({
      day: '20261110',
      usdUah: '41.1000',
      eurUah: '44.1000',
      sourceId: 'statdirectory',
    })

    const callsAfterFirst = askedDays().length
    const second = await svc.getRates('20261110')
    expect(askedDays().length).toBe(callsAfterFirst)
    // Byte-identical to the live exact hit: the DROP settle money gate reads `rateDate`.
    expect(second).toEqual(first)
  })

  it('serves a persisted day even while NBU is down', async () => {
    store.rows.set('20261111', {
      day: '20261111',
      usdUah: '41.2000',
      eurUah: '44.2000',
      sourceId: 'statdirectory',
    })
    feedDown = true
    const r = await svc.getRates('20261111')
    expect(askedDays()).toEqual([])
    expect(r).toMatchObject({
      usdUah: '41.2000',
      eurUah: '44.2000',
      stale: false,
      rateDate: '20261111',
    })
  })

  it('never persists today (it is not a past day)', async () => {
    await svc.getRates()
    await svc.getRates('20261120')
    expect(store.save).not.toHaveBeenCalled()
  })

  it('never persists a previous-day fallback, under either day', async () => {
    // 20261113 is unpublished in the stub; the service falls back to 20261112.
    const r = await svc.getRates('20261113')
    expect(r.stale).toBe(true)
    expect(store.save).not.toHaveBeenCalled()
  })

  it('never persists the hardcoded fallback during an outage', async () => {
    feedDown = true
    const r = await svc.getRates('20261110')
    expect(r.stale).toBe(true)
    expect(r.rateDate).toBeUndefined()
    expect(store.save).not.toHaveBeenCalled()
  })

  it('degrades to the live NBU path when the store cannot be read or written', async () => {
    store.findMany.mockRejectedValueOnce(new Error('relation "nbu_daily_rates" does not exist'))
    store.save.mockRejectedValueOnce(new Error('relation "nbu_daily_rates" does not exist'))
    const r = await svc.getRates('20261110')
    expect(r).toMatchObject({ usdUah: '41.1000', stale: false, rateDate: '20261110' })
  })

  it('works with no store at all (constructed without one)', async () => {
    const bare = new NbuCurrencyService()
    const r = await bare.getRates('20261110')
    expect(r).toMatchObject({ usdUah: '41.1000', stale: false, rateDate: '20261110' })
  })
})

describe('AC2 — batch prefetch, never per row', () => {
  it('reads the store once and calls NBU once per distinct missing day', async () => {
    store.rows.set('20261110', {
      day: '20261110',
      usdUah: '41.1000',
      eurUah: '44.1000',
      sourceId: 'statdirectory',
    })
    // Five "rows" over three distinct past days, one of them already persisted.
    const rates = await svc.getRatesForDays([
      '20261110',
      '20261111',
      '20261111',
      '20261112',
      '20261110',
    ])
    expect(store.findMany).toHaveBeenCalledTimes(1)
    expect(askedDays().sort()).toEqual(['20261111', '20261112'])
    expect(rates.get('20261110')).toMatchObject({ usdUah: '41.1000', stale: false })
    expect(rates.get('20261111')).toMatchObject({ usdUah: '41.2000', stale: false })
    expect(rates.get('20261112')).toMatchObject({ eurUah: '44.3000', stale: false })
    expect([...store.rows.keys()].sort()).toEqual(['20261110', '20261111', '20261112'])

    // A second balance read of the same rows calls NBU for nothing.
    const before = askedDays().length
    await svc.getRatesForDays(['20261110', '20261111', '20261112'])
    expect(askedDays().length).toBe(before)
  })

  it('prices today and future days with the one live rate', async () => {
    const rates = await svc.getRatesForDays(['20261120', '20261120'])
    expect(askedDays()).toEqual(['20261120'])
    expect(rates.get('20261120')).toMatchObject({ usdUah: '41.9000', stale: false })
  })

  it('returns an empty map and calls nothing for no days', async () => {
    const rates = await svc.getRatesForDays([])
    expect(rates.size).toBe(0)
    expect(store.findMany).not.toHaveBeenCalled()
    expect(askedDays()).toEqual([])
  })

  it('bounds the NBU work of one read; the days left over are stale and fetched on a later read', async () => {
    // 40 distinct past days, none published in the stub: the cap still bounds the calls.
    const days = Array.from({ length: 40 }, (_, i) =>
      new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10).replace(/-/g, ''),
    )
    feedDown = false
    const rates = await svc.getRatesForDays(days)
    expect(rates.size).toBe(40)
    for (const d of days) expect(rates.get(d)?.stale).toBe(true)
    // An unanswered day trips the outage breaker: the first one is tried, the rest are not.
    expect(new Set(askedDays())).toEqual(new Set(['20250101', '20241231', '20261120']))
  })
})

describe('AC3 — outage degrades to stale, never breaks', () => {
  it('marks every unresolved day stale and keeps the persisted ones exact', async () => {
    store.rows.set('20261110', {
      day: '20261110',
      usdUah: '41.1000',
      eurUah: '44.1000',
      sourceId: 'statdirectory',
    })
    feedDown = true
    const rates = await svc.getRatesForDays(['20261110', '20261111', '20261112'])
    expect(rates.get('20261110')).toMatchObject({ stale: false, rateDate: '20261110' })
    expect(rates.get('20261111')?.stale).toBe(true)
    expect(rates.get('20261111')?.rateDate).toBeUndefined()
    expect(rates.get('20261112')?.stale).toBe(true)
    // The outage breaker: after the first missing day fails, the next one is not tried.
    expect(askedDays().filter((d) => d === '20261112')).toEqual([])
    expect(store.save).not.toHaveBeenCalled()
  })

  it('makes no historical NBU call when the store is unusable, and marks those days stale', async () => {
    store.findMany.mockRejectedValueOnce(new Error('relation "nbu_daily_rates" does not exist'))
    const rates = await svc.getRatesForDays(['20261110', '20261111'])
    expect(askedDays().filter((d) => d !== '20261120' && d !== '20261119')).toEqual([])
    expect(rates.get('20261110')?.stale).toBe(true)
    expect(rates.get('20261110')?.rateDate).toBeUndefined()
    expect(rates.get('20261111')?.stale).toBe(true)
  })
})
