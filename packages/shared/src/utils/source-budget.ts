/**
 * Per-source request budgets — task-vacancy-matching §4.
 *
 * External job APIs meter us, and each meters differently:
 *
 *     DOU (RSS feed)  no published limit
 *     Jooble          500 per period
 *     Adzuna          250 per day
 *     JSearch         200 PER MONTH — hard
 *
 * A budget that lives only in someone's intention gets spent. This module is the
 * arithmetic that makes it mechanical: how much is left, when it comes back, and
 * whether a collection run is allowed to go to the network AT ALL. The caller
 * (JobSourcingService) refuses BEFORE fetching, so an exhausted budget costs
 * zero requests rather than one more.
 *
 * It lives in `@crm/shared` for the same reason the name matchers do: the API
 * enforces the budget and the web SHOWS the remainder, and those two must never
 * disagree about what "47 left, resets on the 1st" means.
 *
 * WINDOWS ARE CALENDAR-ANCHORED, NOT ROLLING
 * ------------------------------------------
 * `DAY` resets at UTC midnight, `MONTH` at the 1st, 00:00 UTC — which is how the
 * providers themselves describe their caps ("200 per month"), and what lets the
 * UI print a date a human can plan around instead of a moving target.
 *
 * HOSTILE / CORRUPT INPUT MUST TIGHTEN THE LIMIT, NEVER RELEASE IT
 * ---------------------------------------------------------------
 * This is the hard-won rule of this module, and every branch below obeys it. A
 * limit that arrives as `NaN`, `Infinity`, `1e21`, a negative or a fraction is
 * NOT "no limit" — it is a broken limit, and the safe reading of a broken limit
 * is ZERO REMAINING. The opposite reading (treat garbage as unlimited) turns a
 * corrupted row into a licence to burn a month's paid quota in an afternoon, and
 * TypeScript cannot save us here: `number` covers `NaN` and `1e21` perfectly
 * happily, and the value arrives from a database column, so the type is a claim
 * about the shape, not about the contents.
 *
 * The one input that legitimately means "unlimited" is an explicit `null` limit
 * (DOU's feed), which is a DIFFERENT value from a broken number and is treated
 * differently on purpose.
 */

import type { JobSourceBudgetWindow } from '../schemas/job-sourcing'

/** Stored budget state for one source, exactly as it comes out of the row. */
export interface SourceBudgetState {
  /** Requests permitted per window; `null` = explicitly unlimited. */
  limit: number | null
  window: JobSourceBudgetWindow | null
  /** Requests spent so far — in the window that started at `windowStartedAt`. */
  used: number | null
  windowStartedAt: Date | null
}

export interface ResolvedBudget {
  /** `false` when this source has no published limit. */
  limited: boolean
  limit: number | null
  window: JobSourceBudgetWindow | null
  /** Spend attributed to the CURRENT window (0 after a rollover). */
  used: number
  /** `null` only when unlimited. */
  remaining: number | null
  /** Start of the window the spend is attributed to. `null` when unlimited. */
  windowStartedAt: Date | null
  /** When `used` returns to 0. `null` when unlimited. */
  resetsAt: Date | null
  /** True when a further request is NOT allowed. */
  exhausted: boolean
}

/**
 * A limit we are willing to believe. Anything else is treated as broken.
 *
 * The ceiling is not decoration: `1e21` is a finite, integral `number` that
 * `Number.isInteger` accepts, and arithmetic on it silently leaves the range
 * where `used + 1` is even representable — so a "limit" like that is
 * indistinguishable from no limit at all in every comparison downstream. No real
 * provider publishes a cap anywhere near this, so the honest reading of one is
 * "this value is corrupt".
 */
const MAX_CREDIBLE_LIMIT = 10_000_000

/** True when `value` is a limit we can safely do arithmetic with. */
export function isCredibleBudgetLimit(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_CREDIBLE_LIMIT
  )
}

