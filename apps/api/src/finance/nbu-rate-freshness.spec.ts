import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import { kyivToday } from '@crm/shared'
import { NbuCurrencyService } from './nbu-currency.service'

/**
 * MED-6 — freshness of the last-known-good cache, and the multi-path source
 * list, for `NbuCurrencyService`.
 *
 * ── WHAT IS ACTUALLY BEING GUARDED ───────────────────────────────────────────
 * `rateDate` is a MONEY GATE, not a label. Both paths that write a permanent,
 * irreversible amount — DROP settle (`PendingSettlementService`) and
 * `createPayoutRequest` (`transactions.service`) — refuse on exactly
 * `stale && rateDate === undefined`. So every assertion on `rateDate` below is
 * really an assertion about whether a payout would be allowed to proceed.
 *
 * ── THE MOCK DESCRIBES THE REAL API, SO IT CAN FAIL A MUTANT ─────────────────
 * The stub is keyed on WHICH SERVICE and WHICH DAY a URL asks for, and each
 * service answers in its OWN field dialect exactly as the live API does
 * (verified against bank.gov.ua on 2026-08-18):
 *   - statdirectory → { r030, txt, rate, cc, exchangedate }
 *   - exchange_site → adds { units, rate_per_unit, calcdate, enname, group }
 *   - open_data     → { StartDate, CurrencyCodeL, Units, Amount } and a
 *                     DOTTED date (`date=03.07.2026`), not `YYYYMMDD`
 * A mock keyed on call ORDER instead would silently pass a mutant that asked
 * for the wrong day or parsed the wrong dialect — the failure mode this file
 * exists to prevent. Nothing here asserts "the mock was called N times".
 *
 * ── CALENDAR FACTS THE GATE RELIES ON (measured, not assumed) ────────────────
 * Over 383 consecutive days pulled live from `exchange_site` (2025-08-01 …
 * 2026-08-18): NBU publishes a record for EVERY calendar day, and ONLY
 * Saturday and Sunday repeat the preceding Friday's value. Public holidays get
 * their own fresh value (Mon 09.03.2026 = 43.7292 vs Fri 43.8069; Mon
 * 11.05.2026 = 43.855 vs Fri 43.8033), which is why the gate cannot simply
 * treat "holiday" as "stale but fine".
 */

type SourceId = 'statdirectory' | 'exchange_site' | 'open_data'

const ALL_SOURCES: SourceId[] = ['statdirectory', 'exchange_site', 'open_data']

/** Which NBU service a URL addresses (null = something we never should call). */
function sourceOf(url: string): SourceId | null {
  if (url.includes('/NBUStatService/v1/statdirectory/exchange?')) return 'statdirectory'
  if (url.includes('/NBU_Exchange/exchange_site?')) return 'exchange_site'
  if (url.includes('/NBU_Exchange/exchange?')) return 'open_data'
  return null
}

/** The requested day, normalised to `YYYYMMDD` from either date dialect. */
function requestedDay(url: string): string | null {
  const m = /[?&]date=([^&]+)/.exec(url)
  if (m === null) return null
  const raw = m[1] as string
  if (/^\d{8}$/.test(raw)) return raw
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw)
  return dotted === null ? null : `${dotted[3]}${dotted[2]}${dotted[1]}`
}

function ymdToDotted(ymd: string): string {
  return `${ymd.slice(6, 8)}.${ymd.slice(4, 6)}.${ymd.slice(0, 4)}`
}

type Row = { cc: string; rate: number }

/** Renders rows in the dialect the given service really speaks. */
function renderRows(source: SourceId, day: string, rows: Row[]): unknown[] {
  const dotted = ymdToDotted(day)
  if (source === 'statdirectory') {
    return rows.map((r) => ({ r030: 0, txt: r.cc, rate: r.rate, cc: r.cc, exchangedate: dotted }))
  }
  if (source === 'exchange_site') {
    return rows.map((r) => ({
      exchangedate: dotted,
      r030: 0,
      cc: r.cc,
      txt: r.cc,
      enname: r.cc,
      rate: r.rate,
      units: 1,
      rate_per_unit: r.rate,
      group: '1',
      calcdate: dotted,
      special: 'N',
    }))
  }
  return rows.map((r) => ({
    StartDate: dotted,
    TimeSign: '0000',
    CurrencyCode: '840',
    CurrencyCodeL: r.cc,
    Units: 1,
    Amount: r.rate,
  }))
}

const requestedUrls: string[] = []

/**
 * Installs the NBU stub.
 * @param data  rates per `YYYYMMDD`; a day that is absent answers 200 with an
 *              empty array — exactly how the live feed answers for a day it has
 *              no record for (verified against tomorrow's date on 2026-08-18).
 * @param up    services that respond at all; any other errors like a dead
 *              endpoint. Defaults to all three.
 */
function mockNbu(data: Record<string, Row[]>, up: SourceId[] = ALL_SOURCES): void {
  // @ts-expect-error — test stub for global fetch
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    requestedUrls.push(url)
    const source = sourceOf(url)
    const day = requestedDay(url)
    if (source === null || day === null) return Promise.reject(new Error('unexpected URL'))
    if (!up.includes(source)) return Promise.reject(new Error(`${source} is down`))
    const rows = data[day] ?? []
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(renderRows(source, day, rows)),
    })
  })
}

/** Every source fails outright — a whole-host outage (DNS, TLS, network). */
function mockTotalOutage(): void {
  // @ts-expect-error — test stub
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    requestedUrls.push(url)
    return Promise.reject(new Error('ECONNREFUSED'))
  })
}

const RATES: Row[] = [
  { cc: 'USD', rate: 44.6988 },
  { cc: 'EUR', rate: 51.8082 },
]

/** Pins the clock; the freshness gate is calendar-dependent by design. */
function pinDay(isoDay: string): void {
  vi.setSystemTime(new Date(`${isoDay}T09:00:00Z`))
}

