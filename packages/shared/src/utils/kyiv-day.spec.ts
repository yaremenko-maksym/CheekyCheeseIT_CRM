import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addCalendarMonths,
  businessMonthWindow,
  kyivDayOf,
  kyivToday,
  latestSettleBusinessDay,
  transactionBusinessDay,
} from './kyiv-day'

/** The Kyiv month of an instant, for the window-edge assertions below. */
const kyivMonthAt = (at: Date) => kyivDayOf(at).slice(0, 7)

/**
 * Retro business-day clock (CR-867-L-1 / SR-809-L-1): month math on the Kyiv
 * business day must come from calendar PARTS, never from `Date#setMonth` or the
 * host timezone. The TZ matrix in vitest.config.mts runs this file under the
 * host TZ, Europe/Kyiv and America/Los_Angeles.
 */
describe('addCalendarMonths', () => {
  it('subtracts months by calendar parts', () => {
    expect(addCalendarMonths('2026-10-15', -3)).toBe('2026-07-15')
    expect(addCalendarMonths('2026-02-10', -3)).toBe('2025-11-10')
  })

  it('clamps to the last day of a shorter target month instead of overflowing', () => {
    expect(addCalendarMonths('2026-05-31', -3)).toBe('2026-02-28')
    expect(addCalendarMonths('2024-05-31', -3)).toBe('2024-02-29')
    expect(addCalendarMonths('2026-12-31', -1)).toBe('2026-11-30')
  })

  it('adds months across a year boundary', () => {
    expect(addCalendarMonths('2026-11-30', 3)).toBe('2027-02-28')
  })
})

/**
 * `kyivDayOf` — the same Kyiv calendar day, for an instant the CALLER supplies
 * instead of "now". Added for the transaction-date policy (SR-809-H-1), which
 * compares an operator-chosen date against the business day and must therefore
 * be deterministic under an injected clock: a policy that reads the real
 * `Date.now()` cannot be tested at a boundary without faking global time.
 *
 * `kyivToday()` is now defined as `kyivDayOf(new Date())`, so there is still
 * exactly ONE definition of the Kyiv day — the property the module comment
 * exists to protect.
 */
describe('kyivDayOf', () => {
  it('resolves a caller-supplied instant against Europe/Kyiv, with no global clock involved', () => {
    // Kyiv 2026-07-15 00:30 EEST (+3) = UTC 2026-07-14 21:30 — the window the
    // original backlog-148 bug priced wrong.
    expect(kyivDayOf(new Date('2026-07-14T21:30:00Z'))).toBe('2026-07-15')
    expect(kyivDayOf(new Date('2026-07-14T20:59:00Z'))).toBe('2026-07-14')
  })

  it('tracks the DST offset per instant rather than assuming one', () => {
    // EET (+2): Kyiv 2026-01-15 00:30 = UTC 2026-01-14 22:30.
    expect(kyivDayOf(new Date('2026-01-14T22:30:00Z'))).toBe('2026-01-15')
    // A stale +3 would roll this one a day too early.
    expect(kyivDayOf(new Date('2026-10-25T21:15:00Z'))).toBe('2026-10-25')
  })

  it('agrees with kyivToday for the current instant — one definition, two entry points', () => {
    expect(kyivDayOf(new Date())).toBe(kyivToday())
  })
})

/**
 * `latestSettleBusinessDay` — CR-M-4. The settle upper bound, defined once and
 * called by both the server (`PendingSettlementService`) and the picker
 * (`SettleSeniorPayoutDialog`), where it used to be hand-written twice.
 *
 * The clock is frozen for every case: the bound is relative to "today", so a
 * test that computed its fixtures from the real clock would be asserting
 * against a moving target.
 */
describe('latestSettleBusinessDay', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // Kyiv 2026-06-15 15:00 EEST = UTC 12:00 — mid-day, so UTC and Kyiv agree
    // on the day and these cases isolate the max() from the calendar question.
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns TODAY when the source row is in the past', () => {
    expect(latestSettleBusinessDay('2026-06-01')).toBe('2026-06-15')
  })

  it('returns the SOURCE day when it is in the future — the lock-out case', () => {
    // A flat "not after today" would give 2026-06-15 here, which is BELOW the
    // lower bound (the source day), leaving no selectable day at all.
    expect(latestSettleBusinessDay('2026-06-25')).toBe('2026-06-25')
  })

  it('returns today when the source row IS today — both branches agree', () => {
    expect(latestSettleBusinessDay('2026-06-15')).toBe('2026-06-15')
  })

  // The bound is the KYIV day, not the UTC day. Between Kyiv midnight and UTC
  // midnight the two disagree, and a UTC-based bound would be a day behind —
  // refusing a date the operator's own picker had just offered. This case fails
  // if `kyivToday()` is swapped for a UTC "today".
  it('uses the KYIV day, not the UTC day, in the window where they differ', () => {
    // UTC 2026-07-14T21:30Z is already 2026-07-15 in Kyiv (EEST, +3).
    vi.setSystemTime(new Date('2026-07-14T21:30:00.000Z'))
    expect(latestSettleBusinessDay('2026-07-01')).toBe('2026-07-15')
  })
})