/** Start of the calendar window containing `now`, in UTC. */
export function budgetWindowStart(now: Date, window: JobSourceBudgetWindow): Date {
  if (window === 'MONTH') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** Start of the window AFTER the one containing `now` — i.e. when it resets. */
export function budgetWindowEnd(now: Date, window: JobSourceBudgetWindow): Date {
  if (window === 'MONTH') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

/** A usable `Date`, or `null` for a missing / `Invalid Date` value. */
function validDate(value: Date | null | undefined): Date | null {
  if (!value) return null
  const time = value.getTime()
  return Number.isFinite(time) ? value : null
}

/**
 * Current budget position for one source.
 *
 * Pure: it reads state and returns a verdict, it never writes. The caller
 * persists the new counter after a successful spend (`spendBudget`).
 */
export function resolveBudget(state: SourceBudgetState, now: Date = new Date()): ResolvedBudget {
  const unlimited: ResolvedBudget = {
    limited: false,
    limit: null,
    window: null,
    used: 0,
    remaining: null,
    windowStartedAt: null,
    resetsAt: null,
    exhausted: false,
  }

  // An explicit `null` limit is the ONE input that means "no cap" (DOU's feed).
  // It is a different value from a broken number and is the only one that
  // releases the meter.
  if (state.limit === null || state.limit === undefined) return unlimited

  const window = state.window
  if (window !== 'DAY' && window !== 'MONTH') {
    // Limit set, window missing/unknown: refuse. Strictest reading wins.
    return {
      limited: true,
      limit: isCredibleBudgetLimit(state.limit) ? state.limit : 0,
      window: null,
      used: 0,
      remaining: 0,
      windowStartedAt: null,
      resetsAt: null,
      exhausted: true,
    }
  }

  const windowStart = budgetWindowStart(now, window)
  const resetsAt = budgetWindowEnd(now, window)

  // A limit we cannot do arithmetic with (NaN / Infinity / 1e21 / negative /
  // fractional) is a BROKEN limit, not an absent one — nothing may be spent
  // against it until a human fixes the row.
  if (!isCredibleBudgetLimit(state.limit)) {
    return {
      limited: true,
      limit: 0,
      window,
      used: 0,
      remaining: 0,
      windowStartedAt: windowStart,
      resetsAt,
      exhausted: true,
    }
  }

  const limit = state.limit
  const storedStart = validDate(state.windowStartedAt)

  // The stored counter only counts if it belongs to the CURRENT window. A
  // missing or older start means the window has rolled over — spend resets.
  // A start in the FUTURE (clock skew, a hand-edited row) is not trusted to
  // mean "fresh window": the counter is kept, which is the stricter reading.
  const rolledOver = storedStart === null || storedStart.getTime() < windowStart.getTime()

  const rawUsed = state.used
  // Same rule as the limit: an uncountable spend counts as fully spent.
  const usedIsSane = typeof rawUsed === 'number' && Number.isInteger(rawUsed) && rawUsed >= 0
  const carriedUsed = usedIsSane ? Math.min(rawUsed, limit) : limit
  const used = rolledOver ? 0 : carriedUsed

  const remaining = Math.max(0, limit - used)

  return {
    limited: true,
    limit,
    window,
    used,
    remaining,
    windowStartedAt: windowStart,
    resetsAt,
    exhausted: remaining <= 0,
  }
}

/**
 * The state to persist after ONE request has been spent against the budget.
 *
 * Returns `null` for an unlimited source — there is no counter to move. Callers
 * must treat a `null` as "nothing to write", never as "reset the row".
 */
export function spendBudget(
  state: SourceBudgetState,
  now: Date = new Date(),
): { used: number; windowStartedAt: Date } | null {
  const resolved = resolveBudget(state, now)
  if (!resolved.limited || resolved.windowStartedAt === null) return null
  return {
    // Capped at the limit so a race that double-spends cannot inflate the
    // counter past the cap and confuse the "remaining" display.
    used: Math.min(resolved.used + 1, resolved.limit ?? resolved.used + 1),
    windowStartedAt: resolved.windowStartedAt,
  }
}
