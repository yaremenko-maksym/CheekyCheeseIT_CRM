import { Injectable, Logger } from '@nestjs/common'
import { NBU_SOURCES, type NbuRateResponse } from './nbu-rate-sources'

export interface ExchangeRateResult {
  usdUah: string
  usdtUah: string
  eurUah: string
  date: string
  /** AC3 (BIZ-10): true when rates come from a fallback (cached or hardcoded),
   *  i.e. the live NBU API call failed or returned empty data.
   *  Optional for backward-compat with existing mocks; NbuCurrencyService always
   *  populates it. All stale paths are logged via Logger.error/warn in the service.
   *
   *  TODO (deferred with financial conversion): once UAH→USDT conversion is
   *  wired into transactions.service, consumers MUST check `stale === true` and
   *  surface a warning to operators before applying the rate to payout amounts.
   *  Current callers (transactions.service ~:1958 etc.) do not block on stale —
   *  acceptable pre-conversion since rates only affect display, not ledger entries. */
  stale?: boolean
  /**
   * task-drop-payout-currency (owner addendum, 2026-08): the date the
   * returned rates ACTUALLY apply to, when known — distinct from `date`
   * (which always echoes the REQUESTED date, even on a fallback, so
   * existing consumers that assume `date === requested` keep working
   * unchanged). Set only when we have a real, dated source for the numbers
   * that is ALSO fit to price money as of `date`:
   *   - exact match → rateDate === date (the request was honoured as-is).
   *   - previous-day fallback (a gap with no same-day publication) →
   *     rateDate is the PRECEDING day the data actually came from.
   *   - last-known-good cache → rateDate is the day the cached numbers apply
   *     to, but ONLY while no newer official rate has taken effect since that
   *     day (see `noNewRateSince` — this is the MED-6 fix: a cache populated
   *     minutes ago is not the same thing as a dead feed, but a cache from
   *     last week, or even from yesterday, is not fit for a payout).
   * Left `undefined` when we have no dated source fit for the requested day:
   * the hardcoded constant (never dated, by design) or a cached value that is
   * too old / for the wrong day.
   *
   * ── THIS FIELD IS A MONEY GATE, NOT A LABEL ─────────────────────────────
   * Both paths that write a PERMANENT, irreversible amount — DROP settle
   * (`PendingSettlementService`) and `createPayoutRequest`
   * (`transactions.service`) — refuse on exactly `stale && rateDate ===
   * undefined`. So `rateDate` present is this service PROMISING "these
   * numbers are the officially applicable NBU rate for `date`, and you may
   * pay real money on them". Never set it on a value that cannot honour that
   * promise; `stale` alone is not the gate, because a weekend/holiday rate is
   * legitimately stale AND exact.
   */
  rateDate?: string
}

/** NBU fetch timeout — 10 seconds (AbortController guard, AC3). */
const FETCH_TIMEOUT_MS = 10_000

