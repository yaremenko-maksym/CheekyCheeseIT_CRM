import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kyivToday } from './kyiv-day'

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
      | [string, Intl.DateTimeFormatOptions]
      | undefined
    expect(dayFormatterCall).toBeDefined()
    expect(dayFormatterCall?.[1]).toEqual({
      timeZone: 'Europe/Kyiv',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  })
})