describe('MED-6: last-known-good cache freshness gate', () => {
  let svc: NbuCurrencyService
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    requestedUrls.length = 0
    svc = new NbuCurrencyService()
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    // Only `Date` is faked — the service's AbortController timer must stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** Seeds the cache with a genuine live fetch made ON `isoDay`. */
  async function seedCacheOn(isoDay: string): Promise<void> {
    const ymd = isoDay.replace(/-/g, '')
    pinDay(isoDay)
    mockNbu({ [ymd]: RATES })
    const seeded = await svc.getRates()
    expect(seeded.stale).toBe(false)
    expect(seeded.rateDate).toBe(ymd)
  }

  it('THE BUG: a rate cached MINUTES ago is dated, so a payout still goes through', async () => {
    // The MED-6 report exactly: the feed answered at 09:00, died at 09:05, and
    // the 09:05 payout was refused as though the feed had never worked.
    await seedCacheOn('2026-07-07') // Tuesday
    mockTotalOutage()

    const result = await svc.getRates()

    expect(result.stale).toBe(true) // it IS a fallback — that stays honest
    expect(result.rateDate).toBe('20260707') // ...but it is a DATED one
    expect(parseFloat(result.usdUah)).toBeCloseTo(44.6988, 4)
    // The money gate both payout paths apply:
    expect(result.stale === true && result.rateDate === undefined).toBe(false)
  })

  it('a rate cached on Friday still prices Saturday and Sunday — no new NBU rate took effect', async () => {
    // Sat/Sun are the ONLY days that repeat Friday's value, so the cached
    // number is not merely close, it is the officially applicable one.
    await seedCacheOn('2026-07-03') // Friday
    mockTotalOutage()

    pinDay('2026-07-04') // Saturday, age 1
    const sat = await svc.getRates()
    expect(sat.rateDate).toBe('20260703')

    pinDay('2026-07-05') // Sunday, age 2
    const sun = await svc.getRates()
    expect(sun.rateDate).toBe('20260703')
    expect(parseFloat(sun.usdUah)).toBeCloseTo(44.6988, 4)
  })

  it('REFUSES a Friday rate on Monday — Monday has its own official rate', async () => {
    await seedCacheOn('2026-07-03') // Friday
    mockTotalOutage()
    pinDay('2026-07-06') // Monday, age 3

    const mon = await svc.getRates()

    expect(mon.stale).toBe(true)
    expect(mon.rateDate).toBeUndefined() // → payout refused
    // Still usable for DISPLAY, so screens render instead of crashing.
    expect(parseFloat(mon.usdUah)).toBeCloseTo(44.6988, 4)
  })

  it('REFUSES a Saturday rate on Monday — age is only 2, but a business day began', async () => {
    // This is the case a plain "age <= 2 days" rule would WRONGLY accept, and
    // is why the gate asks "has a new rate taken effect" instead of counting
    // days. Monday 06.07 has its own NBU value.
    await seedCacheOn('2026-07-04') // Saturday
    mockTotalOutage()
    pinDay('2026-07-06') // Monday — age 2

    const mon = await svc.getRates()

    expect(mon.rateDate).toBeUndefined()
  })

  it('REFUSES a Monday rate on Tuesday — one day old is already superseded', async () => {
    // Measured live: 17.08.2026 = 44.7061, 18.08.2026 = 44.6938. A one-day-old
    // weekday rate is simply the wrong number, so "age <= 2" would misprice it.
    await seedCacheOn('2026-07-06') // Monday
    mockTotalOutage()
    pinDay('2026-07-07') // Tuesday — age 1

    const tue = await svc.getRates()

    expect(tue.rateDate).toBeUndefined()
  })

  it('REFUSES a cache NEWER than the day being priced (historical request during an outage)', async () => {
    await seedCacheOn('2026-07-07') // Tuesday
    mockTotalOutage()

    // A DROP settle dated last March, resolved while the feed is down: today's
    // rate is not March's rate.
    const historical = await svc.getRates('20260301')

    expect(historical.stale).toBe(true)
    expect(historical.rateDate).toBeUndefined()
  })

  it('the hardcoded constant is NEVER dated — a payout can never ride on an invented number', async () => {
    // Fresh service, nothing ever cached, everything down.
    pinDay('2026-07-07')
    mockTotalOutage()

    const result = await svc.getRates()

    expect(result.stale).toBe(true)
    expect(result.rateDate).toBeUndefined()
    expect(parseFloat(result.usdUah)).toBeGreaterThan(0) // display still works
  })

  it('AC4: a total outage degrades, it does not throw — display survives, money refuses', async () => {
    pinDay('2026-07-07')
    mockTotalOutage()

    await expect(svc.getRates()).resolves.toBeDefined() // no crash
    const result = await svc.getRates()
    expect(parseFloat(result.usdUah)).toBeGreaterThan(0)
    expect(parseFloat(result.eurUah)).toBeGreaterThan(0)
    expect(result.usdtUah).toBe(result.usdUah) // USDT peg holds even here
    expect(result.rateDate).toBeUndefined()
  })

  it('MED-1: the previous-day path obeys the SAME gate — Sunday cannot price Monday', async () => {
    // Before the fix this path claimed `rateDate` unconditionally, so the
    // outcome depended on the ROUTE rather than the calendar: this exact
    // situation is refused when it arrives via the cache ("REFUSES a Friday
    // rate on Monday"), yet was accepted when it arrived here. Monday has its
    // own official NBU rate either way.
    pinDay('2026-07-06') // Monday
    mockNbu({ '20260705': RATES }) // only Sunday published

    const result = await svc.getRates()

    expect(result.stale).toBe(true)
    expect(result.date).toBe('20260706') // still echoes the requested day
    expect(result.rateDate).toBeUndefined() // → payout refused
    expect(parseFloat(result.usdUah)).toBeCloseTo(44.6988, 4) // display still works
    // The warning must say which of the two prev-day outcomes this was —
    // "we fell back a day" alone does not tell an operator whether the
    // payout will go through.
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'display only, money paths refuse',
    )
  })

  it('MED-1: the previous-day path still prices a weekday rate reached on the SAME day', async () => {
    // Guards against over-correcting: a Saturday request served by Friday's
    // publication crosses no new rate (Sat repeats Fri), so it stays payable.
    pinDay('2026-07-04') // Saturday
    mockNbu({ '20260703': RATES }) // only Friday published

    const result = await svc.getRates()

    expect(result.stale).toBe(true)
    expect(result.rateDate).toBe('20260703')
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'DATED for the requested day',
    )
  })

  it('MED-1: a DEGRADED previous-day response is not dated, even when the calendar allows it', async () => {
    // Friday→Saturday crosses no new rate, so the calendar says "payable" —
    // but the response itself was incomplete (no EUR), so `buildResult`
    // already declined to date it. The calendar check must not resurrect a
    // date that the response never earned.
    pinDay('2026-07-04') // Saturday
    mockNbu({ '20260703': [{ cc: 'USD', rate: 44.6988 }] }) // Friday, USD only

    const result = await svc.getRates()

    expect(result.stale).toBe(true)
    expect(result.rateDate).toBeUndefined()
    // Absent, not present-and-undefined: the codebase distinguishes the two
    // (`exactOptionalPropertyTypes`), and `buildResult` documents that it omits
    // the key rather than setting it.
    expect(Object.prototype.hasOwnProperty.call(result, 'rateDate')).toBe(false)
  })

  it('a weekend rate obtained WITH a real date still prices money (unchanged behaviour)', async () => {
    // The prev-day path: the requested day has no record anywhere, the day
    // before does. That is a real NBU publication and must NOT be refused.
    pinDay('2026-07-05') // Sunday
    mockNbu({ '20260704': RATES }) // only Saturday has data

    const result = await svc.getRates()

    expect(result.stale).toBe(true)
    expect(result.date).toBe('20260705') // echoes the REQUESTED day
    expect(result.rateDate).toBe('20260704') // ...from Saturday's publication
    expect(result.stale === true && result.rateDate === undefined).toBe(false)
  })
})

