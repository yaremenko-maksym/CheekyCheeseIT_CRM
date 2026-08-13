import { Injectable, Logger } from '@nestjs/common'

interface NbuRateResponse {
  r030: number
  txt: string
  rate: number
  cc: string
  exchangedate: string
}

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
   * returned rates ACTUALLY came from, when known — distinct from `date`
   * (which always echoes the REQUESTED date, even on a fallback, so
   * existing consumers that assume `date === requested` keep working
   * unchanged). Set only when we have a real, dated source for the numbers:
   *   - exact match → rateDate === date (the request was honoured as-is).
   *   - previous-day fallback (a holiday/weekend gap with no same-day
   *     publication) → rateDate is the PRECEDING day the data actually came
   *     from — see `getRates`.
   * Left `undefined` when we genuinely do not know (the last-known-good
   * cache or the hardcoded constant — could be minutes or weeks old, no
   * specific date to attach). A caller that needs to distinguish "a
   * graceful, dated fallback" from "a genuine feed outage" (see
   * `PendingSettlementService`'s DROP settle date-of-record resolution)
   * checks `rateDate !== undefined`, not `stale` alone, for exactly that
   * reason — a historical date's rate, once actually obtained, is
   * exact/final, not "stale" in the sense that matters for refusing a
   * payout.
   */
  rateDate?: string
}

/** NBU fetch timeout — 10 seconds (AbortController guard, AC3). */
const FETCH_TIMEOUT_MS = 10_000

/**
 * Conservative hardcoded fallback used ONLY when the live NBU API fails AND
 * no prior successful response is cached. Marked stale=true and always logged.
 */
const HARDCODED_FALLBACK = {
  usdUah: '41.50',
  usdtUah: '41.50',
  eurUah: '44.80',
}

@Injectable()
export class NbuCurrencyService {
  private readonly logger = new Logger(NbuCurrencyService.name)

  /**
   * AC3 (BIZ-10): in-memory last-known-good cache.
   * Populated on every successful NBU API response; returned (with stale=true)
   * when the live call fails so consumers get a sensible rate instead of the
   * blind hardcoded constant. Null until the first successful fetch.
   */
  private lastKnownGood: { usdUah: string; usdtUah: string; eurUah: string } | null = null

