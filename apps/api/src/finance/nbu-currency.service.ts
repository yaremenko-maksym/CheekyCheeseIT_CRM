import { Injectable, Logger, Optional } from '@nestjs/common'
import { kyivToday } from '@crm/shared'
import { NBU_SOURCES, ymdToDotted, type NbuRateResponse } from './nbu-rate-sources'
import { NbuRateStore, type PersistedNbuRate } from './nbu-rate-store'

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
 *   - Saturday and Sunday repeat the preceding Friday's value (and its
 *     `calcdate`).
 *   - Public holidays do NOT repeat — the counter-intuitive part, and the
 *     reason a naive "weekends and holidays are stale-but-fine" rule is
 *     wrong. Monday 09.03.2026 (Women's Day observed) = 43.7292 vs Friday's
 *     43.8069. Monday 11.05.2026 (Victory Day observed) = 43.855 vs Friday's
 *     43.8033. New Year's Day 01.01.2026 = 42.3532, its own fresh value.
 *
 * ── WHAT IS A LAW HERE, AND WHAT IS ONLY THE CURRENT REGIME ──────────────────
 * Correction from security-review #574 (MED-6), which measured 2023–2025 —
 * periods outside the window above. It is NOT true in general that "every
 * non-weekend day carries its own value": under the FIXED-RATE regime that ran
 * until October 2023, USD 2023 shows 197 weekday repeats and one identical run
 * of 276 days. That claim holds only under the managed float in force since
 * then, and a future peg would break it again.
 *
 * The gate does not depend on it. What the accept-condition actually rests on
 * is the ONE-WAY premise "a weekend day never differs from the preceding
 * Friday", which the reviewer replayed across five USD/EUR series (2023, 2024,
 * 2025-H1) for 0 violations and 2,168 acceptances with 0 mispricings. Extra
 * repeats can only make the gate REFUSE a rate whose value happened to be
 * identical — the safe direction, costing a retry — never accept a wrong one.
 * So if the regime changes, this code becomes more conservative, not less
 * correct; do not "optimise" it by trusting weekday repeats.
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
 * Manager-role plan PR 8: the most past days ONE balance read fetches from NBU. Every fetched
 * day is persisted, so a cold ledger warms over a few reads instead of holding one read for
 * minutes; the days left over are priced at the live rate and marked `stale` meanwhile.
 */
const MAX_HISTORICAL_FETCHES_PER_READ = 31

/**
 * Manager-role plan PR 8 (security review PR #1523, SR-M-2): the wall-clock budget of ONE
 * historical prefetch, in-flight requests included (each one's abort timer is capped at what is
 * left). The caller's live rate already cost up to 6 x `FETCH_TIMEOUT_MS` = 60 s against a hung
 * feed, so 30 s more keeps the whole balance read near 90 s, under Cloudflare's 100 s. Days not
 * reached in time are priced like an unreachable NBU: live rate, `stale: true`, no `rateDate`.
 */
