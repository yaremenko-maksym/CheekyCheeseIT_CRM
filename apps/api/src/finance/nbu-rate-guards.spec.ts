import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import { NbuCurrencyService } from './nbu-currency.service'
import type { NbuRateStore, PersistedNbuRate } from './nbu-rate-store'

/**
 * PR #1523 fix round 5 (CI mutation gate): the guards of `NbuCurrencyService` that a wrong answer
 * would not show on the returned numbers alone — which days touch the store, what is persisted,
 * why a prefetch stopped (the operator's log), and the dated-cache order of `fetchRates`.
 *
 * The NBU stub answers by the DAY in the URL (`statdirectory` dialect only; every other source is
 * down), and may advance the fake clock to drive the prefetch deadline.
 */

const TODAY_ISO = '2026-11-20' // a Friday
type Row = { cc: string; rate: number; exchangedate?: string }
let published: Record<string, Row[]> = {}
/** Milliseconds the clock moves forward when NBU is asked for a given day. */
let delayFor: Record<string, number> = {}

function dayOf(url: string): string {
  const m = /date=(\d{8})/.exec(url) ?? /date=(\d{2})\.(\d{2})\.(\d{4})/.exec(url)
  if (!m) throw new Error(`unexpected NBU url ${url}`)
  return m.length === 2 ? m[1]! : `${m[3]}${m[2]}${m[1]}`
}
const dotted = (d: string): string => `${d.slice(6, 8)}.${d.slice(4, 6)}.${d.slice(0, 4)}`
const day = (usd: number, eur: number): Row[] => [
  { cc: 'USD', rate: usd },
  { cc: 'EUR', rate: eur },
]

function installFeed(): void {
  // @ts-expect-error — test stub for global fetch
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    const d = dayOf(url)
    if (delayFor[d]) vi.setSystemTime(Date.now() + delayFor[d])
    const rows = published[d]
    if (!rows || !url.includes('statdirectory')) {
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve([]) })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          rows.map((r) => ({
            r030: 1,
            cc: r.cc,
            rate: r.rate,
            exchangedate: r.exchangedate ?? dotted(d),
          })),
        ),
    })
  })
}
const askedDays = (): string[] =>
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([u]) =>
    dayOf(u as string),
  )

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