/**
 * Hard ceiling on how far the cached rate's APPLIES-TO day may lag the day we
 * are pricing. This is a derived arithmetic consequence of the rule below, not
 * a chosen round number — see `noNewRateSince`, which is the real gate.
 *
 * ── WHAT THE LIVE FEED ACTUALLY DOES (measured 2026-08-18) ───────────────────
 * 383 consecutive calendar days (2025-08-01 … 2026-08-18) pulled from
 * `exchange_site`, plus targeted probes around public holidays:
 *
 *   - NBU publishes a record for EVERY calendar day. All 383 days were
 *     present — not one gap, weekends and public holidays included.
 *   - NBU recalculates each business day in the afternoon (~15:30–16:00 Kyiv)
 *     and the value applies from the NEXT calendar day. The record for Tue
 *     18.08.2026 carries `calcdate` 17.08.2026. Asking for TOMORROW before
 *     that window returns an empty array (verified 19.08 at 13:57 Kyiv).
 *   - ONLY Saturday and Sunday repeat the preceding Friday's value (and its
 *     `calcdate`). Every other day carries its own, different value.
 *   - Public holidays do NOT repeat — the counter-intuitive part, and the
 *     reason a naive "weekends and holidays are stale-but-fine" rule is
 *     wrong. Monday 09.03.2026 (Women's Day observed) = 43.7292 vs Friday's
 *     43.8069. Monday 11.05.2026 (Victory Day observed) = 43.855 vs Friday's
 *     43.8033. New Year's Day 01.01.2026 = 42.3532, its own fresh value.
 *
 * ── WHY A PURE "AGE ≤ N DAYS" RULE IS UNSAFE, HENCE `noNewRateSince` ─────────
 * Because every non-weekend day gets its own value, age alone cannot tell a
 * still-valid rate from a superseded one:
 *   - Mon cached → priced Tue: age 1, yet Tuesday has its OWN value
 *     (44.7061 → 44.6938 on 17→18.08.2026). A rate that is one day old is
 *     already WRONG. An "age ≤ 2" rule would have paid on it.
 *   - Sat cached → priced Mon: age 2, and Monday likewise has its own value.
 *     Also WRONG, also accepted by a naive age rule.
 *   - Fri cached → priced Sun: age 2, and the value is PROVABLY identical
 *     (Sat/Sun repeat Friday). Correct to accept.
 * So the question is not "how many days old" but "has any new rate taken
 * effect since" — i.e. has any non-weekend day begun. 2 is simply the largest
 * age that can satisfy that (Fri → Sun); it exists as a cheap guard so a
 * calendar bug can never widen the window silently.
 *
 * ── WHY THIS DOES NOT BREAK AN ORDINARY MONDAY ───────────────────────────────
 * The gate only engages when the feed is DOWN; a working feed answers for
 * every calendar day including Sunday, giving age 0. On a normal Monday
 * nothing here applies. If Monday's own record were briefly missing, the
 * previous-day fallback supplies Sunday's real dated rate directly, never
 * touching this cache path. A Monday is refused only after the feed has been
 * unreachable since Friday — a genuine multi-day outage, not an ordinary
 * Monday — and on that Monday a different official rate provably exists, so
 * refusing is correct rather than a false alarm.
 *
 * ── WHY ERR TIGHT ────────────────────────────────────────────────────────────
 * The failure modes are not symmetric. Too loose → we pay a wrong amount on a
 * transfer that cannot be un-paid, and `payPayoutRequest` then demands the
 * on-chain transfer match that wrong figure EXACTLY. Too tight → the operator
 * retries later, or settles in USDT, which needs no rate at all. Nothing is
 * lost by refusing; money is lost by guessing.
 */
const MAX_CACHED_RATE_AGE_DAYS = 2

/**
 * Conservative hardcoded fallback used ONLY when the live NBU API fails AND
 * no prior successful response is cached. Marked stale=true and always logged.
 *
 * It carries NO date and MUST NEVER be given a `rateDate`: it is a made-up
 * number whose only job is to keep balance screens rendering instead of
 * crashing. Every money path refuses it, always, by design.
 */
const HARDCODED_FALLBACK = {
  usdUah: '41.50',
  usdtUah: '41.50',
  eurUah: '44.80',
}

/** What the last-known-good cache remembers, beyond the numbers themselves. */
interface LastKnownGood {
  usdUah: string
  usdtUah: string
  eurUah: string
  /** `YYYYMMDD` day these numbers APPLY TO — the basis of the freshness gate. */
  rateDate: string
  /** Which source produced them (provenance). */
  sourceId: string
  /** NBU's own publication date (`DD.MM.YYYY`), when the source exposed it. */
  calcdate?: string
}

/** Which source answered, and with what. */
interface SourceHit {
  sourceId: string
  url: string
  rates: NbuRateResponse[]
}

@Injectable()
export class NbuCurrencyService {
  private readonly logger = new Logger(NbuCurrencyService.name)

  /**
   * AC3 (BIZ-10): in-memory last-known-good cache.
   * Populated on every successful NBU response for a TODAY request; returned
   * (with stale=true) when the live call fails so consumers get a sensible
   * rate instead of the blind hardcoded constant. Null until the first
   * successful fetch. Since MED-6 it also remembers WHICH DAY the numbers
   * apply to, so a fallback can tell "cached a minute ago" from "cached last
   * week" — see `MAX_CACHED_RATE_AGE_DAYS`.
   */
  private lastKnownGood: LastKnownGood | null = null