describe('Part 2: multiple NBU paths, tried in a fixed order', () => {
  let svc: NbuCurrencyService

  beforeEach(() => {
    requestedUrls.length = 0
    svc = new NbuCurrencyService()
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'] })
    pinDay('2026-07-07')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('falls through to exchange_site when the primary service is broken', async () => {
    mockNbu({ '20260707': RATES }, ['exchange_site', 'open_data'])

    const result = await svc.getRates()

    expect(result.stale).toBe(false)
    expect(result.rateDate).toBe('20260707')
    expect(parseFloat(result.usdUah)).toBeCloseTo(44.6988, 4)
  })

  it('falls through to the open-data service, whose field names AND date format differ', async () => {
    // Reaching this source at all requires building `date=07.07.2026`, not
    // `date=20260707`, and reading `CurrencyCodeL`/`Amount` rather than
    // `cc`/`rate`. A mutant that reused the primary dialect gets nothing here.
    mockNbu({ '20260707': RATES }, ['open_data'])

    const result = await svc.getRates()

    expect(result.stale).toBe(false)
    expect(parseFloat(result.usdUah)).toBeCloseTo(44.6988, 4)
    expect(parseFloat(result.eurUah)).toBeCloseTo(51.8082, 4)
    expect(requestedUrls.some((u) => u.includes('date=07.07.2026'))).toBe(true)
  })

  it('order is deterministic: the primary answers, later sources are not consulted', async () => {
    // Money must not depend on which endpoint happens to be quickest.
    mockNbu({ '20260707': RATES })

    await svc.getRates()

    expect(sourceOf(requestedUrls[0] as string)).toBe('statdirectory')
    expect(requestedUrls.some((u) => sourceOf(u) === 'exchange_site')).toBe(false)
  })

  it('never calls exchangenew — it is the same handler as exchange, not a second path', async () => {
    // Verified live 2026-08-18: byte-for-byte identical responses. Listing it
    // would fake redundancy that does not exist.
    mockNbu({}, [])

    await svc.getRates()

    expect(requestedUrls.length).toBeGreaterThan(0)
    expect(requestedUrls.some((u) => u.includes('exchangenew'))).toBe(false)
  })

  it('the exact requested day beats a nearer source: date correctness outranks source order', async () => {
    // Primary has nothing for today but has yesterday; exchange_site has TODAY.
    // The right answer is today's rate from exchange_site, not yesterday's from
    // the primary — otherwise we would pay on the wrong day's number.
    mockNbu(
      {
        '20260707': RATES,
        '20260706': [
          { cc: 'USD', rate: 1 },
          { cc: 'EUR', rate: 2 },
        ],
      },
      ['exchange_site'],
    )

    const result = await svc.getRates()

    expect(result.rateDate).toBe('20260707')
    expect(parseFloat(result.usdUah)).toBeCloseTo(44.6988, 4)
  })

  it('a source answering without USD/EUR is passed over for one that has them', async () => {
    // A partial body is not a usable rate: converting EUR with a missing EUR
    // row would silently substitute a cached or invented number.
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      requestedUrls.push(url)
      const source = sourceOf(url)
      const day = requestedDay(url)
      if (source === null || day === null) return Promise.reject(new Error('unexpected URL'))
      const rows: Row[] =
        source === 'statdirectory'
          ? [{ cc: 'PLN', rate: 11.1 }] // answers, but not with what we price in
          : RATES
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(renderRows(source, day, rows)),
      })
    })

    const result = await svc.getRates()

    expect(result.stale).toBe(false)
    expect(parseFloat(result.usdUah)).toBeCloseTo(44.6988, 4)
    expect(parseFloat(result.eurUah)).toBeCloseTo(51.8082, 4)
  })
})

/**
 * Independent reference for "one calendar day earlier", built from UTC
 * component getters. Deliberately a DIFFERENT algorithm from the implementation
 * (which subtracts 86_400_000 ms): if both were the same arithmetic, the test
 * would be a tautology that stays green for any shared mistake.
 */
function utcPrevDay(ymd: string): string {
  const d = new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))),
  )
  d.setUTCDate(d.getUTCDate() - 1)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
}