/**
 * `kyivToday` — backlog 148 (security-review PR #574 MED-2, PR #578 review
 * MED-1/MED-2). SINGLE SOURCE OF TRUTH for "what day is it, for NBU-rate
 * purposes" across `@crm/api` and `@crm/web` — see the module comment in
 * `kyiv-day.ts` for why a third, independent "today" reappearing is exactly
 * how the original bug happened.
 *
 * ── WHY NOT `process.env.TZ` ────────────────────────────────────────────────
 * See `apps/api/src/finance/nbu-rate-freshness.spec.ts`'s DST describe block:
 * a worker caches the zone on first read, so a second case reassigning
 * `process.env.TZ` silently keeps evaluating in the first zone. Every test
 * below pins the ABSOLUTE instant with `vi.setSystemTime` instead —
 * `kyivToday()` resolves it against `Europe/Kyiv` via `Intl.DateTimeFormat`
 * regardless of the host's own default zone.
 */
describe('kyivToday', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function pinUtc(iso: string): void {
    vi.setSystemTime(new Date(iso))
  }

  // ── the boundary matrix (mirrors nbu-rate-freshness.spec.ts's AC4) ─────────
  // Kyiv is UTC+2 in winter (EET) and UTC+3 in summer (EEST, DST) — measured
  // via Intl against the real Europe/Kyiv zone, not assumed. Right after Kyiv
  // midnight, UTC has not yet turned over (00:00-02:00 winter, 00:00-03:00
  // summer): that gap is exactly the window the original bug (backlog 148)
  // priced wrong.
  const MATRIX = [
    { label: 'winter 23:59', utcInstant: '2026-01-14T21:59:00Z', expected: '2026-01-14' },
    { label: 'winter 00:30', utcInstant: '2026-01-14T22:30:00Z', expected: '2026-01-15' },
    { label: 'winter 02:59', utcInstant: '2026-01-15T00:59:00Z', expected: '2026-01-15' },
    { label: 'winter 03:01', utcInstant: '2026-01-15T01:01:00Z', expected: '2026-01-15' },
    { label: 'summer 23:59', utcInstant: '2026-07-14T20:59:00Z', expected: '2026-07-14' },
    { label: 'summer 00:30', utcInstant: '2026-07-14T21:30:00Z', expected: '2026-07-15' },
    { label: 'summer 02:59', utcInstant: '2026-07-14T23:59:00Z', expected: '2026-07-15' },
    { label: 'summer 03:01', utcInstant: '2026-07-15T00:01:00Z', expected: '2026-07-15' },
  ] as const

  for (const c of MATRIX) {
    it(`Kyiv ${c.label} (UTC ${c.utcInstant}) -> ${c.expected}`, () => {
      pinUtc(c.utcInstant)
      expect(kyivToday()).toBe(c.expected)
    })
  }

  // ── DST transition boundary, both directions (mirrors AC2) ─────────────────
  it('the day AFTER spring-forward already uses the new +3 (EEST) offset at the midnight boundary', () => {
    // Kyiv 2026-03-30 00:30 EEST = UTC 2026-03-29 21:30 (still the 29th in UTC).
    pinUtc('2026-03-29T21:30:00Z')
    expect(kyivToday()).toBe('2026-03-30')
  })

  it('the day AFTER fall-back already uses the new +2 (EET) offset at the midnight boundary', () => {
    // Kyiv 2026-10-26 00:30 EET = UTC 2026-10-25 22:30 (still the 25th in UTC).
    pinUtc('2026-10-25T22:30:00Z')
    expect(kyivToday()).toBe('2026-10-26')
  })

  it('fall-back reverse case — a stale +3 offset would roll this into the WRONG day', () => {
    // UTC 2026-10-25T21:15Z: real EET (+2) gives Kyiv 2026-10-25 23:15 (still
    // the 25th). A leftover +3 (EEST) offset would give 2026-10-26 00:15 —
    // one day too early.
    pinUtc('2026-10-25T21:15:00Z')
    expect(kyivToday()).toBe('2026-10-25')
  })

  // ── mutation-gate: a corrupted option must fail LOUD, inside a real test ───
  // `timeZone`/`year`/`month`/`day` each being individually corrupted to `''`
  // (Stryker's default `StringLiteral` mutation) makes `Intl.DateTimeFormat`
  // THROW at construction — verified manually: `new Intl.DateTimeFormat('en-CA',
  // { timeZone: '' })` raises `RangeError: Invalid time zone specified`. This
  // is exactly why the formatter is built LAZILY (see the module comment): a
  // top-level `const` would throw at MODULE IMPORT, before any `it()` body
  // runs, which crashes the whole file's collection rather than failing a
  // specific test — reproduced directly (plain vitest, no Stryker involved):
  // filtering to run only this test with the corrupted source still reports
  // "Failed Suites — 0 tests" instead of a normal assertion failure, and a
  // mutation run scores that as SURVIVED (no covering test recorded a
  // failure) rather than killed. Lazy construction moves the exact same throw
  // inside an ordinary function call the FIRST test to run can observe.
  it('mutation-gate: never throws — a corrupted formatter option must fail LOUD inside a real test, not crash module load', () => {
    expect(() => kyivToday()).not.toThrow()
  })

  // ── mutation-gate: prove the formatter's OWN construction args ─────────────
  // A prior mutation run (PR #578) found that stripping the formatter's
  // options down to `{}` — i.e. dropping `timeZone: 'Europe/Kyiv'` and
  // falling back to the HOST's default zone — survived every test, because
  // on the host the suite ran on (and on a Kyiv-based production host) the
  // runtime's OWN default zone already resolves to `Europe/Kyiv`, so
  // `resolvedOptions()` cannot tell the mutant from the real code (`{}` does
  // NOT throw — only the individual-property case above does). This captures
  // the LITERAL constructor arguments instead, which is unaffected by what
  // zone the host happens to default to.
  //
  // `vi.resetModules()` + a dynamic `import()` forces the module body to
  // re-evaluate against the spy, and calling the freshly-imported
  // `kyivToday()` triggers the LAZY formatter's construction (it does not
  // run merely by importing the module, unlike the old top-level `const`) —
  // a plain `import()` with no call would observe nothing.
  it('mutation-gate: the day formatter is constructed with an explicit Europe/Kyiv timeZone, not the host default', async () => {
    const OriginalDateTimeFormat = Intl.DateTimeFormat
    const captured: unknown[][] = []
    class SpyDateTimeFormat extends OriginalDateTimeFormat {
      constructor(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        captured.push(args)
        super(...args)
      }
    }
    // @ts-expect-error — test patch of a built-in constructor
    Intl.DateTimeFormat = SpyDateTimeFormat

    vi.resetModules()
    try {
      const fresh = await import('./kyiv-day')
      fresh.kyivToday()
    } finally {
      Intl.DateTimeFormat = OriginalDateTimeFormat
    }

    const dayFormatterCall = captured.find((args) => Array.isArray(args) && args[0] === 'en-CA') as
      [string, Intl.DateTimeFormatOptions] | undefined
    expect(dayFormatterCall).toBeDefined()
    expect(dayFormatterCall?.[1]).toEqual({
      timeZone: 'Europe/Kyiv',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  })
})

/**
 * backlog 338 (A): the month windows the KPI readers query with. Expected values
 * are hand-written literals (Kyiv is UTC+2 in winter, UTC+3 in summer), not
 * recomputed with the same Intl call the helper uses.
 */
describe('businessMonthWindow', () => {
  const iso = (d: Date) => d.toISOString()

  it('winter month: the Kyiv month starts at 22:00Z of the previous UTC day (UTC+2)', () => {
    const w = businessMonthWindow('2026-01')
    expect(w.month).toBe('2026-01')
    expect(iso(w.dateStart)).toBe('2026-01-01T00:00:00.000Z')
    expect(iso(w.dateEnd)).toBe('2026-02-01T00:00:00.000Z')
    expect(iso(w.instantStart)).toBe('2025-12-31T22:00:00.000Z')
    expect(iso(w.instantEnd)).toBe('2026-01-31T22:00:00.000Z')
  })

  it('summer month: the Kyiv month starts at 21:00Z of the previous UTC day (UTC+3)', () => {
    const w = businessMonthWindow('2026-07')
    expect(iso(w.dateStart)).toBe('2026-07-01T00:00:00.000Z')
    expect(iso(w.dateEnd)).toBe('2026-08-01T00:00:00.000Z')
    expect(iso(w.instantStart)).toBe('2026-06-30T21:00:00.000Z')
    expect(iso(w.instantEnd)).toBe('2026-07-31T21:00:00.000Z')
  })

  it('DST month ends: March starts on +2 and ends on +3, October starts on +3 and ends on +2', () => {
    const march = businessMonthWindow('2026-03')
    expect(iso(march.instantStart)).toBe('2026-02-28T22:00:00.000Z')
    expect(iso(march.instantEnd)).toBe('2026-03-31T21:00:00.000Z')
    const october = businessMonthWindow('2026-10')
    expect(iso(october.instantStart)).toBe('2026-09-30T21:00:00.000Z')
    expect(iso(october.instantEnd)).toBe('2026-10-31T22:00:00.000Z')
  })

  it('rolls the year over in December', () => {
    const w = businessMonthWindow('2026-12')
    expect(iso(w.dateEnd)).toBe('2027-01-01T00:00:00.000Z')
    expect(iso(w.instantEnd)).toBe('2026-12-31T22:00:00.000Z')
  })

  it('the instant window agrees with the Kyiv day at both edges', () => {
    for (const month of ['2026-01', '2026-03', '2026-07', '2026-10', '2026-12']) {
      const w = businessMonthWindow(month)
      expect(kyivMonthAt(w.instantStart)).toBe(month)
      expect(kyivMonthAt(new Date(w.instantStart.getTime() - 1))).not.toBe(month)
      expect(kyivMonthAt(new Date(w.instantEnd.getTime() - 1))).toBe(month)
      expect(kyivMonthAt(w.instantEnd)).not.toBe(month)
    }
  })

  it('22:30Z on the last UTC day of a month is already the NEXT Kyiv month (the 338 boundary)', () => {
    const created = new Date('2026-10-31T22:30:00.000Z')
    expect(created >= businessMonthWindow('2026-11').instantStart).toBe(true)
    expect(created < businessMonthWindow('2026-10').instantEnd).toBe(false)
    const summer = new Date('2026-06-30T21:30:00.000Z')
    expect(summer >= businessMonthWindow('2026-07').instantStart).toBe(true)
  })
})

describe('transactionBusinessDay', () => {
  it('a non-null txDate keeps its own UTC-midnight day, ignoring createdAt', () => {
    expect(transactionBusinessDay('2026-10-19T00:00:00.000Z', '2026-10-20T22:30:00.000Z')).toBe(
      '2026-10-19',
    )
    expect(transactionBusinessDay(new Date('2026-01-01T00:00:00.000Z'), new Date())).toBe(
      '2026-01-01',
    )
    expect(transactionBusinessDay('2026-03-05', '2026-10-20T05:00:00.000Z')).toBe('2026-03-05')
  })

  it('a NULL txDate falls back to the KYIV day of createdAt (backlog 338, QA-LOW-1)', () => {
    expect(transactionBusinessDay(null, '2026-10-20T05:00:00.000Z')).toBe('2026-10-20')
    expect(transactionBusinessDay(undefined, new Date('2026-10-20T05:00:00.000Z'))).toBe(
      '2026-10-20',
    )
    // 21:00-24:00 UTC: Kyiv (EEST, UTC+3) is already on the next day.
    expect(transactionBusinessDay(null, '2026-10-20T21:30:00.000Z')).toBe('2026-10-21')
    expect(transactionBusinessDay(null, '2026-10-20T20:59:00.000Z')).toBe('2026-10-20')
    // Winter (EET, UTC+2): the boundary moves to 22:00Z.
    expect(transactionBusinessDay(null, '2026-12-31T22:30:00.000Z')).toBe('2027-01-01')
    expect(transactionBusinessDay(null, '2026-12-31T21:59:00.000Z')).toBe('2026-12-31')
  })

  it('returns null instead of throwing for an unparseable value (item e)', () => {
    expect(transactionBusinessDay(null, 'not-a-date')).toBeNull()
    expect(transactionBusinessDay('garbage', '2026-10-20T05:00:00.000Z')).toBeNull()
    expect(transactionBusinessDay(null, new Date(Number.NaN))).toBeNull()
  })
})