  /**
   * Fetch NBU exchange rates for a specific date (YYYYMMDD) or today.
   *
   * Resolution order is FIXED and fully deterministic — the same inputs always
   * yield the same number:
   *   1. the exact requested date, trying each source in `NBU_SOURCES` order;
   *   2. the previous calendar day, again trying each source in order;
   *   3. the last-known-good cache, but only if it is still fresh enough to
   *      price money (otherwise it is returned for display WITHOUT a
   *      `rateDate`, which makes every money path refuse);
   *   4. the hardcoded constant, never dated.
   * Date correctness outranks source preference: we would rather have the
   * right day from the third source than the wrong day from the first.
   */
  async getRates(date?: string): Promise<ExchangeRateResult> {
    const dateStr = date ?? this.todayStr()
    // security-review PR #521 round 3 (MED): `lastKnownGood` backs EVERY
    // other consumer's outage fallback (balances, summaries — anything that
    // calls `getRates()` with no date at all). It must only ever hold a
    // rate for "now": a HISTORICAL request (a DROP settle dated last March)
    // can legitimately succeed against NBU, and caching that success would
    // silently overwrite the shared "current" rate with a months-old one.
    // Gate cache writes on the ORIGINALLY REQUESTED date being today's.
    const isLiveRequest = dateStr === this.todayStr()

    // Attempt 1: the exact requested date.
    const exact = await this.fetchFromSources(dateStr)
    if (exact !== null) {
      const result = this.buildResult(exact.rates, dateStr, {
        stale: false,
        allowCacheUpdate: isLiveRequest,
        sourceId: exact.sourceId,
        calcdate: this.calcdateOf(exact.rates),
      })
      this.logProvenance(result, {
        origin: `live:${exact.sourceId}`,
        url: exact.url,
        requested: dateStr,
        calcdate: this.calcdateOf(exact.rates),
      })
      return result
    }

    // Attempt 2: previous day (weekend / holiday / not-yet-published gap).
    const prev = this.prevDayStr(dateStr)
    const prevHit = await this.fetchFromSources(prev)
    if (prevHit !== null) {
      const prevResult = this.buildResult(prevHit.rates, prev, {
        stale: false, // a real publication for `prev` — cacheable as such
        allowCacheUpdate: isLiveRequest,
        sourceId: prevHit.sourceId,
        calcdate: this.calcdateOf(prevHit.rates),
      })
      // MED-1 (security-review PR #574): this path must clear the SAME gate as
      // the cache path, and until this fix it did not — it claimed `rateDate`
      // unconditionally. That made the identical situation depend on which
      // route it arrived by: Sunday's rate priced on Monday was REFUSED when it
      // came from the cache, yet ACCEPTED when it came from here, even though
      // Monday has its own official rate either way. The rule is a property of
      // the calendar, not of the code path that fetched the numbers.
      //
      // `date` still echoes the REQUESTED day (unchanged contract). `rateDate`
      // is claimed only when no newer official rate has taken effect between
      // `prev` and `dateStr` — which keeps the legitimate case working (a
      // Sunday request served by Saturday's publication: age 1, weekend, still
      // dated and still payable) and refuses the weekday case.
      //
      // Caching above is deliberately NOT conditioned on this: `prev` really
      // was published, so it is a valid cache entry; whether it may price a
      // LATER day is re-decided by `buildFallbackResult` on its own merits.
      const { rateDate: prevRateDate, ...prevNumbers } = prevResult
      const datedForRequestedDay = prevRateDate !== undefined && this.noNewRateSince(prev, dateStr)
      this.logger.warn(
        `NBU had no data for ${dateStr} on any source, using previous-day rates (${prev}) — stale=true, ${
          datedForRequestedDay
            ? 'DATED for the requested day (money paths accept)'
            : 'but a newer official rate applies to the requested day — display only, money paths refuse'
        }`,
      )
      const result: ExchangeRateResult = {
        ...prevNumbers,
        date: dateStr,
        stale: true,
        ...(datedForRequestedDay ? { rateDate: prevRateDate } : {}),
      }
      this.logProvenance(result, {
        origin: `live-prev-day:${prevHit.sourceId}`,
        url: prevHit.url,
        requested: dateStr,
        calcdate: this.calcdateOf(prevHit.rates),
      })
      return result
    }

    // Every source failed for both days — cache or hardcoded constant.
    return this.buildFallbackResult(dateStr)
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Ask each configured NBU source, in fixed order, for `yyyymmdd`.
   * Returns the first hit that carries BOTH currencies we price in (USD, EUR);
   * failing that, the first non-empty answer (preserving the long-standing
   * behaviour where a partial response degrades to stale rather than being
   * discarded); `null` when nothing usable came back at all.
   *
   * NOTE (deliberate): all sources share one host, so this loop protects
   * against a single SERVICE failing, not against `bank.gov.ua` being
   * unreachable — see the header comment in `nbu-rate-sources.ts`.
   */
  private async fetchFromSources(yyyymmdd: string): Promise<SourceHit | null> {
    let partial: SourceHit | null = null

    for (const source of NBU_SOURCES) {
      const url = source.buildUrl(yyyymmdd)
      const body = await this.fetchJson(url, source.id)
      if (body === null) continue

      const rows = source.parse(body)
      if (rows === null) {
        this.logger.warn(
          `NBU source "${source.id}" returned an unrecognised body shape for ${yyyymmdd} — trying next source`,
        )
        continue
      }
      if (rows.length === 0) {
        this.logger.warn(
          `NBU source "${source.id}" returned empty rates for ${yyyymmdd} — trying next source`,
        )
        continue
      }

      const hasUsd = rows.some((r) => r.cc === 'USD')
      const hasEur = rows.some((r) => r.cc === 'EUR')
      if (hasUsd && hasEur) return { sourceId: source.id, url, rates: rows }

      this.logger.warn(
        `NBU source "${source.id}" answered for ${yyyymmdd} but is missing USD and/or EUR — trying next source`,
      )
      partial ??= { sourceId: source.id, url, rates: rows }
    }

    return partial
  }

  /**
   * Fetch and JSON-decode `url` with a 10 s AbortController timeout.
   * Returns the decoded body, or null on any failure (network / timeout /
   * non-OK / undecodable body). Logs internally so callers need not.
   */
  private async fetchJson(url: string, sourceId: string): Promise<unknown | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        this.logger.error(`NBU source "${sourceId}" HTTP ${res.status} for ${url}`)
        return null
      }
      try {
        return (await res.json()) as unknown
      } catch {
        // e.g. `NBU_Exchange/exchange` answers 200 with the non-JSON blob
        // `[{ Wrong date format }]` when handed the wrong date format.
        this.logger.error(`NBU source "${sourceId}" returned an undecodable body for ${url}`)
        return null
      }
    } catch (err: unknown) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      if (isAbort) {
        this.logger.error(
          `NBU source "${sourceId}" request timed out (${FETCH_TIMEOUT_MS}ms) for ${url}`,
        )
      } else {
        this.logger.error(`NBU source "${sourceId}" network error: ${String(err)}`)
      }
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** NBU's own publication date, when the answering source exposed one. */
  private calcdateOf(rates: NbuRateResponse[]): string | undefined {
    return rates.find((r) => r.cc === 'USD')?.calcdate
  }

  /**
   * Build a successful ExchangeRateResult from NBU rate rows and update the
   * last-known-good cache.
   *
   * @param options.stale marks the WHOLE result stale from the caller's own
   *   knowledge. `buildResult` may ALSO derive `stale: true` itself (missing
   *   USD/EUR rows) regardless of this input.
   * @param options.allowCacheUpdate only `true` when the date this call
   *   fetched traces back to a TODAY request — a historical-date fetch must
   *   never overwrite the shared cache every other caller relies on.
   */
  private buildResult(
    rates: NbuRateResponse[],
    date: string,
    options: {
      stale: boolean
      allowCacheUpdate: boolean
      sourceId: string
      calcdate?: string | undefined
    },
  ): ExchangeRateResult {
    const { stale, allowCacheUpdate, sourceId, calcdate } = options
    // Missing currency rows: keep last-known-good value or use hardcoded constant.
    const usd = rates.find((r) => r.cc === 'USD')?.rate
    const eur = rates.find((r) => r.cc === 'EUR')?.rate

    // If we got a response but specific currencies are missing, that's also stale.
    const effectiveStale = stale || usd === undefined || eur === undefined

    const usdVal = usd ?? parseFloat(this.lastKnownGood?.usdUah ?? HARDCODED_FALLBACK.usdUah)
    const eurVal = eur ?? parseFloat(this.lastKnownGood?.eurUah ?? HARDCODED_FALLBACK.eurUah)

    const result: ExchangeRateResult = {
      usdUah: usdVal.toFixed(4),
      usdtUah: usdVal.toFixed(4), // USDT is pegged to USD (explicit, not accidental)
      eurUah: eurVal.toFixed(4),
      date,
      stale: effectiveStale,
      // Only claim `date` as the real applies-to date when nothing was
      // degraded or substituted. Omitted entirely (not set to `undefined`) —
      // `exactOptionalPropertyTypes` distinguishes "absent" from "present but
      // undefined".
      ...(effectiveStale ? {} : { rateDate: date }),
    }

    // Cache the good result for future fallback (only when not stale, sanity
    // passes, AND the request this call answers was for TODAY).
    if (!effectiveStale && allowCacheUpdate) {
      const usdNum = parseFloat(result.usdUah)
      const eurNum = parseFloat(result.eurUah)
      // MED: sanity-check — defence against corrupt API responses with 0 or Inf rates
      if (usdNum > 0 && isFinite(usdNum) && eurNum > 0 && isFinite(eurNum)) {
        this.lastKnownGood = {
          usdUah: result.usdUah,
          usdtUah: result.usdtUah,
          eurUah: result.eurUah,
          // MED-6: remember the day these numbers APPLY TO, not the moment we
          // downloaded them — the freshness gate must compare like with like.
          rateDate: date,
          sourceId,
          // Stryker disable next-line ConditionalExpression: equivalent — spreading
          // `{ calcdate: undefined }` instead of omitting the key is
          // indistinguishable downstream. The only reader is `logProvenance`,
          // which renders `meta.calcdate ?? '(not exposed)'`, and absent vs
          // present-but-undefined both take the `??` branch. The conditional is
          // kept solely to satisfy `exactOptionalPropertyTypes` at compile time.
          ...(calcdate !== undefined ? { calcdate } : {}),
        }
      } else {
        this.logger.warn(
          `NBU API returned invalid rates (usd=${result.usdUah}, eur=${result.eurUah}) — not caching`,
        )
      }
    }

    return result
  }

  /**
   * Build a stale fallback when every source failed for both candidate days.
   *
   * MED-6 — the distinction this method exists to draw:
   *   - a cached rate that is STILL the officially applicable one for `date`
   *     is a real, dated rate. It keeps its `rateDate`, and money paths take
   *     it. Before this fix it was returned dateless and therefore treated as
   *     a total feed outage, blocking payouts on a rate that was live minutes
   *     earlier — the bug being fixed here.
   *   - a cached rate too old (or for the wrong day) is NOT fit to price
   *     money. It is still returned so screens render, but WITHOUT a
   *     `rateDate`, so every money path refuses it.
   *   - the hardcoded constant is never dated and always refused.
   * Always logs — no silent fallback (AC3).
   */
  private buildFallbackResult(date: string): ExchangeRateResult {
    const cached = this.lastKnownGood
    if (cached) {
      const numbers = {
        usdUah: cached.usdUah,
        usdtUah: cached.usdtUah,
        eurUah: cached.eurUah,
      }
      // Age is measured between APPLIES-TO days, both `YYYYMMDD`, in UTC
      // calendar days — never against wall-clock "when we downloaded it",
      // which would be off by the publication offset and would drift with the
      // server's timezone.
      const ageDays = this.dayDiff(cached.rateDate, date)
      const usable = this.noNewRateSince(cached.rateDate, date)

      if (usable) {
        this.logger.error(
          `NBU unavailable on every source — using last-known-good cache: applies-to=${cached.rateDate}, requested=${date}, age=${ageDays}d, no new NBU rate has taken effect since, source="${cached.sourceId}" — DATED, money paths accept`,
        )
        const result: ExchangeRateResult = {
          ...numbers,
          date,
          stale: true,
          rateDate: cached.rateDate,
        }
        this.logProvenance(result, {
          origin: `cache:${cached.sourceId}`,
          url: '(cache)',
          requested: date,
          calcdate: cached.calcdate,
        })
        return result
      }

      this.logger.error(
        `NBU unavailable on every source — cached rate NOT fit to price ${date}: applies-to=${cached.rateDate}, age=${ageDays}d, a newer official NBU rate has taken effect since (or the cache is for a different day) — returning it for DISPLAY ONLY, without rateDate, so money paths refuse`,
      )
      return { ...numbers, date, stale: true }
    }

    this.logger.error(
      'NBU unavailable on every source and no cached rates — using hardcoded fallback (stale=true, no rateDate; display only, money paths refuse)',
    )
    return { ...HARDCODED_FALLBACK, date, stale: true }
  }

  /**
   * Part 3 — provenance of the applied rate, without a schema change.
   *
   * `payout_requests` has no column for the rate, its date or its source, so
   * an accepted conversion currently leaves no trace in the database. Until
   * that migration exists, this log line is the ONLY way to answer "which
   * rate priced this payout, and where did it come from" after the fact — so
   * it is emitted for EVERY rate that a caller could act on, and carries
   * every field needed to reconstruct the number: which service answered (or
   * the cache), the exact URL, the day requested, the day the rate applies
   * to, NBU's own publication date when known, and all three figures.
   *
   * Emitted at `log` level on purpose: `warn`/`error` are for things that are
   * wrong, and a healthy conversion is not. It correlates to a payout by
   * timestamp — which is the weakness a real schema change would remove.
   */
  private logProvenance(
    result: ExchangeRateResult,
    meta: { origin: string; url: string; requested: string; calcdate?: string | undefined },
  ): void {
    this.logger.log(
      `NBU rate applied | origin=${meta.origin} | requested=${meta.requested} | appliesTo=${result.rateDate ?? '(none)'} | published=${meta.calcdate ?? '(not exposed)'} | usdUah=${result.usdUah} | eurUah=${result.eurUah} | usdtUah=${result.usdtUah} (pegged to USD) | stale=${String(result.stale)} | url=${meta.url}`,
    )
  }

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '')
  }

  /** `YYYYMMDD` → UTC epoch ms at midnight of that calendar day. */
  private ymdToUtcMs(yyyymmdd: string): number {
    return Date.UTC(
      Number(yyyymmdd.slice(0, 4)),
      Number(yyyymmdd.slice(4, 6)) - 1,
      Number(yyyymmdd.slice(6, 8)),
    )
  }

  /** Whole calendar days from `fromYmd` to `toYmd` (negative if `to` is earlier). */
  private dayDiff(fromYmd: string, toYmd: string): number {
    return Math.round((this.ymdToUtcMs(toYmd) - this.ymdToUtcMs(fromYmd)) / 86_400_000)
  }

  /**
   * The freshness gate: is a cached rate whose records apply to `cachedYmd`
   * STILL the officially applicable NBU rate on `pricingYmd`?
   *
   * True only when no new rate has taken effect in between — that is, when
   * every calendar day after `cachedYmd` up to and including `pricingYmd` is a
   * Saturday or Sunday, the only days NBU does not produce a new value for
   * (measured over 383 consecutive days; public holidays DO get their own
   * value, so they are not exempt). Same-day (age 0) is trivially true and is
   * the common MED-6 case: the feed answered minutes ago, then died.
   *
   * A cache NEWER than the day being priced (age < 0 — a historical request
   * during an outage) is refused too: today's rate is not last March's rate.
   */
  private noNewRateSince(cachedYmd: string, pricingYmd: string): boolean {
    const age = this.dayDiff(cachedYmd, pricingYmd)
    // Stryker disable next-line ConditionalExpression: the `age > MAX_CACHED_RATE_AGE_DAYS`
    // half is deliberately REDUNDANT, so removing it is unobservable: any span
    // of 3+ calendar days necessarily contains a non-weekend day, which the
    // loop below already rejects. It is kept as a cheap, explicit ceiling so a
    // future bug in the weekday logic cannot silently widen the window that
    // decides whether real money may be paid. The `age < 0` half is NOT
    // redundant and IS covered (a historical request during an outage).
    if (age < 0 || age > MAX_CACHED_RATE_AGE_DAYS) return false
    const cachedMs = this.ymdToUtcMs(cachedYmd)
    for (let i = 1; i <= age; i++) {
      const dow = new Date(cachedMs + i * 86_400_000).getUTCDay()
      const isWeekend = dow === 0 || dow === 6 // Sun = 0, Sat = 6
      if (!isWeekend) return false
    }
    return true
  }

  /**
   * Previous calendar day, computed in UTC.
   * (Was local-time arithmetic on a UTC-parsed date, which stepped back TWO
   * days in any timezone behind UTC — invisible on UTC CI runners.)
   */
  private prevDayStr(yyyymmdd: string): string {
    return new Date(this.ymdToUtcMs(yyyymmdd) - 86_400_000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, '')
  }
}