describe('previous-day arithmetic survives DST transitions', () => {
  // Regression cover for the bug fixed in this PR: the old implementation
  // parsed the date as UTC and then stepped back with LOCAL getters/setters,
  // which skipped TWO days on the day after a DST fall-back. Pure UTC
  // arithmetic is what makes it correct — but "correct by construction" is not
  // a test, and this is precisely the defect that was fixed, so the transition
  // dates themselves are pinned here.
  // ── why this does NOT switch process.env.TZ ────────────────────────────────
  // The obvious way to test this is to set `process.env.TZ` to a DST zone per
  // case. It does not work reliably, and it fails SILENTLY, which is worse than
  // not testing at all: inside a worker thread Node caches the zone on first
  // use, so only the FIRST assignment takes effect. Measured here — a second
  // case switching to `Australia/Sydney` still evaluated in `Europe/Kyiv`
  // (local hour 3, not 10). Under plain `vitest` (per-file isolation) the two
  // cases happened to pass; under Stryker (shared worker) they did not, which
  // is how it surfaced.
  //
  // So instead of simulating a zone, this booby-traps the LOCAL-time accessors
  // themselves. Correct previous-day arithmetic is a pure UTC operation and
  // must never read a local component; the old implementation read
  // `getDate()`. Poisoning those getters makes any local-time dependence
  // produce a visibly wrong day in EVERY timezone at once — deterministic in
  // any pool, on any CI runner, and it fails for the actual reason rather than
  // for an ambient-configuration reason.
  let svc: NbuCurrencyService
  const LOCAL_GETTERS = ['getDate', 'getMonth', 'getFullYear'] as const
  const originals = new Map<string, unknown>()

  /** Makes every local-time component getter return a deliberately wrong value. */
  function poisonLocalTimeAccessors(): void {
    for (const name of LOCAL_GETTERS) {
      const original = Date.prototype[name]
      originals.set(name, original)
      // Offset by 15 so any local-based arithmetic lands far from the answer,
      // rather than throwing — nothing incidental (a logger, the runner) can be
      // crashed by this, it can only be caught misusing the value.
      Object.defineProperty(Date.prototype, name, {
        configurable: true,
        writable: true,
        value: function (this: Date): number {
          return (original as () => number).call(this) + 15
        },
      })
    }
  }

  function restoreLocalTimeAccessors(): void {
    for (const [name, original] of originals) {
      Object.defineProperty(Date.prototype, name, {
        configurable: true,
        writable: true,
        value: original,
      })
    }
    originals.clear()
  }

  beforeEach(() => {
    requestedUrls.length = 0
    svc = new NbuCurrencyService()
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    // No fake timers here: the requested day is passed explicitly, so "today"
    // is irrelevant, and faking Date would obscure the behaviour under test.
  })

  afterEach(() => {
    restoreLocalTimeAccessors()
    vi.restoreAllMocks()
  })

  // The dates are the real transition days measured for this fix (1,299 days
  // per zone): the old implementation was wrong on exactly these, and nowhere
  // else. Both are kept even though the accessor trap catches the bug
  // zone-independently, because they also pin the calendar arithmetic across a
  // month boundary and at the end of October.
  const DST_CASES = [
    {
      requested: '20231030',
      expectedPrev: '20231029',
      wrongPrev: '20231028',
      why: 'the day after the European October fall-back — measured wrong 3/1299 days in Europe/Kyiv, a zone AHEAD of UTC, which the original bug note wrongly assumed was safe',
    },
    {
      requested: '20230402',
      expectedPrev: '20230401',
      wrongPrev: '20230331',
      why: 'the day after the SOUTHERN-hemisphere fall-back, which falls in April — measured wrong 4/1299 days in Australia/Sydney, a case no October-only fixture reaches, and it crosses a month boundary too',
    },
  ] as const

  for (const c of DST_CASES) {
    it(`steps back exactly one day on ${c.requested} without reading local time — ${c.why}`, async () => {
      // Pin the hardcoded literal against an independently-computed reference
      // (UTC component getters, a different algorithm from the implementation's
      // millisecond subtraction), so a typo in the table cannot quietly weaken
      // the assertion and so this is not a tautology.
      expect(utcPrevDay(c.requested)).toBe(c.expectedPrev)

      // The requested day has no record on any service; the day before does.
      mockNbu({ [c.expectedPrev]: RATES })

      poisonLocalTimeAccessors()
      await svc.getRates(c.requested)
      restoreLocalTimeAccessors()

      const daysAsked = requestedUrls.map((u) => requestedDay(u))
      expect(daysAsked).toContain(c.expectedPrev)
      // The exact failure mode of the old code: two days back, never one.
      expect(daysAsked).not.toContain(c.wrongPrev)
    })
  }

  it('proves the trap bites: local-time arithmetic on these dates is demonstrably wrong', async () => {
    // Without this, a future refactor could neutralise `poisonLocalTimeAccessors`
    // (e.g. by patching a getter nothing reads) and the two tests above would
    // keep passing while proving nothing. This asserts the trap actually
    // changes the answer for the arithmetic the old implementation used.
    poisonLocalTimeAccessors()
    const d = new Date('2023-10-30T00:00:00Z')
    const viaLocalGetters = d.getDate() // what the old code read
    restoreLocalTimeAccessors()

    const trueUtcDate = new Date('2023-10-30T00:00:00Z').getUTCDate()
    expect(viaLocalGetters).not.toBe(trueUtcDate)
  })
})

/**
 * backlog 148 (security-review #574, MED-2) — the operational day is
 * `Europe/Kyiv`, not UTC.
 *
 * ── WHY THIS IS OBSERVED THROUGH `getRates`, NOT A DIRECT UNIT ON `todayStr` ─
 * `todayStr` is private; asserting on it directly would mean reaching past the
 * class's own boundary. Every consumer of "today" goes through it exactly
 * once (`getRates` → `dateStr`), so pinning the real UTC instant with
 * `vi.setSystemTime` and reading which `YYYYMMDD` the mock NBU stub was asked
 * for is a black-box proof of the actual value used for the fetch, the
 * `isLiveRequest` cache-write gate AND the `rateDate` key — i.e. it proves
 * AC1 (single, shared key) as a side effect of proving AC4 (the boundary
 * matrix), because there is only one code path capable of producing a
 * mismatch and this exercises all of it.
 *
 * ── WHY NOT `process.env.TZ` ──────────────────────────────────────────────
 * See the DST describe block above: a worker caches the zone on first read,
 * so a second case switching `process.env.TZ` silently keeps evaluating in
 * the first zone. `vi.setSystemTime` pins the absolute instant instead, and
 * `todayStr` resolves it against `Europe/Kyiv` via `Intl.DateTimeFormat`
 * regardless of the host's own zone — nothing here depends on `process.env`.
 */
