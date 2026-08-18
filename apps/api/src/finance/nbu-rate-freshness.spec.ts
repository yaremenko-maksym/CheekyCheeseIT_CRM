import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
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

  beforeEach(() => {
    requestedUrls.length = 0
    svc = new NbuCurrencyService()
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
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
