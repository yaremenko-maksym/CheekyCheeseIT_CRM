import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import { NbuCurrencyService } from './nbu-currency.service'
import type { NbuRateStore, PersistedNbuRate } from './nbu-rate-store'
import { convertDropPayoutAmount } from './pending-settlement-arithmetic.util'

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

/** The caller's own live rate (summary.service passes the one it already fetched, CR-M-1). */
const LIVE = {
  usdUah: '41.9000',
  usdtUah: '41.9000',
  eurUah: '44.9000',
  date: '20261120',
  stale: false,
  rateDate: '20261120',
}
/** The live rate during an outage: the hardcoded fallback, stale and undated. */
const LIVE_DOWN = {
  usdUah: '41.50',
  usdtUah: '41.50',
  eurUah: '44.80',
  date: '20261120',
  stale: true,
}

let feedDown = false
/** Per-currency `exchangedate` override: NBU answering a different day than the one asked. */
let answeredAs: Partial<Record<'USD' | 'EUR', string>> = {}
/** When true, `exchange_site` (the second source) also answers, always correctly dated. */
let exchangeSiteUp = false

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
    const primary = url.includes('statdirectory')
    if (feedDown || !rate || !(primary || (exchangeSiteUp && url.includes('exchange_site')))) {
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve([]) })
    }
    const exchangedate = `${day.slice(6, 8)}.${day.slice(4, 6)}.${day.slice(0, 4)}`
    if (!primary) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { r030: 840, cc: 'USD', rate: rate.usd, exchangedate },
            { r030: 978, cc: 'EUR', rate: rate.eur, exchangedate },
          ]),
      })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve([
          { r030: 840, cc: 'USD', rate: rate.usd, exchangedate: answeredAs.USD ?? exchangedate },
          { r030: 978, cc: 'EUR', rate: rate.eur, exchangedate: answeredAs.EUR ?? exchangedate },
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
  answeredAs = {}
  exchangeSiteUp = false
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

  it.each(['USD', 'EUR'] as const)(
    'an answer whose %s row is dated another day is display-only: stale, undated, unstored (SR-M-1)',
    async (cc) => {
      answeredAs = { [cc]: '09.11.2026' }
      const r = await svc.getRates('20261110')
      expect(r).toEqual({
        usdUah: '41.1000',
        usdtUah: '41.1000',
        eurUah: '44.1000',
        date: '20261110',
        stale: true,
      })
      expect(store.save).not.toHaveBeenCalled()
      // The settlement money path refuses it (no `rateDate`).
      let refused: unknown
      try {
        convertDropPayoutAmount(100, 'USDT', 'UAH', r)
      } catch (err: unknown) {
        refused = err
      }
      expect(refused).toMatchObject({ response: { code: 'FINANCE_NBU_RATE_UNAVAILABLE' } })

      answeredAs = {}
      const before = askedDays().length
      const dated = await svc.getRates('20261110')
      expect(askedDays().slice(before)).toEqual(['20261110'])
      expect(store.rows.get('20261110')?.usdUah).toBe('41.1000')
      // The correctly dated answer prices money: 100 USDT at 41.1 UAH.
      expect(convertDropPayoutAmount(100, 'USDT', 'UAH', dated)).toBe(4110)
    },
  )

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
    const rates = await svc.getRatesForDays(
      ['20261110', '20261111', '20261111', '20261112', '20261110'],
      LIVE,
    )
    expect(store.findMany).toHaveBeenCalledTimes(1)
    expect(askedDays().sort()).toEqual(['20261111', '20261112'])
    expect(rates.get('20261110')).toMatchObject({ usdUah: '41.1000', stale: false })
    expect(rates.get('20261111')).toMatchObject({ usdUah: '41.2000', stale: false })
    expect(rates.get('20261112')).toMatchObject({ eurUah: '44.3000', stale: false })
    expect([...store.rows.keys()].sort()).toEqual(['20261110', '20261111', '20261112'])

    // A second balance read of the same rows calls NBU for nothing.
    const before = askedDays().length
    await svc.getRatesForDays(['20261110', '20261111', '20261112'], LIVE)
    expect(askedDays().length).toBe(before)
  })

  it("prices today and future days with the caller's live rate, asking NBU nothing (CR-M-1)", async () => {
    const rates = await svc.getRatesForDays(['20261120', '20261120', '20261121'], LIVE)
    expect(askedDays()).toEqual([])
    expect(rates.get('20261120')).toBe(LIVE)
    expect(rates.get('20261121')).toBe(LIVE)
  })

  it('one past day costs exactly one NBU call: the live rate is never fetched again (CR-M-1)', async () => {
    await svc.getRatesForDays(['20261110', '20261120'], LIVE)
    expect(askedDays()).toEqual(['20261110'])
  })

  it('returns an empty map and calls nothing for no days', async () => {
    const rates = await svc.getRatesForDays([], LIVE)
    expect(rates.size).toBe(0)
    expect(store.findMany).not.toHaveBeenCalled()
    expect(askedDays()).toEqual([])
  })

  it('bounds the NBU work of one read to 31 days; the rest are stale now and fetched on a later read', async () => {
    const days = Array.from({ length: 40 }, (_, i) =>
      new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10).replace(/-/g, ''),
    )
    for (const d of days) PUBLISHED[d] = { usd: 40, eur: 43 }
    try {
      const rates = await svc.getRatesForDays(days, LIVE)
      expect(rates.size).toBe(40)
      expect(days.filter((d) => rates.get(d)?.stale === false)).toEqual(days.slice(0, 31))
      for (const d of days.slice(31)) {
        expect(rates.get(d)).toMatchObject({ usdUah: '41.9000', stale: true })
        expect(rates.get(d)?.rateDate).toBeUndefined()
      }
      expect(store.rows.size).toBe(31)

      // The next read fetches exactly the 9 left over.
      const before = askedDays().length
      const next = await svc.getRatesForDays(days, LIVE)
      expect(askedDays().slice(before).sort()).toEqual(days.slice(31))
      expect(days.filter((d) => next.get(d)?.stale === false)).toEqual(days)
    } finally {
      for (const d of days) delete PUBLISHED[d]
    }
  })

  it('a day NBU cannot answer while the feed is up does not starve the days after it', async () => {
    // 20250101 is unpublished in the stub, the feed itself is up (today answers exactly).
    const rates = await svc.getRatesForDays(['20250101', '20261110'], LIVE)
    expect(rates.get('20250101')?.stale).toBe(true)
    expect(rates.get('20261110')).toMatchObject({ stale: false, rateDate: '20261110' })
    expect([...store.rows.keys()]).toEqual(['20261110'])

    // The next read costs NBU nothing for the persisted day.
    const before = askedDays().length
    await svc.getRatesForDays(['20250101', '20261110'], LIVE)
    expect(askedDays().slice(before)).not.toContain('20261110')
  })
})