describe('backlog 148: the operational day is Europe/Kyiv, not UTC', () => {
  let svc: NbuCurrencyService
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    requestedUrls.length = 0
    svc = new NbuCurrencyService()
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** Pins the absolute UTC instant the system clock reports. */
  function pinUtc(iso: string): void {
    vi.setSystemTime(new Date(iso))
  }

  /** Which `YYYYMMDD` `getRates()` (with no explicit date) actually asked NBU for. */
  async function askedDay(mockedDay: string): Promise<string | null> {
    mockNbu({ [mockedDay]: RATES })
    await svc.getRates()
    return requestedDay(requestedUrls[0] as string)
  }

  // ── AC4: the boundary matrix, both seasons ──────────────────────────────────
  // Kyiv is UTC+2 in winter (EET) and UTC+3 in summer (EEST, DST) — measured
  // via Intl against the real Europe/Kyiv zone, not assumed:
  //   winter 2026-01-14T21:59Z = Kyiv 2026-01-14 23:59
  //   winter 2026-01-14T22:30Z = Kyiv 2026-01-15 00:30 (UTC still on the 14th)
  //   winter 2026-01-15T00:59Z = Kyiv 2026-01-15 02:59 (UTC already on the 15th
  //                              at this exact minute in winter — the old UTC
  //                              code happened to be right here, see the note
  //                              below)
  //   winter 2026-01-15T01:01Z = Kyiv 2026-01-15 03:01
  //   summer 2026-07-14T20:59Z = Kyiv 2026-07-14 23:59
  //   summer 2026-07-14T21:30Z = Kyiv 2026-07-15 00:30 (UTC still on the 14th)
  //   summer 2026-07-14T23:59Z = Kyiv 2026-07-15 02:59 (UTC still on the 14th)
  //   summer 2026-07-15T00:01Z = Kyiv 2026-07-15 03:01
  const MATRIX = [
    {
      season: 'winter (EET, UTC+2)',
      kyivTime: '23:59',
      utcInstant: '2026-01-14T21:59:00Z',
      expectedDay: '20260114',
      oldUtcDay: '20260114', // UTC calendar date at this instant — matches
    },
    {
      season: 'winter (EET, UTC+2)',
      kyivTime: '00:30',
      utcInstant: '2026-01-14T22:30:00Z',
      expectedDay: '20260115',
      oldUtcDay: '20260114', // WRONG under the old code — a day behind
    },
    {
      season: 'winter (EET, UTC+2)',
      kyivTime: '02:59',
      utcInstant: '2026-01-15T00:59:00Z',
      expectedDay: '20260115',
      // The +2h winter offset means UTC has already turned over by 02:59 Kyiv
      // (02:59 − 2h = 00:59, still the 15th) — the old code happened to agree
      // here. The bug window in winter is 00:00–02:00 Kyiv, not 00:00–03:00;
      // the 03:00 figure in the class comment is the DST (summer) worst case.
      oldUtcDay: '20260115',
    },
    {
      season: 'winter (EET, UTC+2)',
      kyivTime: '03:01',
      utcInstant: '2026-01-15T01:01:00Z',
      expectedDay: '20260115',
      oldUtcDay: '20260115',
    },
    {
      season: 'summer (EEST, UTC+3)',
      kyivTime: '23:59',
      utcInstant: '2026-07-14T20:59:00Z',
      expectedDay: '20260714',
      oldUtcDay: '20260714',
    },
    {
      season: 'summer (EEST, UTC+3)',
      kyivTime: '00:30',
      utcInstant: '2026-07-14T21:30:00Z',
      expectedDay: '20260715',
      oldUtcDay: '20260714', // WRONG under the old code
    },
    {
      season: 'summer (EEST, UTC+3)',
      kyivTime: '02:59',
      utcInstant: '2026-07-14T23:59:00Z',
      expectedDay: '20260715',
      // The +3h summer offset means UTC has NOT yet turned over at 02:59 Kyiv
      // (02:59 − 3h = 23:59 the day before) — this is the case the class
      // comment's "00:00–03:00" window is actually about.
      oldUtcDay: '20260714', // WRONG under the old code
    },
    {
      season: 'summer (EEST, UTC+3)',
      kyivTime: '03:01',
      utcInstant: '2026-07-15T00:01:00Z',
      expectedDay: '20260715',
      oldUtcDay: '20260715',
    },
  ] as const

  for (const c of MATRIX) {
    const wrongUnderOldCode = c.oldUtcDay !== c.expectedDay
    it(`AC4: Kyiv ${c.kyivTime} ${c.season} asks NBU for ${c.expectedDay}${wrongUnderOldCode ? ' (old UTC code asked for ' + c.oldUtcDay + ' — WRONG)' : ' (old UTC code happened to agree here)'}`, async () => {
      pinUtc(c.utcInstant)
      const asked = await askedDay(c.expectedDay)
      console.log(
        `[AC4] Kyiv ${c.kyivTime} ${c.season} (UTC ${c.utcInstant}) -> requested ${asked}` +
          (wrongUnderOldCode ? ` | old UTC-based code would have asked for ${c.oldUtcDay}` : ''),
      )
      expect(asked).toBe(c.expectedDay)
    })
  }

  // ── AC1: the cache key moves WITH the fix, not independently of it ─────────
  it('AC1: a rate cached right after Kyiv midnight is recognised as fresh later the SAME Kyiv day', async () => {
    // Seed at Kyiv 2026-01-15 00:30 — UTC is still on the 14th at this instant.
    // If the cache key were still derived from UTC while the fetch moved to
    // Kyiv (fixing one without the other, exactly the mismatch the class
    // comment warns about), this would cache under "20260114" while later
    // reads that same Kyiv day ask for "20260115" — a permanent miss.
    pinUtc('2026-01-14T22:30:00Z')
    mockNbu({ '20260115': RATES })
    const seeded = await svc.getRates()
    expect(seeded.rateDate).toBe('20260115')

    // Later the SAME Kyiv day (10:00 Kyiv = 08:00 UTC, well past the boundary),
    // the feed goes down. The cache must be recognised as age-0 for TODAY, not
    // stale-from-a-day-that-never-matched.
    mockTotalOutage()
    pinUtc('2026-01-15T08:00:00Z')
    const result = await svc.getRates()

    expect(result.stale).toBe(true) // it IS the outage fallback
    expect(result.rateDate).toBe('20260115') // ...but still dated, money paths accept
  })

  it('AC1: the reverse boundary — cached mid-morning, outage hits right after the NEXT Kyiv midnight', async () => {
    // Seed comfortably inside 2026-01-15 (10:00 Kyiv = 08:00 UTC).
    pinUtc('2026-01-15T08:00:00Z')
    mockNbu({ '20260115': RATES })
    const seeded = await svc.getRates()
    expect(seeded.rateDate).toBe('20260115')

    // The feed dies, and the request comes in at Kyiv 2026-01-16 00:30 — UTC
    // is still on the 15th at that instant. A UTC-keyed cache would see this
    // as the SAME day (age 0, wrongly accepted for an extra ~90 minutes past
    // the real Kyiv-day boundary); the Kyiv-keyed cache must see it as the
    // NEXT day and apply the real freshness gate (age 1, a weekday — refused).
    mockTotalOutage()
    pinUtc('2026-01-15T22:30:00Z') // Kyiv 2026-01-16 00:30
    const result = await svc.getRates()

    expect(result.stale).toBe(true)
    expect(result.rateDate).toBeUndefined() // Thursday->Friday: a new rate exists, refused
  })

  // ── AC2: DST transition boundary, both directions ──────────────────────────
  // Ukraine 2026: clocks spring forward at 2026-03-29 01:00 UTC (Kyiv 02:00
  // EET -> 04:00 EEST, skipping 03:00-03:59) and fall back at 2026-10-25 01:00
  // UTC (Kyiv 04:00 EEST -> 03:00 EET, repeating 03:00-03:59) — measured via
  // Intl against the real tz database, not assumed. Neither transition itself
  // crosses midnight, so what these guard against is a hardcoded "+2" or "+3"
  // offset that fails to pick up the NEW offset the instant it takes effect —
  // exactly the class a fixed-offset implementation (rejected in favour of
  // `Intl.DateTimeFormat` — see the `todayStr` comment) would get wrong for
  // half the year.
  it('AC2: the day AFTER spring-forward already uses the new +3 (EEST) offset at the midnight boundary', async () => {
    // Kyiv 2026-03-30 00:30 EEST = UTC 2026-03-29 21:30 (still the 29th in
    // UTC). A stale "+2" offset would compute Kyiv day as the 29th too by
    // coincidence of rounding; the real EEST offset is what fixes it to the
    // 30th for the right reason.
    pinUtc('2026-03-29T21:30:00Z')
    const asked = await askedDay('20260330')
    expect(asked).toBe('20260330')
  })

  it('AC2: the day AFTER fall-back already uses the new +2 (EET) offset at the midnight boundary', async () => {
    // Kyiv 2026-10-26 00:30 EET = UTC 2026-10-25 22:30 (still the 25th in
    // UTC). Using the just-retired +3 EEST offset would land on 2026-10-26
    // 01:30, still the 26th by luck — the case that actually distinguishes the
    // two offsets is the one below.
    pinUtc('2026-10-25T22:30:00Z')
    const asked = await askedDay('20261026')
    expect(asked).toBe('20261026')
  })

  it('AC2: fall-back reverse case — a stale +3 offset would roll this into the WRONG day', async () => {
    // UTC 2026-10-25T21:15Z: real EET (+2) gives Kyiv 2026-10-25 23:15 (still
    // the 25th). A leftover +3 (EEST) offset would give 2026-10-26 00:15 — the
    // NEXT day, one day too early. This is the case a hardcoded-offset
    // implementation gets wrong: it must switch offset exactly at the real
    // transition instant, not one day later.
    pinUtc('2026-10-25T21:15:00Z')
    const asked = await askedDay('20261025')
    expect(asked).toBe('20261025')
  })

  // ── AC3: the publication-mode gap is a normal empty answer, not a fault ────
  // NBU recalculates each business day in the afternoon and the new value
  // applies from the NEXT calendar day (see the `MAX_CACHED_RATE_AGE_DAYS`
  // header comment, measured live). Before that window, "tomorrow" has no
  // record on any source and the exact-match fetch legitimately returns
  // empty — the two tests below are the two calendar shapes that can follow:
  // tomorrow is a fresh weekday (refused, correctly) or tomorrow is a weekend
  // day (payable, since it will only ever repeat today's value).
  it('AC3: tomorrow is a WEEKDAY — the empty pre-publication gap is not an error, but the fallback is still correctly refused for money', async () => {
    // Wednesday 2026-07-15, well before the afternoon publication; Thursday
    // 2026-07-16 has no record on any source yet.
    pinUtc('2026-07-15T09:00:00Z')
    mockNbu({ '20260715': RATES }) // only today is published; tomorrow is empty
    const result = await svc.getRates('20260716')

    expect(result.date).toBe('20260716') // still echoes the requested (tomorrow) day
    expect(result.stale).toBe(true)
    // Thursday will get its OWN official rate once published — today's number
    // is not fit to price it, so this correctly refuses, exactly like the
    // MED-1 "Sunday cannot price Monday" case.
    expect(result.rateDate).toBeUndefined()
    // The empty-tomorrow gap must not be logged as a source/network failure —
    // it is an expected, normal "not published yet", not a fault. Stronger
    // than a substring check (security-review PR #578 review, LOW-3): the
    // previous-day fallback that serves this request only ever WARNs, so
    // `.error()` must not fire AT ALL, not merely avoid specific phrases.
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('AC3: tomorrow is a WEEKEND day — the pre-publication gap falls back to a real, payable rate', async () => {
    // Friday 2026-07-17, before the afternoon publication; Saturday
    // 2026-07-18 has no record yet, but Saturday only ever repeats Friday's
    // value, so Friday's rate is genuinely fit to price it.
    pinUtc('2026-07-17T09:00:00Z')
    mockNbu({ '20260717': RATES })
    const result = await svc.getRates('20260718')

    expect(result.date).toBe('20260718')
    expect(result.stale).toBe(true) // honestly not the exact day requested
    expect(result.rateDate).toBe('20260717') // but a real, dated, payable rate
    // Stronger than a substring check (security-review PR #578 review, LOW-3).
    expect(errorSpy).not.toHaveBeenCalled()
  })

  // ── PR #578 review: the day formatter now lives in `@crm/shared` ───────────
  // The mutation-gate proof for the formatter's OWN construction args (a
  // mutant that drops `timeZone: 'Europe/Kyiv'` and silently falls back to
  // the HOST's default zone — invisible on a host whose OS zone also happens
  // to BE Kyiv, exactly the assumption `todayStr`'s comment warns against)
  // now lives with the formatter itself, in
  // `packages/shared/src/utils/kyiv-day.spec.ts`. Duplicating it here would
  // test `@crm/shared` FROM `@crm/api`'s suite, the wrong package boundary.
  // What THIS file still owns: proving `NbuCurrencyService.todayStr()` (via
  // `getRates()`, since it is private) actually PRODUCES the same day
  // `kyivToday()` does — see the "client key === server day" test below.

  // ── PR #578 review: client cache key and server day MUST agree ─────────────
  // Security review found three OTHER "today" computations left on plain
  // UTC after this PR's first pass — the client-side `exchange-rate`
  // react-query cache key in `amount-currency-input.tsx` / `PaySalaryDialog`
  // / `UserDialog`, and the DROP-settle `txDate` upper bound in
  // `settleSeniorPayoutSchema` (+ its mirrored date-picker `maxDate`) — and
  // asked for proof that, after routing everything through the same
  // `kyivToday()`, the CLIENT's cache key and the SERVER's actual requested
  // day agree across the exact boundary window this bug lives in (00:00-03:00
  // Kyiv, both seasons). `kyivToday()` stands in for "what the client would
  // compute" (it is the literal function `amount-currency-input.tsx` now
  // calls for its cache key); `getRates()`'s ACTUAL NBU request — not a
  // second call to `kyivToday()`, which would only prove the function is
  // consistent with itself — stands in for the server.
  it('PR #578 review: the client-side cache key (kyivToday()) matches the day the server actually requests, across the boundary window in both seasons', async () => {
    for (const c of MATRIX) {
      pinUtc(c.utcInstant)
      const clientKey = kyivToday().replace(/-/g, '')
      const serverDay = await askedDay(clientKey)
      console.log(
        `[client===server] Kyiv ${c.kyivTime} ${c.season} (UTC ${c.utcInstant}) — client key=${clientKey}, server requested=${serverDay}`,
      )
      expect(serverDay).toBe(clientKey)
      requestedUrls.length = 0
    }
  })
})

describe('Part 3: provenance of the applied rate is recoverable from the log', () => {
  let svc: NbuCurrencyService
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    requestedUrls.length = 0
    svc = new NbuCurrencyService()
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'] })
    pinDay('2026-07-07')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function loggedLines(): string {
    return logSpy.mock.calls.map((c) => String(c[0])).join('\n')
  }

  it('records which service answered, the day priced, the applies-to day and the figures', async () => {
    mockNbu({ '20260707': RATES })

    const result = await svc.getRates()
    const line = loggedLines()

    expect(line).toContain('origin=live:statdirectory')
    expect(line).toContain('requested=20260707')
    expect(line).toContain('appliesTo=20260707')
    expect(line).toContain(result.usdUah) // the exact figure that was applied
    expect(line).toContain(result.eurUah)
  })

  it("records NBU's own publication date when the answering service exposes it", async () => {
    // Only `exchange_site` publishes `calcdate`; it is the difference between
    // "the day this rate applies to" and "the day NBU computed it".
    mockNbu({ '20260707': RATES }, ['exchange_site'])

    await svc.getRates()

    expect(loggedLines()).toContain('published=07.07.2026')
  })

  it('records a cache-served rate as coming from the cache, not from the live feed', async () => {
    mockNbu({ '20260707': RATES })
    await svc.getRates()
    logSpy.mockClear()
    mockTotalOutage()

    await svc.getRates()

    const line = loggedLines()
    expect(line).toContain('origin=cache:')
    expect(line).toContain('appliesTo=20260707')
    expect(line).toContain('stale=true')
  })

  it("carries NBU's publication date through the cache into a later outage", async () => {
    // The cache must remember `calcdate`, not just the numbers: during an
    // outage the log is the only record of which publication was applied.
    mockNbu({ '20260707': RATES }, ['exchange_site'])
    await svc.getRates()
    logSpy.mockClear()
    mockTotalOutage()

    await svc.getRates()

    expect(loggedLines()).toContain('published=07.07.2026')
  })
})

describe('Part 2: degraded source responses fall through, they do not poison the rate', () => {
  let svc: NbuCurrencyService
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    requestedUrls.length = 0
    svc = new NbuCurrencyService()
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'] })
    pinDay('2026-07-07')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** Lets each source answer with an arbitrary body for the pinned day. */
  function mockBodies(bodyBySource: Record<SourceId, unknown>): void {
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      requestedUrls.push(url)
      const source = sourceOf(url)
      if (source === null) return Promise.reject(new Error('unexpected URL'))
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(bodyBySource[source]),
      })
    })
  }

  it('a source answering 200 with an unrecognisable body is passed over', async () => {
    // e.g. the open-data service's `[{ Wrong date format }]`, or a service
    // that starts returning an error object instead of an array.
    mockBodies({
      statdirectory: { error: 'maintenance' },
      exchange_site: renderRows('exchange_site', '20260707', RATES),
      open_data: [],
    })

    const result = await svc.getRates()

    expect(result.stale).toBe(false)
    expect(result.rateDate).toBe('20260707')
    expect(parseFloat(result.usdUah)).toBeCloseTo(44.6988, 4)
    // Name the culprit: silently falling through would hide a service that
    // has started returning garbage.
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'unrecognised body shape',
    )
  })

  it('a source with no record for the day is passed over for one that has it', async () => {
    // An empty array is a valid answer meaning "no data for this day" — but
    // another service may still have it, and today's real rate beats
    // yesterday's.
    mockBodies({
      statdirectory: [],
      exchange_site: renderRows('exchange_site', '20260707', RATES),
      open_data: [],
    })

    const result = await svc.getRates()

    expect(result.stale).toBe(false)
    expect(result.rateDate).toBe('20260707')
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('returned empty rates')
  })

  it('a source carrying USD but NOT EUR is passed over for a complete one', async () => {
    // Half a rate table is not a usable rate: pricing EUR off a missing row
    // would silently substitute a cached or invented number. This is why the
    // check is "has USD AND EUR", not "has either".
    mockBodies({
      statdirectory: renderRows('statdirectory', '20260707', [{ cc: 'USD', rate: 44.6988 }]),
      exchange_site: renderRows('exchange_site', '20260707', RATES),
      open_data: [],
    })

    const result = await svc.getRates()

    expect(result.stale).toBe(false)
    expect(parseFloat(result.usdUah)).toBeCloseTo(44.6988, 4)
    expect(parseFloat(result.eurUah)).toBeCloseTo(51.8082, 4)
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'missing USD and/or EUR',
    )
  })

  it('when EVERY source is incomplete, the partial answer still renders but never prices money', async () => {
    // Nothing is discarded — the screens keep working — but the result is
    // stale and undated, so both payout paths refuse it.
    const usdOnly = [{ cc: 'USD', rate: 44.6988 }]
    mockBodies({
      statdirectory: renderRows('statdirectory', '20260707', usdOnly),
      exchange_site: renderRows('exchange_site', '20260707', usdOnly),
      open_data: renderRows('open_data', '20260707', usdOnly),
    })

    const result = await svc.getRates()

    expect(parseFloat(result.usdUah)).toBeCloseTo(44.6988, 4)
    expect(result.stale).toBe(true)
    expect(result.rateDate).toBeUndefined()
  })

  it('a source carrying EUR but NOT USD is passed over for a complete one', async () => {
    // The mirror of the USD-only case: BOTH currencies must be present for a
    // source to be taken, since USD also underpins the USDT peg.
    mockBodies({
      statdirectory: renderRows('statdirectory', '20260707', [{ cc: 'EUR', rate: 51.8082 }]),
      exchange_site: renderRows('exchange_site', '20260707', RATES),
      open_data: [],
    })

    const result = await svc.getRates()

    expect(result.stale).toBe(false)
    expect(result.rateDate).toBe('20260707')
    expect(parseFloat(result.usdUah)).toBeCloseTo(44.6988, 4)
  })

  it('an answer with no USD row at all does not crash the provenance lookup', async () => {
    // `calcdateOf` looks the publication date up off the USD row; when there
    // is no USD row it must yield "not exposed", not throw.
    const eurOnly = [{ cc: 'EUR', rate: 51.8082 }]
    mockBodies({
      statdirectory: renderRows('statdirectory', '20260707', eurOnly),
      exchange_site: renderRows('exchange_site', '20260707', eurOnly),
      open_data: renderRows('open_data', '20260707', eurOnly),
    })

    const result = await svc.getRates()

    expect(result.stale).toBe(true)
    expect(parseFloat(result.eurUah)).toBeCloseTo(51.8082, 4)
    // The publication date is read off the USD row specifically. With no USD
    // row there is none to report — it must NOT borrow the EUR row's date and
    // present it as the provenance of a USD-derived figure.
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'published=(not exposed)',
    )
  })

  it('a plain network error is reported as such — not as a timeout, not as a bad body', async () => {
    // Each of these three diagnoses sends an operator somewhere different.
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await svc.getRates()

    expect(result.stale).toBe(true)
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('network error')
    expect(logged).not.toContain('timed out')
    // A dead connection is not a malformed payload: the body was never read.
    expect(`${logged}\n${warned}`).not.toContain('unrecognised body shape')
  })

  it('only a genuine abort counts as a timeout — the name alone is not enough', async () => {
    // A DOMException that is NOT an abort (e.g. any other DOM error) must be
    // reported as a network error, and an ordinary Error merely NAMED
    // "AbortError" must not be promoted into one either. Both halves of the
    // `instanceof && name` check carry weight.
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('boom', 'InvalidStateError'))
    await svc.getRates()
    let logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('network error')
    expect(logged).not.toContain('timed out')

    errorSpy.mockClear()
    const impostor = new Error('not really an abort')
    impostor.name = 'AbortError'
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockRejectedValue(impostor)
    await svc.getRates()
    logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('network error')
    expect(logged).not.toContain('timed out')
  })

  it('reads the publication date off the USD row, not merely the first row', async () => {
    // USD is the row that drives both the USD figure and the USDT peg, so its
    // publication date is the one that describes the applied number. Here EUR
    // comes first and carries a DIFFERENT calcdate — reporting that one would
    // attribute the USD figure to a publication it did not come from.
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      requestedUrls.push(url)
      if (sourceOf(url) !== 'exchange_site') return Promise.reject(new Error('down'))
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { cc: 'EUR', rate: 51.8082, exchangedate: '07.07.2026', calcdate: '01.01.2020' },
            { cc: 'USD', rate: 44.6988, exchangedate: '07.07.2026', calcdate: '06.07.2026' },
          ]),
      })
    })

    await svc.getRates()

    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('published=06.07.2026')
    expect(logged).not.toContain('published=01.01.2020')
  })
})

