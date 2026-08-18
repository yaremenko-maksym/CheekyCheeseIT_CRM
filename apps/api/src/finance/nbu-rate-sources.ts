/**
 * Normalised NBU rate row — the single internal shape every source parser
 * converts to, so `NbuCurrencyService` never learns which endpoint answered.
 */
export interface NbuRateResponse {
  /** ISO-4217 alphabetic code, e.g. `USD`. */
  cc: string
  /** Rate for ONE unit of `cc`, in UAH. */
  rate: number
  /** Date the rate APPLIES TO, as published (`DD.MM.YYYY`). */
  exchangedate: string
  /**
   * Date NBU actually COMPUTED the value (`DD.MM.YYYY`), when the source
   * exposes it. Distinct from `exchangedate`: NBU recalculates every business
   * day in the afternoon (~15:30–16:00 Kyiv) and the result applies from the
   * NEXT calendar day, so a Monday rate carries a Friday `calcdate`, and a
   * Saturday/Sunday row repeats the Friday row together with its Friday
   * `calcdate`. Verified live 2026-08-18 against `exchange_site`
   * (16.08.2026 Sun → rate 44.6988, calcdate 13.08.2026).
   * Only `exchange_site` publishes it — used for provenance logging, never
   * for the freshness gate (which measures the APPLIES-TO date; see
   * `MAX_CACHED_RATE_AGE_DAYS` in nbu-currency.service.ts).
   */
  calcdate?: string
}

/** A single, concretely-addressed way to ask NBU for rates. */
export interface NbuSource {
  /** Stable identifier used in provenance logs — do not rename casually. */
  id: string
  /** Builds the request URL for a `YYYYMMDD` date. */
  buildUrl: (yyyymmdd: string) => string
  /** Parses a decoded JSON body into normalised rows, or `null` if unrecognised. */
  parse: (body: unknown) => NbuRateResponse[] | null
}

// ── small, total type-narrowing helpers (no `any`, no unchecked casts) ────────

function asRecordArray(body: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(body)) return null
  // Stryker disable next-line ArrayDeclaration: equivalent — seeding this
  // accumulator with junk cannot be observed. Every consumer is a parser that
  // reads named fields off each row, and a stray primitive yields `undefined`
  // for all of them, so the row is dropped before it can become a rate.
  const out: Record<string, unknown>[] = []
  for (const row of body) {
    if (typeof row !== 'object' || row === null) return null
    out.push(row as Record<string, unknown>)
  }
  return out
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function toStringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** `20260818` → `18.08.2026` (the format `NBU_Exchange/exchange` demands). */
export function ymdToDotted(yyyymmdd: string): string {
  return `${yyyymmdd.slice(6, 8)}.${yyyymmdd.slice(4, 6)}.${yyyymmdd.slice(0, 4)}`
}

/**
 * Parser for the two services that speak the `cc` / `rate` dialect
 * (`statdirectory/exchange` and `NBU_Exchange/exchange_site`).
 *
 * `exchange_site` additionally publishes `units` + `rate_per_unit`; we prefer
 * `rate_per_unit` when present so a currency NBU quotes per 100 units (not USD
 * or EUR today, but the field exists for a reason) can never be misread as a
 * per-unit rate. Verified live 2026-08-18: USD and EUR are both `units: 1`.
 */
function parseCcRateDialect(body: unknown): NbuRateResponse[] | null {
  const rows = asRecordArray(body)
  if (rows === null) return null
  const out: NbuRateResponse[] = []
  for (const row of rows) {
    const cc = toStringOrUndefined(row.cc)
    const exchangedate = toStringOrUndefined(row.exchangedate)
    const perUnit = toFiniteNumber(row.rate_per_unit)
    const raw = toFiniteNumber(row.rate)
    const units = toFiniteNumber(row.units)
    // Prefer the explicit per-unit figure; otherwise divide by units when the
    // source states them; otherwise take `rate` as-is (statdirectory dialect).
    // Stryker disable next-line ConditionalExpression: the `units !== null` half is
    // equivalent on its own — `null > 0` is already false, so the `units > 0`
    // guard rejects a missing units count regardless. It stays for legibility:
    // the null check states the intent, rather than leaning on a coercion.
    const rate = perUnit ?? (raw !== null && units !== null && units > 0 ? raw / units : raw)
    if (cc === undefined || exchangedate === undefined || rate === null) continue
    const calcdate = toStringOrUndefined(row.calcdate)
    out.push({ cc, rate, exchangedate, ...(calcdate !== undefined ? { calcdate } : {}) })
  }
  return out
}