describe('SR-M-2 — one deadline bounds the whole prefetch', () => {
  const fetchMock = (): ReturnType<typeof vi.fn> =>
    globalThis.fetch as unknown as ReturnType<typeof vi.fn>

  it('stops fetching at 30 s; later days are stale stand-ins, unstored, and fetched on the next read', async () => {
    const answer = fetchMock().getMockImplementation()!
    // Every NBU answer takes 16 s of wall clock: two days fit in the 30 s budget, the third does not.
    fetchMock().mockImplementation((url: string) => {
      vi.setSystemTime(Date.now() + 16_000)
      return answer(url)
    })
    const rates = await svc.getRatesForDays(['20261110', '20261111', '20261112'], LIVE)
    expect(askedDays()).toEqual(['20261110', '20261111'])
    expect(rates.get('20261111')).toMatchObject({ stale: false, rateDate: '20261111' })
    expect(rates.get('20261112')).toEqual({
      usdUah: '41.9000',
      usdtUah: '41.9000',
      eurUah: '44.9000',
      date: '20261112',
      stale: true,
    })
    expect([...store.rows.keys()].sort()).toEqual(['20261110', '20261111'])

    fetchMock().mockImplementation(answer)
    const before = askedDays().length
    const next = await svc.getRatesForDays(['20261110', '20261111', '20261112'], LIVE)
    expect(askedDays().slice(before)).toEqual(['20261112'])
    expect(next.get('20261112')).toMatchObject({ stale: false, rateDate: '20261112' })
  })

  it('aborts a request still in flight at the deadline and asks nothing after it', async () => {
    let call = 0
    fetchMock().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      call++
      if (call === 1) {
        // The first source fails slowly, leaving 10 ms of the budget.
        vi.setSystemTime(Date.now() + 29_990)
        return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve([]) })
      }
      // The second source hangs until its (now 10 ms) abort timer fires. `Date` is faked, so
      // the stub moves the clock by those 10 ms itself.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          vi.setSystemTime(Date.now() + 10)
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })
    const started = performance.now()
    const rates = await svc.getRatesForDays(['20261110', '20261111'], LIVE)
    expect(performance.now() - started).toBeLessThan(5_000) // not the 10 s per-request timeout
    expect(call).toBe(2)
    for (const d of ['20261110', '20261111']) {
      expect(rates.get(d)).toMatchObject({ usdUah: '41.9000', stale: true })
      expect(rates.get(d)?.rateDate).toBeUndefined()
    }
    expect(store.save).not.toHaveBeenCalled()
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
    const rates = await svc.getRatesForDays(['20261110', '20261111', '20261112'], LIVE_DOWN)
    expect(rates.get('20261110')).toMatchObject({ stale: false, rateDate: '20261110' })
    expect(rates.get('20261111')?.stale).toBe(true)
    expect(rates.get('20261111')?.rateDate).toBeUndefined()
    expect(rates.get('20261112')?.stale).toBe(true)
    // CR-M-5: a stale live rate means the feed is down, so the prefetch asks NBU nothing.
    expect(askedDays()).toEqual([])
    expect(store.save).not.toHaveBeenCalled()
  })

  it('makes no historical NBU call when the store is unusable, and marks those days stale', async () => {
    store.findMany.mockRejectedValueOnce(new Error('relation "nbu_daily_rates" does not exist'))
    const rates = await svc.getRatesForDays(['20261110', '20261111'], LIVE)
    expect(askedDays()).toEqual([])
    expect(rates.get('20261110')?.stale).toBe(true)
    expect(rates.get('20261110')?.rateDate).toBeUndefined()
    expect(rates.get('20261111')?.stale).toBe(true)
  })
})