const HISTORICAL_PREFETCH_DEADLINE_MS = 30_000

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
  /**
   * NBU's own publication date (`DD.MM.YYYY`), when the source exposed it.
   * Deliberately a REQUIRED `string | undefined` rather than an optional
   * property: the value is always known at the one place this is built, so
   * there is nothing to branch on, and the conditional spread it replaces
   * needed a mutation suppression that also covered a mutant worth keeping
   * (security-review #574, MED-4).
   */
  calcdate: string | undefined
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
   * Manager-role plan PR 8: persisted past NBU days. Optional so the many specs that build this
   * service bare keep working; without a store every read takes the live NBU path, as before.
   */
  constructor(@Optional() private readonly rateStore?: NbuRateStore) {}

  /**
   * Fetch NBU exchange rates for a specific date (YYYYMMDD) or today.
   *
   * A PAST date (before today in Kyiv) is first looked up in `nbu_daily_rates`: a past day's
   * official rate never changes, so a persisted day is returned exactly as the live exact hit
   * returned it (same strings, `rateDate` set) and NBU is not called. A past day not yet
   * persisted is fetched below and persisted when it was an exact hit. A store failure is
   * logged and the live path runs unchanged.
   */
  async getRates(date?: string): Promise<ExchangeRateResult> {
    const today = this.todayStr()
    const dateStr = date ?? today
    if (dateStr < today) {
      const hit = (await this.readPersisted([dateStr]))?.get(dateStr)
      if (hit) {
        const result = this.persistedResult(hit)
        this.logProvenance(result, {
          origin: `persisted:${hit.sourceId}`,
          url: '(nbu_daily_rates)',
          requested: dateStr,
        })
        return result
      }
    }
    return this.fetchRates(dateStr, today)
  }

  /**
   * Manager-role plan PR 8 AC2: rates for MANY days in one batch, for a balance that converts
   * each row at its own day's rate. `days` are `YYYYMMDD`, duplicates welcome (one per row);
   * the result has one entry per distinct day.
   *
   *   - today / future days: `live`, the caller's own `getRates()` result (code review PR #1523,
   *     CR-M-1: the read never asks NBU for today a second time);
   *   - persisted past days: one store query for all of them, no NBU call;
   *   - missing past days: one NBU fetch per distinct day (each persisted on an exact hit), at
   *     most `MAX_HISTORICAL_FETCHES_PER_READ` per read. A day that comes back stale while the
   *     live rate is stale too (the feed is down) stops further fetches for this read; a day
   *     that is merely unanswerable does not. The whole prefetch has ONE deadline,
   *     `HISTORICAL_PREFETCH_DEADLINE_MS`; a request still in flight at it is aborted. Every day
   *     left over is priced at the live rate and marked `stale: true` with no `rateDate`, so no
   *     money path can take it.
   *   - an unusable store (e.g. the table is not deployed yet) means NO historical NBU call at
   *     all on this read: every past day gets the stale live stand-in.
   * Never throws for an NBU or store failure.
   */
  async getRatesForDays(
    days: readonly string[],
    live: ExchangeRateResult,
  ): Promise<Map<string, ExchangeRateResult>> {
    const out = new Map<string, ExchangeRateResult>()
    const unique = [...new Set(days)]
    if (unique.length === 0) return out

    const deadline = Date.now() + HISTORICAL_PREFETCH_DEADLINE_MS
    const today = this.todayStr()
    const past = unique.filter((d) => d < today)
    for (const d of unique) if (d >= today) out.set(d, live)
    if (past.length === 0) return out

    const persisted = await this.readPersisted(past)
    const missing = past.filter((d) => {
      const hit = persisted?.get(d)
      if (hit) out.set(d, this.persistedResult(hit))
      return hit === undefined
    })

    const { usdUah, usdtUah, eurUah } = live
    let fetches = 0
    let standIns = 0
    let stop: string | null = persisted === null ? 'rate store unavailable' : null
    for (const d of missing) {
      if (stop === null && fetches >= MAX_HISTORICAL_FETCHES_PER_READ) {
        stop = `per-read cap of ${MAX_HISTORICAL_FETCHES_PER_READ} fetches reached`
      }
      if (stop === null && Date.now() >= deadline) {
        stop = `prefetch deadline of ${HISTORICAL_PREFETCH_DEADLINE_MS}ms reached`
      }
      if (stop === null) {
        fetches++
        const fetched = await this.fetchRates(d, today, deadline)
        if (fetched.stale !== true || Date.now() < deadline) {
          out.set(d, fetched)
          // A stale day trips the breaker only when the feed itself is down (the live rate is
          // stale too); one unanswerable day must not starve the days after it on every read.
          if (fetched.stale === true && live.stale === true)
            stop = 'NBU feed down (live rate stale)'
          continue
        }
        // Cut by the deadline: priced as a stand-in below, never as a fallback for this day.
        stop = `prefetch deadline of ${HISTORICAL_PREFETCH_DEADLINE_MS}ms reached`
      }
      standIns++
      out.set(d, { usdUah, usdtUah, eurUah, date: d, stale: true })
    }

    if (standIns > 0) {
      this.logger.warn(
        `NBU historical prefetch incomplete | provider=bank.gov.ua | cause=${stop} | daysAtLiveRate=${standIns} | stale=true`,
      )
    }
    return out
  }

  /** The persisted subset of `days`, or `null` when the store is absent or failed (logged). */
  private async readPersisted(days: string[]): Promise<Map<string, PersistedNbuRate> | null> {
    if (!this.rateStore) return null
    try {
      return await this.rateStore.findMany(days)
    } catch (err: unknown) {
      this.logger.error(
        `NBU rate store read failed | provider=nbu_daily_rates | cause=${String(err)} | falling back to live NBU`,
      )
      return null
    }
  }

  /** A persisted day, shaped exactly like the live exact hit for that day. */
  private persistedResult(hit: PersistedNbuRate): ExchangeRateResult {
    return {
      usdUah: hit.usdUah,
      usdtUah: hit.usdUah, // USDT is pegged to USD, as in buildResult
      eurUah: hit.eurUah,
      date: hit.day,
      stale: false,
      rateDate: hit.day,
    }
  }

  /**
   * Persist an exact past-day hit. Only a result that is not stale and whose `rateDate` is the
   * requested day qualifies: a previous-day, cached or hardcoded value is never written, since a
   * row here is permanent. NBU's own date on BOTH the USD and the EUR row (`exchangedate` /
   * `StartDate`) must also be the requested day: a source that answers a different day than asked
   * (security review PR #1523, SR-M-1) is served for this read but never stored under the wrong
   * label. A write failure is logged and ignored (the read already succeeded).
   */
  private async persistExact(result: ExchangeRateResult, hit: SourceHit): Promise<void> {
    if (!this.rateStore || result.stale !== false || result.rateDate !== result.date) return
    const asked = ymdToDotted(result.date)
    // Both currencies are present here: a hit missing one makes `result` stale (returned above).
    const dated = (cc: string): boolean =>
      hit.rates.every((r) => r.cc !== cc || r.exchangedate === asked)
    if (!dated('USD') || !dated('EUR')) {
      this.logger.warn(
        `NBU rate not persisted | provider=bank.gov.ua | source=${hit.sourceId} | day=${result.date} | cause=answer is dated another day`,
      )
      return
    }
    const usd = Number(result.usdUah)
    const eur = Number(result.eurUah)
    if (!(usd > 0 && Number.isFinite(usd) && eur > 0 && Number.isFinite(eur))) return
    try {
      await this.rateStore.save({
        day: result.date,
        usdUah: result.usdUah,
        eurUah: result.eurUah,
        sourceId: hit.sourceId,
      })
    } catch (err: unknown) {
      this.logger.error(
        `NBU rate store write failed | provider=nbu_daily_rates | day=${result.date} | cause=${String(err)}`,
      )
    }
  }

  /**
   * The live NBU path for `dateStr` (YYYYMMDD); `today` is Kyiv today, computed once by the caller.
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
  private async fetchRates(
    dateStr: string,
    today: string,
    deadline?: number,
  ): Promise<ExchangeRateResult> {
    // security-review PR #578 review (LOW-1): `today` is computed ONCE by the
    // caller — `todayStr()` is not free (it formats against a real timezone
    // database) and every read below must agree on the exact same instant.
    // security-review PR #521 round 3 (MED): `lastKnownGood` backs EVERY
    // other consumer's outage fallback (balances, summaries — anything that
    // calls `getRates()` with no date at all). It must only ever hold a
    // rate for "now": a HISTORICAL request (a DROP settle dated last March)
    // can legitimately succeed against NBU, and caching that success would
    // silently overwrite the shared "current" rate with a months-old one.
    // Gate cache writes on the ORIGINALLY REQUESTED date being today's.
    const isLiveRequest = dateStr === today

    // Attempt 1: the exact requested date.
    const exact = await this.fetchFromSources(dateStr, deadline)
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
      if (dateStr < today) await this.persistExact(result, exact)
      return result
    }

    // Attempt 2: previous day (weekend / holiday / not-yet-published gap).
    const prev = this.prevDayStr(dateStr)
    const prevHit = await this.fetchFromSources(prev, deadline)
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
  private async fetchFromSources(yyyymmdd: string, deadline?: number): Promise<SourceHit | null> {
    let partial: SourceHit | null = null

    for (const source of NBU_SOURCES) {
      const url = source.buildUrl(yyyymmdd)
      const body = await this.fetchJson(url, source.id, deadline)
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
   * Fetch and JSON-decode `url` with a 10 s AbortController timeout, cut shorter by `deadline`
   * (epoch ms) when one is given; past the deadline nothing is requested at all.
   * Returns the decoded body, or null on any failure (network / timeout /
   * non-OK / undecodable body). Logs internally so callers need not.
   */
  private async fetchJson(
    url: string,
    sourceId: string,
    deadline?: number,
  ): Promise<unknown | null> {
    const timeoutMs = Math.min(FETCH_TIMEOUT_MS, (deadline ?? Infinity) - Date.now())
    if (timeoutMs <= 0) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
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
        this.logger.error(`NBU source "${sourceId}" request timed out (${timeoutMs}ms) for ${url}`)
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
          calcdate,
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

  /**
   * "Today" in `Europe/Kyiv` — where NBU's operational day actually turns —
   * NOT in UTC (backlog item 148, security-review #574 MED-2).
   *
   * ── THE BUG THIS REPLACES ─────────────────────────────────────────────────
   * The previous implementation took the UTC calendar date. Kyiv is ahead of
   * UTC (+2 in winter, +3 in summer under DST), so for a window right after
   * Kyiv midnight — 00:00–02:00 in winter, 00:00–03:00 in summer — the UTC
   * calendar day had not yet turned over: the service asked NBU for
   * YESTERDAY, priced with yesterday's rate, and — the part that made this a
   * MONEY path rather than display-only — cached it under yesterday's date.
   * The MED-6 freshness gate (`noNewRateSince`) then saw an outage cache as
   * age-0 in that same window and ACCEPTED it, where the old dateless
   * fallback used to refuse everything. So the gate's own invariant — "no new
   * rate has taken effect since" — was provably false for up to three hours a
   * day. Fixing only the fetch/cache DAY here (not a second, separate "today"
   * getter) is what keeps the cache key in sync: `getRates()` derives
   * `dateStr` from this one function and threads it through the fetch, the
   * `isLiveRequest` cache-write gate and `rateDate`, so there is nowhere left
   * for a UTC/Kyiv day to leak in independently and make the cache serve
   * yesterday's numbers under today's key (or vice versa).
   *
   * ── WHY THIS DELEGATES TO `@crm/shared` (PR #578 review, MED-1/MED-2) ─────
   * The `Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', ... })`
   * formatter used to live here as a private static field. Security review
   * on PR #578 found THREE OTHER "today" computations left on plain UTC —
   * the client-side `exchange-rate` react-query cache key
   * (`amount-currency-input.tsx` and its siblings) and the DROP-settle
   * `txDate` upper bound (`settleSeniorPayoutSchema` plus its mirrored
   * date-picker `maxDate`) — which is exactly the failure MODE this fix
   * exists to close, just one level up: a THIRD, independently-defined
   * "today" quietly reappearing is how the original UTC-vs-Kyiv bug happened
   * in the first place. `kyivToday()` in `@crm/shared` (`utils/kyiv-day.ts`)
   * is now the ONLY definition, shared verbatim by the server, the web
   * client's cache keys, and the Zod schema — see its module comment for the
   * full "why `Intl.DateTimeFormat`, not manual offset arithmetic, and not
   * `process.env.TZ` in tests" reasoning (unchanged from what used to live
   * here) and its own mutation-gate coverage of the formatter's construction.
   */
  private todayStr(): string {
    return kyivToday().replace(/-/g, '')
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
   * True only when no new rate can have taken effect in between — that is,
   * when every calendar day after `cachedYmd` up to and including `pricingYmd`
   * is a Saturday or Sunday. Public holidays are NOT exempt: they get their own
   * value. Same-day (age 0) is trivially true and is the common MED-6 case:
   * the feed answered minutes ago, then died.
   *
   * The premise is deliberately ONE-WAY — "a weekend day never differs from the
   * preceding Friday" — not the converse "every weekday differs". Only the
   * former is load-bearing, and it held at 0 violations across five USD/EUR
   * series spanning 2023–2026 (security-review #574). The converse is merely
   * true of the current FX regime; where it fails, this function refuses a rate
   * that happened to be identical, which costs a retry and never money.
   *
   * A cache NEWER than the day being priced (age < 0 — a historical request
   * during an outage) is refused too: today's rate is not last March's rate.
   */
  private noNewRateSince(cachedYmd: string, pricingYmd: string): boolean {
    const age = this.dayDiff(cachedYmd, pricingYmd)
    // Split from the ceiling below on purpose (security-review #574, MED-4):
    // as one combined condition, a single line-level suppression also silenced
    // THIS check — the one that stops a cache NEWER than the day being priced
    // from being accepted. It carries weight and stays unsuppressed.
    if (age < 0) return false
    // Stryker disable next-line ConditionalExpression: this ceiling is deliberately
    // REDUNDANT — any span of 3+ calendar days necessarily contains a
    // non-weekend day, which the loop below already rejects, so dropping the
    // check cannot change an outcome. It is kept as a cheap explicit bound so a
    // future bug in the weekday logic cannot silently widen the window that
    // decides whether real money may be paid. Two mutants fall under this
    // directive: `→ false` (the equivalent one this reason is about) and
    // `→ true`, which refuses every cached rate and is independently killed by
    // the acceptance tests ("a rate cached MINUTES ago…", "…still prices
    // Saturday and Sunday").
    if (age > MAX_CACHED_RATE_AGE_DAYS) return false
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
   *
   * The previous implementation mixed a UTC-parsed date with LOCAL-time
   * arithmetic (`setDate(getDate() - 1)`). Corrected description
   * (security-review #574, MED-5 — the earlier note here was wrong about both
   * the trigger and the scope): it did not misbehave in "any timezone behind
   * UTC". It skipped back TWO days on exactly the day AFTER a DST fall-back,
   * in any zone that observes DST — including `Europe/Kyiv`, which is AHEAD of
   * UTC and is where production most plausibly runs. Measured over 1,299
   * consecutive days per zone:
   *
   *   Europe/Kyiv        3 wrong — 20231030 → 20231028 (want 20231029),
   *                                20241028, 20251027
   *   America/New_York   3 wrong — 20231106 → 20231104 (want 20231105),
   *                                20241104, 20251103
   *   Australia/Sydney   4 wrong — 20230402 → 20230331 (want 20230401), …
   *                                (southern-hemisphere fall-back is in April)
   *   UTC                0 wrong  ← why CI never saw it
   *   Pacific/Kiritimati 0 wrong  ← no DST, despite being UTC+14
   *
   * So the pattern is DST, not the sign of the offset, and "our servers are
   * not west of UTC" is NOT a reason to revert this to local-time arithmetic.
   * The replacement is pure UTC arithmetic and was wrong on 0 of 1,299 days in
   * every zone above.
   */
  private prevDayStr(yyyymmdd: string): string {
    return new Date(this.ymdToUtcMs(yyyymmdd) - 86_400_000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, '')
  }
}