describe('operator diagnostics: the log says WHY a payout was refused', () => {
  // With no provenance columns in `payout_requests` yet, these lines are the
  // only durable record of which rate was applied and why one was rejected.
  let svc: NbuCurrencyService
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    requestedUrls.length = 0
    svc = new NbuCurrencyService()
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const errors = (): string => errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
  const logs = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n')

  it('names the previous-day fallback as such, in both the warning and the provenance line', async () => {
    pinDay('2026-07-05')
    mockNbu({ '20260704': RATES })

    await svc.getRates()

    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('previous-day rates')
    expect(logs()).toContain('origin=live-prev-day:')
    expect(logs()).toContain('requested=20260705')
    expect(logs()).toContain('appliesTo=20260704')
  })

  it('states that an accepted cache may price money, and marks it as cache-sourced', async () => {
    pinDay('2026-07-07')
    mockNbu({ '20260707': RATES })
    await svc.getRates()
    errorSpy.mockClear()
    logSpy.mockClear()
    mockTotalOutage()

    await svc.getRates()

    expect(errors()).toContain('money paths accept')
    expect(logs()).toContain('url=(cache)')
  })

  it('states that a too-old cache is display-only', async () => {
    pinDay('2026-07-06') // Monday
    mockNbu({ '20260706': RATES })
    await svc.getRates()
    errorSpy.mockClear()
    mockTotalOutage()
    pinDay('2026-07-07') // Tuesday — a new official rate exists

    await svc.getRates()

    expect(errors()).toContain('DISPLAY ONLY')
  })

  it('names the hardcoded constant when there is nothing else at all', async () => {
    pinDay('2026-07-07')
    mockTotalOutage()

    await svc.getRates()

    expect(errors()).toContain('hardcoded fallback')
    expect(logs()).not.toContain('NBU rate applied') // never presented as applied
  })

  it('marks an undated result as having no applies-to day', async () => {
    // `appliesTo=(none)` is the human-readable form of "no payout may use this".
    pinDay('2026-07-07')
    mockNbu({ '20260707': [{ cc: 'USD', rate: 44.6988 }] }) // USD only → incomplete

    const result = await svc.getRates()

    expect(result.rateDate).toBeUndefined()
    expect(logs()).toContain('appliesTo=(none)')
  })

  it('distinguishes a timeout from a plain network error in the log', async () => {
    // Operators triage these differently: a timeout means NBU is slow/hanging,
    // a network error means it is unreachable.
    // @ts-expect-error — test stub
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'))

    const result = await svc.getRates()

    expect(result.stale).toBe(true)
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('timed out')
    expect(logged).not.toContain('network error')
  })

  it('survives a 200 whose body is not JSON at all, and says so', async () => {
    // Not hypothetical: `NBU_Exchange/exchange` answers HTTP 200 with the
    // non-JSON blob `[{ Wrong date format }]` when handed the wrong date
    // dialect (verified live 2026-08-18). Decoding must fail softly into
    // "try the next source", never bubble out of getRates.
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      requestedUrls.push(url)
      if (sourceOf(url) === 'statdirectory') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected token W in JSON at position 3')),
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(renderRows('exchange_site', '20260707', RATES)),
      })
    })

    const result = await svc.getRates()

    expect(result.stale).toBe(false)
    expect(parseFloat(result.usdUah)).toBeCloseTo(44.6988, 4)
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('undecodable body')
  })

  it('reports a non-OK HTTP status rather than silently treating it as no data', async () => {
    // @ts-expect-error — test stub
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      requestedUrls.push(url)
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve([]) })
    })

    await svc.getRates()

    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('HTTP 503')
  })
})