describe('fix round 3 — every NBU source is date-checked (MED)', () => {
  it('a wrongly dated primary falls through to a correctly dated fallback, which is persisted', async () => {
    answeredAs = { USD: '09.11.2026' }
    exchangeSiteUp = true
    const r = await svc.getRates('20261110')
    expect(r).toEqual({
      usdUah: '41.1000',
      usdtUah: '41.1000',
      eurUah: '44.1000',
      date: '20261110',
      stale: false,
      rateDate: '20261110',
    })
    expect(store.rows.get('20261110')).toMatchObject({ sourceId: 'exchange_site' })
  })

  it('the previous-day path checks ITS day: a wrongly dated Saturday is stale with no rateDate', async () => {
    // Sunday 20261115 is unpublished in the stub, so Saturday 20261114 answers for it.
    PUBLISHED['20261114'] = { usd: 41.4, eur: 44.4 }
    try {
      // Control: correctly dated, the weekend rule makes Saturday payable for Sunday.
      const ok = await svc.getRates('20261115')
      expect(ok).toMatchObject({ usdUah: '41.4000', stale: true, rateDate: '20261114' })

      answeredAs = { EUR: '13.11.2026' }
      const r = await svc.getRates('20261115')
      expect(r.stale).toBe(true)
      expect(r.rateDate).toBeUndefined()
      expect(store.save).not.toHaveBeenCalled()
    } finally {
      delete PUBLISHED['20261114']
    }
  })

  it('a today request served by a wrongly dated yesterday never seeds the payable cache', async () => {
    // Today is Sunday 20261122 (unpublished), so Saturday 20261121 answers the live request;
    // a correctly dated Saturday would be payable for Sunday, from the feed and from the cache.
    vi.setSystemTime(new Date('2026-11-22T09:00:00Z'))
    PUBLISHED['20261121'] = { usd: 41.8, eur: 44.8 }
    try {
      answeredAs = { USD: '20.11.2026' }
      const r = await svc.getRates()
      expect(r.rateDate).toBeUndefined()
      // The feed then dies: the cache must not give the wrong-day numbers a `rateDate`.
      feedDown = true
      const later = await svc.getRates()
      expect(later.rateDate).toBeUndefined()
    } finally {
      delete PUBLISHED['20261121']
    }
  })
})