  /**
   * Fetch NBU exchange rates for a specific date (YYYYMMDD) or today.
   *
   * task-drop-payout-currency (owner addendum, 2026-08): `date` is no longer
   * always "today" — a DROP settle now passes the operator-selected date, so
   * this resolves the rate AS OF an arbitrary past date, not just the
   * current one. The two-attempt shape below (exact date, then the day
   * before) already reads correctly either way — "today" was always just
   * the caller's default, never special-cased internally.
   *
   * AC3 resilience:
   *   - AbortController timeout (10 s) on every fetch call.
   *   - 200-OK with empty body (empty JSON array) triggers stale fallback + log.
   *   - Network error / timeout → stale fallback + log.
   *   - Last-known-good cache returned on failure (before hardcoded constant).
   *   - All fallback activations are logged (no silent degradation).
   *   - `stale: true` on any non-live result so callers can detect it.
   */
  async getRates(date?: string): Promise<ExchangeRateResult> {
    const dateStr = date ?? this.todayStr()
    // security-review PR #521 round 3 (MED): `lastKnownGood` backs EVERY
    // other consumer's outage fallback (balances, summaries — anything that
    // calls `getRates()` with no date at all). It must only ever hold a
    // rate for "now" — before the date-of-record feature, every call HERE
    // was implicitly for today, so this was never a live distinction.
    // Today, a HISTORICAL request (a DROP settle dated last March, or the
    // dialog's own preview fetch for that same date) can legitimately
    // succeed against NBU — and if that success were cached, it would
    // silently overwrite the shared "current" rate with a months-old one,
    // which then gets handed to every OTHER caller the next time the LIVE
    // feed genuinely goes down. Gate cache writes on the ORIGINALLY
    // REQUESTED date being today's — never on which attempt (exact-date or
    // prev-day fallback) happened to succeed.
    const isLiveRequest = dateStr === this.todayStr()
    const url = `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=${dateStr}&json`

    // Attempt 1: today's date
    const attempt1 = await this.fetchRates(url)
    if (attempt1 !== null && attempt1.length > 0) {
      return this.buildResult(attempt1, dateStr, false, isLiveRequest)
    }

    // Attempt 1 returned empty data or failed
    if (attempt1 !== null) {
      // Got 200-OK but no rates in the body (e.g. holiday with no data yet)
      this.logger.warn(`NBU API returned empty rates for ${dateStr}, trying previous day`)
    }
    // If attempt1 === null it means fetch threw (network / timeout) — already logged inside fetchRates

    // Attempt 2: previous day (weekends/holidays fallback)
    const prev = this.prevDayStr(dateStr)
    const attempt2 = await this.fetchRates(
      `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=${prev}&json`,
    )
    if (attempt2 !== null && attempt2.length > 0) {
      this.logger.warn(
        `NBU API unavailable for ${dateStr}, using previous-day rates (${prev}) — stale=true`,
      )
      // MED fix (round 1): cache prev-day result so a subsequent API failure
      // can use lastKnownGood instead of making 2 more HTTP calls then
      // falling to hardcoded — but ONLY when the ORIGINAL request was for
      // today (see isLiveRequest above); a historical request's prev-day
      // fallback is just as unfit to cache as its exact-date match would
      // have been. buildResult with stale=true skips the cache update, so
      // we update it here.
      const prevResult = this.buildResult(attempt2, prev, false, isLiveRequest) // cache as fresh prev-day, live requests only
      void prevResult // side-effect: updates this.lastKnownGood
      return { ...prevResult, date: dateStr, stale: true }
    }

    // Both attempts failed — use last-known-good cache or hardcoded constant
    return this.buildFallbackResult(dateStr)
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Fetch NBU rates from `url` with a 10 s AbortController timeout.
   * Returns the parsed rate array on success, null on any error (network / timeout / non-OK).
   * Logs errors internally so getRates() does not need to duplicate logging.
   */
  private async fetchRates(url: string): Promise<NbuRateResponse[] | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        this.logger.error(`NBU API HTTP ${res.status} for ${url}`)
        return null
      }
      return (await res.json()) as NbuRateResponse[]
    } catch (err: unknown) {
      const isAbort = err instanceof DOMException && (err as DOMException).name === 'AbortError'
      if (isAbort) {
        this.logger.error(`NBU API request timed out (${FETCH_TIMEOUT_MS}ms) for ${url}`)
      } else {
        this.logger.error(`NBU API network error: ${String(err)}`)
      }
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Build a successful ExchangeRateResult from NBU rate rows and update the
   * last-known-good cache.
   *
   * @param allowCacheUpdate security-review PR #521 round 3 (MED) — only
   *   `true` when the date this call actually fetched traces back to a
   *   TODAY request (see `isLiveRequest` in `getRates`). A historical-date
   *   fetch (the new date-of-record feature) must never overwrite the
   *   shared last-known-good cache that every OTHER `getRates()` caller
   *   relies on during a genuine live-feed outage.
   */
  private buildResult(
    rates: NbuRateResponse[],
    date: string,
    stale: boolean,
    allowCacheUpdate: boolean,
  ): ExchangeRateResult {
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
      // `date` here is the date THIS call actually fetched (either the
      // originally-requested date on the exact-match path, or the prior
      // business day on the fallback path — see getRates). Only claim it as
      // the real source when nothing was degraded/substituted. Omitted
      // entirely (not set to `undefined`) — `exactOptionalPropertyTypes`
      // distinguishes "absent" from "present but undefined".
      ...(effectiveStale ? {} : { rateDate: date }),
    }

    // Cache the good result for future fallback (only when not stale, sanity
    // passes, AND — round 3, MED — the request this call is answering was
    // for TODAY; see the `allowCacheUpdate` doc comment above).
    if (!effectiveStale && allowCacheUpdate) {
      const usdNum = parseFloat(result.usdUah)
      const eurNum = parseFloat(result.eurUah)
      // MED: sanity-check — defence against corrupt API responses with 0 or Inf rates
      if (usdNum > 0 && isFinite(usdNum) && eurNum > 0 && isFinite(eurNum)) {
        this.lastKnownGood = {
          usdUah: result.usdUah,
          usdtUah: result.usdtUah,
          eurUah: result.eurUah,
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
   * Build a stale fallback result when all NBU API attempts have failed.
   * Prefers last-known-good cache over the hardcoded constant.
   * Always logs — no silent fallback (AC3).
   */
  private buildFallbackResult(date: string): ExchangeRateResult {
    if (this.lastKnownGood) {
      this.logger.error(
        'NBU API completely unavailable — returning last-known-good cached rates (stale=true)',
      )
      return { ...this.lastKnownGood, date, stale: true }
    }
    this.logger.error(
      'NBU API completely unavailable and no cached rates — using hardcoded fallback (stale=true)',
    )
    return { ...HARDCODED_FALLBACK, date, stale: true }
  }

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '')
  }

  private prevDayStr(yyyymmdd: string): string {
    const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`)
    d.setDate(d.getDate() - 1)
    return d.toISOString().slice(0, 10).replace(/-/g, '')
  }
}