const LIVE = {
  usdUah: '41.9000',
  usdtUah: '41.9000',
  eurUah: '44.9000',
  date: '20261120',
  stale: false,
  rateDate: '20261120',
}
let store: FakeStore
let svc: NbuCurrencyService
let log: ReturnType<typeof vi.spyOn>
let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
const said = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((c) => String(c[0]))
const prefetchWarnings = (): string[] =>
  said(warn).filter((m) => m.includes('historical prefetch incomplete'))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${TODAY_ISO}T09:00:00Z`))
  log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  published = {
    '20261110': day(41.1, 44.1),
    '20261111': day(41.2, 44.2),
    '20261120': day(41.9, 44.9),
  }
  delayFor = {}
  installFeed()
  store = new FakeStore()
  svc = new NbuCurrencyService(store as unknown as NbuRateStore)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the requested day is validated before anything else', () => {
  it.each(['2026111', 'x20261110', '20261110x', 'abcdefgh'])('rejects %s', async (bad) => {
    await expect(svc.getRates(bad)).rejects.toMatchObject({
      response: { code: 'FINANCE_DATE_FORMAT_INVALID' },
    })
    expect(askedDays()).toEqual([])
  })
})

describe('only a past day reads the store', () => {
  it('today never reads the store, even when it holds a row for today', async () => {
    store.rows.set('20261120', {
      day: '20261120',
      usdUah: '40.0000',
      eurUah: '43.0000',
      sourceId: 'statdirectory',
    })
    expect(await svc.getRates()).toMatchObject({ usdUah: '41.9000', rateDate: '20261120' })
    expect(store.findMany).not.toHaveBeenCalled()
  })

  it('a persisted past day logs its provenance as the store', async () => {
    store.rows.set('20261110', {
      day: '20261110',
      usdUah: '41.1000',
      eurUah: '44.1000',
      sourceId: 'statdirectory',
    })
    await svc.getRates('20261110')
    expect(
      said(log).some(
        (m) => m.includes('origin=persisted:statdirectory') && m.includes('url=(nbu_daily_rates)'),
      ),
    ).toBe(true)
  })

  it('a batch of only today and future days reads neither the store nor NBU', async () => {
    const out = await svc.getRatesForDays(['20261120', '20261121'], LIVE)
    expect([...out.keys()].sort()).toEqual(['20261120', '20261121'])
    expect(store.findMany).not.toHaveBeenCalled()
    expect(askedDays()).toEqual([])
  })

  it('without a store nothing is read or written, and no store failure is logged', async () => {
    const bare = new NbuCurrencyService()
    expect(await bare.getRates('20261110')).toMatchObject({ rateDate: '20261110', stale: false })
    expect(said(error).filter((m) => m.includes('rate store'))).toEqual([])
  })
})

describe('what is persisted', () => {
  it.each([
    ['a zero USD rate', day(0, 44.1)],
    ['a zero EUR rate', day(41.1, 0)],
    ['an infinite USD rate', day(Infinity, 44.1)],
  ])('never persists %s', async (_label, rows) => {
    published['20261110'] = rows
    await svc.getRates('20261110')
    expect(store.save).not.toHaveBeenCalled()
  })

  it('the write guard alone refuses a stale result and an undated one', async () => {
    // `buildResult` never makes either shape (it dates exactly the non-stale results); a row is
    // permanent, so each half of the guard is pinned on its own.
    const persist = (r: object): Promise<void> =>
      (svc as unknown as { persistExact(r: object, s: string): Promise<void> }).persistExact(
        r,
        'statdirectory',
      )
    const exact = { usdUah: '41.1000', usdtUah: '41.1000', eurUah: '44.1000', date: '20261110' }
    await persist({ ...exact, stale: true, rateDate: '20261110' })
    await persist({ ...exact, stale: false })
    expect(store.save).not.toHaveBeenCalled()
    await persist({ ...exact, stale: false, rateDate: '20261110' })
    expect(store.save).toHaveBeenCalledTimes(1)
  })

  it('a failed write is logged with the day, and the read still succeeds', async () => {
    store.save.mockRejectedValueOnce(new Error('relation does not exist'))
    expect(await svc.getRates('20261110')).toMatchObject({ rateDate: '20261110', stale: false })
    expect(said(error)).toContainEqual(
      expect.stringContaining(
        'NBU rate store write failed | provider=nbu_daily_rates | day=20261110 | cause=Error: relation does not exist',
      ),
    )
  })

  it('a failed read is logged, and the live NBU path answers', async () => {
    store.findMany.mockRejectedValueOnce(new Error('relation does not exist'))
    expect(await svc.getRates('20261110')).toMatchObject({ rateDate: '20261110' })
    expect(said(error)).toContainEqual(
      expect.stringContaining(
        'NBU rate store read failed | provider=nbu_daily_rates | cause=Error: relation does not exist',
      ),
    )
  })
})

describe('the date check and its log', () => {
  it('a right-day answer logs no wrong-day warning; a wrong-day one says which source and day', async () => {
    await svc.getRates('20261111')
    expect(said(warn).filter((m) => m.includes('dated another day'))).toEqual([])

    // 20261110 answered as 09.11; the previous day 20261109 is unpublished, so the wrong-day
    // answer is what is served (for display).
    published['20261110'] = [
      { cc: 'USD', rate: 41.1, exchangedate: '09.11.2026' },
      { cc: 'EUR', rate: 44.1 },
    ]
    await svc.getRates('20261110')
    expect(said(warn)).toContainEqual(
      'NBU source "statdirectory" answered for 20261110 with rates dated another day — trying next source',
    )
    expect(said(warn)).toContainEqual(
      expect.stringContaining(
        'NBU answer dated another day | provider=bank.gov.ua | source=statdirectory | day=20261110',
      ),
    )
  })

  it('a row of another currency dated another day does not make a right answer wrong', async () => {
    published['20261110'] = [
      ...day(41.1, 44.1),
      { cc: 'GBP', rate: 52, exchangedate: '07.11.2026' },
    ]
    expect(await svc.getRates('20261110')).toMatchObject({ stale: false, rateDate: '20261110' })
  })
})

describe('why a prefetch stopped is logged exactly', () => {
  it('logs nothing when every day was fetched', async () => {
    await svc.getRatesForDays(['20261110', '20261111'], LIVE)
    expect(prefetchWarnings()).toEqual([])
  })

  it('an unreadable store: no NBU call and the cause, even when the read took past the deadline', async () => {
    store.findMany.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 31_000)
      throw new Error('boom')
    })
    await svc.getRatesForDays(['20261110'], LIVE)
    expect(askedDays()).toEqual([])
    expect(prefetchWarnings()).toEqual([
      expect.stringContaining('cause=rate store unavailable | daysAtLiveRate=1 | cooledDays=0'),
    ])
  })

  it('a stale live rate: no NBU call and the cause', async () => {
    await svc.getRatesForDays(['20261110'], { ...LIVE, stale: true })
    expect(askedDays()).toEqual([])
    expect(prefetchWarnings()).toEqual([
      expect.stringContaining('cause=NBU feed down (live rate stale) | daysAtLiveRate=1'),
    ])
  })

  it('the per-read cap: the first day past it is priced at the live rate', async () => {
    const days = Array.from({ length: 32 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10).replace(/-/g, ''),
    )
    for (const d of days) published[d] = day(40, 43)
    const out = await svc.getRatesForDays(days, LIVE)
    expect(out.get(days[31]!)).toMatchObject({ usdUah: '41.9000', stale: true })
    expect(prefetchWarnings()).toEqual([
      expect.stringContaining('cause=per-read cap of 31 fetches reached | daysAtLiveRate=1'),
    ])
  })

  it('a fetch that ends exactly at the deadline stops the prefetch before the next day', async () => {
    delayFor['20261110'] = 30_000
    const out = await svc.getRatesForDays(['20261110', '20261111'], LIVE)
    expect(out.get('20261110')).toMatchObject({ rateDate: '20261110' })
    expect(out.get('20261111')).toMatchObject({ usdUah: '41.9000', stale: true })
    expect(prefetchWarnings()).toEqual([
      expect.stringContaining('cause=prefetch deadline of 30000ms reached | daysAtLiveRate=1'),
    ])
    expect(said(error).filter((m) => m.includes('NBU unavailable on every source'))).toEqual([])
  })

  it('a cooling day read under a stopped prefetch is a stand-in for the stop, not a cooled day', async () => {
    await svc.getRatesForDays(['20261109'], LIVE) // unanswerable (and so is 20261108): cooled
    const asked = askedDays().length
    await svc.getRatesForDays(['20261109'], { ...LIVE, stale: true })
    await svc.getRatesForDays(['20261109'], LIVE)
    expect(asked).toBeGreaterThan(0)
    expect(askedDays()).toHaveLength(asked) // neither later read asked NBU again
    expect(prefetchWarnings()).toEqual([
      expect.stringContaining(
        'cause=NBU feed down (live rate stale) | daysAtLiveRate=1 | cooledDays=0',
      ),
      expect.stringContaining('cause=failed days cooling down | daysAtLiveRate=1 | cooledDays=1'),
    ])
  })

  it('a day cut by the deadline on the last allowed fetch keeps the deadline as the cause', async () => {
    const days = Array.from({ length: 32 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10).replace(/-/g, ''),
    )
    for (const d of days.slice(0, 30)) published[d] = day(40, 43)
    delayFor[days[30]!] = 30_000 // the 31st fetch: unpublished, and the clock runs out on it
    await svc.getRatesForDays(days, LIVE)
    expect(prefetchWarnings()).toEqual([
      expect.stringContaining('cause=prefetch deadline of 30000ms reached | daysAtLiveRate=2'),
    ])
  })
})

describe('fix round 5 — the dated-cache order of the previous-day step', () => {
  it('a dated previous day beats a dated cache', async () => {
    await svc.getRates() // Friday 20261120 cached, rightly dated
    vi.setSystemTime(new Date('2026-11-23T09:00:00Z')) // Monday
    published['20261121'] = day(41.95, 44.95) // Saturday, payable for Sunday by the weekend rule
    expect(await svc.getRates('20261122')).toEqual({
      usdUah: '41.9500',
      usdtUah: '41.9500',
      eurUah: '44.9500',
      date: '20261122',
      stale: true,
      rateDate: '20261121',
    })
  })

  it('an undated previous day beats a cache that does not price the day', async () => {
    await svc.getRates() // Friday 20261120 cached
    vi.setSystemTime(new Date('2026-11-25T09:00:00Z')) // Wednesday
    published['20261123'] = day(42.3, 45.3) // Monday, rightly dated; Tuesday has its own rate
    expect(await svc.getRates('20261124')).toEqual({
      usdUah: '42.3000',
      usdtUah: '42.3000',
      eurUah: '45.3000',
      date: '20261124',
      stale: true,
    })
  })
})