/**
 * Parser for the open-data dialect (`NBU_Exchange/exchange`), which names the
 * very same numbers differently: `CurrencyCodeL` / `Amount` / `Units` /
 * `StartDate`. It has no `calcdate`.
 */
function parseOpenDataDialect(body: unknown): NbuRateResponse[] | null {
  const rows = asRecordArray(body)
  if (rows === null) return null
  const out: NbuRateResponse[] = []
  for (const row of rows) {
    const cc = toStringOrUndefined(row.CurrencyCodeL)
    const exchangedate = toStringOrUndefined(row.StartDate)
    const amount = toFiniteNumber(row.Amount)
    const units = toFiniteNumber(row.Units)
    if (cc === undefined || exchangedate === undefined || amount === null) continue
    // Stryker disable next-line ConditionalExpression: as above, the `units !== null`
    // half is equivalent — `null > 0` is false, so a missing `Units` already
    // falls through to the undivided amount. Kept for the same reason.
    const rate = units !== null && units > 0 ? amount / units : amount
    out.push({ cc, rate, exchangedate })
  }
  return out
}

/**
 * The ordered list of NBU paths we try, most-authoritative first.
 *
 * ── HONEST LIMIT OF THIS REDUNDANCY ──────────────────────────────────────────
 * Every entry below lives on the SAME host, `bank.gov.ua`. That buys us
 * resilience against ONE SERVICE breaking — a single endpoint 500-ing,
 * returning an empty body, changing shape, or being down for maintenance
 * while its siblings keep serving. It buys us NOTHING against the host itself
 * going down, a DNS failure, an expired TLS certificate, a network partition
 * between us and NBU, or a site-wide outage: in every one of those, all
 * entries fail together. That case is real and not rare, and it is exactly
 * what the last-known-good cache and its freshness gate exist for. Do not
 * read this list as "the rate is now highly available".
 *
 * A source INDEPENDENT of bank.gov.ua would be needed to change that, and is
 * deliberately NOT wired in here: a third party carries different
 * responsibility for the number, and this figure is written into irreversible
 * payouts. That is an owner decision, not an implementation detail.
 *
 * ── ORDER IS FIXED AND MEANINGFUL, NOT "whoever answers first" ───────────────
 * We try these strictly in order and take the first that yields usable rows,
 * so the SAME inputs always produce the SAME number. Racing them would make
 * the applied rate depend on network timing — unacceptable for money.
 *
 * ── DELIBERATELY EXCLUDED ────────────────────────────────────────────────────
 * `statdirectory/exchangenew` is NOT listed. Checked live 2026-08-18: its
 * response is BYTE-FOR-BYTE identical to `statdirectory/exchange` (`diff`
 * reported no difference on a 5547-byte body) — the same handler under a
 * second name. Listing it would inflate the retry count while adding zero
 * real redundancy, and would mislead the next reader into believing the feed
 * is better protected than it is.
 */
export const NBU_SOURCES: readonly NbuSource[] = [
  {
    // Primary — the long-standing path this service has always used.
    // Date format: YYYYMMDD. Answers for EVERY calendar day incl. weekends.
    id: 'statdirectory',
    buildUrl: (d) => `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=${d}&json`,
    parse: parseCcRateDialect,
  },
  {
    // Different service, same host. Date format: YYYYMMDD. Richest payload —
    // the only one exposing `calcdate` (true publication date) and
    // `rate_per_unit`.
    id: 'exchange_site',
    buildUrl: (d) => `https://bank.gov.ua/NBU_Exchange/exchange_site?date=${d}&json`,
    parse: parseCcRateDialect,
  },
  {
    // Open-data service. Note the DIFFERENT date format (DD.MM.YYYY): passing
    // YYYYMMDD here returns a 200 whose body is the non-JSON blob
    // `[{ Wrong date format }]`, which fails to decode and is treated as "no
    // data" — verified live 2026-08-18. Field names differ too, hence its own
    // parser.
    id: 'open_data',
    buildUrl: (d) => `https://bank.gov.ua/NBU_Exchange/exchange?date=${ymdToDotted(d)}&json`,
    parse: parseOpenDataDialect,
  },
] as const