describe('fix round 3 — a requested date must be a real calendar day (LOW)', () => {
  it.each(['20260230', '00000000', '20261301', '20261100'])(
    'rejects %s like a bad format, before the store or NBU is touched',
    async (bad) => {
      await expect(svc.getRates(bad)).rejects.toMatchObject({
        response: { code: 'FINANCE_DATE_FORMAT_INVALID' },
      })
      expect(store.findMany).not.toHaveBeenCalled()
      expect(askedDays()).toEqual([])
    },
  )

  it('accepts a leap day', async () => {
    const r = await svc.getRates('20240229')
    expect(r.date).toBe('20240229')
    expect(store.findMany).toHaveBeenCalledWith(['20240229'])
  })
})

describe('fix round 3 — a failed past day cools down for 10 minutes (LOW)', () => {
  it('does not refetch a failed day within 10 min, prices it as the stale stand-in, retries after', async () => {
    // 20250101 is unpublished in the stub while the feed is up.
    await svc.getRatesForDays(['20250101'], LIVE)
    expect(askedDays()).toContain('20250101')

    vi.setSystemTime(Date.now() + 10 * 60_000 - 1)
    const before = askedDays().length
    const cooled = await svc.getRatesForDays(['20250101', '20261110'], LIVE)
    expect(askedDays().slice(before)).toEqual(['20261110'])
    expect(cooled.get('20250101')).toEqual({
      usdUah: '41.9000',
      usdtUah: '41.9000',
      eurUah: '44.9000',
      date: '20250101',
      stale: true,
    })

    vi.setSystemTime(Date.now() + 1)
    const after = askedDays().length
    await svc.getRatesForDays(['20250101'], LIVE)
    expect(askedDays().slice(after)).toContain('20250101')
  })

  it('cools down a wrong-day answer too; a direct getRates still retries at once', async () => {
    answeredAs = { USD: '09.11.2026' }
    await svc.getRatesForDays(['20261110'], LIVE)
    answeredAs = {}
    const before = askedDays().length
    const r = await svc.getRatesForDays(['20261110'], LIVE)
    expect(askedDays().slice(before)).toEqual([])
    expect(r.get('20261110')?.rateDate).toBeUndefined()
    expect(await svc.getRates('20261110')).toMatchObject({ rateDate: '20261110' })
  })

  it('never cools down a day cut by the prefetch deadline', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const answer = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(() => {
      vi.setSystemTime(Date.now() + 31_000)
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve([]) })
    })
    await svc.getRatesForDays(['20261110'], LIVE)
    fetchMock.mockImplementation(answer)
    const before = askedDays().length
    const r = await svc.getRatesForDays(['20261110'], LIVE)
    expect(askedDays().slice(before)).toEqual(['20261110'])
    expect(r.get('20261110')).toMatchObject({ rateDate: '20261110' })
  })

  it('bounds the cooldown map at 100 days, evicting the oldest', async () => {
    const days = Array.from({ length: 101 }, (_, i) =>
      new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10).replace(/-/g, ''),
    )
    for (let i = 0; i < days.length; i += 31) {
      await svc.getRatesForDays(days.slice(i, i + 31), LIVE)
    }
    const before = askedDays().length
    await svc.getRatesForDays([days[1]!], LIVE)
    expect(askedDays().slice(before)).toEqual([]) // still cooled
    await svc.getRatesForDays([days[0]!], LIVE)
    expect(askedDays().slice(before)).toContain(days[0]) // evicted, so fetched again
  })
})
